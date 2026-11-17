// The forge's store: git objects, refs, and the REST resources built on them.
//
// One process holds every repository in memory; a trial is a fresh process, so nothing persists.
// Object ids are SHA-1 over the git header + bytes, exactly as git computes them, and every tree and
// commit this server writes is byte-identical to what git would write for the same data.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- identity

/** The login the trial token belongs to (the suite's seeded viewer). */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const DEFAULT_BRANCH = 'main';

/** Every server-side timestamp comes from here, never from a clock: two runs must agree. */
const BASE_EPOCH_SEC = 1_766_000_000;

let timeTick = 0;

/** A deterministic, monotonically increasing ISO-8601 instant for commits and resources. */
export function nextInstant(): string {
  const env = process.env.MAKEFUN_TRIAL_NOW;
  let base = BASE_EPOCH_SEC;
  if (env !== undefined && env !== '') {
    const parsed = Date.parse(env);
    if (Number.isFinite(parsed)) base = Math.floor(parsed / 1000);
  }
  const seconds = base + timeTick;
  timeTick += 1;
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------- git object model

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const HEADERS: Record<GitObjectType, string> = {
  blob: 'blob',
  tree: 'tree',
  commit: 'commit',
  tag: 'tag',
};

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(HEADERS[type] + ' ' + data.length + '\0', 'utf8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

export function hashBlob(data: Buffer): string {
  return hashObject('blob', data);
}

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
    if (space === -1) break;
    const nul = data.indexOf(0x00, space);
    if (nul === -1) break;
    const mode = data.subarray(offset, space).toString('latin1');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  // git orders entries by name, with a tree's name compared as if it ended in '/'.
  return entry.mode === '40000' ? entry.name + '/' : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(entry.mode + ' ' + entry.name + '\0', 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitIdentity {
  name: string;
  email: string;
  /** Seconds since the epoch, as git stores them. */
  seconds: number;
  /** The timezone offset git stores, e.g. +0000. */
  offset: string;
}

export function formatIdentity(identity: CommitIdentity): string {
  return identity.name + ' <' + identity.email + '> ' + identity.seconds + ' ' + identity.offset;
}

export function parseIdentityLine(line: string): CommitIdentity {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: '', email: '', seconds: 0, offset: '+0000' };
  return { name: match[1], email: match[2], seconds: Number(match[3]), offset: match[4] };
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: CommitIdentity;
  committer: CommitIdentity;
  message: string;
  /** The raw header block, for a tag or a re-encode. */
  extra: string[];
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const commit: ParsedCommit = {
    tree: '',
    parents: [],
    author: { name: '', email: '', seconds: 0, offset: '+0000' },
    committer: { name: '', email: '', seconds: 0, offset: '+0000' },
    message,
    extra: [],
  };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5);
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7));
    else if (line.startsWith('author ')) commit.author = parseIdentityLine(line.slice(7));
    else if (line.startsWith('committer ')) commit.committer = parseIdentityLine(line.slice(10));
    else if (line !== '') commit.extra.push(line);
  }
  return commit;
}

export interface CommitInput {
  tree: string;
  parents: string[];
  author: CommitIdentity;
  committer: CommitIdentity;
  message: string;
  extra?: string[];
}

export function buildCommit(input: CommitInput): Buffer {
  const lines: string[] = ['tree ' + input.tree];
  for (const parent of input.parents) lines.push('parent ' + parent);
  lines.push('author ' + formatIdentity(input.author));
  lines.push('committer ' + formatIdentity(input.committer));
  for (const line of input.extra ?? []) lines.push(line);
  const text = lines.join('\n') + '\n\n' + (input.message.endsWith('\n') ? input.message : input.message + '\n');
  return Buffer.from(text, 'utf8');
}

// ---------------------------------------------------------------- resources

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  user: typeof VIEWER | { id: number; login: string; name: string; email: string };
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
  comments: Comment[];
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  sha: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  files: PullFile[];
  seq: number;
}

export interface Repo {
  owner: string;
  name: string;
  private: boolean;
  description: string;
  createdAt: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  defaultBranch: string;
}

const repos = new Map<string, Repo>();
let repoSeq = 0;

function repoKey(owner: string, name: string): string {
  return owner.toLowerCase() + '/' + name.toLowerCase();
}

export function isViewer(login: string): boolean {
  return login.toLowerCase() === VIEWER.login;
}

export function createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
  if (!isViewer(owner)) return null;
  const key = repoKey(owner, name);
  if (repos.has(key)) return null;
  const repo: Repo = {
    owner: VIEWER.login,
    name,
    private: isPrivate,
    description,
    createdAt: nextInstant(),
    seq: repoSeq++,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextIssue: 1,
    nextPull: 1,
    nextComment: 1,
    defaultBranch: DEFAULT_BRANCH,
  };
  repos.set(key, repo);
  return repo;
}

export function getRepo(owner: string, name: string): Repo | null {
  if (!isViewer(owner)) return null;
  return repos.get(repoKey(owner, name)) ?? null;
}

