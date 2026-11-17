// The GitHub REST v3 surface: repositories, branches, commits, contents, issues, comments and pulls.
//
// The suite drives this as a client, so the shapes and the status codes are the contract: 201 for a
// create, 200 for an update, 409 for a stale contents sha, 422 for an unknown label, 405 for a
// conflicted merge, and a JSON {message} body on every error.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  buildCommit,
  buildTree,
  commitTree,
  createRepo,
  deleteRepo,
  firstParentLog,
  getRepo,
  hashBlob,
  listRepos,
  mergeBase,
  nextInstant,
  nowIso,
  parseTree,
  putObject,
  readCommit,
  readFiles,
  resolveRev,
  writeTreeFromFiles,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type PullFile,
  type Repo,
} from './store.ts';

type Json = Record<string, unknown>;

export const REQUEST_ID_HEADER = 'x-github-request-id';

let requestCounter = 0;

export function jsonHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  requestCounter += 1;
  return {
    'content-type': 'application/json; charset=utf-8',
    [REQUEST_ID_HEADER]: VIEWER.login + '-' + requestCounter,
    ...extra,
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Readonly<Record<string, string>> = {}): void {
  const text = JSON.stringify(body) + '\n';
  res.writeHead(status, { ...jsonHeaders(extra), 'content-length': String(Buffer.byteLength(text)) });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, message: string, extra: Readonly<Record<string, string>> = {}): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest' }, extra);
}

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
  origin: string;
  authenticated: boolean;
}

export function isAuthenticated(headers: IncomingMessage['headers']): boolean {
  const value = headers['authorization'];
  if (typeof value !== 'string') return false;
  return /^Bearer\s+(\S+)\s*$/i.test(value);
}

function parseJsonBody(body: Buffer): { ok: true; value: Json } | { ok: false } {
  const text = body.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Json };
  } catch {
    return { ok: false };
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bool(value: unknown): boolean {
  return value === true;
}

function userJson(): Json {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: nodeId('User', VIEWER.id),
    avatar_url: 'https://avatars.githubusercontent.com/u/' + VIEWER.id,
    gravatar_id: '',
    url: '/api/v3/users/' + VIEWER.login,
    html_url: 'https://github.com/' + VIEWER.login,
    type: 'User',
    site_admin: false,
  };
}

export function nodeId(type: string, id: number | string): string {
  return Buffer.from('04:' + type + String(id), 'utf8').toString('base64');
}

function repoJson(repo: Repo, extra: Json = {}): Json {
  return {
    id: 1000 + repo.seq,
    node_id: nodeId('Repository', 1000 + repo.seq),
    name: repo.name,
    full_name: repo.owner + '/' + repo.name,
    owner: userJson(),
    private: repo.private,
    description: repo.description,
    fork: false,
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name,
    html_url: 'https://github.com/' + repo.owner + '/' + repo.name,
    clone_url: 'https://github.com/' + repo.owner + '/' + repo.name + '.git',
    git_url: 'git://github.com/' + repo.owner + '/' + repo.name + '.git',
    ssh_url: 'git@github.com:' + repo.owner + '/' + repo.name + '.git',
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    ...extra,
  };
}

function hash32(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return hash === 0 ? 1 : hash;
}

