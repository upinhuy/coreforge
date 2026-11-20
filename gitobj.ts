// The git object model, implemented in-process: SHA-1 object ids, commit / tree
// / blob / tag parsing and building, packfile reading (with OFS_DELTA and
// REF_DELTA resolution, including thin packs whose bases the repository already
// holds) and packfile writing, reachability walks with shallow-depth support,
// and the tree flatten / rebuild / three-way-merge helpers the REST surface
// builds on. Node's standard library only: node:crypto for SHA-1, node:zlib for
// the deflate streams inside packs. The system git binary is never invoked.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** git's object id: SHA-1 over `<type> <size>\0` followed by the raw bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object in a repo's object map and return its id. */
export function putObject(objects: Map<string, GitObject>, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------------------
// trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: truncated entry');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: by name bytes, directories compared as if named `name/`. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of [...entries].sort(compareTreeEntries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> {mode, oid}. */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const tree = objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [childPath, child] of flattenTree(objects, entry.oid, path)) out.set(childPath, child);
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

/** Build (and store) nested trees from a flat path -> {mode, oid} map; returns the root tree id. */
export function buildTreeFromFiles(objects: Map<string, GitObject>, files: Map<string, { mode: string; oid: string }>): string {
  interface Dir {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const segments = path.split('/');
    let dir = root;
    for (const segment of segments.slice(0, -1)) {
      let next = dir.dirs.get(segment);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    dir.files.set(segments[segments.length - 1], file);
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(sub) });
    return putObject(objects, 'tree', buildTree(entries));
  };
  return emit(root);
}

/**
 * A file-level three-way merge of two trees against their common ancestor's
 * tree. Returns the merged tree id, or null when both sides changed the same
 * path differently (a conflict the caller reports, never resolves silently).
 */
export function mergeTrees(
  objects: Map<string, GitObject>,
  baseTree: string | null,
  ourTree: string,
  theirTree: string,
): string | null {
  const base = baseTree ? flattenTree(objects, baseTree) : new Map<string, { mode: string; oid: string }>();
  const ours = flattenTree(objects, ourTree);
  const theirs = flattenTree(objects, theirTree);
  const merged = new Map<string, { mode: string; oid: string }>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean => x?.oid === y?.oid;
    if (same(o, t)) {
      if (o) merged.set(path, o);
    } else if (same(b, o)) {
      if (t) merged.set(path, t);
    } else if (same(b, t)) {
      if (o) merged.set(path, o);
    } else {
      return null;
    }
  }
  return buildTreeFromFiles(objects, merged);
}

// ---------------------------------------------------------------------------
// commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const header = data.subarray(0, blank < 0 ? data.length : blank).toString('utf8');
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  return view;
}

export function buildCommitBytes(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const header = data.subarray(0, blank < 0 ? data.length : blank).toString('utf8');
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') view.object = value;
    else if (key === 'type') view.type = value;
    else if (key === 'tag') view.tag = value;
    else if (key === 'tagger') view.tagger = value;
  }
  return view;
}

/** Peel a ref target through annotated tags to the commit it ultimately names (or null). */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// reachability

/** Every object reachable from `roots`, skipping ones the store does not hold. */
export function reachableAll(objects: Map<string, GitObject>, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or reachable from it through parents. */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') queue.push(...parseCommit(object.data).parents);
    else if (object.type === 'tag') queue.push(parseTag(object.data).object);
  }
  return false;
}

