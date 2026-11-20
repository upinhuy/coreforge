// The GraphQL v4 surface at POST /api/graphql. A compact hand-written parser
// (operations, fragments, variables, input objects, enums) and an executor over
// a hard-coded schema whose field tables double as the introspection data, so
// __type answers can never drift from what execution accepts. Global ids are
// opaque base64 encodings of (type, key) — stable across reads, never the bare
// database id — and node(id) decodes them back. Mutations land in the same
// store helpers the REST surface uses, so an object created one way reads back
// identically the other way.

import type { ServerResponse } from 'node:http';
import { mergeBase, mergeTrees, parseCommit, peelToCommit } from './gitobj.ts';
import { ApiError, sendJson } from './http.ts';
import { computePullFiles, createIssueRecord, createPullRecord, mergePullRecord } from './rest.ts';
import { store, VIEWER, type Issue, type Pull, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// global ids

export function encodeGlobalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const value = Number.parseInt(text.replace(/^cursor:/, ''), 10);
    return Number.isFinite(value) ? value : -1;
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// the schema: type name -> field name -> named result type. Introspection and
// validation both read this table.

const TYPE_FIELDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: { id: 'ID', login: 'String', name: 'String', email: 'String', databaseId: 'Int' },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    owner: 'User',
    description: 'String',
    isPrivate: 'Boolean',
    visibility: 'String',
    defaultBranchRef: 'Ref',
    viewerPermission: 'String',
    hasIssuesEnabled: 'Boolean',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequest: 'PullRequest',
    pullRequests: 'PullRequestConnection',
    createdAt: 'DateTime',
    updatedAt: 'DateTime',
  },
  Ref: { name: 'String', prefix: 'String', target: 'Commit' },
  Commit: { oid: 'String' },
  Issue: {
    id: 'ID',
    databaseId: 'Int',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'IssueState',
    createdAt: 'DateTime',
    updatedAt: 'DateTime',
    author: 'User',
    repository: 'Repository',
    labels: 'LabelConnection',
    comments: 'IssueCommentConnection',
  },
  PullRequest: {
    id: 'ID',
    databaseId: 'Int',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'PullRequestState',
    merged: 'Boolean',
    mergedAt: 'DateTime',
    mergeCommit: 'Commit',
    headRefName: 'String',
    baseRefName: 'String',
    headRefOid: 'String',
    baseRefOid: 'String',
    mergeable: 'MergeableState',
    files: 'PullRequestChangedFileConnection',
    createdAt: 'DateTime',
    updatedAt: 'DateTime',
    author: 'User',
    repository: 'Repository',
  },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', edges: 'PullRequestChangedFileEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFileEdge: { node: 'PullRequestChangedFile', cursor: 'String' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  LabelConnection: { nodes: 'Label', edges: 'LabelEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  LabelEdge: { node: 'Label', cursor: 'String' },
  Label: { id: 'ID', name: 'String', color: 'String', description: 'String' },
  IssueCommentConnection: { nodes: 'IssueComment', edges: 'IssueCommentEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  IssueComment: { id: 'ID', body: 'String', createdAt: 'DateTime', author: 'User' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Issue', clientMutationId: 'String' },
  __Type: { name: 'String', kind: 'String', description: 'String', fields: '__Field', enumValues: '__EnumValue', possibleTypes: '__Type' },
  __Field: { name: 'String', description: 'String', type: '__Type', args: '__InputValue' },
  __InputValue: { name: 'String', description: 'String', type: '__Type' },
  __EnumValue: { name: 'String', description: 'String' },
  __Schema: { queryType: '__Type', mutationType: '__Type', types: '__Type' },
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime']);

function typeKind(name: string): string {
  if (TYPE_FIELDS[name]) return 'OBJECT';
  if (ENUM_VALUES[name]) return 'ENUM';
  if (SCALARS.has(name)) return 'SCALAR';
  if (name === 'Node') return 'INTERFACE';
  return 'OBJECT';
}

// ---------------------------------------------------------------------------
// tokenizer + parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: Value }>;
  directives: Array<{ name: string; args: Array<{ name: string; value: Value }> }>;
  selectionSet?: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition?: string; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name?: string;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selectionSet: SelectionNode[];
}

class GqlSyntaxError extends Error {}

function tokenize(source: string): Array<{ type: string; value: string }> {
  const tokens: Array<{ type: string; value: string }> = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ type: '...', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(ch)) {
      tokens.push({ type: ch, value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GqlSyntaxError('unterminated block string');
        tokens.push({ type: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'u') {
            text += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            text += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' }[esc] ?? esc;
            j += 2;
          }
        } else {
          text += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new GqlSyntaxError('unterminated string');
      tokens.push({ type: 'string', value: text });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      if (!match) throw new GqlSyntaxError(`bad number at ${i}`);
      tokens.push({ type: match[0].includes('.') || /[eE]/.test(match[0]) ? 'float' : 'int', value: match[0] });
      i += match[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i))!;
      tokens.push({ type: 'name', value: match[0] });
      i += match[0].length;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

class Parser {
  private tokens: Array<{ type: string; value: string }>;
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): { type: string; value: string } {
    return this.tokens[this.pos];
  }

  private next(): { type: string; value: string } {
    return this.tokens[this.pos++];
  }

  private expect(type: string): { type: string; value: string } {
    const token = this.next();
    if (token.type !== type) throw new GqlSyntaxError(`expected ${type}, found ${token.type} ${token.value}`);
    return token;
  }

  private skip(type: string): boolean {
    if (this.peek().type === type) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().type !== 'eof') {
      const token = this.peek();
      if (token.type === '{') {
        operations.push({ operation: 'query', selectionSet: this.parseSelectionSet() });
      } else if (token.type === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        const operation = token.value as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek().type === 'name') name = this.next().value;
        if (this.peek().type === '(') this.parseVariableDefinitions();
        this.parseDirectives();
        operations.push({ operation, name, selectionSet: this.parseSelectionSet() });
      } else if (token.type === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expect('name').value;
        this.expect('name'); // 'on'
        const typeCondition = this.expect('name').value;
        this.parseDirectives();
        fragments.set(name, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new GqlSyntaxError(`unexpected token ${token.type} ${token.value}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek().type !== ')') {
      this.expect('$');
      this.expect('name');
      this.expect(':');
      this.parseType();
      if (this.skip('=')) this.parseValue();
      this.parseDirectives();
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.skip('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.expect('name');
    }
    this.skip('!');
  }

  private parseDirectives(): Array<{ name: string; args: Array<{ name: string; value: Value }> }> {
    const directives: Array<{ name: string; args: Array<{ name: string; value: Value }> }> = [];
    while (this.peek().type === '@') {
      this.next();
      const name = this.expect('name').value;
      const args = this.peek().type === '(' ? this.parseArguments() : [];
      directives.push({ name, args });
    }
    return directives;
  }

  private parseArguments(): Array<{ name: string; value: Value }> {
    const args: Array<{ name: string; value: Value }> = [];
    this.expect('(');
    while (this.peek().type !== ')') {
      const name = this.expect('name').value;
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expect(')');
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.type === '$') return { kind: 'variable', name: this.expect('name').value };
    if (token.type === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.type === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.type === 'string') return { kind: 'string', value: token.value };
    if (token.type === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.type === '[') {
      const values: Value[] = [];
      while (this.peek().type !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.type === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek().type !== '}') {
        const name = this.expect('name').value;
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    throw new GqlSyntaxError(`unexpected value token ${token.type}`);
  }

  private parseSelectionSet(): SelectionNode[] {
    const selections: SelectionNode[] = [];
    this.expect('{');
    while (this.peek().type !== '}') {
      if (this.peek().type === '...') {
        this.next();
        if (this.peek().type === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expect('name').value;
          this.parseDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else if (this.peek().type === '{') {
          selections.push({ kind: 'inline', selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.expect('name').value;
          this.parseDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let name = this.expect('name').value;
      let alias: string | undefined;
      if (this.skip(':')) {
        alias = name;
        name = this.expect('name').value;
      }
      const args = this.peek().type === '(' ? this.parseArguments() : [];
      const directives = this.parseDirectives();
      const selectionSet = this.peek().type === '{' ? this.parseSelectionSet() : undefined;
      selections.push({ kind: 'field', alias, name, args, directives, selectionSet });
    }
    this.expect('}');
    return selections;
  }
}

// ---------------------------------------------------------------------------
// execution

type GqlValue = { __kind: string; [key: string]: unknown };

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string; path?: unknown[] }>;
}

function resolveValue(value: Value, ctx: ExecContext): unknown {
  switch (value.kind) {
    case 'variable':
      return ctx.variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx);
  return out;
}

function directivesAllow(directives: FieldNode['directives'], ctx: ExecContext): boolean {
  for (const directive of directives) {
    const args: Record<string, unknown> = {};
    for (const arg of directive.args) args[arg.name] = resolveValue(arg.value, ctx);
    if (directive.name === 'skip' && args.if === true) return false;
    if (directive.name === 'include' && args.if === false) return false;
  }
  return true;
}

function userValue(): GqlValue {
  return { __kind: 'User' };
}

function repoValue(repo: Repo): GqlValue {
  return { __kind: 'Repository', repo };
}

function issueValue(repo: Repo, issue: Issue): GqlValue {
  return { __kind: 'Issue', repo, issue };
}

function pullValue(repo: Repo, pull: Pull): GqlValue {
  return { __kind: 'PullRequest', repo, pull };
}

interface ConnectionData {
  typeName: string;
  nodes: GqlValue[];
  edges: Array<{ node: GqlValue; cursor: string }>;
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  totalCount: number;
}

function paginate(items: GqlValue[], args: Record<string, unknown>, typeName: string): GqlValue {
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : items.length;
  let start = 0;
  if (typeof args.after === 'string') start = decodeCursor(args.after) + 1;
  const slice = items.slice(start, start + first);
  const edges = slice.map((node, index) => ({ node, cursor: encodeCursor(start + index) }));
  const data: ConnectionData = {
    typeName,
    nodes: slice,
    edges,
    pageInfo: {
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length ? edges[0].cursor : null,
      endCursor: edges.length ? edges[edges.length - 1].cursor : null,
    },
    totalCount: items.length,
  };
  return { __kind: 'Connection', connection: data };
}

function orderByCreated<T extends { seq: number }>(items: readonly T[], args: Record<string, unknown>): T[] {
  const orderBy = (args.orderBy ?? {}) as { direction?: string };
  const direction = orderBy.direction ?? 'DESC';
  return [...items].sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
}

function nodeById(id: string): GqlValue | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  const { type, key } = decoded;
  if (type === 'User') return key === String(VIEWER.id) ? userValue() : null;
  if (type === 'Repository') {
    const repo = store.getRepoById(Number.parseInt(key, 10));
    return repo ? repoValue(repo) : null;
  }
  if (type === 'Issue' || type === 'PullRequest') {
    const [repoId, number] = key.split(':');
    const repo = store.getRepoById(Number.parseInt(repoId, 10));
    if (!repo) return null;
    if (type === 'Issue') {
      const issue = repo.issues.find((candidate) => candidate.number === Number.parseInt(number, 10));
      return issue ? issueValue(repo, issue) : null;
    }
    const pull = repo.pulls.find((candidate) => candidate.number === Number.parseInt(number, 10));
    return pull ? pullValue(repo, pull) : null;
  }
  if (type === 'IssueComment') {
    const [repoId, issueNumber, commentId] = key.split(':');
    const repo = store.getRepoById(Number.parseInt(repoId, 10));
    const issue = repo?.issues.find((candidate) => candidate.number === Number.parseInt(issueNumber, 10));
    const comment = issue?.comments.find((candidate) => candidate.id === Number.parseInt(commentId, 10));
    return issue && comment ? { __kind: 'IssueComment', repo, issue, comment } : null;
  }
  return null;
}

class FieldError extends Error {}

/** MERGEABLE / CONFLICTING for an open pull request, by a dry-run three-way tree merge. */
function mergeableOf(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.base_ref}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head_ref}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  const baseCommit = peelToCommit(repo.objects, baseTip);
  const headCommit = peelToCommit(repo.objects, headTip);
  if (!baseCommit || !headCommit) return 'UNKNOWN';
  const treeOf = (oid: string): string | null => {
    const commit = repo.objects.get(oid);
    return commit ? parseCommit(commit.data).tree : null;
  };
  const ancestor = mergeBase(repo.objects, baseCommit, headCommit);
  const baseTree = treeOf(baseCommit);
  const headTree = treeOf(headCommit);
  if (!baseTree || !headTree) return 'UNKNOWN';
  const merged = mergeTrees(repo.objects, ancestor ? treeOf(ancestor) : null, baseTree, headTree);
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

function resolveField(obj: GqlValue, field: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const kind = obj.__kind;
  if (field === '__typename') {
    if (kind === 'Connection') return (obj.connection as ConnectionData).typeName;
    return kind;
  }
  switch (kind) {
    case 'Query': {
      if (field === 'viewer') return userValue();
      if (field === 'repository') {
        const repo = typeof args.name === 'string' && typeof args.owner === 'string' ? store.getRepo(args.owner, args.name) : undefined;
        return repo ? repoValue(repo) : null;
      }
      if (field === 'node') return typeof args.id === 'string' ? nodeById(args.id) : null;
      if (field === '__type') {
        const name = args.name;
        if (typeof name !== 'string') return null;
        if (!TYPE_FIELDS[name] && !ENUM_VALUES[name] && !SCALARS.has(name) && name !== 'Node') return null;
        return { __kind: '__Type', name };
      }
      if (field === '__schema') return { __kind: '__Schema' };
      break;
    }
    case 'Mutation': {
      return resolveMutation(field, args);
    }
    case 'User': {
      if (field === 'id') return encodeGlobalId('User', String(VIEWER.id));
      if (field === 'login') return VIEWER.login;
      if (field === 'name') return VIEWER.name;
      if (field === 'email') return VIEWER.email;
      if (field === 'databaseId') return VIEWER.id;
      break;
    }
    case 'Repository': {
      const repo = obj.repo as Repo;
      switch (field) {
        case 'id':
          return encodeGlobalId('Repository', String(repo.id));
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return userValue();
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.private;
        case 'visibility':
          return repo.private ? 'PRIVATE' : 'PUBLIC';
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
          return tip ? { __kind: 'Ref', repo, name: repo.default_branch, oid: tip } : null;
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'createdAt':
          return repo.created_at;
        case 'updatedAt':
          return repo.updated_at;
        case 'issue': {
          const issue = repo.issues.find((candidate) => candidate.number === args.number);
          return issue ? issueValue(repo, issue) : null;
        }
        case 'issues': {
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          const filtered = repo.issues.filter((issue) => !states || states.includes(issue.state.toUpperCase()));
          return paginate(orderByCreated(filtered, args).map((issue) => issueValue(repo, issue)), args, 'IssueConnection');
        }
        case 'pullRequest': {
          const pull = repo.pulls.find((candidate) => candidate.number === args.number);
          return pull ? pullValue(repo, pull) : null;
        }
        case 'pullRequests': {
          const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
          const filtered = repo.pulls.filter((pull) => {
            const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
            return states.includes(state) || (states.includes('CLOSED') && state === 'MERGED');
          });
          return paginate(orderByCreated(filtered, args).map((pull) => pullValue(repo, pull)), args, 'PullRequestConnection');
        }
      }
      break;
    }
    case 'Ref': {
      if (field === 'name') return obj.name;
      if (field === 'prefix') return 'refs/heads/';
      if (field === 'target') return { __kind: 'Commit', oid: obj.oid };
      break;
    }
    case 'Commit': {
      if (field === 'oid') return obj.oid;
      break;
    }
    case 'Issue': {
      const repo = obj.repo as Repo;
      const issue = obj.issue as Issue;
      switch (field) {
        case 'id':
          return encodeGlobalId('Issue', `${repo.id}:${issue.number}`);
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        case 'createdAt':
          return issue.created_at;
        case 'updatedAt':
          return issue.updated_at;
        case 'author':
          return userValue();
        case 'repository':
          return repoValue(repo);
        case 'labels':
          return paginate(
            issue.labels.map((name) => ({ __kind: 'Label', repo, name }) as GqlValue),
            args,
            'LabelConnection',
          );
        case 'comments':
          return paginate(
            [...issue.comments].sort((a, b) => a.id - b.id).map((comment) => ({ __kind: 'IssueComment', repo, issue, comment }) as GqlValue),
            args,
            'IssueCommentConnection',
          );
      }
      break;
    }
    case 'PullRequest': {
      const repo = obj.repo as Repo;
      const pull = obj.pull as Pull;
      switch (field) {
        case 'id':
          return encodeGlobalId('PullRequest', `${repo.id}:${pull.number}`);
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.merged_at;
        case 'mergeCommit':
          return pull.merge_commit_sha ? { __kind: 'Commit', oid: pull.merge_commit_sha } : null;
        case 'headRefName':
          return pull.head_ref;
        case 'baseRefName':
          return pull.base_ref;
        case 'headRefOid':
          return repo.refs.get(`refs/heads/${pull.head_ref}`) ?? pull.head_sha;
        case 'baseRefOid':
          return repo.refs.get(`refs/heads/${pull.base_ref}`) ?? pull.base_sha;
        case 'mergeable':
          return mergeableOf(repo, pull);
        case 'files': {
          const files = computePullFiles(repo, pull).map((file) => ({
            __kind: 'PullRequestChangedFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
          }) as GqlValue);
          return paginate(files, args, 'PullRequestChangedFileConnection');
        }
        case 'createdAt':
          return pull.created_at;
        case 'updatedAt':
          return pull.updated_at;
        case 'author':
          return userValue();
        case 'repository':
          return repoValue(repo);
      }
      break;
    }
    case 'Label': {
      const repo = obj.repo as Repo;
      const label = repo.labels.find((candidate) => candidate.name === obj.name);
      if (field === 'id') return encodeGlobalId('Label', `${repo.id}:${String(obj.name)}`);
      if (field === 'name') return obj.name;
      if (field === 'color') return label?.color ?? 'ededed';
      if (field === 'description') return label?.description ?? null;
      break;
    }
    case 'IssueComment': {
      const repo = obj.repo as Repo;
      const issue = obj.issue as Issue;
      const comment = obj.comment as Issue['comments'][number];
      if (field === 'id') return encodeGlobalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`);
      if (field === 'body') return comment.body;
      if (field === 'createdAt') return comment.created_at;
      if (field === 'author') return userValue();
      break;
    }
    case 'PullRequestChangedFile': {
      if (field === 'path') return obj.path;
      if (field === 'additions') return obj.additions;
      if (field === 'deletions') return obj.deletions;
      if (field === 'changeType') return obj.changeType;
      break;
    }
    case 'Connection': {
      const connection = obj.connection as ConnectionData;
      if (field === 'nodes') return connection.nodes;
      if (field === 'edges') return connection.edges.map((edge) => ({ __kind: 'Edge', node: edge.node, cursor: edge.cursor }));
      if (field === 'pageInfo') return { __kind: 'PageInfo', pageInfo: connection.pageInfo };
      if (field === 'totalCount') return connection.totalCount;
      break;
    }
    case 'Edge': {
      if (field === 'node') return obj.node;
      if (field === 'cursor') return obj.cursor;
      break;
    }
    case 'PageInfo': {
      const pageInfo = obj.pageInfo as ConnectionData['pageInfo'];
      if (field === 'hasNextPage') return pageInfo.hasNextPage;
      if (field === 'hasPreviousPage') return pageInfo.hasPreviousPage;
      if (field === 'startCursor') return pageInfo.startCursor;
      if (field === 'endCursor') return pageInfo.endCursor;
      break;
    }
    case '__Type': {
      const name = obj.name as string;
      if (field === 'name') return name;
      if (field === 'kind') return typeKind(name);
      if (field === 'description') return null;
      if (field === 'fields') {
        const fields = TYPE_FIELDS[name];
        if (!fields) return null;
        return Object.entries(fields).map(([fieldName, fieldType]) => ({ __kind: '__Field', name: fieldName, typeName: fieldType }));
      }
      if (field === 'enumValues') {
        const values = ENUM_VALUES[name];
        if (!values) return null;
        return values.map((value) => ({ __kind: '__EnumValue', name: value }));
      }
      if (field === 'possibleTypes') return null;
      break;
    }
    case '__Field': {
      if (field === 'name') return obj.name;
      if (field === 'description') return null;
      if (field === 'type') return { __kind: '__Type', name: obj.typeName };
      if (field === 'args') return [];
      break;
    }
    case '__EnumValue': {
      if (field === 'name') return obj.name;
      if (field === 'description') return null;
      break;
    }
    case '__Schema': {
      if (field === 'queryType') return { __kind: '__Type', name: 'Query' };
      if (field === 'mutationType') return { __kind: '__Type', name: 'Mutation' };
      if (field === 'types') return Object.keys(TYPE_FIELDS).map((name) => ({ __kind: '__Type', name }));
      break;
    }
    default: {
      // Mutation payloads carry their object under a named key.
      if (kind.endsWith('Payload')) {
        if (field === 'clientMutationId') return obj.clientMutationId ?? null;
        if (field === 'issue') return obj.issue ?? null;
        if (field === 'pullRequest') return obj.pullRequest ?? null;
        if (field === 'commentEdge') return obj.commentEdge ?? null;
        if (field === 'subject') return obj.subject ?? null;
      }
      break;
    }
  }
  throw new FieldError(`Field '${field}' doesn't exist on type '${kind}'`);
}

function repoFromGlobalId(id: unknown): Repo {
  if (typeof id !== 'string') throw new FieldError('a repository id is required');
  const decoded = decodeGlobalId(id);
  const repo = decoded && decoded.type === 'Repository' ? store.getRepoById(Number.parseInt(decoded.key, 10)) : undefined;
  if (!repo) throw new FieldError(`Could not resolve to a Repository with the id of ${id}.`);
  return repo;
}

function issueFromGlobalId(id: unknown): { repo: Repo; issue: Issue } {
  if (typeof id !== 'string') throw new FieldError('an issue id is required');
  const value = nodeById(id);
  if (!value || value.__kind !== 'Issue') throw new FieldError(`Could not resolve to an Issue with the id of ${id}.`);
  return { repo: value.repo as Repo, issue: value.issue as Issue };
}

function pullFromGlobalId(id: unknown): { repo: Repo; pull: Pull } {
  if (typeof id !== 'string') throw new FieldError('a pull request id is required');
  const value = nodeById(id);
  if (!value || value.__kind !== 'PullRequest') throw new FieldError(`Could not resolve to a PullRequest with the id of ${id}.`);
  return { repo: value.repo as Repo, pull: value.pull as Pull };
}

function resolveMutation(field: string, args: Record<string, unknown>): GqlValue {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
  try {
    if (field === 'createIssue') {
      const repo = repoFromGlobalId(input.repositoryId);
      const title = typeof input.title === 'string' ? input.title : '';
      if (!title) throw new FieldError('title is required');
      const issue = createIssueRecord(repo, { title, body: typeof input.body === 'string' ? input.body : '' });
      return { __kind: 'CreateIssuePayload', issue: issueValue(repo, issue), clientMutationId };
    }
    if (field === 'closeIssue') {
      const { repo, issue } = issueFromGlobalId(input.issueId);
      issue.state = 'closed';
      issue.updated_at = store.tick();
      return { __kind: 'CloseIssuePayload', issue: issueValue(repo, issue), clientMutationId };
    }
    if (field === 'createPullRequest') {
      const repo = repoFromGlobalId(input.repositoryId);
      const pull = createPullRecord(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
      });
      return { __kind: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pull), clientMutationId };
    }
    if (field === 'mergePullRequest') {
      const { repo, pull } = pullFromGlobalId(input.pullRequestId);
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
      mergePullRecord(repo, pull, method === 'merge' ? 'merge' : 'squash');
      return { __kind: 'MergePullRequestPayload', pullRequest: pullValue(repo, pull), clientMutationId };
    }
    if (field === 'addComment') {
      const { repo, issue } = issueFromGlobalId(input.subjectId);
      const body = typeof input.body === 'string' ? input.body : '';
      const now = store.tick();
      const comment = { id: repo.nextCommentId++, body, seq: store.nextSeq(), created_at: now, updated_at: now };
      issue.comments.push(comment);
      const commentValue = { __kind: 'IssueComment', repo, issue, comment } as GqlValue;
      return {
        __kind: 'AddCommentPayload',
        commentEdge: { __kind: 'Edge', node: commentValue, cursor: encodeCursor(comment.id) },
        subject: issueValue(repo, issue),
        clientMutationId,
      };
    }
  } catch (err) {
    if (err instanceof ApiError) throw new FieldError(err.message);
    throw err;
  }
  throw new FieldError(`Unknown mutation '${field}'`);
}

function typeNameOf(obj: GqlValue): string {
  if (obj.__kind === 'Connection') return (obj.connection as ConnectionData).typeName;
  return obj.__kind;
}

function validateSelections(typeName: string, selections: SelectionNode[], ctx: ExecContext, errors: string[]): void {
  const fields = TYPE_FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      validateSelections(selection.typeCondition ?? typeName, selection.selectionSet, ctx, errors);
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) validateSelections(fragment.typeCondition, fragment.selectionSet, ctx, errors);
      continue;
    }
    if (selection.name === '__typename') continue;
    if (!fields || !(selection.name in fields)) {
      errors.push(`Field '${selection.name}' doesn't exist on type '${typeName}'`);
      continue;
    }
    if (selection.selectionSet) {
      const childType = fields[selection.name];
      if (TYPE_FIELDS[childType]) validateSelections(childType, selection.selectionSet, ctx, errors);
    }
  }
}