function labelJson(label: Label): Json {
  return {
    id: Math.abs(hash32(label.name)),
    node_id: nodeId('Label', label.name),
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function commentJson(comment: Comment): Json {
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: 'https://github.com/' + VIEWER.login + '/x/issues/1#issuecomment-' + comment.id,
  };
}

function issueJson(repo: Repo, issue: Issue): Json {
  return {
    id: 100000 + issue.number,
    node_id: nodeId('Issue', 100000 + issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    locked: false,
    user: userJson(),
    labels: issue.labels.map(labelJson),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    repository_url: '/api/v3/repos/' + repo.owner + '/' + repo.name,
    html_url: 'https://github.com/' + repo.owner + '/' + repo.name + '/issues/' + issue.number,
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/issues/' + issue.number,
    comments_url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/issues/' + issue.number + '/comments',
    events_url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/issues/' + issue.number + '/events',
    labels_url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/issues/' + issue.number + '/labels{/name}',
  };
}

function branchRefJson(repo: Repo, ref: string, sha: string): Json {
  const stripped = ref.startsWith('refs/heads/') ? ref.slice(11) : ref;
  return {
    ref: ref,
    node_id: nodeId('Ref', repo.owner + '/' + repo.name + '/' + ref),
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/git/refs/' + stripped,
    object: { type: 'commit', sha, url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/git/commits/' + sha },
  };
}

function pullJson(repo: Repo, pull: Pull): Json {
  const headSha = resolveRev(repo, pull.headRef) ?? pull.headSha;
  const baseSha = resolveRev(repo, pull.baseRef) ?? pull.baseSha;
  const additions = pull.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = pull.files.reduce((sum, file) => sum + file.deletions, 0);
  return {
    id: 200000 + pull.number,
    node_id: nodeId('PullRequest', 200000 + pull.number),
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    labels: [],
    milestone: null,
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    closed_at: pull.merged ? pull.mergedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    draft: false,
    head: {
      label: repo.owner + ':' + pull.headRef,
      ref: pull.headRef,
      sha: headSha,
      user: userJson(),
      repo: repoJson(repo),
    },
    base: {
      label: repo.owner + ':' + pull.baseRef,
      ref: pull.baseRef,
      sha: baseSha,
      user: userJson(),
      repo: repoJson(repo),
    },
    author_association: 'OWNER',
    commits: 1,
    additions,
    deletions,
    changed_files: pull.files.length,
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/pulls/' + pull.number,
    html_url: 'https://github.com/' + repo.owner + '/' + repo.name + '/pull/' + pull.number,
    diff_url: 'https://github.com/' + repo.owner + '/' + repo.name + '/pull/' + pull.number + '.diff',
    patch_url: 'https://github.com/' + repo.owner + '/' + repo.name + '/pull/' + pull.number + '.patch',
  };
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function linkHeader(origin: string, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const last = Math.max(1, Math.ceil(total / perPage));
  const url = (target: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    return origin + path + '?' + params.toString();
  };
  const links: string[] = [];
  if (page < last) links.push('<' + url(page + 1) + '>; rel="next"', '<' + url(last) + '>; rel="last"');
  if (page > 1) links.push('<' + url(1) + '>; rel="first"', '<' + url(page - 1) + '>; rel="prev"');
  return links.length === 0 ? null : links.join(', ');
}

function lookupEntry(repo: Repo, treeOid: string, path: string): { oid: string; mode: string; name: string } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const entries = parseTree(repo.objects.get(current)?.data ?? Buffer.alloc(0));
    const entry = entries.find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function blobShaAt(repo: Repo, treeOid: string, path: string): string | null {
  const found = lookupEntry(repo, treeOid, path);
  if (found === null || found.mode === '40000') return null;
  return found.oid;
}

function treeWithPath(repo: Repo, treeOid: string, path: string, blobOid: string | null): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  const load = (oid: string, node: Node): void => {
    for (const entry of parseTree(repo.objects.get(oid)?.data ?? Buffer.alloc(0))) {
      if (entry.mode === '40000') {
        const child: Node = { files: new Map(), dirs: new Map() };
        load(entry.oid, child);
        node.dirs.set(entry.name, child);
      } else node.files.set(entry.name, entry.oid);
    }
  };
  load(treeOid, root);
  const segments = path.split('/').filter((segment) => segment !== '');
  let node = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (!node.dirs.has(segments[index])) node.dirs.set(segments[index], { files: new Map(), dirs: new Map() });
    node = node.dirs.get(segments[index])!;
  }
  node.files.set(segments[segments.length - 1], blobOid as string);
  const build = (current: Node): string => {
    const entries: { mode: string; name: string; oid: string }[] = [];
    const prune: string[] = [];
    for (const [name, oid] of current.files) {
      if (oid === null) prune.push(name);
      else entries.push({ mode: '100644', name, oid });
    }
    for (const name of prune) current.files.delete(name);
    for (const [name, child] of current.dirs) {
      const oid = build(child);
      if (oid !== '') entries.push({ mode: '40000', name, oid });
      else current.dirs.delete(name);
    }
    if (entries.length === 0) return '';
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

function commitFiles(repo: Repo, commitOid: string): Map<string, Buffer> {
  const tree = commitTree(repo, commitOid);
  if (tree === null) return new Map();
  return readFiles(repo, tree);
}

function lineStats(base: string, next: string): { additions: number; deletions: number } {
  if (base === next) return { additions: 0, deletions: 0 };
  const before = base === '' ? [] : base.split('\n');
  const after = next === '' ? [] : next.split('\n');
  const beforeSet = new Map<string, number>();
  for (const line of before) beforeSet.set(line, (beforeSet.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of after) {
    const count = beforeSet.get(line) ?? 0;
    if (count > 0) beforeSet.set(line, count - 1);
    else additions += 1;
  }
  const afterSet = new Map<string, number>();
  for (const line of after) afterSet.set(line, (afterSet.get(line) ?? 0) + 1);
  let deletions = 0;
  for (const line of before) {
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
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
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

function refName(repo: Repo, branch: string | null | undefined): string {
  if (branch === null || branch === undefined || branch === '') return 'refs/heads/' + repo.defaultBranch;
  if (branch.startsWith('refs/')) return branch;
  return 'refs/heads/' + branch;
}

function commitOnBranch(repo: Repo, branchRef: string, files: Map<string, Buffer | null>, message: string): string {
  const parent = repo.refs.get(branchRef) ?? null;
  const parentTree = parent === null ? null : commitTree(repo, parent);
  const all = parentTree === null ? new Map<string, Buffer>() : readFiles(repo, parentTree);
  for (const [path, data] of files) {
    if (data === null) all.delete(path);
    else all.set(path, data);
  }
  const tree = writeTreeFromFiles(repo, all);
  const instant = nextInstant();
  const seconds = Math.floor(Date.parse(instant) / 1000);
  const identity = { name: VIEWER.name, email: VIEWER.email, seconds, offset: '+0000' };
  const data = buildCommit({
    tree,
    parents: parent === null ? [] : [parent],
    author: identity,
    committer: identity,
    message,
  });
  const oid = putObject(repo, 'commit', data);
  repo.refs.set(branchRef, oid);
  return oid;
}

export function handleRest(request: ApiRequest, res: ServerResponse): void {
  const segments = request.path.split('/').filter((segment) => segment !== '');
  const method = request.method.toUpperCase();

  if (segments.length === 0) {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, apiRoot(), { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (segments[0] === 'meta') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      hooks: [],
      installed_version: '2022-11-28',
      github_services_sha: 'forge-local',
    });
    return;
  }

  if (!request.authenticated) {
    sendError(res, 401, 'Requires authentication');
    return;
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, userJson());
    return;
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') {
      const parsed = parseJsonBody(request.body);
      if (!parsed.ok) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const name = str(parsed.value.name);
      if (name === '') {
        sendError(res, 422, 'Repository creation failed.');
        return;
      }
      const repo = createRepo(VIEWER.login, name, bool(parsed.value.private), str(parsed.value.description));
      if (repo === null) {
        sendError(res, 422, 'Repository creation failed.');
        return;
      }
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const all = listRepos();
      const { page, perPage } = pageParams(request.query);
      const start = (page - 1) * perPage;
      const items = all.slice(start, start + perPage);
      const link = linkHeader(request.origin, '/api/v3/user/repos', request.query, page, perPage, all.length);
      sendJson(res, 200, items.map((repo) => repoJson(repo)), link === null ? {} : { link });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (segments[0] !== 'repos' || segments.length < 3) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const owner = decodeURIComponent(segments[1]);
  const name = decodeURIComponent(segments[2]);
  const repo = getRepo(owner, name);
  if (repo === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(request.body);
      if (!parsed.ok) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      deleteRepo(repo.owner, repo.name);
      res.writeHead(204, jsonHeaders());
      res.end();
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (dispatchRepo(request, res, repo, rest)) return;
  sendError(res, 404, 'Not Found');
}

function apiRoot(): Json {
  return {
    current_user_url: '/api/v3/user',
    authorizations_url: '/api/v3/authorizations',
    emails_url: '/api/v3/user/emails',
    emojis_url: '/api/v3/emojis',
    events_url: '/api/v3/events',
    feeds_url: '/api/v3/feeds',
    followers_url: '/api/v3/user/followers',
    following_url: '/api/v3/user/following{/target}',
    gists_url: '/api/v3/gists{/gist_id}',
    issue_search_url: '/api/v3/search/issues?q={query}',
    issues_url: '/api/v3/issues',
    notifications_url: '/api/v3/notifications',
    rate_limit_url: '/api/v3/rate_limit',
    repository_url: '/api/v3/repos/{owner}/{repo}',
    current_user_repositories_url: '/api/v3/user/repos',
    user_url: '/api/v3/users/{user}',
  };
}

function dispatchRepo(request: ApiRequest, res: ServerResponse, repo: Repo, rest: string[]): boolean {
  const method = request.method.toUpperCase();
  const head = rest[0];

  if (head === 'branches') {
    if (method !== 'GET') return false;
    const items = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([ref, sha]) => ({
        name: ref.slice(11),
        commit: { sha, url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/commits/' + sha },
        protected: false,
      }));
    if (rest.length === 2) {
      const found = items.find((item) => item.name === rest[1]);
      if (found === undefined) return false;
      sendJson(res, 200, found);
      return true;
    }
    sendJson(res, 200, items);
    return true;
  }

  if (head === 'commits' && rest.length === 1) {
    if (method !== 'GET') return false;
    const sha = request.query.get('sha');
    const tip = sha === null ? resolveRev(repo, 'HEAD') : resolveRev(repo, sha);
    const log = tip === null ? [] : firstParentLog(repo, tip, 100);
    sendJson(res, 200, log.map((oid) => commitJson(repo, oid)));
    return true;
  }

  if (head === 'commits' && rest.length === 2) {
    if (method !== 'GET') return false;
    const oid = resolveRev(repo, rest[1]);
    if (oid === null) return false;
    sendJson(res, 200, commitJson(repo, oid));
    return true;
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseJsonBody(request.body);
      if (!parsed.ok) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const ref = str(parsed.value.ref);
      const sha = str(parsed.value.sha);
      if (ref === '' || !/^[0-9a-f]{40}$/.test(sha)) {
        sendError(res, 422, 'Reference update failed');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Reference already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, branchRefJson(repo, ref, sha));
      return true;
    }
    if (rest.length === 2 && (method === 'GET' || method === 'PATCH' || method === 'DELETE')) {
      const key = rest[1].startsWith('refs/') ? rest[1] : 'refs/' + rest[1];
      const existing = repo.refs.get(key);
      if (existing === undefined) return false;
      if (method === 'GET') {
        sendJson(res, 200, branchRefJson(repo, key, existing));
        return true;
      }
      if (method === 'DELETE') {
        repo.refs.delete(key);
        res.writeHead(204, jsonHeaders());
        res.end();
        return true;
      }
      const parsed = parseJsonBody(request.body);
      if (!parsed.ok) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const sha = str(parsed.value.sha);
      repo.refs.set(key, sha);
      sendJson(res, 200, branchRefJson(repo, key, sha));
      return true;
    }
    return false;
  }

  if (head === 'contents') {
    const path = rest.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
    const answered = handleContents(request, res, repo, path, method);
    if (answered) return true;
    return false;
  }

  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const parsed = parseJsonBody(request.body);
      if (!parsed.ok) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const labelName = str(parsed.value.name);
      if (labelName === '') {
        sendError(res, 422, 'Validation Failed');
        return true;
      }
      const label: Label = {
        name: labelName,
        color: str(parsed.value.color) || 'ededed',
        description: typeof parsed.value.description === 'string' ? parsed.value.description : null,
      };
      repo.labels.set(label.name, label);
      sendJson(res, 201, labelJson(label));
      return true;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map(labelJson));
      return true;
    }
    return false;
  }

  if (head === 'issues') return handleIssues(request, res, repo, rest, method);
  if (head === 'pulls') return handlePulls(request, res, repo, rest, method);

  if (head === 'git' && rest[1] === 'commits' && rest.length === 3) {
    if (method !== 'GET') return false;
    const sha = resolveRev(repo, rest[2]);
    if (sha === null) return false;
    sendJson(res, 200, commitJson(repo, sha));
    return true;
  }

  return false;
}

function commitJson(repo: Repo, oid: string): Json {
  const commit = readCommit(repo, oid);
  const instant = new Date((commit?.author.seconds ?? 0) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    sha: oid,
    node_id: nodeId('Commit', oid),
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/commits/' + oid,
    html_url: 'https://github.com/' + repo.owner + '/' + repo.name + '/commit/' + oid,
    commit: {
      author: { name: commit?.author.name ?? VIEWER.name, email: commit?.author.email ?? VIEWER.email, date: instant },
      committer: { name: commit?.committer.name ?? VIEWER.name, email: commit?.committer.email ?? VIEWER.email, date: instant },
      message: (commit?.message ?? '').replace(/\n$/, ''),
      tree: { sha: commit?.tree ?? '', url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/git/trees/' + (commit?.tree ?? '') },
    },
    author: userJson(),
    committer: userJson(),
    parents: (commit?.parents ?? []).map((parent) => ({ sha: parent, url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/commits/' + parent })),
  };
}

function contentEntryJson(repo: Repo, name: string, path: string, entry: { mode: string; oid: string }): Json {
  const isDir = entry.mode === '40000';
  const size = isDir ? 0 : repo.objects.get(entry.oid)?.data.length ?? 0;
  return {
    type: isDir ? 'dir' : 'file',
    size,
    name,
    path,
    sha: entry.oid,
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/contents/' + path,
    html_url: 'https://github.com/' + repo.owner + '/' + repo.name + '/blob/' + repo.defaultBranch + '/' + path,
    git_url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/git/blobs/' + entry.oid,
    download_url: isDir ? null : 'https://raw.githubusercontent.com/' + repo.owner + '/' + repo.name + '/' + repo.defaultBranch + '/' + path,
    _links: {},
  };
}

function handleContents(request: ApiRequest, res: ServerResponse, repo: Repo, path: string, method: string): boolean {
  if (method === 'PUT') {
    const parsed = parseJsonBody(request.body);
    if (!parsed.ok) {
      sendError(res, 400, 'Problems parsing JSON');
      return true;
    }
    const ref = refName(repo, typeof parsed.value.branch === 'string' ? parsed.value.branch : null);
    const tip = repo.refs.get(ref) ?? null;
    const parentTree = tip === null ? null : commitTree(repo, tip);
    const currentBlob = parentTree === null ? null : blobShaAt(repo, parentTree, path);
    const supplied = typeof parsed.value.sha === 'string' ? parsed.value.sha : null;
    if (supplied !== null && currentBlob !== null && supplied !== currentBlob) {
      sendError(res, 409, path + ' does not match ' + supplied);
      return true;
    }
    const content = Buffer.from(str(parsed.value.content).replace(/\n/g, ''), 'base64');
    const blobOid = putObject(repo, 'blob', content);
    const baseTree = parentTree ?? putObject(repo, 'tree', Buffer.alloc(0));
    const tree = treeWithPath(repo, baseTree, path, blobOid);
    const commitOid = commitOnBranch(repo, ref, new Map([[path, content]]), str(parsed.value.message) || 'Update ' + path);
    const updated = currentBlob !== null;
    sendJson(res, updated ? 200 : 201, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: blobOid,
        encoding: 'base64',
        size: content.length,
        url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/contents/' + path,
        html_url: 'https://github.com/' + repo.owner + '/' + repo.name + '/blob/' + repo.defaultBranch + '/' + path,
        git_url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/git/blobs/' + blobOid,
        download_url: 'https://raw.githubusercontent.com/' + repo.owner + '/' + repo.name + '/' + repo.defaultBranch + '/' + path,
        type: 'file',
        _links: {},
      },
      commit: commitSummary(repo, commitOid, tip),
    });
    return true;
  }

  if (method === 'DELETE') {
    const parsed = parseJsonBody(request.body);
    if (!parsed.ok) {
      sendError(res, 400, 'Problems parsing JSON');
      return true;
    }
    const ref = refName(repo, typeof parsed.value.branch === 'string' ? parsed.value.branch : null);
    const tip = repo.refs.get(ref) ?? null;
    const parentTree = tip === null ? null : commitTree(repo, tip);
    if (parentTree === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const currentBlob = blobShaAt(repo, parentTree, path);
    if (currentBlob === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const commitOid = commitOnBranch(repo, ref, new Map([[path, null]]), str(parsed.value.message) || 'Delete ' + path);
    sendJson(res, 200, { content: null, commit: commitSummary(repo, commitOid, tip) });
    return true;
  }

  if (method === 'GET') {
    const refParam = request.query.get('ref');
    const tip = resolveRev(repo, refParam);
    if (tip === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const tree = commitTree(repo, tip);
    if (tree === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (path === '') {
      sendJson(res, 200, parseTree(repo.objects.get(tree)?.data ?? Buffer.alloc(0)).map((entry) => contentEntryJson(repo, entry.name, entry.name, entry)));
      return true;
    }
    const entry = lookupEntry(repo, tree, path);
    if (entry === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (entry.mode === '40000') {
      const listing = parseTree(repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0)).map((child) =>
        contentEntryJson(repo, child.name, path + '/' + child.name, child),
      );
      sendJson(res, 200, listing);
      return true;
    }
    const data = repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0);
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: entry.name,
      path,
      content: data.toString('base64'),
      sha: entry.oid,
      url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/contents/' + path,
      git_url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/git/blobs/' + entry.oid,
      html_url: 'https://github.com/' + repo.owner + '/' + repo.name + '/blob/' + repo.defaultBranch + '/' + path,
      download_url: 'https://raw.githubusercontent.com/' + repo.owner + '/' + repo.name + '/' + repo.defaultBranch + '/' + path,
      _links: {},
    });
    return true;
  }

  return false;
}

function commitSummary(repo: Repo, oid: string, parent: string | null): Json {
  const commit = readCommit(repo, oid);
  const instant = new Date((commit?.author.seconds ?? 0) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    sha: oid,
    node_id: nodeId('Commit', oid),
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/commits/' + oid,
    html_url: 'https://github.com/' + repo.owner + '/' + repo.name + '/commit/' + oid,
    message: (commit?.message ?? '').replace(/\n$/, ''),
    author: { name: VIEWER.name, email: VIEWER.email, date: instant },
    committer: { name: VIEWER.name, email: VIEWER.email, date: instant },
    parents: parent === null ? [] : [{ sha: parent }],
  };
}

function handleIssues(request: ApiRequest, res: ServerResponse, repo: Repo, rest: string[], method: string): boolean {
  if (rest.length === 1) {
    if (method === 'POST') {
      const parsed = parseJsonBody(request.body);
      if (!parsed.ok) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const wanted = Array.isArray(parsed.value.labels) ? parsed.value.labels.map((label) => String(label)) : [];
      const labels: Label[] = [];
      for (const labelName of wanted) {
        const label = repo.labels.get(labelName);
        if (label === undefined) {
          sendError(res, 422, 'Validation Failed: label ' + labelName + ' does not exist');
          return true;
        }
        labels.push(label);
      }
      const number = repo.nextIssue;
      repo.nextIssue += 1;
      const instant = nowIso();
      const issue: Issue = {
        number,
        title: str(parsed.value.title),
        body: str(parsed.value.body),
        state: 'open',
        labels,
        createdAt: instant,
        updatedAt: instant,
        closedAt: null,
        seq: number,
        comments: [],
      };
      repo.issues.set(number, issue);
      sendJson(res, 201, issueJson(repo, issue));
      return true;
    }
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      const sort = request.query.get('sort') ?? 'created';
      const direction = request.query.get('direction') ?? (sort === 'created' ? 'asc' : 'desc');
      let items = [...repo.issues.values()];
      if (state !== 'all') items = items.filter((issue) => issue.state === state);
      items.sort((a, b) => (sort === 'updated' ? (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number) : a.number - b.number));
      if (direction === 'desc') items.reverse();
      const { page, perPage } = pageParams(request.query);
      const start = (page - 1) * perPage;
      const link = linkHeader(request.origin, '/api/v3/repos/' + repo.owner + '/' + repo.name + '/issues', request.query, page, perPage, items.length);
      sendJson(res, 200, items.slice(start, start + perPage).map((issue) => issueJson(repo, issue)), link === null ? {} : { link });
      return true;
    }
    return false;
  }

  const number = Number(rest[1]);
  if (!Number.isInteger(number)) return false;
  const issue = repo.issues.get(number);

  if (rest.length === 2) {
    if (issue === undefined) {
      if (method === 'GET' || method === 'PATCH') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      return false;
    }
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(request.body);
      if (!parsed.ok) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') {
        issue.state = parsed.value.state;
        issue.closedAt = parsed.value.state === 'closed' ? nowIso() : null;
      }
      if (Array.isArray(parsed.value.labels)) {
        const next: Label[] = [];
        for (const labelName of parsed.value.labels.map((label) => String(label))) {
          const label = repo.labels.get(labelName);
          if (label === undefined) {
            sendError(res, 422, 'Validation Failed');
            return true;
          }
          next.push(label);
        }
        issue.labels = next;
      }
      issue.updatedAt = nowIso();
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    return false;
  }

  if (rest.length === 3 && rest[2] === 'comments') {
    if (issue === undefined) {
      if (method === 'GET' || method === 'POST') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      return false;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(request.body);
      if (!parsed.ok) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const comment: Comment = {
        id: repo.nextComment,
        body: str(parsed.value.body),
        createdAt: nowIso(),
        user: VIEWER,
      };
      repo.nextComment += 1;
      issue.comments.push(comment);
      sendJson(res, 201, commentJson(comment));
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map(commentJson));
      return true;
    }
  }

  return false;
}

function diffFor(repo: Repo, pull: Pull): PullFile[] {
  const headTip = resolveRev(repo, pull.headRef);
  const baseTip = resolveRev(repo, pull.baseRef);
  const common = mergeBase(repo, headTip, baseTip);
  return headTip === null ? pull.files : diffFiles(repo, common, headTip);
}

function handlePulls(request: ApiRequest, res: ServerResponse, repo: Repo, rest: string[], method: string): boolean {
  if (rest.length === 1) {
    if (method === 'POST') {
      const parsed = parseJsonBody(request.body);
      if (!parsed.ok) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const head = str(parsed.value.head);
      const base = str(parsed.value.base) || repo.defaultBranch;
      const headSha = resolveRev(repo, head);
      const baseSha = resolveRev(repo, base);
      if (headSha === null || baseSha === null) {
        sendError(res, 422, 'Validation Failed: no commits between ' + base + ' and ' + head);
        return true;
      }
      const common = mergeBase(repo, headSha, baseSha);
      const number = repo.nextPull;
      repo.nextPull += 1;
      const pull: Pull = {
        number,
        title: str(parsed.value.title),
        body: str(parsed.value.body),
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        createdAt: nowIso(),
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        files: diffFiles(repo, common, headSha),
        seq: number,
      };
      repo.pulls.set(number, pull);
      sendJson(res, 201, pullJson(repo, pull));
      return true;
    }
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      let items = [...repo.pulls.values()];
      if (state !== 'all') items = items.filter((pull) => pull.state === state);
      items.sort((a, b) => a.number - b.number);
      const { page, perPage } = pageParams(request.query);
      const start = (page - 1) * perPage;
      sendJson(res, 200, items.slice(start, start + perPage).map((pull) => pullJson(repo, pull)));
      return true;
    }
    return false;
  }

  const number = Number(rest[1]);
  if (!Number.isInteger(number)) return false;
  const pull = repo.pulls.get(number) ?? null;

  if (rest.length === 2) {
    if (pull === null) {
      if (method === 'GET') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      return false;
    }
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(request.body);
      if (!parsed.ok) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (typeof parsed.value.title === 'string') pull.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') pull.body = parsed.value.body;
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') pull.state = parsed.value.state;
      sendJson(res, 200, pullJson(repo, pull));
      return true;
    }
    return false;
  }

  if (rest.length === 3 && rest[2] === 'files') {
    if (method !== 'GET') return false;
    if (pull === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const files = pull.files.length === 0 ? diffFor(repo, pull) : pull.files;
    sendJson(
      res,
      200,
      files.map((file) => ({
        sha: file.sha,
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        blob_url: 'https://github.com/' + repo.owner + '/' + repo.name + '/blob/' + pull.headSha + '/' + file.filename,
        raw_url: 'https://github.com/' + repo.owner + '/' + repo.name + '/raw/' + pull.headSha + '/' + file.filename,
        contents_url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/contents/' + file.filename + '?ref=' + pull.headSha,
      })),
    );
    return true;
  }

  if (rest.length === 3 && rest[2] === 'merge') {
    if (method !== 'PUT') return false;
    if (pull === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (pull.merged) {
      sendError(res, 405, 'Pull Request is not mergeable');
      return true;
    }
    const baseTip = resolveRev(repo, pull.baseRef);
    const headTip = resolveRev(repo, pull.headRef);
    if (baseTip === null || headTip === null) {
      sendError(res, 409, 'Pull Request is not mergeable');
      return true;
    }
    const common = mergeBase(repo, headTip, baseTip);
    const baseFiles = common === null ? new Map<string, Buffer>() : commitFiles(repo, common);
    const ourFiles = commitFiles(repo, baseTip);
    const theirFiles = commitFiles(repo, headTip);
    const mergedFiles = new Map(ourFiles);
    let conflict = false;
    for (const name of new Set([...baseFiles.keys(), ...theirFiles.keys()])) {
      const baseBytes = baseFiles.get(name);
      const theirBytes = theirFiles.get(name);
      const oursBytes = ourFiles.get(name);
      const baseKey = baseBytes === undefined ? null : baseBytes.toString('base64');
      const theirKey = theirBytes === undefined ? null : theirBytes.toString('base64');
      const ourKey = oursBytes === undefined ? null : oursBytes.toString('base64');
      if (baseKey === theirKey) continue;
      if (baseKey !== ourKey) {
        conflict = true;
        break;
      }
      if (theirBytes === undefined) mergedFiles.delete(name);
      else mergedFiles.set(name, theirBytes);
    }
    if (conflict) {
      sendError(res, 405, 'Pull Request is not mergeable');
      return true;
    }
    const tree = writeTreeFromFiles(repo, mergedFiles);
    const instant = nextInstant();
    const seconds = Math.floor(Date.parse(instant) / 1000);
    const identity = { name: VIEWER.name, email: VIEWER.email, seconds, offset: '+0000' };
    const message = pull.title + ' (#' + pull.number + ')' + (pull.body === '' ? '' : '\n\n' + pull.body);
    const data = buildCommit({ tree, parents: [baseTip], author: identity, committer: identity, message });
    const mergeSha = putObject(repo, 'commit', data);
    repo.refs.set('refs/heads/' + pull.baseRef, mergeSha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = mergeSha;
    sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
    return true;
  }

  return false;
}
