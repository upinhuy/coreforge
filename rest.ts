// The REST v3 surface: users, repositories, the contents API (which is also how
// branches and commits are born on an unborn repository), git refs, branches,
// labels, issues with comments, and pull requests with file diffs and merges.
// Handlers throw ApiError for every expected failure; app.ts turns those into
// GitHub-shaped JSON error bodies. The record-creating helpers are exported so
// the GraphQL mutations and the MCP tools act on exactly the same store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildCommitBytes,
  buildTreeFromFiles,
  flattenTree,
  isObjectId,
  mergeBase,
  mergeTrees,
  parseCommit,
  parseTree,
  peelToCommit,
  putObject,
} from './gitobj.ts';
import { ApiError, notFound, sendEmpty, sendJson, validationFailed } from './http.ts';
import { VIEWER, VIEWER_IDENTITY, store, type Issue, type Pull, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// small helpers

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', String(VIEWER.id)),
    type: 'User',
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.find((candidate) => candidate.name === name);
  return {
    id: label ? repo.labels.indexOf(label) + 1 : 0,
    node_id: globalId('Label', `${repo.id}:${name}`),
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    comments: issue.comments.length,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head_ref}`) ?? pull.head_sha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base_ref}`) ?? pull.base_sha;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { label: `${repo.owner}:${pull.head_ref}`, ref: pull.head_ref, sha: headSha },
    base: { label: `${repo.owner}:${pull.base_ref}`, ref: pull.base_ref, sha: baseSha },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
  };
}

/** Create a commit authored by the viewer on top of `parents` and return its id. */
export function commitWithTree(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
  const stamp = store.tickSeconds();
  const who = `${VIEWER_IDENTITY} ${stamp} +0000`;
  const text = message.endsWith('\n') ? message : `${message}\n`;
  return putObject(repo.objects, 'commit', buildCommitBytes({ tree: treeOid, parents, message: text, author: who, committer: who }));
}

/** The tree id at a commit id, peeling tags first. */
export function treeOfCommit(repo: Repo, oid: string): string | null {
  const commitOid = peelToCommit(repo.objects, oid);
  if (!commitOid) return null;
  const commit = repo.objects.get(commitOid);
  if (!commit) return null;
  return parseCommit(commit.data).tree;
}

/** Paginate a list the way GitHub does: per_page/page plus a Link header with rel="next". */
function paginate<T>(res: ServerResponse, url: URL, items: readonly T[]): T[] {
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const next = new URL(url.toString());
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    const last = new URL(url.toString());
    last.searchParams.set('page', String(Math.ceil(items.length / perPage)));
    last.searchParams.set('per_page', String(perPage));
    res.setHeader('link', `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`);
  }
  return [...slice];
}

/** Sort by creation sequence; direction 'asc' is oldest first, anything else newest first. */
function sortByCreation<T extends { seq: number }>(items: readonly T[], url: URL): T[] {
  const direction = url.searchParams.get('direction') ?? 'desc';
  return [...items].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
}

// ---------------------------------------------------------------------------
// shared record creation (REST, GraphQL and MCP all land here)

export function createIssueRecord(repo: Repo, fields: { title: string; body?: string; labels?: string[] }): Issue {
  const labels = fields.labels ?? [];
  for (const name of labels) {
    if (!repo.labels.some((label) => label.name === name)) {
      throw validationFailed('Validation Failed', [{ resource: 'Issue', field: 'labels', code: 'invalid', message: `label "${name}" does not exist` }]);
    }
  }
  const now = store.tick();
  const issue: Issue = {
    id: store.nextRecordId(),
    number: repo.nextNumber++,
    title: fields.title,
    body: fields.body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: store.nextSeq(),
    created_at: now,
    updated_at: now,
  };
  repo.issues.push(issue);
  return issue;
}

