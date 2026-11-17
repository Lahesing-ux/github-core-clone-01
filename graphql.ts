// The GitHub GraphQL v4 surface: the documents gh and github-mcp-server actually send, executed against
// the same in-memory store the REST v3 surface reads and writes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  buildCommit,
  commitTree,
  getRepo,
  hashBlob,
  listRepos,
  mergeBase,
  nextInstant,
  nowIso,
  putObject,
  readFiles,
  resolveRev,
  writeTreeFromFiles,
  type Comment,
  type Issue,
  type Pull,
  type PullFile,
  type Repo,
} from './store.ts';
import { nodeId, sendError, sendJson } from './rest.ts';

export interface GraphQLRequest {
  method: string;
  body: Buffer;
  headers: IncomingMessage['headers'];
  query: URLSearchParams;
  res: ServerResponse;
  authenticated: boolean;
}

// ---------------------------------------------------------------- small helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function integerArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function pageSize(value: unknown): number {
  return Math.max(0, Math.min(100, integerArg(value, 30)));
}

// ---------------------------------------------------------------- global ids

const REPO_ID_BASE = 1000;

function repoDatabaseId(repo: Repo): number {
  return REPO_ID_BASE + repo.seq;
}

function repoGlobalId(repo: Repo): string {
  return nodeId('Repository', String(repoDatabaseId(repo)));
}

function repoKey(repo: Repo): string {
  return repo.owner + '/' + repo.name;
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return nodeId('Issue', repoKey(repo) + '#' + issue.number);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return nodeId('PullRequest', repoKey(repo) + '#' + pull.number);
}

function commentGlobalId(repo: Repo, comment: Comment): string {
  return nodeId('IssueComment', repoKey(repo) + '#' + comment.id);
}

const NODE_TYPES: readonly string[] = ['IssueComment', 'PullRequest', 'Repository', 'Issue', 'User', 'Label', 'Commit', 'Ref', 'Tree', 'Blob', 'Tag'];

interface DecodedNode {
  type: string;
  id: string;
}

function decodeGlobalId(value: unknown): DecodedNode | null {
  if (typeof value !== 'string' || value === '') return null;
  let decoded: string;
  try {
    decoded = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded.startsWith('04:')) return null;
  const rest = decoded.slice(3);
  const type = NODE_TYPES.find((candidate) => rest.startsWith(candidate));
  if (type === undefined) return null;
  return { type, id: rest.slice(type.length) };
}

function repoByDatabaseId(databaseId: number): Repo | null {
  for (const repo of listRepos()) if (repoDatabaseId(repo) === databaseId) return repo;
  return null;
}

function repoFromGlobalId(value: unknown): Repo | null {
  const decoded = decodeGlobalId(value);
  if (decoded === null || decoded.type !== 'Repository') return null;
  const databaseId = Number(decoded.id);
  if (!Number.isInteger(databaseId)) return null;
  return repoByDatabaseId(databaseId);
}

interface RepoAndNumber {
  owner: string;
  name: string;
  number: number;
}

function splitRepoAndNumber(value: string): RepoAndNumber | null {
  const hash = value.lastIndexOf('#');
  if (hash <= 0) return null;
  const ownerRepo = value.slice(0, hash);
  const number = Number(value.slice(hash + 1));
  if (!Number.isInteger(number)) return null;
  const slash = ownerRepo.indexOf('/');
  if (slash <= 0) return null;
  return { owner: ownerRepo.slice(0, slash), name: ownerRepo.slice(slash + 1), number };
}

interface IssueRef {
  repo: Repo;
  issue: Issue;
}

interface PullRef {
  repo: Repo;
  pull: Pull;
}

interface CommentRef {
  repo: Repo;
  comment: Comment;
}

function locateIssue(value: unknown): IssueRef | null {
  const decoded = decodeGlobalId(value);
  if (decoded === null || decoded.type !== 'Issue') return null;
  const parts = splitRepoAndNumber(decoded.id);
  if (parts === null) return null;
  const repo = getRepo(parts.owner, parts.name);
  if (repo === null) return null;
  const issue = repo.issues.get(parts.number);
  return issue === undefined ? null : { repo, issue };
}

function locatePull(value: unknown): PullRef | null {
  const decoded = decodeGlobalId(value);
  if (decoded === null || decoded.type !== 'PullRequest') return null;
  const parts = splitRepoAndNumber(decoded.id);
  if (parts === null) return null;
  const repo = getRepo(parts.owner, parts.name);
  if (repo === null) return null;
  const pull = repo.pulls.get(parts.number);
  return pull === undefined ? null : { repo, pull };
}

// ---------------------------------------------------------------- diff and merge helpers (local to GraphQL)

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

