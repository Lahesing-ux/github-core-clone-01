// Git smart HTTP: protocol v2 (ls-refs, fetch) for upload-pack, protocol v0 for receive-pack.
//
// Everything is written here from the wire up: pkt-line framing, the capability advertisements, the
// packfile writer and reader, and the push report. There is no git binary anywhere, and the only
// dependencies are node:zlib and node:crypto.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildCommit, buildTree, getRepo, parseTree, putObject, type Repo } from './store.ts';

const ZERO_OID = '0'.repeat(40);
const AGENT = 'makefun-forge/1.0';

export interface GitHttpRequest {
  owner: string;
  repo: string;
  rest: string;
  method: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
  res: ServerResponse;
  authenticated: boolean;
}

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from(data.length + 4 >= 0x10000 ? '0000' : (data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

function decodePktLines(body: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      lines.push('FLUSH');
      offset += 4;
      continue;
    }
    if (length === 1) {
      lines.push('DELIM');
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) break;
    lines.push(body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, ''));
    offset += length;
  }
  return { lines, rest: body.subarray(offset) };
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'cache-control': 'no-cache, max-age=0, must-revalidate',
  });
  res.end(body);
}

// ---------------------------------------------------------------- object store helpers

interface Object { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }

function objectOf(repo: Repo, oid: string): Object | null {
  const found = repo.objects.get(oid);
  return found === undefined ? null : { type: found.type, data: found.data };
}

function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objectOf(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    const text = object.data.toString('utf8');
    for (const line of text.split('\n')) {
      if (line === '') break;
      if (!line.startsWith('parent ')) continue;
      const parent = line.slice(7);
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** Every object reachable from `tips`, stopping at any object in `exclude`. */
function reachableObjects(repo: Repo, tips: readonly string[], exclude: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const queue = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (out.has(oid) || exclude.has(oid)) continue;
    const object = objectOf(repo, oid);
    if (object === null) continue;
    out.add(oid);
    if (object.type === 'commit') {
      for (const line of object.data.toString('utf8').split('\n')) {
        if (line === '') break;
        if (line.startsWith('tree ')) queue.push(line.slice(5));
        else if (line.startsWith('parent ')) queue.push(line.slice(7));
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      const text = object.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match !== null) queue.push(match[1]);
    }
  }
  return out;
}

/** Objects reachable from `tips`, not walking past a commit named in `shallow` (a shallow boundary). */
function reachableObjectsShallow(repo: Repo, tips: readonly string[], shallow: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const queue = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (out.has(oid)) continue;
    const object = objectOf(repo, oid);
    if (object === null) continue;
    out.add(oid);
    if (object.type === 'commit') {
      for (const line of object.data.toString('utf8').split('\n')) {
        if (line === '') break;
        if (line.startsWith('tree ')) queue.push(line.slice(5));
        else if (line.startsWith('parent ') && !shallow.has(oid)) queue.push(line.slice(7));
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match !== null) queue.push(match[1]);
    }
  }
  return out;
}