export function createPullRecord(repo: Repo, fields: { title: string; body?: string; head: string; base: string }): Pull {
  const short = (ref: string): string => (ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref);
  const head = short(fields.head);
  const base = short(fields.base);
  const headSha = repo.refs.get(`refs/heads/${head}`);
  if (!headSha) throw validationFailed('Validation Failed', [{ resource: 'PullRequest', field: 'head', code: 'invalid', message: `head ref "${head}" does not exist` }]);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!baseSha) throw validationFailed('Validation Failed', [{ resource: 'PullRequest', field: 'base', code: 'invalid', message: `base ref "${base}" does not exist` }]);
  const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head_ref === head && pull.base_ref === base);
  if (duplicate) {
    throw validationFailed('Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${repo.owner}:${head} → ${repo.owner}:${base}.` }]);
  }
  const now = store.tick();
  const pull: Pull = {
    id: store.nextRecordId(),
    number: repo.nextNumber++,
    title: fields.title,
    body: fields.body ?? '',
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    head_ref: head,
    base_ref: base,
    head_sha: headSha,
    base_sha: baseSha,
    seq: store.nextSeq(),
    created_at: now,
    updated_at: now,
  };
  repo.pulls.push(pull);
  return pull;
}

/** Split text into lines the way diff counts them: a trailing newline ends the last line, it does not start a new one. */
function toLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Line counts of a text diff via a longest-common-subsequence pass (with a cheap fallback for huge files). */
export function lineDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = toLines(before);
  const b = toLines(after);
  if (a.length * b.length > 4_000_000) {
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
    return { additions: b.length - prefix - suffix, deletions: a.length - prefix - suffix };
  }
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  const common = previous[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

/** The file diff of a pull request: its base tip's tree against its head tip's tree. */
export function computePullFiles(repo: Repo, pull: Pull): PullFile[] {
  const baseSha = repo.refs.get(`refs/heads/${pull.base_ref}`) ?? pull.base_sha;
  const headSha = repo.refs.get(`refs/heads/${pull.head_ref}`) ?? pull.head_sha;
  const baseTree = treeOfCommit(repo, baseSha);
  const headTree = treeOfCommit(repo, headSha);
  const baseFiles = baseTree ? flattenTree(repo.objects, baseTree) : new Map<string, { mode: string; oid: string }>();
  const headFiles = headTree ? flattenTree(repo.objects, headTree) : new Map<string, { mode: string; oid: string }>();
  const files: PullFile[] = [];
  const paths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort();
  for (const path of paths) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before && after && before.oid === after.oid) continue;
    const beforeText = before ? (repo.objects.get(before.oid)?.data.toString('utf8') ?? '') : '';
    const afterText = after ? (repo.objects.get(after.oid)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = lineDiff(beforeText, afterText);
    files.push({
      filename: path,
      status: !before ? 'added' : !after ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: (after ?? before)!.oid,
    });
  }
  return files;
}

/** Merge a pull request into its base branch. Throws ApiError(405) when it cannot merge. */
export function mergePullRecord(repo: Repo, pull: Pull, method: string, commitTitle?: string, commitMessage?: string): { sha: string } {
  if (pull.state !== 'open') throw new ApiError(405, 'Pull Request is not mergeable');
  const baseRef = `refs/heads/${pull.base_ref}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(`refs/heads/${pull.head_ref}`) ?? pull.head_sha;
  if (!baseTip || !headTip) throw new ApiError(405, 'Pull Request is not mergeable');
  const baseCommit = peelToCommit(repo.objects, baseTip);
  const headCommit = peelToCommit(repo.objects, headTip);
  if (!baseCommit || !headCommit) throw new ApiError(405, 'Pull Request is not mergeable');
  const ancestor = mergeBase(repo.objects, baseCommit, headCommit);
  const ancestorTree = ancestor ? treeOfCommit(repo, ancestor) : null;
  const baseTree = treeOfCommit(repo, baseCommit);
  const headTree = treeOfCommit(repo, headCommit);
  if (!baseTree || !headTree) throw new ApiError(405, 'Pull Request is not mergeable');
  const mergedTree = mergeTrees(repo.objects, ancestorTree, baseTree, headTree);
  if (mergedTree === null) throw new ApiError(405, 'Pull Request is not mergeable');
  let sha: string;
  if (method === 'merge') {
    const message = commitTitle ?? `Merge pull request #${pull.number} from ${pull.head_ref}`;
    sha = commitWithTree(repo, mergedTree, [baseCommit, headCommit], commitMessage ? `${message}\n\n${commitMessage}` : message);
  } else {
    const title = commitTitle ?? pull.title;
    const message = commitMessage ?? pull.body;
    sha = commitWithTree(repo, mergedTree, [baseCommit], message ? `${title}\n\n${message}` : title);
  }
  repo.refs.set(baseRef, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = store.tick();
  pull.merge_commit_sha = sha;
  pull.updated_at = pull.merged_at;
  return { sha };
}