function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  if (pull.files.length > 0) return pull.files;
  const headTip = resolveRev(repo, pull.headRef);
  const baseTip = resolveRev(repo, pull.baseRef);
  if (headTip === null) return pull.files;
  const common = mergeBase(repo, headTip, baseTip);
  return diffFiles(repo, common, headTip);
}

function pullHasConflict(repo: Repo, pull: Pull): boolean {
  const headTip = resolveRev(repo, pull.headRef);
  const baseTip = resolveRev(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return false;
  const common = mergeBase(repo, headTip, baseTip);
  const baseFiles = common === null ? new Map<string, Buffer>() : commitFiles(repo, common);
  const ourFiles = commitFiles(repo, baseTip);
  const theirFiles = commitFiles(repo, headTip);
  for (const name of new Set([...baseFiles.keys(), ...theirFiles.keys()])) {
    const baseBytes = baseFiles.get(name);
    const theirBytes = theirFiles.get(name);
    const ourBytes = ourFiles.get(name);
    const baseKey = baseBytes === undefined ? null : baseBytes.toString('base64');
    const theirKey = theirBytes === undefined ? null : theirBytes.toString('base64');
    const ourKey = ourBytes === undefined ? null : ourBytes.toString('base64');
    if (baseKey === theirKey) continue;
    if (baseKey !== ourKey) return true;
  }
  return false;
}

function mergeableState(repo: Repo, pull: Pull): string {
  if (pull.merged) return 'UNKNOWN';
  const headTip = resolveRev(repo, pull.headRef);
  const baseTip = resolveRev(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return 'UNKNOWN';
  return pullHasConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

function mergeIntoBase(repo: Repo, pull: Pull): void {
  if (pull.merged) throw new Error('Pull request is already merged');
  const baseTip = resolveRev(repo, pull.baseRef);
  const headTip = resolveRev(repo, pull.headRef);
  if (baseTip === null || headTip === null) throw new Error('Pull request is not mergeable: its head or base ref does not exist');
  const common = mergeBase(repo, headTip, baseTip);
  const baseFiles = common === null ? new Map<string, Buffer>() : commitFiles(repo, common);
  const ourFiles = commitFiles(repo, baseTip);
  const theirFiles = commitFiles(repo, headTip);
  const mergedFiles = new Map<string, Buffer>(ourFiles);
  let conflict = false;
  for (const name of new Set([...baseFiles.keys(), ...theirFiles.keys()])) {
    const baseBytes = baseFiles.get(name);
    const theirBytes = theirFiles.get(name);
    const ourBytes = ourFiles.get(name);
    const baseKey = baseBytes === undefined ? null : baseBytes.toString('base64');
    const theirKey = theirBytes === undefined ? null : theirBytes.toString('base64');
    const ourKey = ourBytes === undefined ? null : ourBytes.toString('base64');
    if (baseKey === theirKey) continue;
    if (baseKey !== ourKey) {
      conflict = true;
      break;
    }
    if (theirBytes === undefined) mergedFiles.delete(name);
    else mergedFiles.set(name, theirBytes);
  }
  if (conflict) throw new Error('Pull request is not mergeable');
  const tree = writeTreeFromFiles(repo, mergedFiles);
  const instant = nextInstant();
  const seconds = Math.floor(Date.parse(instant) / 1000);
  const identity = { name: VIEWER.name, email: VIEWER.email, seconds, offset: '+0000' };
  const message = pull.title + ' (#' + pull.number + ')' + (pull.body === '' ? '' : '\n\n' + pull.body);
  const data = buildCommit({ tree, parents: [baseTip], author: identity, committer: identity, message });
  const sha = putObject(repo, 'commit', data);
  repo.refs.set('refs/heads/' + pull.baseRef, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
}

// ---------------------------------------------------------------- cursors

function encodeCursor(number: number): string {
  return Buffer.from('cursor:' + number, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded.startsWith('cursor:')) return null;
  const number = Number(decoded.slice('cursor:'.length));
  return Number.isInteger(number) ? number : null;
}

// ---------------------------------------------------------------- the schema surface

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'databaseId', 'isViewer', 'email'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequests',
    'pullRequest',
    'createdAt',
    'description',
    'isPrivate',
  ],
  Ref: ['name', 'prefix'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closed', 'closedAt', 'author', 'repository', 'url'],
  IssueConnection: ['nodes', 'totalCount', 'pageInfo'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id',
    'number',
    'title',
    'body',
    'state',
    'merged',
    'mergeable',
    'headRefName',
    'baseRefName',
    'headRefOid',
    'baseRefOid',
    'mergedAt',
    'createdAt',
    'files',
    'changedFiles',
    'additions',
    'deletions',
    'isDraft',
    'url',
    'repository',
  ],
  PullRequestConnection: ['nodes', 'totalCount', 'pageInfo'],
  PullRequestChangedFileConnection: ['nodes', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'createdAt', 'author'],
  IssueCommentEdge: ['node'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['kind', 'name', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'isDeprecated', 'deprecationReason', 'args', 'type'],
  __EnumValue: ['name', 'description', 'isDeprecated'],
};

const ENUM_VALUES: Record<string, readonly string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
};

// ---------------------------------------------------------------- document parser

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

const PUNCTUATION = '{}()[]:$!=|&@';

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const length = source.length;
  while (index < length) {
    const ch = source[index];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if (PUNCTUATION.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', index)) {
        let end = source.indexOf('"""', index + 3);
        if (end === -1) end = length;
        tokens.push({ kind: 'string', value: source.slice(index + 3, end) });
        index = end === length ? length : end + 3;
        continue;
      }
      let value = '';
      let cursor = index + 1;
      while (cursor < length) {
        const current = source[cursor];
        if (current === '"') {
          cursor += 1;
          break;
        }
        if (current === '\\') {
          const next = source[cursor + 1] ?? '';
          cursor += 2;
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else if (next === 'b') value += '\b';
          else if (next === 'f') value += '\f';
          else if (next === '/') value += '/';
          else if (next === '"') value += '"';
          else if (next === '\\') value += '\\';
          else if (next === 'u') {
            const hex = source.slice(cursor, cursor + 4);
            value += String.fromCharCode(Number.parseInt(hex, 16) || 0);
            cursor += 4;
          } else value += next;
          continue;
        }
        value += current;
        cursor += 1;
      }
      tokens.push({ kind: 'string', value });
      index = cursor;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(source[index + 1] ?? ''))) {
      let cursor = index + 1;
      while (cursor < length && /[0-9.eE+\-]/.test(source[cursor])) cursor += 1;
      const raw = source.slice(index, cursor);
      tokens.push({ kind: /[.eE]/.test(raw) ? 'float' : 'int', value: raw });
      index = cursor;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let cursor = index + 1;
      while (cursor < length && /[_0-9A-Za-z]/.test(source[cursor])) cursor += 1;
      tokens.push({ kind: 'name', value: source.slice(index, cursor) });
      index = cursor;
      continue;
    }
    index += 1;
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

interface VariableRef {
  __variable: string;
}

function isVariableRef(value: unknown): value is VariableRef {
  return isRecord(value) && typeof value.__variable === 'string';
}

interface ArgumentNode {
  name: string;
  value: unknown;
}

interface FieldNode {
  alias: string | null;
  name: string;
  args: ArgumentNode[];
  selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface VariableDefinition {
  name: string;
  defaultValue: unknown;
}

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: VariableDefinition[];
  selections: SelectionNode[];
}

interface FragmentDefinition {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentDefinition>;
}

class ParseError extends Error {}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.peek().kind !== 'eof') {
      if (this.atPunct('{')) {
        operations.push({ kind: 'query', name: null, variables: [], selections: this.parseSelectionSet() });
        continue;
      }
      const token = this.peek();
      if (token.kind !== 'name') throw new ParseError('Syntax error: unexpected ' + JSON.stringify(token.value));
      if (token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        if (!this.atName('on')) throw new ParseError('Syntax error: expected "on" in the fragment definition');
        this.next();
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
        continue;
      }
      let kind: 'query' | 'mutation' = 'query';
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        if (token.value === 'mutation') kind = 'mutation';
      }
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const variables = this.atPunct('(') ? this.parseVariableDefinitions() : [];
      const selections = this.parseSelectionSet();
      operations.push({ kind, name, variables, selections });
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    const definitions: VariableDefinition[] = [];
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseTypeRef();
      let defaultValue: unknown = undefined;
      if (this.atPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      definitions.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return definitions;
  }

  private parseTypeRef(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseTypeRef();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    const selections: SelectionNode[] = [];
    this.expectPunct('{');
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new ParseError('Syntax error: unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.atPunct('...')) {
      this.next();
      if (this.atName('on')) {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.atPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.atPunct('(') ? this.parseArguments() : [];
    this.skipDirectives();
    const selections = this.atPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', field: { alias, name, args, selections } };
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      if (this.peek().kind === 'eof') throw new ParseError('Syntax error: unterminated arguments');
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): unknown {
    const token = this.peek();
    if (token.kind === 'punct') {
      if (token.value === '$') {
        this.next();
        return { __variable: this.expectName() };
      }
      if (token.value === '[') {
        this.next();
        const values: unknown[] = [];
        while (!this.atPunct(']')) values.push(this.parseValue());
        this.expectPunct(']');
        return values;
      }
      if (token.value === '{') {
        this.next();
        const object: Record<string, unknown> = {};
        while (!this.atPunct('}')) {
          const name = this.expectName();
          this.expectPunct(':');
          object[name] = this.parseValue();
        }
        this.expectPunct('}');
        return object;
      }
      if (token.value === '!') {
        this.next();
        return null;
      }
      throw new ParseError('Syntax error: unexpected ' + JSON.stringify(token.value));
    }
    this.next();
    if (token.kind === 'int' || token.kind === 'float') return Number(token.value);
    if (token.kind === 'string') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value;
    }
    throw new ParseError('Syntax error: unexpected end of the document');
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (this.index < this.tokens.length - 1) this.index += 1;
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private atName(value: string): boolean {
    const token = this.peek();
    return token.kind === 'name' && token.value === value;
  }

  private expectPunct(value: string): void {
    if (!this.atPunct(value)) throw new ParseError('Syntax error: expected ' + JSON.stringify(value));
    this.next();
  }

  private expectName(): string {
    const token = this.peek();
    if (token.kind !== 'name') throw new ParseError('Syntax error: expected a name');
    this.next();
    return token.value;
  }
}

// ---------------------------------------------------------------- execution

interface GraphQLErrorEntry {
  message: string;
  path?: (string | number)[];
}

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefinition>;
  errors: GraphQLErrorEntry[];
}

interface Entity {
  __entity: string;
  value: unknown;
}

function entity(kind: string, value: unknown): Entity {
  return { __entity: kind, value };
}

function isEntity(value: unknown): value is Entity {
  return isRecord(value) && typeof value.__entity === 'string';
}

function resolveValue(node: unknown, ctx: ExecContext): unknown {
  if (isVariableRef(node)) return ctx.variables[node.__variable];
  if (Array.isArray(node)) return node.map((entry) => resolveValue(entry, ctx));
  if (isRecord(node)) {
    const object: Record<string, unknown> = {};
    for (const key of Object.keys(node)) object[key] = resolveValue(node[key], ctx);
    return object;
  }
  return node;
}

function resolveArgs(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx);
  return args;
}

