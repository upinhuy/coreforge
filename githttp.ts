// Git smart HTTP: the three endpoints under /{owner}/{repo}.git — info/refs
// advertisements (protocol v0 and v2), git-upload-pack (v2 ls-refs and fetch,
// plus a v0 fetch fallback) and git-receive-pack (v0, with report-status in
// sideband frames). Everything is pkt-line framed by hand; packs come from
// gitobj.ts. The handlers never throw at a request: a malformed body is an
// error answer, and the server keeps serving.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  buildPack,
  collectForFetch,
  isAncestor,
  isObjectId,
  parseTag,
  peelToCommit,
  readPack,
  type GitObject,
} from './gitobj.ts';
import type { Repo } from './store.ts';

const PKT_MAX_PAYLOAD = 65520 - 4;
const AGENT = 'coreforge/1.0';

/** Encode one pkt-line data packet. */
export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/**
 * Decode a pkt-line stream. With `stopAtFlush` (receive-pack) the first flush
 * ends the command list and the remaining raw bytes come back as `rest` (the
 * pack). Without it (upload-pack) every packet is decoded, since a v0 fetch
 * has a flush in the middle of its request.
 */
function decodePackets(buffer: Buffer, stopAtFlush = false): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length < 4 || offset + length > buffer.length) {
      break;
    } else {
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
    // A receive-pack body is: command packets, one flush, then the raw pack.
    if (stopAtFlush && packets.length && packets[packets.length - 1].kind === 'flush') {
      return { packets, rest: buffer.subarray(offset) };
    }
  }
  return { packets, rest: buffer.subarray(offset) };
}