// ---------------------------------------------------------------------------
// repository-scoped handlers

function requireRepo(owner: string, name: string): Repo {
  const repo = store.getRepo(owner, name);
  if (!repo) throw notFound();
  return repo;
}

function repoRoot(res: ServerResponse, method: string, repo: Repo, body: Record<string, unknown>): void {
  if (method === 'GET') {
    sendJson(res, 200, repoJson(repo));
    return;
  }
  if (method === 'PATCH') {
    if (str(body.description) !== undefined) repo.description = str(body.description)!;
    if (typeof body.private === 'boolean') repo.private = body.private;
    if (str(body.name) !== undefined && str(body.name) !== repo.name) {
      const target = str(body.name)!;
      if (store.getRepo(repo.owner, target)) throw validationFailed('Repository creation failed.', [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }]);
      store.repos.delete(`${repo.owner}/${repo.name}`);
      repo.name = target;
      store.repos.set(`${repo.owner}/${repo.name}`, repo);
    }
    repo.updated_at = store.tick();
    sendJson(res, 200, repoJson(repo));
    return;
  }
  if (method === 'DELETE') {
    store.deleteRepo(repo.owner, repo.name);
    sendEmpty(res, 204);
    return;
  }
  throw notFound();
}

function resolveCommit(repo: Repo, ref: string | undefined): string | null {
  if (ref && isObjectId(ref) && repo.objects.has(ref)) return peelToCommit(repo.objects, ref);
  const name = ref ?? repo.default_branch;
  const oid = repo.refs.get(`refs/heads/${name}`) ?? repo.refs.get(name);
  if (!oid) return null;
  return peelToCommit(repo.objects, oid);
}

function contentsGet(res: ServerResponse, repo: Repo, path: string, url: URL): void {
  const commitOid = resolveCommit(repo, url.searchParams.get('ref') ?? undefined);
  if (!commitOid) throw notFound();
  const treeOid = treeOfCommit(repo, commitOid);
  if (!treeOid) throw notFound();
  if (path === '') {
    const tree = repo.objects.get(treeOid);
    const entries = parseTree(tree!.data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: entry.name,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    }));
    sendJson(res, 200, entries);
    return;
  }
  const segments = path.split('/');
  let currentTree = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const tree = repo.objects.get(currentTree);
    if (!tree || tree.type !== 'tree') throw notFound();
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) throw notFound();
    if (i === segments.length - 1) {
      if (entry.mode === '40000') {
        const dir = repo.objects.get(entry.oid);
        const entries = parseTree(dir!.data).map((child) => ({
          type: child.mode === '40000' ? 'dir' : 'file',
          name: child.name,
          path: `${path}/${child.name}`,
          sha: child.oid,
          size: child.mode === '40000' ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0),
        }));
        sendJson(res, 200, entries);
        return;
      }
      const blob = repo.objects.get(entry.oid);
      if (!blob) throw notFound();
      sendJson(res, 200, {
        type: 'file',
        name: entry.name,
        path,
        sha: entry.oid,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
      });
      return;
    }
    if (entry.mode !== '40000') throw notFound();
    currentTree = entry.oid;
  }
  throw notFound();
}

function branchTipForWrite(repo: Repo, branch: string): { refName: string; tip: string | null } {
  const refName = `refs/heads/${branch}`;
  const existing = repo.refs.get(refName);
  if (existing) return { refName, tip: existing };
  if (repo.refs.size === 0) {
    // An unborn repository: the first write lands on the default branch only.
    if (branch !== repo.default_branch) throw notFound();
    return { refName, tip: null };
  }
  // A contents write naming a new branch forks it from the default branch tip.
  const defaultTip = repo.refs.get(`refs/heads/${repo.default_branch}`);
  if (!defaultTip) throw notFound();
  return { refName, tip: defaultTip };
}