function executeSelections(kind: string, value: unknown, selections: readonly SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const field = selection.field;
      const key = field.alias ?? field.name;
      if (field.name === '__typename') {
        output[key] = kind;
        continue;
      }
      const known = TYPE_FIELDS[kind];
      if (known === undefined || !known.includes(field.name)) {
        ctx.errors.push({ message: 'Cannot query field "' + field.name + '" on type "' + kind + '".', path: [key] });
        continue;
      }
      let resolved: unknown;
      try {
        resolved = resolveField(kind, value, field.name, resolveArgs(field, ctx), ctx);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [key] });
        output[key] = null;
        continue;
      }
      output[key] = completeValue(resolved, field.selections, ctx);
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== kind) continue;
      Object.assign(output, executeSelections(kind, value, selection.selections, ctx));
      continue;
    }
    const fragment = ctx.fragments.get(selection.name);
    if (fragment === undefined) {
      ctx.errors.push({ message: 'Unknown fragment "' + selection.name + '".' });
      continue;
    }
    if (fragment.typeCondition !== kind) continue;
    Object.assign(output, executeSelections(kind, value, fragment.selections, ctx));
  }
  return output;
}

function completeValue(value: unknown, selections: readonly SelectionNode[], ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (isEntity(value)) {
    if (selections.length === 0) return {};
    return executeSelections(value.__entity, value.value, selections, ctx);
  }
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, selections, ctx));
  return value;
}

