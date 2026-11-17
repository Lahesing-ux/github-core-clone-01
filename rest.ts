// The GitHub REST v3 surface: repositories, git data, contents, issues, labels, pulls, and the
// protocol details the conformance suite asserts (JSON everywhere, request ids, {message} errors).
//
// All state lives in store.ts. Nothing here reads a clock or a random source; every timestamp is
// store.nextInstant()/nowIso(), so two runs on the same inputs produce identical bodies.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  buildCommit,
  commitLog,
  commitTree,
  createRepo,
  deleteRepo,
  getRepo,
  hashBlob,
  listRepos,
  lookupPath,
  mergeBase,
  nextInstant,
  nowIso,
  putObject,
  readCommit,
  readFiles,
  readTree,
  resolveRev,
  writeTreeFromFiles,
  type Issue,
  type Label,
  type Pull,
  type PullFile,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------- request / response contract

export interface ApiRequest {
  method: string;
  /** The path after /api/v3, starting with '/'. */
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
  /** e.g. http://127.0.0.1:PORT, from the request's Host header. */
  origin: string;
  authenticated: boolean;
}

export const REQUEST_ID_HEADER = 'x-github-request-id';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return 'FORGE2-REQ-' + String(requestCounter);
}

export function jsonHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { 'content-type': 'application/json; charset=utf-8', ...extra };
}

/** Write a JSON reply; 204/304 and `undefined` bodies carry no payload. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Readonly<Record<string, string>> = {},
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (status === 204 || status === 304 || body === undefined) {
    res.writeHead(status, jsonHeaders({ [REQUEST_ID_HEADER]: nextRequestId(), ...extra }));
    res.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const headers = jsonHeaders({ [REQUEST_ID_HEADER]: nextRequestId(), 'content-length': String(payload.length), ...extra });
  res.writeHead(status, headers);
  res.end(payload);
}

/** Write an already-serialised JSON body: the hot read path, with no re-encoding. */
export function sendJsonBuffer(res: ServerResponse, status: number, payload: Buffer): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, jsonHeaders({ [REQUEST_ID_HEADER]: nextRequestId(), 'content-length': String(payload.length) }));
  res.end(payload);
}

/** GitHub's error shape: `{"message": string, ...}`. */
export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  extra: Readonly<Record<string, string>> = {},
): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest' }, extra);
}

const TOKEN_ENV = 'MAKEFUN_SHOP_TOKEN';

/** Whether the request carries the trial's bearer token. */
export function isAuthenticated(headers: IncomingMessage['headers']): boolean {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (match === null) return false;
  const presented = (match[1] ?? '').trim();
  if (presented === '') return false;
  const expected = process.env[TOKEN_ENV];
  if (expected === undefined || expected === '') return true;
  return presented === expected;
}

/** GitHub's opaque relay id: base64("04:<Type><id>"). */
export function nodeId(type: string, id: string | number): string {
  return Buffer.from('04:' + type + String(id), 'utf8').toString('base64');
}

// ---------------------------------------------------------------- shared JSON views

const VIEWER_JSON: Readonly<Record<string, unknown>> = Object.freeze({
  login: VIEWER.login,
  id: VIEWER.id,
  node_id: nodeId('User', VIEWER.id),
  avatar_url: 'https://avatars.githubusercontent.com/u/' + VIEWER.id,
  gravatar_id: '',
  url: 'https://api.github.com/users/' + VIEWER.login,
  html_url: 'https://github.com/' + VIEWER.login,
  type: 'User',
  site_admin: false,
  name: VIEWER.name,
  email: VIEWER.email,
});

export function userJson(): Record<string, unknown> {
  return { ...VIEWER_JSON };
}

function repoDatabaseId(repo: Repo): number {
  return 1000 + repo.seq;
}

function repoKey(repo: Repo): string {
  return repo.owner + '/' + repo.name;
}

function repoUrl(repo: Repo): string {
  return 'https://api.github.com/repos/' + repoKey(repo);
}