function contentsPut(res: ServerResponse, repo: Repo, path: string, body: Record<string, unknown>): void {
  if (path === '') throw validationFailed('Validation Failed', [{ resource: 'Contents', field: 'path', code: 'missing_field' }]);
  const content = str(body.content);
  if (content === undefined) throw validationFailed('Validation Failed', [{ resource: 'Contents', field: 'content', code: 'missing_field' }]);
  const message = str(body.message) ?? `Update ${path}`;
  const branch = str(body.branch) ?? repo.default_branch;
  const { refName, tip } = branchTipForWrite(repo, branch);
  const tipTree = tip ? treeOfCommit(repo, tip) : null;
  const files = tipTree ? flattenTree(repo.objects, tipTree) : new Map<string, { mode: string; oid: string }>();
  const existing = files.get(path);
  if (existing) {
    const sha = str(body.sha);
    if (sha === undefined) throw validationFailed('"sha" wasn\'t supplied.');
    if (sha !== existing.oid) throw new ApiError(409, `${path} sha ${sha} does not match ${existing.oid}`);
  }
  const data = Buffer.from(content.replace(/\s/g, ''), 'base64');
  const blobOid = putObject(repo.objects, 'blob', data);
  files.set(path, { mode: existing?.mode ?? '100644', oid: blobOid });
  const treeOid = buildTreeFromFiles(repo.objects, files);
  const commitOid = commitWithTree(repo, treeOid, tip ? [tip] : [], message);
  repo.refs.set(refName, commitOid);
  repo.updated_at = store.tick();
  sendJson(res, existing ? 200 : 201, {
    content: {
      type: 'file',
      name: path.split('/').pop(),
      path,
      sha: blobOid,
      size: data.length,
      encoding: 'base64',
    },
    commit: { sha: commitOid, message, tree: { sha: treeOid }, parents: tip ? [{ sha: tip }] : [] },
  });
}

function contentsDelete(res: ServerResponse, repo: Repo, path: string, body: Record<string, unknown>): void {
  const message = str(body.message) ?? `Delete ${path}`;
  const branch = str(body.branch) ?? repo.default_branch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (!tip) throw notFound();
  const tipTree = treeOfCommit(repo, tip);
  if (!tipTree) throw notFound();
  const files = flattenTree(repo.objects, tipTree);
  const existing = files.get(path);
  if (!existing) throw notFound();
  const sha = str(body.sha);
  if (sha !== undefined && sha !== existing.oid) throw new ApiError(409, `${path} sha ${sha} does not match ${existing.oid}`);
  files.delete(path);
  const treeOid = buildTreeFromFiles(repo.objects, files);
  const commitOid = commitWithTree(repo, treeOid, [tip], message);
  repo.refs.set(refName, commitOid);
  sendJson(res, 200, { content: null, commit: { sha: commitOid, message } });
}

function gitRefs(res: ServerResponse, method: string, repo: Repo, rest: string, body: Record<string, unknown>): void {
  if (method === 'POST' && rest === '') {
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref || !ref.startsWith('refs/') || !sha || !repo.objects.has(sha)) {
      throw validationFailed('Validation Failed', [{ resource: 'Reference', code: 'invalid' }]);
    }
    if (repo.refs.has(ref)) throw validationFailed('Reference already exists');
    repo.refs.set(ref, sha);
    const object = repo.objects.get(sha)!;
    sendJson(res, 201, { ref, node_id: globalId('Ref', `${repo.id}:${ref}`), object: { type: object.type, sha } });
    return;
  }
  if (method === 'GET' && rest !== '') {
    const ref = `refs/${rest}`;
    const sha = repo.refs.get(ref);
    if (!sha) throw notFound();
    const object = repo.objects.get(sha);
    sendJson(res, 200, { ref, node_id: globalId('Ref', `${repo.id}:${ref}`), object: { type: object?.type ?? 'commit', sha } });
    return;
  }
  throw notFound();
}