function resolveField(kind: string, current: unknown, name: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  switch (kind) {
    case 'Query':
      return resolveQueryField(name, args);
    case 'Mutation':
      return resolveMutationField(name, args);
    case 'User':
      return resolveUserField(current as typeof VIEWER, name);
    case 'Repository':
      return resolveRepositoryField(current as Repo, name, args);
    case 'Ref':
      return resolveRefField(current as { name: string }, name);
    case 'Issue':
      return resolveIssueField(current as IssueRef, name);
    case 'IssueConnection':
      return resolveIssueConnectionField(current as IssuesConnection, name);
    case 'PageInfo':
      return resolvePageInfoField(current as PageInfoValue, name);
    case 'PullRequest':
      return resolvePullRequestField(current as PullRef, name, args);
    case 'PullRequestConnection':
      return resolvePullRequestConnectionField(current as PullRequestsConnection, name);
    case 'PullRequestChangedFileConnection':
      return resolveChangedFileConnectionField(current as ChangedFilesConnection, name);
    case 'PullRequestChangedFile':
      return resolveChangedFileField(current as PullFile, name);
    case 'IssueComment':
      return resolveCommentField(current as CommentRef, name);
    case 'IssueCommentEdge':
      return isRecord(current) ? entity('IssueComment', (current as { node: CommentRef }).node) : null;
    case 'CreateIssuePayload':
      return resolveIssuePayloadField(current as IssueRef, name);
    case 'CloseIssuePayload':
      return resolveIssuePayloadField(current as IssueRef, name);
    case 'CreatePullRequestPayload':
      return resolvePullRequestPayloadField(current as PullRef, name);
    case 'MergePullRequestPayload':
      return resolvePullRequestPayloadField(current as PullRef, name);
    case 'AddCommentPayload':
      return isRecord(current) && name === 'commentEdge' ? entity('IssueCommentEdge', { node: current }) : null;
    case '__Type':
      return resolveIntrospectionTypeField(current as { name: string }, name);
    case '__Field':
      return resolveIntrospectionFieldField(current as { name: string }, name);
    case '__EnumValue':
      return resolveIntrospectionEnumValueField(current as { name: string }, name);
    default:
      return null;
  }
}

