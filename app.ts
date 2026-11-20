// CoreForge's HTTP router. One server, four surfaces:
//   - GET /healthz                     the env's boot probe (no auth)
//   - /{owner}/{repo}.git/...          git smart HTTP (see githttp.ts)
//   - /api/v3/...                      the REST surface (see rest.ts)
//   - POST /api/graphql                the GraphQL surface (see graphql.ts)
//   - POST /mcp                        the MCP endpoint (see mcp.ts)
// REST, GraphQL and MCP require the trial token as a Bearer credential — the
// process's own MAKEFUN_SHOP_TOKEN — exactly as the rules state: a missing or
// wrong token is a 401 JSON body, and a repository owned by someone else is a
// 404, never a 403 (repositories only ever belong to the token's owner here,
// so any other owner is simply unknown). Git smart HTTP serves the same
// repositories without demanding the header, as a public clone would.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { ApiError, nextRequestId, parseJsonBody, readBody, sendJson } from './http.ts';
import { handleMcp } from './mcp.ts';
import { handleApiV3 } from './rest.ts';
import { store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || header.length <= 'Bearer '.length) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected) return header === `Bearer ${expected}`;
  return true;
}

function pathOf(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', `http://${req.headers.host ?? 'entry'}`);
  } catch {
    return null;
  }
}

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = pathOf(req);
  if (!url) {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const path = url.pathname;

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP.
  const gitMatch = GIT_ROUTE.exec(path);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repo = store.getRepo(owner, decodeURIComponent(gitMatch[2]));
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const endpoint = gitMatch[3];
    if (endpoint === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      handleInfoRefs(req, res, repo, service);
      return;
    }
    if (endpoint === 'git-upload-pack' && method === 'POST') {
      handleUploadPack(res, repo, await readBody(req));
      return;
    }
    if (endpoint === 'git-receive-pack' && method === 'POST') {
      handleReceivePack(res, repo, await readBody(req));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // The API root and meta answer without auth, as the starter's surface did.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    const text = `${JSON.stringify({
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
    })}\n`;
    res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-oauth-scopes': 'repo, read:org', 'x-github-request-id': nextRequestId() });
    res.end(text);
    return;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    sendJson(res, 200, { installed_version: 'coreforge 1.0.0', git_url: 'git://', hooks: [] });
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const body = method === 'GET' || method === 'HEAD' ? {} : parseJsonBody(await readBody(req));
    handleApiV3(req, res, url, body);
    return;
  }

  if (path === '/api/graphql') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    handleGraphQL(res, payload);
    return;
  }

  if (path === '/mcp') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    handleMcp(res, await readBody(req));
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof ApiError) {
        sendJson(res, err.status, { message: err.message, ...err.extra });
        return;
      }
      process.stderr.write(`[coreforge] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      sendJson(res, 500, { message: 'Internal Server Error' });
    });
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  return server;
}
