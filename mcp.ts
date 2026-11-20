// The MCP endpoint at POST /mcp: JSON-RPC 2.0 over Streamable HTTP. The server
// speaks the modern revision — server/discover answers identity, capabilities
// and supportedVersions in one request — and still honours the legacy
// initialize + notifications/initialized handshake for older clients. The tool
// list is a fixed constant (two tools/list calls answer byte-for-byte the
// same), and every tool acts on the same store helpers as REST and GraphQL, so
// an object made over MCP reads back identically over /api/v3.

import type { ServerResponse } from 'node:http';
import { sendEmpty, sendJson } from './http.ts';
import { createIssueRecord, createPullRecord, issueJson, mergePullRecord, pullJson, repoJson } from './rest.ts';
import { store, VIEWER, type Repo } from './store.ts';

const SERVER_INFO = { name: 'coreforge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SESSION_ID = 'coreforge-session';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function tool(name: string, description: string, properties: Record<string, string>, required: string[]): ToolDef {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(properties).map(([key, text]) => [key, { type: key === 'private' ? 'boolean' : key === 'pull_number' || key === 'issue_number' ? 'number' : 'string', description: text }])),
      required,
    },
  };
}

/** The fixed tool list. Order and content never change between calls. */
const TOOLS: readonly ToolDef[] = [
  tool('create_repo', 'Create a new repository for the authenticated user.', { name: 'The repository name', description: 'A short description of the repository', private: 'Whether the repository is private' }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', { owner: 'The repository owner login', repo: 'The repository name' }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', { owner: 'The repository owner login', repo: 'The repository name', title: 'The issue title', body: 'The issue body' }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List the issues of a repository, optionally filtered by state (open, closed, all).', { owner: 'The repository owner login', repo: 'The repository name', state: 'Issue state filter: open, closed or all' }, ['owner', 'repo']),
  tool('get_issue', 'Get one issue of a repository by its number.', { owner: 'The repository owner login', repo: 'The repository name', issue_number: 'The issue number' }, ['owner', 'repo', 'issue_number']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch.', { owner: 'The repository owner login', repo: 'The repository name', title: 'The pull request title', body: 'The pull request body', head: 'The head branch name', base: 'The base branch name' }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request into its base branch (squash).', { owner: 'The repository owner login', repo: 'The repository name', pull_number: 'The pull request number' }, ['owner', 'repo', 'pull_number']),
];

interface RpcOutcome {
  status: number;
  payload?: Record<string, unknown>;
  session?: boolean;
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id: id as string | number | null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): RpcOutcome {
  return { status, payload: { jsonrpc: '2.0', id: id as string | number | null, error: { code, message } } };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function requireRepo(owner: unknown, repo: unknown): Repo {
  if (typeof owner !== 'string' || typeof repo !== 'string') throw new Error('owner and repo are required');
  const found = store.getRepo(owner, repo);
  if (!found) throw new Error(`repository ${owner}/${repo} not found`);
  return found;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((candidate) => candidate.name === name);
  if (!def) throw new ToolUnknown(name);
  for (const required of def.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      throw new ToolInvalidParams(`missing required argument: ${required}`);
    }
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = String(args.name);
        if (store.getRepo(VIEWER.login, repoName)) return toolFailure(`repository ${VIEWER.login}/${repoName} already exists`);
        const repo = store.createRepo(VIEWER.login, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
        return toolResult(repoJson(repo));
      }
      case 'get_repo': {
        return toolResult(repoJson(requireRepo(args.owner, args.repo)));
      }
      case 'create_issue': {
        const repo = requireRepo(args.owner, args.repo);
        const issue = createIssueRecord(repo, { title: String(args.title), body: typeof args.body === 'string' ? args.body : '' });
        return toolResult(issueJson(repo, issue));
      }
      case 'list_issues': {
        const repo = requireRepo(args.owner, args.repo);
        const state = typeof args.state === 'string' ? args.state : 'open';
        const list = repo.issues
          .filter((issue) => state === 'all' || issue.state === state)
          .sort((a, b) => a.seq - b.seq)
          .map((issue) => issueJson(repo, issue));
        return toolResult(list);
      }
      case 'get_issue': {
        const repo = requireRepo(args.owner, args.repo);
        const issue = repo.issues.find((candidate) => candidate.number === Number(args.issue_number));
        if (!issue) return toolFailure(`issue ${String(args.issue_number)} not found`);
        return toolResult(issueJson(repo, issue));
      }
      case 'create_pull_request': {
        const repo = requireRepo(args.owner, args.repo);
        const pull = createPullRecord(repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          head: String(args.head),
          base: String(args.base),
        });
        return toolResult(pullJson(repo, pull));
      }
      case 'merge_pull_request': {
        const repo = requireRepo(args.owner, args.repo);
        const pull = repo.pulls.find((candidate) => candidate.number === Number(args.pull_number));
        if (!pull) return toolFailure(`pull request ${String(args.pull_number)} not found`);
        mergePullRecord(repo, pull, 'squash');
        return toolResult(pullJson(repo, pull));
      }
      default:
        throw new ToolUnknown(name);
    }
  } catch (err) {
    if (err instanceof ToolUnknown || err instanceof ToolInvalidParams) throw err;
    return toolFailure(err instanceof Error ? err.message : 'tool call failed');
  }
}

class ToolUnknown extends Error {
  constructor(name: string) {
    super(`unknown tool: ${name}`);
  }
}

class ToolInvalidParams extends Error {}

/** Dispatch one JSON-RPC request object. Returns null for notifications (answered 202 with no body). */
function dispatch(request: Record<string, unknown>): RpcOutcome | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  if (id === undefined || id === null) {
    // A notification: initialized, cancelled, progress — accepted silently.
    return null;
  }
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return { ...rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO }), session: true };
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      try {
        return rpcResult(id, callTool(name, args));
      } catch (err) {
        if (err instanceof ToolUnknown) return rpcError(id, -32602, err.message);
        if (err instanceof ToolInvalidParams) return rpcError(id, -32602, err.message);
        return rpcError(id, -32603, err instanceof Error ? err.message : 'internal error');
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/**
 * Handle one POST /mcp. Auth is enforced by app.ts before this runs. A body
 * that is not JSON is a 400 with a -32700 parse error, as the protocol demands.
 */
export function handleMcp(res: ServerResponse, rawBody: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const outcomes = parsed
      .map((entry) => (typeof entry === 'object' && entry !== null ? dispatch(entry as Record<string, unknown>) : rpcError(null, -32600, 'invalid request')))
      .filter((outcome): outcome is RpcOutcome => outcome !== null);
    if (!outcomes.length) {
      sendEmpty(res, 202);
      return;
    }
    sendJson(res, 200, outcomes.map((outcome) => outcome.payload));
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const outcome = dispatch(parsed as Record<string, unknown>);
  if (outcome === null) {
    sendEmpty(res, 202);
    return;
  }
  const headers: Record<string, string> = {};
  if (outcome.session) headers['mcp-session-id'] = SESSION_ID;
  sendJson(res, outcome.status, outcome.payload, headers);
}