// ---------------------------------------------------------------- root fields

function resolveQueryField(name: string, args: Record<string, unknown>): unknown {
  if (name === 'viewer') return entity('User', VIEWER);
  if (name === 'repository') {
    const repo = getRepo(text(args.owner), text(args.name));
    return repo === null ? null : entity('Repository', repo);
  }
  if (name === 'node') {
    const decoded = decodeGlobalId(args.id);
    if (decoded === null) return null;
    if (decoded.type === 'Repository') {
      const repo = repoFromGlobalId(args.id);
      return repo === null ? null : entity('Repository', repo);
    }
    if (decoded.type === 'Issue') {
      const located = locateIssue(args.id);
      return located === null ? null : entity('Issue', located);
    }
    if (decoded.type === 'PullRequest') {
      const located = locatePull(args.id);
      return located === null ? null : entity('PullRequest', located);
    }
    if (decoded.type === 'User') return entity('User', VIEWER);
    return null;
  }
  if (name === '__type') {
    const typeName = text(args.name);
    if (TYPE_FIELDS[typeName] !== undefined) return entity('__Type', { name: typeName, isEnum: false });
    if (ENUM_VALUES[typeName] !== undefined) return entity('__Type', { name: typeName, isEnum: true });
    return null;
  }
  return null;
}

function resolveUserField(current: typeof VIEWER, name: string): unknown {
  if (name === 'id') return nodeId('User', VIEWER.id);
  if (name === 'login') return current.login;
  if (name === 'name') return current.name;
  if (name === 'email') return current.email;
  if (name === 'databaseId') return current.id;
  if (name === 'isViewer') return true;
  return null;
}

function resolveRepositoryField(repo: Repo, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'id':
      return repoGlobalId(repo);
    case 'databaseId':
      return repoDatabaseId(repo);
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return repoKey(repo);
    case 'owner':
      return entity('User', VIEWER);
    case 'defaultBranchRef':
      return entity('Ref', { name: repo.defaultBranch });
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'createdAt':
      return repo.createdAt;
    case 'description':
      return repo.description;
    case 'isPrivate':
      return repo.private;
    case 'issue': {
      const issue = repo.issues.get(integerArg(args.number, -1));
      return issue === undefined ? null : entity('Issue', { repo, issue });
    }
    case 'issues':
      return entity('IssueConnection', buildIssuesConnection(repo, args));
    case 'pullRequest': {
      const pull = repo.pulls.get(integerArg(args.number, -1));
      return pull === undefined ? null : entity('PullRequest', { repo, pull });
    }
    case 'pullRequests':
      return entity('PullRequestConnection', buildPullRequestsConnection(repo, args));
    default:
      return null;
  }
}

function resolveRefField(current: { name: string }, name: string): unknown {
  if (name === 'name') return current.name;
  if (name === 'prefix') return 'refs/heads/';
  return null;
}

// ---------------------------------------------------------------- connections