export function deleteRepo(owner: string, name: string): boolean {
  if (!isViewer(owner)) return false;
  return repos.delete(repoKey(owner, name));
}

export function listRepos(): Repo[] {
  return [...repos.values()].sort((a, b) => a.seq - b.seq);
}

// ---------------------------------------------------------------- object access

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  const existing = repo.objects.get(oid);
  if (existing === undefined) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | null {
  return repo.objects.get(oid) ?? null;
}

export function hasObject(repo: Repo, oid: string): boolean {
  return repo.objects.has(oid);
}

export function readTree(repo: Repo, oid: string): TreeEntry[] {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data);
}

export function readCommit(repo: Repo, oid: string): ParsedCommit | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

/** A tree written from a nested path map: every directory is a tree, every leaf a blob. */
export function writeTreeFromFiles(repo: Repo, files: ReadonlyMap<string, Buffer>): string {
  interface Node {
    files: Map<string, Buffer>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, data] of files) {
    const segments = path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) continue;
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index];
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1], data);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, data] of node.files) entries.push({ mode: '100644', name, oid: putObject(repo, 'blob', data) });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Every file reachable from a tree, keyed by its slash-separated path. */
export function readFiles(repo: Repo, treeOid: string, prefix = '', out = new Map<string, Buffer>()): Map<string, Buffer> {
  for (const entry of readTree(repo, treeOid)) {
    const path = prefix === '' ? entry.name : prefix + '/' + entry.name;
    if (entry.mode === '40000') readFiles(repo, entry.oid, path, out);
    else {
      const object = repo.objects.get(entry.oid);
      if (object !== undefined) out.set(path, object.data);
    }
  }
  return out;
}

/** Walk a tree by path and answer the entry, or null. */
export function lookupPath(repo: Repo, treeOid: string, path: string): { entry: TreeEntry; tree: TreeEntry[] } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  let entries = readTree(repo, current);
  let found: TreeEntry | null = null;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const entry = entries.find((candidate) => candidate.name === segment);
    if (entry === undefined) return null;
    if (index === segments.length - 1) {
      found = entry;
      break;
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
    entries = readTree(repo, current);
  }
  if (found === null) return null;
  return { entry: found, tree: entries };
}

/** Resolve a branch/ref/oid to a commit id: a full ref, a branch name, a 40-hex sha, or HEAD. */
export function resolveRev(repo: Repo, rev: string | null | undefined): string | null {
  const text = (rev ?? '').trim();
  if (text === '' || text === 'HEAD') return repo.refs.get('refs/heads/' + repo.defaultBranch) ?? null;
  if (text.startsWith('refs/')) return repo.refs.get(text) ?? null;
  if (/^[0-9a-f]{40}$/i.test(text)) return repo.objects.has(text) ? text : null;
  if (/^[0-9a-f]{4,39}$/i.test(text)) {
    const matches = [...repo.objects.keys()].filter((oid) => oid.startsWith(text.toLowerCase()));
    return matches.length === 1 ? matches[0] : null;
  }
  const head = repo.refs.get('refs/heads/' + text);
  if (head !== undefined) return head;
  return repo.refs.get('refs/tags/' + text) ?? null;
}

/** The commit ancestry of a tip, newest first, following every parent (bounded). */
export function commitLog(repo: Repo, tip: string | null, limit = 1000): string[] {
  if (tip === null) return [];
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [tip];
  while (queue.length > 0 && order.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = readCommit(repo, oid);
    if (commit === null) continue;
    order.push(oid);
    for (const parent of commit.parents) if (!seen.has(parent)) queue.push(parent);
  }
  return order;
}

/** The first-parent chain, the order a log shows. */
export function firstParentLog(repo: Repo, tip: string | null, limit = 1000): string[] {
  const order: string[] = [];
  let current = tip;
  while (current !== null && order.length < limit) {
    const commit = readCommit(repo, current);
    if (commit === null) break;
    order.push(current);
    current = commit.parents[0] ?? null;
  }
  return order;
}

/** Every ancestor of a tip, including it. */
export function ancestors(repo: Repo, tip: string | null): Set<string> {
  return new Set(commitLog(repo, tip, 100_000));
}

/** The newest commit reachable from both tips, or null when they are unrelated. */
export function mergeBase(repo: Repo, left: string | null, right: string | null): string | null {
  if (left === null || right === null) return null;
  const rightAncestors = ancestors(repo, right);
  if (rightAncestors.has(left)) return left;
  for (const oid of commitLog(repo, left, 100_000)) if (rightAncestors.has(oid)) return oid;
  return null;
}

/** The tree of a commit, or null. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  if (!/^[0-9a-f]{40}$/.test(commitOid)) return null;
  const object = repo.objects.get(commitOid);
  if (object !== undefined && object.type === 'tree') return commitOid;
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** The tree a rev names: a commit's tree, or the tree itself. */
export function treeOfRev(repo: Repo, rev: string | null | undefined): string | null {
  const oid = resolveRev(repo, rev);
  if (oid === null) return null;
  return commitTree(repo, oid);
}

export function nowIso(): string {
  return nextInstant();
}