function executeSelections(obj: GqlValue, selections: SelectionNode[], ctx: ExecContext, path: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeName = typeNameOf(obj);
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (!selection.typeCondition || selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        Object.assign(out, executeSelections(obj, selection.selectionSet, ctx, path));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment && (fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
        Object.assign(out, executeSelections(obj, fragment.selectionSet, ctx, path));
      }
      continue;
    }
    if (!directivesAllow(selection.directives, ctx)) continue;
    const key = selection.alias ?? selection.name;
    const args = argsOf(selection, ctx);
    try {
      const value = resolveField(obj, selection.name, args, ctx);
      out[key] = completeValue(value, selection, ctx, [...path, key]);
    } catch (err) {
      if (err instanceof FieldError) {
        ctx.errors.push({ message: err.message, path: [...path, key] });
        out[key] = null;
      } else {
        throw err;
      }
    }
  }
  return out;
}

function completeValue(value: unknown, selection: FieldNode, ctx: ExecContext, path: unknown[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, selection, ctx, path));
  if (typeof value === 'object' && (value as GqlValue).__kind) {
    if (!selection.selectionSet) return null;
    return executeSelections(value as GqlValue, selection.selectionSet, ctx, path);
  }
  return value;
}

// ---------------------------------------------------------------------------
// the HTTP handler