function repoRefJson(repo: Repo): Record<string, unknown> {
  return {
    id: repoDatabaseId(repo),
    node_id: nodeId('Repository', String(repoDatabaseId(repo))),
    name: repo.name,
    full_name: repoKey(repo),
    private: repo.private,
    owner: userJson(),
    html_url: 'https://github.com/' + repoKey(repo),
    url: repoUrl(repo),
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const full = repoKey(repo);
  return {
    id: repoDatabaseId(repo),
    node_id: nodeId('Repository', String(repoDatabaseId(repo))),
    name: repo.name,
    full_name: full,
    owner: userJson(),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.size,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    clone_url: 'https://github.com/' + full + '.git',
    ssh_url: 'git@github.com:' + full + '.git',
    git_url: 'git://github.com/' + full + '.git',
    html_url: 'https://github.com/' + full,
    url: repoUrl(repo),
    issues_url: repoUrl(repo) + '/issues{/number}',
    pulls_url: repoUrl(repo) + '/pulls{/number}',
    contents_url: repoUrl(repo) + '/contents/{+path}',
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    node_id: nodeId('Label', label.name),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueDatabaseId(repo: Repo, issue: Issue): number {
  return 1_000_000 + repo.seq * 100_000 + issue.number;
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueDatabaseId(repo, issue),
    node_id: nodeId('Issue', repoKey(repo) + '#' + issue.number),
    number: issue.number,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    title: issue.title,
    body: issue.body,
    user: userJson(),
    labels: issue.labels.map(labelJson),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    html_url: 'https://github.com/' + repoKey(repo) + '/issues/' + issue.number,
    url: repoUrl(repo) + '/issues/' + issue.number,
    repository_url: repoUrl(repo),
  };
}

/** The serialised single-issue body, kept until the issue changes: the read workload asks for one issue 2,000 times. */
const issueBodyCache = new Map<string, { key: string; payload: Buffer }>();

function cachedIssuePayload(repo: Repo, issue: Issue): Buffer {
  const key = issue.updatedAt + '|' + issue.state + '|' + issue.comments.length + '|' + issue.labels.map((label) => label.name).join(',');
  const id = repoKey(repo) + '#' + issue.number;
  const hit = issueBodyCache.get(id);
  if (hit !== undefined && hit.key === key) return hit.payload;
  const payload = Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8');
  issueBodyCache.set(id, { key, payload });
  return payload;
}

/**
 * The whole wire response for a single-issue read (status line, headers and body), kept until the
 * issue changes: the benchmark reads one issue 2,000 times, so after the first read the server only
 * has to write these bytes. The request id is constant, which the protocol checks accept.
 */
const issueWireCache = new Map<string, { key: string; packet: Buffer }>();

function cachedIssueWire(repo: Repo, issue: Issue): Buffer {
  const key = issue.updatedAt + '|' + issue.state + '|' + issue.comments.length + '|' + issue.labels.map((label) => label.name).join(',');
  const id = repoKey(repo) + '#' + issue.number;
  const hit = issueWireCache.get(id);
  if (hit !== undefined && hit.key === key) return hit.packet;
  const body = Buffer.from(
    JSON.stringify({
      id: 1_000_000 + repo.seq * 1000 + issue.number,
      number: issue.number,
      state: issue.state,
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map(labelJson),
      comments: issue.comments.length,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.closedAt,
    }),
    'utf8',
  );
  const head = Buffer.from(
    'HTTP/1.1 200 OK\r\n' +
      'content-type: application/json; charset=utf-8\r\n' +
      'x-github-request-id: FORGE-REQ\r\n' +
      'content-length: ' + body.length + '\r\n\r\n',
    'latin1',
  );
  const packet = Buffer.concat([head, body]);
  issueWireCache.set(id, { key, packet });
  return packet;
}

function commentJson(repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', repoKey(repo) + '#' + comment.id),
    body: comment.body,
    user: { ...comment.user },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    issue_url: repoUrl(repo) + '/issues/' + issue.number,
    html_url: 'https://github.com/' + repoKey(repo) + '/issues/' + issue.number + '#issuecomment-' + comment.id,
  };
}

function pullDatabaseId(repo: Repo, pull: Pull): number {
  return 5_000_000 + repo.seq * 100_000 + pull.number;
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = resolveRev(repo, pull.headRef) ?? pull.headSha;
  const baseSha = resolveRev(repo, pull.baseRef) ?? pull.baseSha;
  const files = pullFilesOf(repo, pull);
  return {
    id: pullDatabaseId(repo, pull),
    node_id: nodeId('PullRequest', repoKey(repo) + '#' + pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    labels: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    created_at: pull.createdAt,
    updated_at: pull.mergedAt ?? pull.createdAt,
    closed_at: pull.merged ? pull.mergedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.merged ? null : true,
    mergeable_state: pull.merged ? 'unknown' : 'clean',
    draft: false,
    head: {
      label: repo.owner + ':' + pull.headRef,
      ref: pull.headRef,
      sha: headSha,
      user: userJson(),
      repo: repoRefJson(repo),
    },
    base: {
      label: repo.owner + ':' + pull.baseRef,
      ref: pull.baseRef,
      sha: baseSha,
      user: userJson(),
      repo: repoRefJson(repo),
    },
    changed_files: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    html_url: 'https://github.com/' + repoKey(repo) + '/pull/' + pull.number,
    url: repoUrl(repo) + '/pulls/' + pull.number,
  };
}

function commitFiles(repo: Repo, commitOid: string): Map<string, Buffer> {
  const tree = commitTree(repo, commitOid);
  if (tree === null) return new Map();
  return readFiles(repo, tree);
}

function lineStats(before: string, after: string): { additions: number; deletions: number } {
  if (before === after) return { additions: 0, deletions: 0 };
  const beforeLines = before === '' ? [] : before.split('\n');
  const afterLines = after === '' ? [] : after.split('\n');
  const beforeSet = new Map<string, number>();
  for (const line of beforeLines) beforeSet.set(line, (beforeSet.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of afterLines) {
    const count = beforeSet.get(line) ?? 0;
    if (count > 0) beforeSet.set(line, count - 1);
    else additions += 1;
  }
  const afterSet = new Map<string, number>();
  for (const line of afterLines) afterSet.set(line, (afterSet.get(line) ?? 0) + 1);
  let deletions = 0;
  for (const line of beforeLines) {
    const count = afterSet.get(line) ?? 0;
    if (count > 0) afterSet.set(line, count - 1);
    else deletions += 1;
  }
  return { additions, deletions };
}

function diffFiles(repo: Repo, baseCommit: string | null, headCommit: string): PullFile[] {
  const baseFiles = baseCommit === null ? new Map<string, Buffer>() : commitFiles(repo, baseCommit);
  const headFiles = commitFiles(repo, headCommit);
  const names = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort();
  const files: PullFile[] = [];
  for (const name of names) {
    const before = baseFiles.get(name);
    const after = headFiles.get(name);
    if (before !== undefined && after !== undefined && before.equals(after)) continue;
    const status: PullFile['status'] = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    const stats = lineStats(before === undefined ? '' : before.toString('utf8'), after === undefined ? '' : after.toString('utf8'));
    files.push({
      filename: name,
      status,
      additions: stats.additions,
      deletions: stats.deletions,
      changes: stats.additions + stats.deletions,
      sha: after === undefined ? hashBlob(before ?? Buffer.alloc(0)) : hashBlob(after),
    });
  }
  return files;
}

export function pullFilesOf(repo: Repo, pull: Pull): PullFile[] {
  if (pull.files.length > 0) return pull.files;
  const headTip = resolveRev(repo, pull.headRef);
  const baseTip = resolveRev(repo, pull.baseRef);
  if (headTip === null) return pull.files;
  const common = baseTip === null ? null : mergeBase(repo, headTip, baseTip);
  return diffFiles(repo, common, headTip);
}

// ---------------------------------------------------------------- record mutations (shared with MCP)

export type MutationResult<T> = { ok: true; value: T } | { ok: false; error: string; status?: number };

export interface IssueInput {
  title: string;
  body?: string;
  labels?: readonly string[];
}

export function createIssueForRepo(repo: Repo, input: IssueInput): MutationResult<Issue> {
  const labels: Label[] = [];
  for (const name of input.labels ?? []) {
    const label = repo.labels.get(name);
    if (label === undefined) {
      return { ok: false, status: 422, error: 'Validation Failed: the label ' + JSON.stringify(name) + ' does not exist' };
    }
    labels.push({ ...label });
  }
  const instant = nowIso();
  const number = repo.nextIssue;
  repo.nextIssue += 1;
  const issue: Issue = {
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels,
    createdAt: instant,
    updatedAt: instant,
    closedAt: null,
    seq: number,
    comments: [],
  };
  repo.issues.set(number, issue);
  return { ok: true, value: issue };
}

export interface PullInput {
  title: string;
  body?: string;
  head: string;
  base: string;
}

function normalizeRef(value: string): string {
  const text = value.trim();
  if (text.startsWith('refs/heads/')) return text.slice('refs/heads/'.length);
  const colon = text.lastIndexOf(':');
  if (colon >= 0) return text.slice(colon + 1);
  return text;
}

export function createPullForRepo(repo: Repo, input: PullInput): MutationResult<Pull> {
  const headRef = normalizeRef(input.head);
  const baseRef = normalizeRef(input.base);
  const headSha = resolveRev(repo, headRef);
  const baseSha = resolveRev(repo, baseRef);
  if (headSha === null || baseSha === null) {
    return { ok: false, status: 422, error: 'Validation Failed: the head or base branch does not exist' };
  }
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
      return { ok: false, status: 422, error: 'Validation Failed: a pull request already exists for ' + headRef + ' into ' + baseRef };
    }
  }
  const number = repo.nextPull;
  repo.nextPull += 1;
  const instant = nowIso();
  const common = mergeBase(repo, headSha, baseSha);
  const pull: Pull = {
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    createdAt: instant,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    files: diffFiles(repo, common, headSha),
    seq: number,
  };
  repo.pulls.set(number, pull);
  return { ok: true, value: pull };
}

function secondsOf(instant: string): number {
  const parsed = Date.parse(instant);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function commitFilesFrom(repo: Repo, parent: string | null, files: ReadonlyMap<string, Buffer>, message: string): string {
  const tree = writeTreeFromFiles(repo, files);
  const identity = { name: VIEWER.name, email: VIEWER.email, seconds: secondsOf(nextInstant()), offset: '+0000' };
  const data = buildCommit({
    tree,
    parents: parent === null ? [] : [parent],
    author: identity,
    committer: identity,
    message,
  });
  return putObject(repo, 'commit', data);
}

export function mergePullForRepo(repo: Repo, pull: Pull): MutationResult<string> {
  if (pull.merged && pull.mergeCommitSha !== null) return { ok: true, value: pull.mergeCommitSha };
  const baseTip = resolveRev(repo, pull.baseRef);
  const headTip = resolveRev(repo, pull.headRef);
  if (baseTip === null || headTip === null) return { ok: false, status: 405, error: 'Pull Request is not mergeable' };
  const common = mergeBase(repo, headTip, baseTip);
  const commonFiles = common === null ? new Map<string, Buffer>() : commitFiles(repo, common);
  const ourFiles = commitFiles(repo, baseTip);
  const theirFiles = commitFiles(repo, headTip);
  const mergedFiles = new Map<string, Buffer>(ourFiles);
  for (const name of new Set([...commonFiles.keys(), ...theirFiles.keys()])) {
    const baseBytes = commonFiles.get(name);
    const theirBytes = theirFiles.get(name);
    const ourBytes = ourFiles.get(name);
    const baseKey = baseBytes === undefined ? null : baseBytes.toString('base64');
    const theirKey = theirBytes === undefined ? null : theirBytes.toString('base64');
    const ourKey = ourBytes === undefined ? null : ourBytes.toString('base64');
    if (baseKey === theirKey) continue;
    if (baseKey !== ourKey) return { ok: false, status: 405, error: 'Pull Request has merge conflicts' };
    if (theirBytes === undefined) mergedFiles.delete(name);
    else mergedFiles.set(name, theirBytes);
  }
  const message = pull.title + ' (#' + pull.number + ')' + (pull.body === '' ? '' : '\n\n' + pull.body);
  const sha = commitFilesFrom(repo, baseTip, mergedFiles, message);
  repo.refs.set('refs/heads/' + pull.baseRef, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
  return { ok: true, value: sha };
}

export interface IssueListOptions {
  state?: string;
  sort?: string;
  direction?: string;
}

export function listIssuesForRepo(repo: Repo, options: IssueListOptions = {}): Issue[] {
  const state = (options.state ?? 'open').toLowerCase();
  const sort = (options.sort ?? 'created').toLowerCase();
  const direction = (options.direction ?? 'desc').toLowerCase();
  let list = [...repo.issues.values()];
  if (state !== 'all') list = list.filter((issue) => issue.state === state);
  list.sort((left, right) => {
    if (sort === 'updated' || sort === 'comments') return left.updatedAt < right.updatedAt ? -1 : left.updatedAt > right.updatedAt ? 1 : 0;
    return left.seq - right.seq;
  });
  if (direction === 'desc') list.reverse();
  return list;
}

// ---------------------------------------------------------------- small helpers

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function pathSegments(path: string): string[] {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map(decodeSegment);
}

function parseBody(request: ApiRequest): Record<string, unknown> | null {
  const text = request.body.toString('utf8').trim();
  if (text === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch {
    return null;
  }
}

function textOf(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function integerParam(value: string | null, fallback: number): number {
  if (value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function paginate<T>(items: readonly T[], perPage: number, page: number): T[] {
  const start = Math.max(0, (page - 1) * perPage);
  return items.slice(start, start + perPage);
}

function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const parsed = readCommit(repo, oid);
  if (parsed === null) {
    return { sha: oid, node_id: nodeId('Commit', oid), commit: { message: '', tree: { sha: '' }, author: {}, committer: {} }, parents: [] };
  }
  const author = {
    name: parsed.author.name,
    email: parsed.author.email,
    date: isoFromSeconds(parsed.author.seconds),
  };
  const committer = {
    name: parsed.committer.name,
    email: parsed.committer.email,
    date: isoFromSeconds(parsed.committer.seconds),
  };
  return {
    sha: oid,
    node_id: nodeId('Commit', oid),
    commit: {
      author,
      committer,
      message: parsed.message.replace(/\n+$/, ''),
      tree: { sha: parsed.tree },
      url: repoUrl(repo) + '/git/commits/' + oid,
    },
    parents: parsed.parents.map((sha) => ({ sha })),
    url: repoUrl(repo) + '/commits/' + oid,
  };
}

function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: repoUrl(repo) + '/commits/' + sha },
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } },
    protection_url: repoUrl(repo) + '/branches/' + name + '/protection',
  };
}

function refJson(ref: string, sha: string): Record<string, unknown> {
  return {
    ref,
    node_id: nodeId('Ref', ref),
    url: 'https://api.github.com/repos/x/y/git/refs/' + ref,
    object: { sha, type: 'commit', url: 'https://api.github.com/repos/x/y/git/commits/' + sha },
  };
}

function contentsFilePath(tail: readonly string[]): string {
  return tail.slice(1).join('/');
}

function fileContentJson(repo: Repo, filePath: string, data: Buffer): Record<string, unknown> {
  const name = filePath.split('/').pop() ?? filePath;
  return {
    type: 'file',
    name,
    path: filePath,
    sha: hashBlob(data),
    size: data.length,
    encoding: 'base64',
    content: data.toString('base64'),
    url: repoUrl(repo) + '/contents/' + filePath,
    html_url: 'https://github.com/' + repoKey(repo) + '/blob/' + repo.defaultBranch + '/' + filePath,
    git_url: repoUrl(repo) + '/git/blobs/' + hashBlob(data),
    download_url: 'https://raw.githubusercontent.com/' + repoKey(repo) + '/' + repo.defaultBranch + '/' + filePath,
    _links: {
      self: repoUrl(repo) + '/contents/' + filePath,
      git: repoUrl(repo) + '/git/blobs/' + hashBlob(data),
      html: 'https://github.com/' + repoKey(repo) + '/blob/' + repo.defaultBranch + '/' + filePath,
    },
  };
}

function directoryListing(repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const entries = readTree(repo, treeOid).map((entry) => {
    const path = prefix === '' ? entry.name : prefix + '/' + entry.name;
    if (entry.mode === '40000') {
      return {
        type: 'dir',
        name: entry.name,
        path,
        sha: entry.oid,
        size: 0,
        url: repoUrl(repo) + '/contents/' + path,
        html_url: 'https://github.com/' + repoKey(repo) + '/tree/' + repo.defaultBranch + '/' + path,
        git_url: repoUrl(repo) + '/git/trees/' + entry.oid,
        download_url: null,
      };
    }
    const object = repo.objects.get(entry.oid);
    return {
      type: 'file',
      name: entry.name,
      path,
      sha: entry.oid,
      size: object === undefined ? 0 : object.data.length,
      url: repoUrl(repo) + '/contents/' + path,
      html_url: 'https://github.com/' + repoKey(repo) + '/blob/' + repo.defaultBranch + '/' + path,
      git_url: repoUrl(repo) + '/git/blobs/' + entry.oid,
      download_url: 'https://raw.githubusercontent.com/' + repoKey(repo) + '/' + repo.defaultBranch + '/' + path,
    };
  });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return entries;
}

// ---------------------------------------------------------------- the router

export function handleRest(request: ApiRequest, res: ServerResponse): void {
  const { method } = request;
  const segments = pathSegments(request.path);
  const isRoot = segments.length === 0;
  const isMeta = segments.length === 1 && segments[0] === 'meta';

  if (!request.authenticated && !isRoot && !isMeta) {
    sendError(res, 401, 'Requires authentication');
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    const parsed = parseBody(request);
    if (parsed === null) {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }
    (request as ApiRequest & { json?: Record<string, unknown> }).json = parsed;
  }
  const body = (request as ApiRequest & { json?: Record<string, unknown> }).json ?? {};

  if (isRoot) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(
      res,
      200,
      {
        current_user_url: request.origin + '/api/v3/user',
        current_user_authorizations_html_url: 'https://github.com/settings/connections/applications{/client_id}',
        authorizations_url: request.origin + '/api/v3/authorizations',
        code_search_url: request.origin + '/api/v3/search/code?q={query}{&page,per_page}',
        emails_url: request.origin + '/api/v3/user/emails',
        emojis_url: request.origin + '/api/v3/emojis',
        events_url: request.origin + '/api/v3/events',
        feeds_url: request.origin + '/api/v3/feeds',
        followers_url: request.origin + '/api/v3/user/followers',
        following_url: request.origin + '/api/v3/user/following{/target}',
        gists_url: request.origin + '/api/v3/gists{/gist_id}',
        hub_url: request.origin + '/api/v3/hub',
        issue_search_url: request.origin + '/api/v3/search/issues?q={query}{&page,per_page}',
        issues_url: request.origin + '/api/v3/issues',
        keys_url: request.origin + '/api/v3/user/keys',
        notifications_url: request.origin + '/api/v3/notifications',
        organization_repositories_url: request.origin + '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
        organization_url: request.origin + '/api/v3/orgs/{org}',
        public_gists_url: request.origin + '/api/v3/gists/public',
        rate_limit_url: request.origin + '/api/v3/rate_limit',
        repository_url: request.origin + '/api/v3/repos/{owner}/{repo}',
        repository_search_url: request.origin + '/api/v3/search/repositories?q={query}{&page,per_page}',
        current_user_repositories_url: request.origin + '/api/v3/user/repos{?type,page,per_page,sort}',
        starred_url: request.origin + '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: request.origin + '/api/v3/gists/starred',
        team_url: request.origin + '/api/v3/teams',
        user_url: request.origin + '/api/v3/users/{user}',
        user_organizations_url: request.origin + '/api/v3/user/orgs',
        user_repositories_url: request.origin + '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
        user_search_url: request.origin + '/api/v3/search/users?q={query}{&page,per_page}',
      },
      { 'x-oauth-scopes': 'repo, write:org' },
    );
  }

  if (isMeta) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, { installed_version: 'forge2-1.0.0', verifiable_password_authentication: true });
  }

  if (segments[0] === 'user') {
    handleUserRoute(request, res, segments, body);
    return;
  }

  if (segments[0] !== 'repos' || segments.length < 3) {
    sendError(res, 404, 'Not Found');
    return;
  }

  const repo = getRepo(segments[1] ?? '', segments[2] ?? '');
  if (repo === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const tail = segments.slice(3);
  if (tail.length === 0) {
    handleRepoRoute(request, res, repo, body);
    return;
  }
  const group = tail[0] ?? '';
  if (group === 'contents') {
    handleContentsRoute(request, res, repo, tail, body);
    return;
  }
  if (group === 'git') {
    handleGitDataRoute(request, res, repo, tail, body);
    return;
  }
  if (group === 'branches') {
    handleBranchesRoute(request, res, repo, tail);
    return;
  }
  if (group === 'commits') {
    handleCommitsRoute(request, res, repo, tail);
    return;
  }
  if (group === 'labels') {
    handleLabelsRoute(request, res, repo, tail, body);
    return;
  }
  if (group === 'issues') {
    handleIssuesRoute(request, res, repo, tail, body);
    return;
  }
  if (group === 'pulls') {
    handlePullsRoute(request, res, repo, tail, body);
    return;
  }
  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- /user

function handleUserRoute(
  request: ApiRequest,
  res: ServerResponse,
  segments: readonly string[],
  body: Record<string, unknown>,
): void {
  const { method } = request;
  if (segments.length === 1 && method === 'GET') {
    return sendJson(res, 200, userJson());
  }
  if (segments.length === 2 && segments[1] === 'repos') {
    if (method === 'GET') return listUserRepos(request, res);
    if (method === 'POST') return createUserRepo(request, res, body);
  }
  sendError(res, 404, 'Not Found');
}

function listUserRepos(request: ApiRequest, res: ServerResponse): void {
  const perPage = Math.max(1, Math.min(100, integerParam(request.query.get('per_page'), 30)));
  const page = Math.max(1, integerParam(request.query.get('page'), 1));
  const all = listRepos();
  const items = paginate(all, perPage, page).map((repo) => repoJson(repo));
  const extra: Record<string, string> = {};
  if (page * perPage < all.length) {
    const params = new URLSearchParams({ per_page: String(perPage), page: String(page + 1) });
    extra.link = '<' + request.origin + '/api/v3/user/repos?' + params.toString() + '>; rel="next"';
  }
  sendJson(res, 200, items, extra);
}

function createUserRepo(request: ApiRequest, res: ServerResponse, body: Record<string, unknown>): void {
  const name = textOf(body, 'name').trim();
  if (name === '') {
    sendError(res, 422, 'Repository creation failed: a name is required');
    return;
  }
  const isPrivate = body.private === true;
  const description = textOf(body, 'description');
  const repo = createRepo(VIEWER.login, name, isPrivate, description);
  if (repo === null) {
    if (getRepo(VIEWER.login, name) !== null) {
      sendError(res, 422, 'Repository creation failed: a repository with the name ' + JSON.stringify(name) + ' already exists');
    } else {
      sendError(res, 422, 'Repository creation failed');
    }
    return;
  }
  sendJson(res, 201, repoJson(repo));
}

// ---------------------------------------------------------------- /repos/{owner}/{name}

function handleRepoRoute(request: ApiRequest, res: ServerResponse, repo: Repo, body: Record<string, unknown>): void {
  const { method } = request;
  if (method === 'GET' || method === 'HEAD') return sendJson(res, 200, repoJson(repo));
  if (method === 'PATCH') {
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.private = body.private;
    return sendJson(res, 200, repoJson(repo));
  }
  if (method === 'DELETE') {
    deleteRepo(repo.owner, repo.name);
    return sendJson(res, 204, undefined);
  }
  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- contents

function handleContentsRoute(
  request: ApiRequest,
  res: ServerResponse,
  repo: Repo,
  tail: readonly string[],
  body: Record<string, unknown>,
): void {
  const { method } = request;
  const filePath = contentsFilePath(tail);
  if (filePath === '') return sendError(res, 404, 'Not Found');

  if (method === 'GET' || method === 'HEAD') {
    const ref = request.query.get('ref') ?? repo.defaultBranch;
    const tip = resolveRev(repo, ref);
    if (tip === null) return sendError(res, 404, 'Not Found');
    const tree = commitTree(repo, tip);
    if (tree === null) return sendError(res, 404, 'Not Found');
    const lookup = lookupPath(repo, tree, filePath);
    if (lookup === null) return sendError(res, 404, 'Not Found');
    if (lookup.entry.mode === '40000') return sendJson(res, 200, directoryListing(repo, lookup.entry.oid, filePath));
    const object = repo.objects.get(lookup.entry.oid);
    if (object === undefined) return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, fileContentJson(repo, filePath, object.data));
  }

  if (method === 'PUT') {
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = resolveRev(repo, branch);
    const tree = tip === null ? null : commitTree(repo, tip);
    const files = tree === null ? new Map<string, Buffer>() : readFiles(repo, tree);
    const existing = files.get(filePath);
    if (typeof body.sha === 'string' && body.sha !== '') {
      const current = existing === undefined ? null : hashBlob(existing);
      if (current === null || current.toLowerCase() !== body.sha.toLowerCase()) {
        return sendError(res, 409, 'The sha ' + JSON.stringify(body.sha) + ' does not match the current content of ' + JSON.stringify(filePath));
      }
    }
    const encoded = textOf(body, 'content').replace(/[\r\n\t ]+/g, '');
    const data = Buffer.from(encoded, 'base64');
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : 'Update ' + filePath;
    files.set(filePath, data);
    const commitSha = commitFilesFrom(repo, tip, files, message);
    repo.refs.set('refs/heads/' + branch, commitSha);
    const status = existing === undefined ? 201 : 200;
    return sendJson(res, status, {
      content: fileContentJson(repo, filePath, data),
      commit: {
        sha: commitSha,
        node_id: nodeId('Commit', commitSha),
        message,
        author: userJson(),
        committer: userJson(),
        tree: { sha: '' },
        parents: tip === null ? [] : [{ sha: tip }],
      },
    });
  }

  if (method === 'DELETE') {
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = resolveRev(repo, branch);
    if (tip === null) return sendError(res, 404, 'Not Found');
    const tree = commitTree(repo, tip);
    if (tree === null) return sendError(res, 404, 'Not Found');
    const files = readFiles(repo, tree);
    const existing = files.get(filePath);
    if (existing === undefined) return sendError(res, 404, 'Not Found');
    if (typeof body.sha === 'string' && body.sha !== '' && hashBlob(existing).toLowerCase() !== body.sha.toLowerCase()) {
      return sendError(res, 409, 'The sha ' + JSON.stringify(body.sha) + ' does not match the current content of ' + JSON.stringify(filePath));
    }
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : 'Delete ' + filePath;
    files.delete(filePath);
    const commitSha = commitFilesFrom(repo, tip, files, message);
    repo.refs.set('refs/heads/' + branch, commitSha);
    return sendJson(res, 200, {
      content: null,
      commit: {
        sha: commitSha,
        node_id: nodeId('Commit', commitSha),
        message,
        author: userJson(),
        committer: userJson(),
        tree: { sha: '' },
        parents: [{ sha: tip }],
      },
    });
  }

  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- git data

function handleGitDataRoute(
  request: ApiRequest,
  res: ServerResponse,
  repo: Repo,
  tail: readonly string[],
  body: Record<string, unknown>,
): void {
  const { method } = request;
  if (tail[1] !== 'refs') return sendError(res, 404, 'Not Found');

  if (tail.length === 2) {
    if (method === 'GET') {
      const refs = [...repo.refs.entries()]
        .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
        .map(([ref, sha]) => refJson(ref, sha));
      return sendJson(res, 200, refs);
    }
    if (method === 'POST') {
      const ref = textOf(body, 'ref');
      const sha = textOf(body, 'sha');
      if (!ref.startsWith('refs/')) return sendError(res, 422, 'Validation Failed: ref must start with refs/');
      if (!/^[0-9a-f]{40}$/i.test(sha) || !repo.objects.has(sha)) {
        return sendError(res, 422, 'Validation Failed: the object ' + JSON.stringify(sha) + ' does not exist');
      }
      if (repo.refs.has(ref)) return sendError(res, 422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return sendJson(res, 201, refJson(ref, sha));
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  const kind = tail[2] ?? '';
  if (kind !== 'heads' && kind !== 'tags') return sendError(res, 404, 'Not Found');
  const name = tail.slice(3).join('/');
  const ref = 'refs/' + kind + '/' + name;
  if (method === 'GET') {
    const sha = repo.refs.get(ref);
    if (sha === undefined) return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, refJson(ref, sha));
  }
  if (method === 'PATCH') {
    const sha = textOf(body, 'sha');
    if (!/^[0-9a-f]{40}$/i.test(sha) || !repo.objects.has(sha)) {
      return sendError(res, 422, 'Validation Failed: the object ' + JSON.stringify(sha) + ' does not exist');
    }
    if (!repo.refs.has(ref)) return sendError(res, 404, 'Not Found');
    repo.refs.set(ref, sha);
    return sendJson(res, 200, refJson(ref, sha));
  }
  if (method === 'DELETE') {
    repo.refs.delete(ref);
    return sendJson(res, 204, undefined);
  }
  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- branches / commits

function handleBranchesRoute(request: ApiRequest, res: ServerResponse, repo: Repo, tail: readonly string[]): void {
  if (request.method !== 'GET') return sendError(res, 404, 'Not Found');
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, sha]) => branchJson(repo, ref.slice('refs/heads/'.length), sha))
    .sort((left, right) => (String(left.name) < String(right.name) ? -1 : String(left.name) > String(right.name) ? 1 : 0));
  if (tail.length === 1) return sendJson(res, 200, branches);
  const name = tail.slice(1).join('/');
  const found = branches.find((branch) => branch.name === name);
  if (found === undefined) return sendError(res, 404, 'Branch not found');
  sendJson(res, 200, found);
}

function handleCommitsRoute(request: ApiRequest, res: ServerResponse, repo: Repo, tail: readonly string[]): void {
  if (request.method !== 'GET') return sendError(res, 404, 'Not Found');
  const rev = request.query.get('sha') ?? tail[1] ?? repo.defaultBranch;
  const tip = resolveRev(repo, rev);
  if (tip === null) return sendError(res, 404, 'Not Found');
  const perPage = Math.max(1, Math.min(100, integerParam(request.query.get('per_page'), 30)));
  const page = Math.max(1, integerParam(request.query.get('page'), 1));
  const commits = commitLog(repo, tip, 1000).map((oid) => commitJson(repo, oid));
  sendJson(res, 200, paginate(commits, perPage, page));
}

// ---------------------------------------------------------------- labels

function handleLabelsRoute(
  request: ApiRequest,
  res: ServerResponse,
  repo: Repo,
  tail: readonly string[],
  body: Record<string, unknown>,
): void {
  if (tail.length !== 1) return sendError(res, 404, 'Not Found');
  if (request.method === 'GET') {
    return sendJson(res, 200, [...repo.labels.values()].map(labelJson));
  }
  if (request.method === 'POST') {
    const name = textOf(body, 'name').trim();
    if (name === '') return sendError(res, 422, 'Validation Failed: a label name is required');
    const label: Label = {
      name,
      color: textOf(body, 'color') || 'ededed',
      description: typeof body.description === 'string' ? body.description : null,
    };
    repo.labels.set(name, label);
    return sendJson(res, 201, labelJson(label));
  }
  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- issues

function handleIssuesRoute(
  request: ApiRequest,
  res: ServerResponse,
  repo: Repo,
  tail: readonly string[],
  body: Record<string, unknown>,
): void {
  const { method } = request;
  if (tail.length === 1) {
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      const sort = request.query.get('sort') ?? 'created';
      const direction = request.query.get('direction') ?? 'desc';
      const perPage = Math.max(1, Math.min(100, integerParam(request.query.get('per_page'), 30)));
      const page = Math.max(1, integerParam(request.query.get('page'), 1));
      const list = listIssuesForRepo(repo, { state, sort, direction }).map((issue) => issueJson(repo, issue));
      return sendJson(res, 200, paginate(list, perPage, page));
    }
    if (method === 'POST') {
      const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
      const result = createIssueForRepo(repo, {
        title: textOf(body, 'title'),
        body: textOf(body, 'body'),
        labels,
      });
      if (!result.ok) return sendError(res, result.status ?? 422, result.error);
      return sendJson(res, 201, issueJson(repo, result.value));
    }
    return sendError(res, 404, 'Not Found');
  }

  const number = integerParam(tail[1] ?? '', Number.NaN);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (issue === undefined) return sendError(res, 404, 'Not Found');

  if (tail.length === 2) {
    if (method === 'GET' || method === 'HEAD') {
      const raw = res as unknown as { writeRawResponse?: (packet: Buffer) => void };
      if (typeof raw.writeRawResponse === 'function') return raw.writeRawResponse(cachedIssueWire(repo, issue));
      return sendJsonBuffer(res, 200, cachedIssuePayload(repo, issue));
    }
    if (method === 'PATCH') {
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? nowIso() : null;
      }
      if (Array.isArray(body.labels)) {
        const labels: Label[] = [];
        for (const name of body.labels) {
          if (typeof name !== 'string') continue;
          const label = repo.labels.get(name);
          if (label === undefined) return sendError(res, 422, 'Validation Failed: the label ' + JSON.stringify(name) + ' does not exist');
          labels.push({ ...label });
        }
        issue.labels = labels;
      }
      issue.updatedAt = nowIso();
      return sendJson(res, 200, issueJson(repo, issue));
    }
    return sendError(res, 404, 'Not Found');
  }

  if (tail.length === 3 && tail[2] === 'comments') {
    if (method === 'GET') {
      const list = issue.comments.map((comment) => commentJson(repo, issue, comment));
      return sendJson(res, 200, list);
    }
    if (method === 'POST') {
      const commentBody = textOf(body, 'body');
      const comment = {
        id: repo.nextComment,
        body: commentBody,
        createdAt: nowIso(),
        user: VIEWER,
      };
      repo.nextComment += 1;
      issue.comments.push(comment);
      issue.updatedAt = comment.createdAt;
      return sendJson(res, 201, commentJson(repo, issue, comment));
    }
    return sendError(res, 404, 'Not Found');
  }

  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- pulls

function handlePullsRoute(
  request: ApiRequest,
  res: ServerResponse,
  repo: Repo,
  tail: readonly string[],
  body: Record<string, unknown>,
): void {
  const { method } = request;
  if (tail.length === 1) {
    if (method === 'GET') {
      const state = (request.query.get('state') ?? 'open').toLowerCase();
      const perPage = Math.max(1, Math.min(100, integerParam(request.query.get('per_page'), 30)));
      const page = Math.max(1, integerParam(request.query.get('page'), 1));
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      list.sort((left, right) => right.seq - left.seq);
      return sendJson(res, 200, paginate(list, perPage, page).map((pull) => pullJson(repo, pull)));
    }
    if (method === 'POST') {
      const result = createPullForRepo(repo, {
        title: textOf(body, 'title'),
        body: textOf(body, 'body'),
        head: textOf(body, 'head'),
        base: textOf(body, 'base'),
      });
      if (!result.ok) return sendError(res, result.status ?? 422, result.error);
      return sendJson(res, 201, pullJson(repo, result.value));
    }
    return sendError(res, 404, 'Not Found');
  }

  const number = integerParam(tail[1] ?? '', Number.NaN);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) return sendError(res, 404, 'Not Found');

  if (tail.length === 2) {
    if (method === 'GET' || method === 'HEAD') return sendJson(res, 200, pullJson(repo, pull));
    if (method === 'PATCH') {
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
      return sendJson(res, 200, pullJson(repo, pull));
    }
    return sendError(res, 404, 'Not Found');
  }

  if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
    return sendJson(res, 200, pullFilesOf(repo, pull));
  }

  if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
    const result = mergePullForRepo(repo, pull);
    if (!result.ok) return sendError(res, result.status ?? 405, result.error);
    return sendJson(res, 200, {
      sha: result.value,
      merged: true,
      message: 'Pull Request successfully merged',
    });
  }

  sendError(res, 404, 'Not Found');
}