/** The commits of a fetch at a limited depth: { commits, boundaries }. */
function walkCommitsDepth(repo: Repo, wants: readonly string[], depth: number): { commits: Set<string>; boundaries: Set<string> } {
  const commits = new Set<string>();
  const boundaries = new Set<string>();
  const seen = new Map<string, number>();
  const queue: { oid: string; level: number }[] = wants.map((oid) => ({ oid, level: 1 }));
  while (queue.length > 0) {
    const { oid, level } = queue.shift()!;
    const previous = seen.get(oid);
    if (previous !== undefined && previous <= level) continue;
    seen.set(oid, level);
    const object = objectOf(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    commits.add(oid);
    const parents: string[] = [];
    for (const line of object.data.toString('utf8').split('\n')) {
      if (line === '') break;
      if (line.startsWith('parent ')) parents.push(line.slice(7));
    }
    for (const parent of parents) {
      if (level + 1 > depth) boundaries.add(oid);
      else queue.push({ oid: parent, level: level + 1 });
    }
  }
  return { commits, boundaries };
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, 'commit' | 'tree' | 'blob' | 'tag'> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let byte = (remaining & 0x0f) | ((typeCode & 0x07) << 4);
  remaining = Math.floor(remaining / 16);
  if (remaining > 0) byte |= 0x80;
  bytes.push(byte);
  while (remaining > 0) {
    let next = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/** A packfile holding the given objects, uncompressed objects only (no deltas). */
export function writePack(objects: readonly { type: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const code = TYPE_CODE[object.type] ?? 3;
    parts.push(packObjectHeader(code, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

interface ParsedPackObject {
  offset: number;
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
  oid: string;
}

function readObjectAt(pack: Buffer, offset: number): { type: string; data: Buffer; next: number; baseOffset?: number; baseRef?: string } {
  let position = offset;
  let byte = pack[position];
  position += 1;
  const typeCode = (byte >> 4) & 0x7;
  let size = byte & 0x0f;
  let shift = 4;
  while ((byte & 0x80) !== 0) {
    byte = pack[position];
    position += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  if (typeCode === 6) {
    // ofs-delta: a negative offset varint.
    let value = pack[position];
    position += 1;
    let baseOffset = value & 0x7f;
    while ((value & 0x80) !== 0) {
      value = pack[position];
      position += 1;
      baseOffset = ((baseOffset + 1) << 7) + (value & 0x7f);
    }
    const inflated = inflateSync(pack.subarray(position), { info: true } as never) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    return { type: 'ofs-delta', data: inflated.buffer, next: position + inflated.engine.bytesWritten, baseOffset: offset - baseOffset };
  }
  if (typeCode === 7) {
    const baseRef = pack.subarray(position, position + 20).toString('hex');
    position += 20;
    const inflated = inflateSync(pack.subarray(position), { info: true } as never) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    return { type: 'ref-delta', data: inflated.buffer, next: position + inflated.engine.bytesWritten, baseRef };
  }
  const inflated = inflateSync(pack.subarray(position), { info: true } as never) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { type: CODE_TYPE[typeCode] ?? 'blob', data: inflated.buffer, next: position + inflated.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let position = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[position];
      position += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint();
  const targetLength = readVarint();
  const out = Buffer.alloc(targetLength);
  let written = 0;
  while (position < delta.length) {
    const opcode = delta[position];
    position += 1;
    if ((opcode & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if (opcode & 0x01) { copyOffset += delta[position]; position += 1; }
      if (opcode & 0x02) { copyOffset += delta[position] * 0x100; position += 1; }
      if (opcode & 0x04) { copyOffset += delta[position] * 0x10000; position += 1; }
      if (opcode & 0x08) { copyOffset += delta[position] * 0x1000000; position += 1; }
      if (opcode & 0x10) { copySize += delta[position]; position += 1; }
      if (opcode & 0x20) { copySize += delta[position] * 0x100; position += 1; }
      if (opcode & 0x40) { copySize += delta[position] * 0x10000; position += 1; }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (opcode !== 0) {
      delta.copy(out, written, position, position + opcode);
      written += opcode;
      position += opcode;
    } else {
      break;
    }
  }
  return out;
}

function hashGitObject(type: string, data: Buffer): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(type + ' ' + data.length + '\0', 'utf8'), data])).digest('hex');
}

/** Read every object of a pack, resolving deltas against the pack itself or the repository. */
export function readPackObjects(pack: Buffer, lookup: (oid: string) => { type: string; data: Buffer } | null): ParsedPackObject[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') return [];
  const count = pack.readUInt32BE(8);
  const byOffset = new Map<number, ParsedPackObject>();
  const byOid = new Map<string, ParsedPackObject>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    const entry = readObjectAt(pack, start);
    offset = entry.next;
    let type = entry.type;
    let data = entry.data;
    if (type === 'ofs-delta') {
      const base = byOffset.get(entry.baseOffset ?? -1);
      if (base === undefined) throw new Error('ofs-delta base is missing from the pack');
      type = base.type;
      data = applyDelta(base.data, data);
    } else if (type === 'ref-delta') {
      const base = byOid.get(entry.baseRef ?? '') ?? lookup(entry.baseRef ?? '');
      if (base === null) throw new Error('ref-delta base is missing');
      type = base.type;
      data = applyDelta(base.data, data);
    }
    const object: ParsedPackObject = { offset: start, type: type as ParsedPackObject['type'], data, oid: hashGitObject(type, data) };
    byOffset.set(start, object);
    byOid.set(object.oid, object);
  }
  return [...byOffset.values()];
}

// ---------------------------------------------------------------- advertisement

function capabilityList(repo: Repo, service: string): string[] {
  if (service === 'git-upload-pack') {
    return ['multi_ack_detailed', 'multi_ack', 'side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', 'no-progress', 'include-tag', 'agent=' + AGENT];
  }
  return ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'quiet', 'agent=' + AGENT];
}

function refsOf(repo: Repo): { name: string; oid: string; peeled?: string }[] {
  const out: { name: string; oid: string; peeled?: string }[] = [];
  const entries = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, oid] of entries) {
    const peeled = peel(repo, oid);
    out.push(peeled === null ? { name, oid } : { name, oid, peeled });
  }
  return out;
}

function peel(repo: Repo, oid: string): string | null {
  const object = objectOf(repo, oid);
  if (object === null || object.type !== 'tag') return null;
  for (const line of object.data.toString('utf8').split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) return line.slice(7);
  }
  return null;
}

function advertiseV0(repo: Repo, service: string, headTarget: string | null): Buffer {
  const refs = refsOf(repo);
  const caps = capabilityList(repo, service);
  if (service === 'git-upload-pack' && headTarget !== null) caps.push('symref=HEAD:' + headTarget);
  const parts: Buffer[] = [];
  parts.push(pktLine('# service=' + service + '\n'));
  parts.push(FLUSH);
  if (refs.length === 0) {
    parts.push(pktLine(ZERO_OID + ' capabilities^{}\0' + caps.join(' ') + '\n'));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  refs.forEach((ref, index) => {
    const suffix = index === 0 ? '\0' + caps.join(' ') : '';
    parts.push(pktLine(ref.oid + ' ' + ref.name + suffix + '\n'));
    if (ref.peeled !== undefined) parts.push(pktLine(ref.peeled + ' ' + ref.name + '^{}\n'));
  });
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function advertiseV2(repo: Repo): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('agent=' + AGENT + '\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ]);
}

// ---------------------------------------------------------------- services

function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  for (const line of lines) {
    if (line === 'FLUSH' || line === 'DELIM') continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  for (const ref of refsOf(repo)) {
    if (!keep(ref.name)) continue;
    let line = ref.oid + ' ' + ref.name;
    if (peel && ref.peeled !== undefined) line += ' peeled:' + ref.peeled;
    parts.push(pktLine(line + '\n'));
  }
  if (keep('HEAD')) {
    const head = repo.refs.get('refs/heads/' + repo.defaultBranch);
    const target = 'refs/heads/' + repo.defaultBranch;
    if (head === undefined) {
      if (prefixes.length === 0) parts.push(pktLine('unborn HEAD' + (symrefs ? ' symref-target:' + target : '') + '\n'));
    } else {
      parts.push(pktLine(head + ' HEAD' + (symrefs ? ' symref-target:' + target : '') + '\n'));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function sidebandPackets(pack: Buffer, res: ServerResponse): void {
  const CHUNK = 60_000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    res.write(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
}

function handleFetchV2(repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let deepenSince: number | null = null;
  for (const line of lines) {
    if (line === 'FLUSH' || line === 'DELIM' || line === 'done' || line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta' || line === 'include-tag') continue;
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) deepenSince = Number(line.slice(13).trim());
  }
  const exclude = new Set<string>();
  const shallowSet = new Set(shallow);
  for (const have of haves) for (const oid of reachableObjectsShallow(repo, [have], shallowSet)) exclude.add(oid);

  const included = new Set<string>();
  let boundaries = new Set<string>();
  if (depth !== null && depth > 0) {
    const walk = walkCommitsDepth(repo, wants, depth);
    boundaries = walk.boundaries;
    const cut = new Set<string>();
    for (const boundary of walk.boundaries) {
      const object = objectOf(repo, boundary);
      if (object === null) continue;
      for (const line of object.data.toString('utf8').split('\n')) {
        if (line === '') break;
        if (line.startsWith('parent ')) cut.add(line.slice(7));
      }
    }
    for (const oid of reachableObjects(repo, [...walk.commits], cut)) included.add(oid);
  } else {
    for (const oid of reachableObjects(repo, wants, new Set())) included.add(oid);
  }
  if (deepenSince !== null) {
    for (const oid of [...included]) included.delete(oid);
    for (const oid of reachableObjects(repo, wants, new Set())) included.add(oid);
  }
  for (const oid of exclude) included.delete(oid);

  const objects: { type: string; data: Buffer }[] = [];
  for (const oid of included) {
    const object = objectOf(repo, oid);
    if (object !== null) objects.push(object);
  }
  objects.sort((a, b) => {
    const rank = (type: string): number => (type === 'commit' ? 0 : type === 'tree' ? 1 : 2);
    return rank(a.type) - rank(b.type);
  });

  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(FLUSH);

  const shallowLines: string[] = [];
  const previous = new Set(shallow);
  for (const oid of previous) if (!boundaries.has(oid)) shallowLines.push('unshallow ' + oid);
  for (const oid of boundaries) if (!previous.has(oid)) shallowLines.push('shallow ' + oid);
  if (shallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of shallowLines) parts.push(pktLine(line + '\n'));
    parts.push(FLUSH);
  }

  parts.push(pktLine('packfile\n'));
  const pack = writePack(objects);
  const CHUNK = 60_000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, Math.min(offset + CHUNK, pack.length))])));
  }
  parts.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from('counting objects: ' + objects.length + '\n', 'utf8')])));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { lines, rest } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  lines.forEach((line, index) => {
    if (line === 'FLUSH' || line === 'DELIM') return;
    let text = line;
    if (index === 0) {
      const nul = text.indexOf('\u0000');
      if (nul >= 0) {
        const caps = text.slice(nul + 1).split(' ').filter(Boolean);
        sideband = caps.includes('side-band-64k');
        text = text.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (match !== null) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  });

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const objects = readPackObjects(rest, (oid) => objectOf(repo, oid));
      for (const object of objects) putObject(repo, object.type, object.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const report: Buffer[] = [];
  report.push(pktLine('unpack ' + (unpackOk ? 'ok' : 'error ' + unpackDetail) + '\n'));
  if (unpackOk) {
    for (const command of commands) {
      const existing = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        if (existing === undefined) report.push(pktLine('ok ' + command.ref + '\n'));
        else {
          repo.refs.delete(command.ref);
          report.push(pktLine('ok ' + command.ref + '\n'));
        }
        continue;
      }
      if (existing !== undefined && existing !== command.oldOid) {
        report.push(pktLine('ng ' + command.ref + ' stale info\n'));
        continue;
      }
      if (existing !== undefined && !isAncestor(repo, existing, command.newOid)) {
        report.push(pktLine('ng ' + command.ref + ' non-fast-forward\n'));
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        report.push(pktLine('ng ' + command.ref + ' missing object\n'));
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push(pktLine('ok ' + command.ref + '\n'));
    }
  }
  report.push(FLUSH);
  const inner = Buffer.concat(report);
  if (!sideband) return inner;
  const out: Buffer[] = [];
  const CHUNK = 60_000;
  for (let offset = 0; offset < inner.length; offset += CHUNK) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(offset, Math.min(offset + CHUNK, inner.length))])));
  }
  out.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from('unpacking\n', 'utf8')])));
  out.push(FLUSH);
  return Buffer.concat(out);
}