interface PageInfoValue {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

interface IssuesConnection {
  repo: Repo;
  issues: Issue[];
  totalCount: number;
  pageInfo: PageInfoValue;
}

interface PullRequestsConnection {
  repo: Repo;
  pulls: Pull[];
  totalCount: number;
  pageInfo: PageInfoValue;
}

interface ChangedFilesConnection {
  files: PullFile[];
  totalCount: number;
}

function buildIssuesConnection(repo: Repo, args: Record<string, unknown>): IssuesConnection {
  const states = Array.isArray(args.states)
    ? args.states.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.toUpperCase())
    : ['OPEN'];
  const wanted = new Set(states);
  const issues = [...repo.issues.values()].filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const orderField = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  issues.sort((left, right) => {
    let compare = 0;
    if (orderField === 'UPDATED_AT') compare = left.updatedAt < right.updatedAt ? -1 : left.updatedAt > right.updatedAt ? 1 : 0;
    else if (orderField === 'COMMENTS') compare = left.comments.length - right.comments.length;
    else compare = left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
    if (compare === 0) compare = left.number - right.number;
    return direction === 'ASC' ? compare : -compare;
  });
  let start = 0;
  const after = typeof args.after === 'string' ? args.after : null;
  if (after !== null) {
    const cursorNumber = decodeCursor(after);
    if (cursorNumber !== null) {
      const found = issues.findIndex((issue) => issue.number === cursorNumber);
      if (found >= 0) start = found + 1;
    }
  }
  const first = pageSize(args.first);
  const page = issues.slice(start, start + first);
  const end = start + page.length;
  return {
    repo,
    issues: page,
    totalCount: issues.length,
    pageInfo: {
      hasNextPage: end < issues.length,
      hasPreviousPage: start > 0,
      startCursor: page.length === 0 ? null : encodeCursor(page[0].number),
      endCursor: page.length === 0 ? null : encodeCursor(page[page.length - 1].number),
    },
  };
}

function buildPullRequestsConnection(repo: Repo, args: Record<string, unknown>): PullRequestsConnection {
  const states = Array.isArray(args.states)
    ? args.states.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.toUpperCase())
    : ['OPEN'];
  const wanted = new Set(states);
  const pulls = [...repo.pulls.values()].filter((pull) => wanted.has(pullState(pull)));
  pulls.sort((left, right) => right.number - left.number);
  let start = 0;
  const after = typeof args.after === 'string' ? args.after : null;
  if (after !== null) {
    const cursorNumber = decodeCursor(after);
    if (cursorNumber !== null) {
      const found = pulls.findIndex((pull) => pull.number === cursorNumber);
      if (found >= 0) start = found + 1;
    }
  }
  const first = pageSize(args.first);
  const page = pulls.slice(start, start + first);
  const end = start + page.length;
  return {
    repo,
    pulls: page,
    totalCount: pulls.length,
    pageInfo: {
      hasNextPage: end < pulls.length,
      hasPreviousPage: start > 0,
      startCursor: page.length === 0 ? null : encodeCursor(page[0].number),
      endCursor: page.length === 0 ? null : encodeCursor(page[page.length - 1].number),
    },
  };
}

function resolveIssueConnectionField(connection: IssuesConnection, name: string): unknown {
  if (name === 'nodes') return connection.issues.map((issue) => entity('Issue', { repo: connection.repo, issue }));
  if (name === 'totalCount') return connection.totalCount;
  if (name === 'pageInfo') return entity('PageInfo', connection.pageInfo);
  return null;
}

function resolvePullRequestConnectionField(connection: PullRequestsConnection, name: string): unknown {
  if (name === 'nodes') return connection.pulls.map((pull) => entity('PullRequest', { repo: connection.repo, pull }));
  if (name === 'totalCount') return connection.totalCount;
  if (name === 'pageInfo') return entity('PageInfo', connection.pageInfo);
  return null;
}

function resolvePageInfoField(pageInfo: PageInfoValue, name: string): unknown {
  if (name === 'hasNextPage') return pageInfo.hasNextPage;
  if (name === 'hasPreviousPage') return pageInfo.hasPreviousPage;
  if (name === 'startCursor') return pageInfo.startCursor;
  if (name === 'endCursor') return pageInfo.endCursor;
  return null;
}

function resolveChangedFileConnectionField(connection: ChangedFilesConnection, name: string): unknown {
  if (name === 'nodes') return connection.files.map((file) => entity('PullRequestChangedFile', file));
  if (name === 'totalCount') return connection.totalCount;
  return null;
}

function resolveChangedFileField(file: PullFile, name: string): unknown {
  if (name === 'path') return file.filename;
  if (name === 'additions') return file.additions;
  if (name === 'deletions') return file.deletions;
  if (name === 'changeType') {
    if (file.status === 'added') return 'ADDED';
    if (file.status === 'removed') return 'DELETED';
    if (file.status === 'renamed') return 'RENAMED';
    return 'MODIFIED';
  }
  return null;
}

// ---------------------------------------------------------------- issues and pull requests

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveIssueField(ref: IssueRef, name: string): unknown {
  switch (name) {
    case 'id':
      return issueGlobalId(ref.repo, ref.issue);
    case 'number':
      return ref.issue.number;
    case 'title':
      return ref.issue.title;
    case 'body':
      return ref.issue.body;
    case 'state':
      return issueState(ref.issue);
    case 'createdAt':
      return ref.issue.createdAt;
    case 'updatedAt':
      return ref.issue.updatedAt;
    case 'closedAt':
      return ref.issue.closedAt;
    case 'closed':
      return ref.issue.state === 'closed';
    case 'author':
      return entity('User', VIEWER);
    case 'repository':
      return entity('Repository', ref.repo);
    case 'url':
      return 'https://github.com/' + repoKey(ref.repo) + '/issues/' + ref.issue.number;
    default:
      return null;
  }
}