function packetLines(packets: Packet[]): string[] {
  return packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8').replace(/\n$/, ''));
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendGitError(res: ServerResponse, status: number, message: string): void {
  sendBuffer(res, status, 'text/plain; charset=utf-8', Buffer.from(`${message}\n`, 'utf8'));
}

/** Every ref the repo advertises, sorted by name, with HEAD handled by the callers. */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.default_branch}`;
}

// ---------------------------------------------------------------------------
// info/refs

export function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string): void {
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  const contentType = `application/x-${service}-advertisement`;
  if (wantsV2) {
    const body = Buffer.concat([
      pkt('# service=git-upload-pack\n'),
      PKT_FLUSH,
      pkt('version 2\n'),
      pkt(`agent=${AGENT}\n`),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow wait-for-done\n'),
      pkt('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    sendBuffer(res, 200, contentType, body);
    return;
  }
  const capabilities =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:${headTarget(repo)} object-format=sha1`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:${headTarget(repo)}`;
  const lines: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(pkt(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    let first = true;
    const headOid = repo.refs.get(headTarget(repo));
    if (headOid) {
      lines.push(pkt(`${headOid} HEAD\0${capabilities}\n`));
      first = false;
    }
    for (const [name, oid] of refs) {
      lines.push(pkt(first ? `${oid} ${name}\0${capabilities}\n` : `${oid} ${name}\n`));
      first = false;
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') {
        const peeled = peelToCommit(repo.objects, oid);
        if (peeled) lines.push(pkt(`${peeled} ${name}^{}\n`));
      }
    }
  }
  lines.push(PKT_FLUSH);
  sendBuffer(res, 200, contentType, Buffer.concat(lines));
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)

function handleLsRefs(res: ServerResponse, repo: Repo, packets: Packet[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data' || !inArgs) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const headOid = repo.refs.get(headTarget(repo));
  if (matches('HEAD')) {
    if (headOid) {
      out.push(pkt(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    } else if (unborn) {
      out.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') {
        const peeled = peelToCommit(repo.objects, oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
    }
    out.push(pkt(`${line}\n`));
  }
  out.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

// ---------------------------------------------------------------------------
// fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

/** Wrap pack bytes in band-1 sideband packets of at most 65520 bytes each. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const chunkSize = PKT_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + chunkSize)])));
  }
  return out;
}

function handleFetchV2(res: ServerResponse, repo: Repo, packets: Packet[]): void {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data' || !inArgs) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'done') args.done = true;
  }
  const selection = collectForFetch(repo.objects, args.wants, args.haves, args.depth, args.shallow);
  const pack = buildPack(selection.objects);
  const out: Buffer[] = [];
  if (args.haves.length) {
    out.push(pkt('acknowledgments\n'));
    const common = args.haves.filter((have) => repo.objects.has(have));
    if (common.length === 0) out.push(pkt('NAK\n'));
    else for (const have of common) out.push(pkt(`ACK ${have}\n`));
    out.push(PKT_FLUSH);
  }
  if (args.depth !== null || selection.shallow.length || selection.unshallow.length) {
    out.push(pkt('shallow-info\n'));
    for (const oid of selection.shallow) out.push(pkt(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) out.push(pkt(`unshallow ${oid}\n`));
    out.push(PKT_FLUSH);
  }
  out.push(pkt('packfile\n'));
  out.push(...sidebandPackets(pack));
  out.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

function handleFetchV0(res: ServerResponse, repo: Repo, packets: Packet[]): void {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of packetLines(packets)) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) args.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'done') args.done = true;
  }
  const selection = collectForFetch(repo.objects, args.wants, args.haves, args.depth, args.shallow);
  const pack = buildPack(selection.objects);
  const out: Buffer[] = [pkt('NAK\n')];
  for (const oid of selection.shallow) out.push(pkt(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) out.push(pkt(`unshallow ${oid}\n`));
  out.push(...sidebandPackets(pack));
  out.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

export function handleUploadPack(res: ServerResponse, repo: Repo, body: Buffer): void {
  const { packets } = decodePackets(body);
  const firstData = packets.find((packet) => packet.kind === 'data');
  const firstLine = firstData ? firstData.payload.toString('utf8').replace(/\n$/, '') : '';
  try {
    if (firstLine === 'command=ls-refs') {
      handleLsRefs(res, repo, packets);
      return;
    }
    if (firstLine === 'command=fetch') {
      handleFetchV2(res, repo, packets);
      return;
    }
    // No command line: a protocol v0 fetch request.
    handleFetchV0(res, repo, packets);
  } catch {
    sendGitError(res, 400, 'bad fetch request');
  }
}

// ---------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(res: ServerResponse, repo: Repo, body: Buffer): void {
  const { packets, rest } = decodePackets(body, true);
  const lines = packetLines(packets);
  const commands: PushCommand[] = [];
  let capabilities = '';
  lines.forEach((raw, index) => {
    let line = raw;
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  });
  const useSideband = capabilities.split(' ').includes('side-band-64k');
  const reportStatus = capabilities.split(' ').includes('report-status') || capabilities.split(' ').includes('report-status-v2');

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      readPack(rest, repo.objects);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'error';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk) {
    for (const command of commands) {
      results.push(applyPushCommand(repo, command));
    }
  }

  if (!reportStatus) {
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  const reportLines: string[] = [`unpack ${unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  // The report is one pkt-line stream, terminated by its own flush. With
  // side-band-64k that whole stream travels inside band-1 packets (chunked as
  // needed), and a final bare flush ends the response — the exact framing
  // git's own receive-pack produces; without the inner flush a client waits
  // for more report lines forever.
  const reportStream = Buffer.concat([...reportLines.map((line) => pkt(line)), PKT_FLUSH]);
  const out: Buffer[] = [];
  if (useSideband) {
    const chunkSize = PKT_MAX_PAYLOAD - 1;
    for (let offset = 0; offset < reportStream.length; offset += chunkSize) {
      out.push(pkt(Buffer.concat([Buffer.from([1]), reportStream.subarray(offset, offset + chunkSize)])));
    }
    out.push(PKT_FLUSH);
  } else {
    out.push(reportStream);
  }
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(out));
}

function applyPushCommand(repo: Repo, command: PushCommand): { ref: string; ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = command;
  const fail = (reason: string) => ({ ref, ok: false, reason });
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return fail('invalid refname');
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    // A delete: the ref must exist at the value the client named.
    if (current === ZERO_OID) return fail('ref does not exist');
    if (oldOid !== ZERO_OID && oldOid !== current) return fail('stale info');
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }
  const target: GitObject | undefined = repo.objects.get(newOid);
  if (!target) return fail('invalid object');
  if (ref.startsWith('refs/heads/') && target.type !== 'commit') return fail('invalid object');
  if (ref.startsWith('refs/tags/') && target.type !== 'commit' && target.type !== 'tag') return fail('invalid object');
  if (current !== ZERO_OID) {
    if (oldOid !== current) return fail('stale info');
    const currentCommit = peelToCommit(repo.objects, current);
    const newCommit = peelToCommit(repo.objects, newOid);
    if (!currentCommit || !newCommit || !isAncestor(repo.objects, currentCommit, newCommit)) {
      return fail('non-fast-forward');
    }
  } else if (oldOid !== ZERO_OID) {
    return fail('stale info');
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true, reason: '' };
}