export function handleGit(request: GitHttpRequest): void {
  const { owner, repo: name, rest, method, res } = request;
  const repo = getRepo(owner, name);
  if (repo === null) {
    send(res, 404, 'text/plain; charset=utf-8', Buffer.from('repository not found\n', 'utf8'));
    return;
  }
  const path = rest.split('?')[0];

  if (method === 'GET' && path === '/info/refs') {
    const service = request.query.get('service') ?? '';
    const version = request.headers['git-protocol'];
    const wantsV2 = typeof version === 'string' && /version=2/.test(version);
    if (service === 'git-upload-pack') {
      if (wantsV2) return void send(res, 200, 'application/x-git-upload-pack-advertisement', advertiseV2(repo));
      const head = repo.refs.has('refs/heads/' + repo.defaultBranch) ? 'refs/heads/' + repo.defaultBranch : null;
      return void send(res, 200, 'application/x-git-upload-pack-advertisement', advertiseV0(repo, service, head));
    }
    if (service === 'git-receive-pack') {
      const head = repo.refs.has('refs/heads/' + repo.defaultBranch) ? 'refs/heads/' + repo.defaultBranch : null;
      return void send(res, 200, 'application/x-git-receive-pack-advertisement', advertiseV0(repo, service, head));
    }
    send(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad service\n', 'utf8'));
    return;
  }

  if (method === 'POST' && path === '/git-upload-pack') {
    const version = request.headers['git-protocol'];
    const wantsV2 = typeof version === 'string' && /version=2/.test(version);
    try {
      const { lines } = decodePktLines(request.body);
      if (wantsV2) {
        const command = lines.find((line) => line.startsWith('command=')) ?? '';
        if (command === 'command=ls-refs') return void send(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, lines));
        if (command === 'command=fetch') return void send(res, 200, 'application/x-git-upload-pack-result', handleFetchV2(repo, lines));
        return void send(res, 200, 'application/x-git-upload-pack-result', FLUSH);
      }
      return void send(res, 200, 'application/x-git-upload-pack-result', handleFetchV0(repo, lines));
    } catch {
      send(res, 200, 'application/x-git-upload-pack-result', FLUSH);
      return;
    }
  }

  if (method === 'POST' && path === '/git-receive-pack') {
    try {
      return void send(res, 200, 'application/x-git-receive-pack-result', handleReceivePack(repo, request.body));
    } catch {
      const report = Buffer.concat([pktLine('unpack error bad pack\n'), FLUSH]);
      send(res, 200, 'application/x-git-receive-pack-result', report);
      return;
    }
  }

  send(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found\n', 'utf8'));
}

/** v0 upload-pack: wants then haves, answered with the same pack, sideband-framed. */
function handleFetchV0(repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0].trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const exclude = new Set<string>();
  for (const have of haves) for (const oid of reachableObjects(repo, [have], new Set())) exclude.add(oid);
  const included = reachableObjects(repo, wants, new Set());
  for (const oid of exclude) included.delete(oid);
  const objects: { type: string; data: Buffer }[] = [];
  for (const oid of included) {
    const object = objectOf(repo, oid);
    if (object !== null) objects.push(object);
  }
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  const pack = writePack(objects);
  const CHUNK = 60_000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, Math.min(offset + CHUNK, pack.length))])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