export function executeGraphQL(payload: unknown): { status: number; body: unknown } {
  const isBatch = Array.isArray(payload);
  const requests = isBatch ? (payload as unknown[]) : [payload];
  const results: unknown[] = [];
  for (const request of requests) {
    results.push(executeOne(request));
  }
  return { status: 200, body: isBatch ? results : results[0] };
}

function executeOne(request: unknown): unknown {
  if (typeof request !== 'object' || request === null) return { errors: [{ message: 'a GraphQL request must be an object' }] };
  const { query, variables, operationName } = request as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof query !== 'string') return { errors: [{ message: 'a GraphQL query string is required' }] };
  let document: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  const operation =
    document.operations.find((candidate) => typeof operationName === 'string' && candidate.name === operationName) ?? document.operations[0];
  if (!operation) return { errors: [{ message: 'no operation in the document' }] };
  const ctx: ExecContext = {
    variables: typeof variables === 'object' && variables !== null ? (variables as Record<string, unknown>) : {},
    fragments: document.fragments,
    errors: [],
  };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: string[] = [];
  validateSelections(rootType, operation.selectionSet, ctx, validationErrors);
  if (validationErrors.length) {
    return { errors: validationErrors.map((message) => ({ message })) };
  }
  const root: GqlValue = { __kind: rootType };
  const data = executeSelections(root, operation.selectionSet, ctx, []);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length) body.errors = ctx.errors;
  return body;
}

export function handleGraphQL(res: ServerResponse, payload: unknown): void {
  const { status, body } = executeGraphQL(payload);
  sendJson(res, status, body);
}