function resolvePullRequestField(ref: PullRef, name: string, args: Record<string, unknown>): unknown {
  const { repo, pull } = ref;
  switch (name) {
    case 'id':
      return pullGlobalId(repo, pull);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pullState(pull);
    case 'merged':
      return pull.merged;
    case 'mergeable':
      return mergeableState(repo, pull);
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'headRefOid':
      return resolveRev(repo, pull.headRef) ?? pull.headSha;
    case 'baseRefOid':
      return resolveRev(repo, pull.baseRef) ?? pull.baseSha;
    case 'mergedAt':
      return pull.mergedAt;
    case 'createdAt':
      return pull.createdAt;
    case 'isDraft':
      return false;
    case 'url':
      return 'https://github.com/' + repoKey(repo) + '/pull/' + pull.number;
    case 'repository':
      return entity('Repository', repo);
    case 'files': {
      const files = pullFiles(repo, pull);
      return entity('PullRequestChangedFileConnection', { files: files.slice(0, pageSize(args.first)), totalCount: files.length });
    }
    case 'changedFiles':
      return pullFiles(repo, pull).length;
    case 'additions': {
      let total = 0;
      for (const file of pullFiles(repo, pull)) total += file.additions;
      return total;
    }
    case 'deletions': {
      let total = 0;
      for (const file of pullFiles(repo, pull)) total += file.deletions;
      return total;
    }
    default:
      return null;
  }
}

function resolveCommentField(ref: CommentRef, name: string): unknown {
  switch (name) {
    case 'id':
      return commentGlobalId(ref.repo, ref.comment);
    case 'body':
      return ref.comment.body;
    case 'createdAt':
      return ref.comment.createdAt;
    case 'author':
      return entity('User', VIEWER);
    default:
      return null;
  }
}

function resolveIssuePayloadField(ref: IssueRef, name: string): unknown {
  return name === 'issue' ? entity('Issue', ref) : null;
}

function resolvePullRequestPayloadField(ref: PullRef, name: string): unknown {
  return name === 'pullRequest' ? entity('PullRequest', ref) : null;
}

// ---------------------------------------------------------------- introspection

interface IntrospectionTypeRef {
  name: string;
  isEnum: boolean;
}

function resolveIntrospectionTypeField(ref: IntrospectionTypeRef, name: string): unknown {
  switch (name) {
    case 'name':
      return ref.name;
    case 'kind':
      return ref.isEnum ? 'ENUM' : 'OBJECT';
    case 'description':
      return null;
    case 'fields': {
      if (ref.isEnum) return null;
      const fields = TYPE_FIELDS[ref.name];
      return fields === undefined ? null : fields.map((fieldName) => entity('__Field', { name: fieldName }));
    }
    case 'enumValues': {
      if (!ref.isEnum) return null;
      const values = ENUM_VALUES[ref.name];
      return values === undefined ? null : values.map((value) => entity('__EnumValue', { name: value }));
    }
    case 'inputFields':
      return [];
    case 'interfaces':
      return [];
    case 'possibleTypes':
      return [];
    default:
      return null;
  }
}

function resolveIntrospectionFieldField(ref: { name: string }, name: string): unknown {
  switch (name) {
    case 'name':
      return ref.name;
    case 'description':
      return null;
    case 'isDeprecated':
      return false;
    case 'deprecationReason':
      return null;
    case 'args':
      return [];
    case 'type':
      return entity('__Type', { name: 'String', isEnum: false });
    default:
      return null;
  }
}