/** The best common ancestor of two commits (the one with the greatest generation), or null. */
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const generations = new Map<string, number>();
  const walk = (root: string): void => {
    const queue: Array<[string, number]> = [[root, 0]];
    while (queue.length) {
      const [oid, depth] = queue.pop()!;
      if ((generations.get(oid) ?? -1) >= depth) continue;
      generations.set(oid, depth);
      const object = objects.get(oid);
      if (object?.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push([parent, depth + 1]);
      }
    }
  };
  walk(a);
  const fromA = new Map(generations);
  generations.clear();
  walk(b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, depthB] of generations) {
    const depthA = fromA.get(oid);
    if (depthA === undefined) continue;
    const score = depthA + depthB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/**
 * The closure of `roots` as a shallow client actually holds it: a commit the
 * client marks shallow is held together with its tree, but its parents are
 * not — the walk must not cross a shallow boundary, or a deepen fetch would
 * wrongly conclude the client already has the history below the boundary.
 */
export function reachableWithShallow(objects: Map<string, GitObject>, roots: Iterable<string>, shallow: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!shallow.has(oid)) queue.push(...commit.parents);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

export interface FetchSelection {
  /** The objects to pack, in no significant order. */
  objects: GitObject[];
  /** Commits at the shallow boundary (their parents were cut by the depth). */
  shallow: string[];
  /** Client shallow commits that are no longer at the boundary. */
  unshallow: string[];
}

/**
 * Choose the objects a fetch response carries: the closure of `wants`, minus
 * the closure of `haves`, optionally cut at `depth` commits of history. The
 * depth walk is a breadth-first pass over commits so each commit's generation
 * is its shortest distance from a want; trees and blobs of an included commit
 * are always included whole.
 */
export function collectForFetch(
  objects: Map<string, GitObject>,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  clientShallow: readonly string[],
): FetchSelection {
  const haveClosure = reachableWithShallow(objects, haves, new Set(clientShallow));
  if (depth === null) {
    const wanted = reachableAll(objects, wants);
    const send = [...wanted].filter((oid) => !haveClosure.has(oid)).map((oid) => objects.get(oid)!);
    return { objects: send, shallow: [], unshallow: [] };
  }
  const included = new Set<string>();
  const boundary = new Set<string>();
  const includeTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop()!;
      if (included.has(oid)) continue;
      const object = objects.get(oid);
      if (!object) continue;
      included.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
  };
  // Breadth-first by commit generation; non-commit wants ride along at depth 1.
  const queue: Array<{ oid: string; generation: number }> = wants.map((oid) => ({ oid, generation: 1 }));
  const visitedCommits = new Map<string, number>();
  while (queue.length) {
    const { oid, generation } = queue.shift()!;
    const object = objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      const seenAt = visitedCommits.get(oid);
      if (seenAt !== undefined && seenAt <= generation) continue;
      visitedCommits.set(oid, generation);
      included.add(oid);
      const commit = parseCommit(object.data);
      includeTreeClosure(commit.tree);
      if (generation < depth) {
        for (const parent of commit.parents) queue.push({ oid: parent, generation: generation + 1 });
      } else if (commit.parents.length) {
        boundary.add(oid);
      }
    } else if (object.type === 'tag') {
      if (included.has(oid)) continue;
      included.add(oid);
      queue.push({ oid: parseTag(object.data).object, generation });
    } else if (object.type === 'tree') {
      includeTreeClosure(oid);
    } else {
      included.add(oid);
    }
  }
  const shallow = [...boundary];
  const unshallow = clientShallow.filter((oid) => included.has(oid) && !boundary.has(oid));
  const send = [...included].filter((oid) => !haveClosure.has(oid)).map((oid) => objects.get(oid)!);
  return { objects: send, shallow, unshallow };
}

// ---------------------------------------------------------------------------
// packfiles

/** Encode one object's pack header (type + size varint). */
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 pack of plain (non-delta) objects, with its SHA-1 trailer. */
export function buildPack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface RawPackEntry {
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  offset: number;
}

function readPackHeader(buffer: Buffer, start: number): { size: number; typeCode: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, typeCode: (first >> 4) & 0x07, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate the zlib stream at `offset`; returns its bytes and the offset past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (!result.engine.bytesWritten) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/**
 * Read a packfile into `into` (the repository's object map, which also supplies
 * bases for thin packs). Returns the ids the pack carried. Throws on any
 * structural problem; the caller turns that into an `unpack` failure.
 */
export function readPack(pack: Buffer, into: Map<string, GitObject>): string[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readPackHeader(pack, offset);
    offset = header.next;
    const entry: RawPackEntry = { typeCode: header.typeCode, size: header.size, data: Buffer.alloc(0), offset: entryOffset };
    if (header.typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (header.typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[header.typeCode]) {
      throw new Error(`unknown pack type code ${header.typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolved = new Map<number, GitObject & { oid: string }>();
  const resolve = (entry: RawPackEntry): GitObject & { oid: string } => {
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const inPack = raw.find((candidate) => candidate !== entry && resolved.get(candidate.offset)?.oid === entry.baseOid);
      let base: GitObject | undefined;
      if (inPack) base = resolve(inPack);
      else base = into.get(entry.baseOid!);
      if (!base) throw new Error(`ref-delta base ${entry.baseOid} is unavailable`);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const object = { type, data, oid: hashObject(type, data) };
    resolved.set(entry.offset, object);
    return object;
  };
  const ids: string[] = [];
  for (const entry of raw) {
    const object = resolve(entry);
    if (!into.has(object.oid)) into.set(object.oid, { type: object.type, data: object.data });
    ids.push(object.oid);
  }
  return ids;
}