function branches(res: ServerResponse, method: string, repo: Repo, rest: string): void {
  if (method === 'GET' && rest === '') {
    const list = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(res, 200, list);
    return;
  }
  if (method === 'GET' && rest !== '') {
    const sha = repo.refs.get(`refs/heads/${rest}`);
    if (!sha) throw notFound();
    sendJson(res, 200, { name: rest, commit: { sha }, protected: false });
    return;
  }
  throw notFound();
}

function labels(res: ServerResponse, method: string, repo: Repo, body: Record<string, unknown>): void {
  if (method === 'GET') {
    sendJson(res, 200, repo.labels.map((label) => labelJson(repo, label.name)));
    return;
  }
  if (method === 'POST') {
    const name = str(body.name);
    if (!name) throw validationFailed('Validation Failed', [{ resource: 'Label', field: 'name', code: 'missing_field' }]);
    if (repo.labels.some((label) => label.name === name)) throw validationFailed('Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }]);
    const color = (str(body.color) ?? 'ededed').replace(/^#/, '').toLowerCase();
    repo.labels.push({ name, color, description: str(body.description) ?? null });
    sendJson(res, 201, labelJson(repo, name));
    return;
  }
  throw notFound();
}

function labelNamesOf(body: Record<string, unknown>): string[] {
  const raw = body.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

function issues(res: ServerResponse, method: string, url: URL, repo: Repo, rest: string, body: Record<string, unknown>): void {
  const segments = rest === '' ? [] : rest.split('/');
  if (segments.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const wantedLabels = (url.searchParams.get('labels') ?? '').split(',').filter(Boolean);
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      if (wantedLabels.length) list = list.filter((issue) => wantedLabels.every((name) => issue.labels.includes(name)));
      sendJson(res, 200, paginate(res, url, sortByCreation(list, url).map((issue) => issueJson(repo, issue))));
      return;
    }
    if (method === 'POST') {
      const title = str(body.title);
      if (!title) throw validationFailed('Validation Failed', [{ resource: 'Issue', field: 'title', code: 'missing_field' }]);
      const issue = createIssueRecord(repo, { title, body: str(body.body) ?? '', labels: labelNamesOf(body) });
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    throw notFound();
  }
  const number = Number.parseInt(segments[0], 10);
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (!issue) throw notFound();
  if (segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      if (str(body.title) !== undefined) issue.title = str(body.title)!;
      if (str(body.body) !== undefined) issue.body = str(body.body)!;
      if (Array.isArray(body.labels)) {
        const names = labelNamesOf(body);
        for (const name of names) {
          if (!repo.labels.some((label) => label.name === name)) throw validationFailed('Validation Failed', [{ resource: 'Issue', field: 'labels', code: 'invalid' }]);
        }
        issue.labels = names;
      }
      const state = str(body.state);
      if (state === 'open' || state === 'closed') issue.state = state;
      issue.updated_at = store.tick();
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    throw notFound();
  }
  if (segments.length === 2 && segments[1] === 'comments') {
    if (method === 'GET') {
      const list = [...issue.comments].sort((a, b) => a.id - b.id);
      sendJson(res, 200, paginate(res, url, list.map((comment) => commentJson(repo, issue, comment))));
      return;
    }
    if (method === 'POST') {
      const text = str(body.body);
      if (text === undefined) throw validationFailed('Validation Failed', [{ resource: 'IssueComment', field: 'body', code: 'missing_field' }]);
      const now = store.tick();
      const comment = { id: repo.nextCommentId++, body: text, seq: store.nextSeq(), created_at: now, updated_at: now };
      issue.comments.push(comment);
      issue.updated_at = now;
      sendJson(res, 201, commentJson(repo, issue, comment));
      return;
    }
  }
  throw notFound();
}

function commentJson(repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`),
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}

function pulls(res: ServerResponse, method: string, url: URL, repo: Repo, rest: string, body: Record<string, unknown>): void {
  const segments = rest === '' ? [] : rest.split('/');
  if (segments.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state || (state === 'closed' && pull.state === 'closed'));
      sendJson(res, 200, paginate(res, url, sortByCreation(list, url).map((pull) => pullJson(repo, pull))));
      return;
    }
    if (method === 'POST') {
      const title = str(body.title);
      const head = str(body.head);
      const base = str(body.base);
      if (!title || !head || !base) throw validationFailed('Validation Failed', [{ resource: 'PullRequest', code: 'missing_field' }]);
      const pull = createPullRecord(repo, { title, body: str(body.body) ?? '', head, base });
      sendJson(res, 201, pullJson(repo, pull));
      return;
    }
    throw notFound();
  }
  const number = Number.parseInt(segments[0], 10);
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (!pull) throw notFound();
  if (segments.length === 1 && method === 'GET') {
    sendJson(res, 200, pullJson(repo, pull));
    return;
  }
  if (segments.length === 2 && segments[1] === 'files' && method === 'GET') {
    const files = computePullFiles(repo, pull).map((file) => ({
      sha: file.sha,
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    sendJson(res, 200, paginate(res, url, files));
    return;
  }
  if (segments.length === 2 && segments[1] === 'merge' && method === 'PUT') {
    const methodName = str(body.merge_method) ?? 'merge';
    const { sha } = mergePullRecord(repo, pull, methodName, str(body.commit_title), str(body.commit_message));
    sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  throw notFound();
}

// commits (read-only history views)

function commits(res: ServerResponse, url: URL, repo: Repo): void {
  const ref = url.searchParams.get('sha') ?? undefined;
  const tip = resolveCommit(repo, ref);
  if (!tip) {
    sendJson(res, 200, []);
    return;
  }
  const ordered: Array<{ sha: string; message: string; tree: string; parents: string[] }> = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    ordered.push({ sha: oid, message: commit.message.replace(/\n$/, ''), tree: commit.tree, parents: commit.parents });
    queue.push(...commit.parents);
  }
  const list = ordered.map((entry) => ({
    sha: entry.sha,
    commit: { message: entry.message, tree: { sha: entry.tree } },
    parents: entry.parents.map((sha) => ({ sha })),
  }));
  sendJson(res, 200, paginate(res, url, list));
}

// ---------------------------------------------------------------------------
// the /api/v3 router

export function handleApiV3(req: IncomingMessage, res: ServerResponse, url: URL, body: Record<string, unknown>): void {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter(Boolean).slice(2).map((segment) => decodeURIComponent(segment));

  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    sendJson(res, 200, userJson());
    return;
  }
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      sendJson(res, 200, paginate(res, url, store.viewerRepos().map(repoJson)));
      return;
    }
    if (method === 'POST') {
      const name = str(body.name);
      if (!name) throw validationFailed('Repository creation failed.', [{ resource: 'Repository', field: 'name', code: 'missing_field' }]);
      if (store.getRepo(VIEWER.login, name)) {
        throw validationFailed('Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
      }
      const repo = store.createRepo(VIEWER.login, name, str(body.description) ?? '', body.private === true);
      sendJson(res, 201, repoJson(repo));
      return;
    }
    throw notFound();
  }
  if (segments.length >= 3 && segments[0] === 'repos') {
    const repo = requireRepo(segments[1], segments[2]);
    const rest = segments.slice(3);
    if (rest.length === 0) {
      repoRoot(res, method, repo, body);
      return;
    }
    const [head, ...tail] = rest;
    if (head === 'contents') {
      const path = tail.join('/');
      if (method === 'GET') contentsGet(res, repo, path, url);
      else if (method === 'PUT') contentsPut(res, repo, path, body);
      else if (method === 'DELETE') contentsDelete(res, repo, path, body);
      else throw notFound();
      return;
    }
    if (head === 'git' && tail[0] === 'refs') {
      gitRefs(res, method, repo, tail.slice(1).join('/'), body);
      return;
    }
    if (head === 'branches') {
      branches(res, method, repo, tail.join('/'));
      return;
    }
    if (head === 'labels' && tail.length === 0) {
      labels(res, method, repo, body);
      return;
    }
    if (head === 'issues') {
      issues(res, method, url, repo, tail.join('/'), body);
      return;
    }
    if (head === 'pulls') {
      pulls(res, method, url, repo, tail.join('/'), body);
      return;
    }
    if (head === 'commits' && tail.length === 0 && method === 'GET') {
      commits(res, url, repo);
      return;
    }
    throw notFound();
  }
  throw notFound();
}