function resolveIntrospectionEnumValueField(ref: { name: string }, name: string): unknown {
  switch (name) {
    case 'name':
      return ref.name;
    case 'description':
      return null;
    case 'isDeprecated':
      return false;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- mutations

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  return isRecord(args.input) ? args.input : {};
}

function resolveMutationField(name: string, args: Record<string, unknown>): unknown {
  const input = inputOf(args);
  if (name === 'createIssue') {
    const repo = repoFromGlobalId(input.repositoryId);
    if (repo === null) throw new Error('Could not resolve to a node with the global id of ' + JSON.stringify(input.repositoryId) + '.');
    const number = repo.nextIssue;
    repo.nextIssue += 1;
    const instant = nowIso();
    const issue: Issue = {
      number,
      title: text(input.title),
      body: text(input.body),
      state: 'open',
      labels: [],
      createdAt: instant,
      updatedAt: instant,
      closedAt: null,
      seq: number,
      comments: [],
    };
    repo.issues.set(number, issue);
    return entity('CreateIssuePayload', { repo, issue });
  }
  if (name === 'closeIssue') {
    const located = locateIssue(input.issueId);
    if (located === null) throw new Error('Could not resolve to a node with the global id of ' + JSON.stringify(input.issueId) + '.');
    located.issue.state = 'closed';
    located.issue.closedAt = nowIso();
    located.issue.updatedAt = nowIso();
    return entity('CloseIssuePayload', located);
  }
  if (name === 'createPullRequest') {
    const repo = repoFromGlobalId(input.repositoryId);
    if (repo === null) throw new Error('Could not resolve to a node with the global id of ' + JSON.stringify(input.repositoryId) + '.');
    const baseRef = text(input.baseRefName) === '' ? repo.defaultBranch : text(input.baseRefName);
    const headRef = text(input.headRefName);
    const headSha = resolveRev(repo, headRef);
    const baseSha = resolveRev(repo, baseRef);
    if (headSha === null || baseSha === null) throw new Error('No commits between ' + baseRef + ' and ' + headRef);
    const common = mergeBase(repo, headSha, baseSha);
    const number = repo.nextPull;
    repo.nextPull += 1;
    const pull: Pull = {
      number,
      title: text(input.title),
      body: text(input.body),
      state: 'open',
      headRef,
      baseRef,
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
    return entity('CreatePullRequestPayload', { repo, pull });
  }
  if (name === 'mergePullRequest') {
    const located = locatePull(input.pullRequestId);
    if (located === null) throw new Error('Could not resolve to a node with the global id of ' + JSON.stringify(input.pullRequestId) + '.');
    mergeIntoBase(located.repo, located.pull);
    return entity('MergePullRequestPayload', located);
  }
  if (name === 'addComment') {
    const located = locateIssue(input.subjectId);
    if (located === null) throw new Error('Could not resolve to a node with the global id of ' + JSON.stringify(input.subjectId) + '.');
    const comment: Comment = {
      id: located.repo.nextComment,
      body: text(input.body),
      createdAt: nowIso(),
      user: VIEWER,
    };
    located.repo.nextComment += 1;
    located.issue.comments.push(comment);
    return entity('AddCommentPayload', { repo: located.repo, comment });
  }
  return null;
}

// ---------------------------------------------------------------- request handling

function pickOperation(document: DocumentNode, operationName: string | null): OperationNode | null {
  if (document.operations.length === 0) return null;
  if (operationName === null) return document.operations[0];
  return document.operations.find((operation) => operation.name === operationName) ?? null;
}

function executeRequest(entry: unknown): Record<string, unknown> {
  if (!isRecord(entry) || typeof entry.query !== 'string' || entry.query.trim() === '') {
    return { data: null, errors: [{ message: 'No query string was present' }] };
  }
  const variables = isRecord(entry.variables) ? entry.variables : {};
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
  try {
    const document = new Parser(entry.query).parseDocument();
    const operation = pickOperation(document, operationName);
    if (operation === null) {
      return {
        data: null,
        errors: [{ message: operationName === null ? 'No operation found in the document' : 'Unknown operation named "' + operationName + '"' }],
      };
    }
    const mergedVariables: Record<string, unknown> = {};
    for (const definition of operation.variables) {
      if (definition.defaultValue !== undefined) mergedVariables[definition.name] = definition.defaultValue;
    }
    for (const key of Object.keys(variables)) mergedVariables[key] = variables[key];
    const ctx: ExecContext = { variables: mergedVariables, fragments: document.fragments, errors: [] };
    const data = executeSelections(operation.kind === 'mutation' ? 'Mutation' : 'Query', null, operation.selections, ctx);
    const body: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) body.errors = ctx.errors;
    return body;
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

export function handleGraphQL(request: GraphQLRequest): void {
  const method = request.method.toUpperCase();
  if (method !== 'POST') {
    sendError(request.res, 405, 'Method Not Allowed');
    return;
  }
  if (!request.authenticated) {
    sendError(request.res, 401, 'Requires authentication');
    return;
  }
  const raw = request.body.toString('utf8').trim();
  if (raw === '') {
    sendError(request.res, 400, 'Problems parsing JSON');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendError(request.res, 400, 'Problems parsing JSON');
    return;
  }
  if (Array.isArray(parsed)) {
    sendJson(request.res, 200, parsed.map((entry) => executeRequest(entry)));
    return;
  }
  if (!isRecord(parsed)) {
    sendError(request.res, 400, 'Problems parsing JSON');
    return;
  }
  sendJson(request.res, 200, executeRequest(parsed));
}
