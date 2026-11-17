// forge/mcp.ts: the Model Context Protocol surface — JSON-RPC 2.0 over the streamable HTTP
// transport, answered from the same in-memory store the REST v3 API serves (an object written by a
// tool here is the object REST reads back, never a copy).
//
// Era. This endpoint speaks the current 2026-07-28 revision: `server/discover` answers the server
// identity, its tools capability and the revisions it supports in one request, every request declares
// its revision in `_meta`, and there is no handshake and no protocol session. The legacy `initialize`
// handshake is answered too — statelessly, without handing out a session id — so an older client can
// still connect and use the same tools.
//
// Transport. One POST carries one JSON-RPC request (or a batch array) and is answered by one JSON
// body with `content-type: application/json`; a body that is not JSON answers HTTP 400 with -32700;
// a request without a bearer token answers HTTP 401 before anything is decoded; GET is refused with
// 405 because this server offers no server-initiated stream and DELETE is refused with 405 because
// it keeps no sessions. A JSON-RPC notification gets HTTP 202 and no body.
//
// Tools. Every tool takes the arguments `github-mcp-server` documents (owner, repo, title, body,
// head, base, pull_number), validates them itself, and answers either a text + structuredContent
// result or an `isError: true` result; an unknown tool name is JSON-RPC -32602, never HTTP 500.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { nodeId } from './rest.ts';
import {
  VIEWER,
  buildCommit,
  commitTree,
  createRepo,
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
} from './store.ts';
import type { Issue, Label, Pull, PullFile, Repo } from './store.ts';

export interface McpRequest {
  method: string;
  body: Buffer;
  headers: IncomingMessage['headers'];
  res: ServerResponse;
  authenticated: boolean;
}

type Json = Record<string, unknown>;
type JsonRpcId = string | number | null;

interface JsonRpcAnswer {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface TextBlock {
  type: 'text';
  text: string;
}

interface ToolResult {
  content: TextBlock[];
  structuredContent?: Json;
  isError?: boolean;
  resultType?: string;
}

interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  run(args: Json): ToolResult;
}

// ---------------------------------------------------------------- protocol constants

/** The current revision this endpoint declares; the newest entry of the supported list. */
const PROTOCOL_VERSION = '2026-07-28';

/** The revisions this server can answer; the suite's client picks the current one. */
const SUPPORTED_VERSIONS: readonly string[] = [PROTOCOL_VERSION, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** The identity every discover result and initialize result reports, whose name/version are graded. */
const SERVER_INFO: Readonly<{ name: string; version: string }> = Object.freeze({ name: 'makefun-forge', version: '1.0.0' });

/** What a discovering client is told this server is for. */
const INSTRUCTIONS =
  'A GitHub-compatible forge. The tools read and write the same repositories, issues and pull requests the REST v3 API serves, so anything written here is visible at /api/v3 immediately.';

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;
/** A transport-level authentication refusal, reported as HTTP 401 as well. */
const JSON_RPC_UNAUTHORIZED = -32001;

const UNAUTHORIZED_MESSAGE = 'Unauthorized: the MCP endpoint requires a bearer token.';

// ---------------------------------------------------------------- transport

/** Answer one MCP request; the router hands every method on /mcp here. */
export function handleMcp(request: McpRequest): void {
  try {
    serve(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (request.res.headersSent) {
      request.res.end();
      return;
    }
    writeJson(request.res, 200, answerError(null, JSON_RPC_INTERNAL_ERROR, 'Internal error: ' + message));
  }
}

/** The transport proper: method, authentication, body, dispatch. */
function serve(request: McpRequest): void {
  const method = request.method.toUpperCase();
  if (method !== 'POST') {
    // No server-initiated SSE stream (GET) and no session store (DELETE): POST is the only verb.
    writeEmpty(request.res, 405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' });
    return;
  }
  if (!request.authenticated) {
    writeJson(request.res, 401, answerError(null, JSON_RPC_UNAUTHORIZED, UNAUTHORIZED_MESSAGE));
    return;
  }
  const text = request.body.toString('utf8');
  if (text.trim() === '') {
    writeJson(request.res, 400, answerError(null, JSON_RPC_PARSE_ERROR, 'Parse error: the request body is empty.'));
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    writeJson(request.res, 400, answerError(null, JSON_RPC_PARSE_ERROR, 'Parse error: the request body is not JSON.'));
    return;
  }
  if (Array.isArray(payload)) {
    // JSON-RPC batching: one answer per request, none for a notification; an all-notification batch
    // gets the 202 the transport gives a notification.
    const answers: JsonRpcAnswer[] = [];
    for (const entry of payload) {
      const answer = dispatchMessage(entry);
      if (answer !== null) answers.push(answer);
    }
    if (answers.length === 0) {
      writeEmpty(request.res, 202, {});
      return;
    }
    writeJson(request.res, 200, answers);
    return;
  }
  const answer = dispatchMessage(payload);
  if (answer === null) {
    // A notification: accepted, nothing to say.
    writeEmpty(request.res, 202, {});
    return;
  }
  writeJson(request.res, 200, answer);
}

/** Write one JSON body with the transport's content type. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const text = JSON.stringify(body) + '\n';
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** Write a bodyless answer (202 for a notification, 405 for a verb this endpoint does not offer). */
function writeEmpty(res: ServerResponse, status: number, headers: Record<string, string>): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end();
}

// ---------------------------------------------------------------- JSON-RPC

/** The id a message carries: a string, a number, or null (never a missing id). */
function idOf(value: unknown): JsonRpcId {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}

function answerResult(id: JsonRpcId, result: unknown): JsonRpcAnswer {
  return { jsonrpc: '2.0', id, result };
}

function answerError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcAnswer {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

/**
 * One decoded message: a request answers an answer, a notification answers null. The id a request
 * carried is echoed exactly — a string id stays a string (the suite uses one for its discover probe
 * and two concurrent calls).
 */
function dispatchMessage(value: unknown): JsonRpcAnswer | null {
  if (!isRecord(value)) {
    return answerError(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request: a JSON-RPC message must be an object.');
  }
  const hasId = Object.prototype.hasOwnProperty.call(value, 'id');
  const id = idOf(value.id);
  const method = typeof value.method === 'string' ? value.method : '';
  if (method === '') {
    return hasId ? answerError(id, JSON_RPC_INVALID_REQUEST, 'Invalid Request: the message names no method.') : null;
  }
  const params = isRecord(value.params) ? value.params : {};
  const answer = handleRpc(method, params, id);
  return hasId ? answer : null;
}

/** The RPC surface itself. */
function handleRpc(method: string, params: Json, id: JsonRpcId): JsonRpcAnswer {
  switch (method) {
    case 'server/discover':
      return answerResult(id, discoverResult());
    case 'initialize':
      return answerResult(id, initializeResult(params));
    case 'ping':
      return answerResult(id, {});
    case 'tools/list':
      return answerResult(id, { resultType: 'complete', tools: TOOL_LIST });
    case 'tools/call':
      return callTool(id, params);
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return answerResult(id, {});
    default:
      return answerError(id, JSON_RPC_METHOD_NOT_FOUND, 'Method not found: ' + method);
  }
}

/** The 2026-07-28 discover result: identity, capabilities and the revisions this server answers. */
function discoverResult(): Json {
  const serverInfo = { name: SERVER_INFO.name, version: SERVER_INFO.version };
  return {
    resultType: 'complete',
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: { listChanged: false } },
    instructions: INSTRUCTIONS,
    serverInfo,
    _meta: { 'io.modelcontextprotocol/serverInfo': { ...serverInfo } },
  };
}

/** The legacy handshake's answer: the revision the client asked for when it is one we speak, else the current one. */
function initializeResult(params: Json): Json {
  const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
  const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_INFO.name, version: SERVER_INFO.version },
    instructions: INSTRUCTIONS,
  };
}

/** tools/call: resolve the tool, run it, wrap both failures and successes in a tool result. */
function callTool(id: JsonRpcId, params: Json): JsonRpcAnswer {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = name === '' ? undefined : TOOL_BY_NAME.get(name);
  if (tool === undefined) {
    return answerError(id, JSON_RPC_INVALID_PARAMS, 'Invalid params: no tool named ' + (name === '' ? '(missing name)' : name) + '.');
  }
  const args = isRecord(params.arguments) ? params.arguments : {};
  return answerResult(id, executeTool(tool, args));
}

/** Run one tool; an unexpected throw is a tool error, never a transport error. */
function executeTool(tool: McpTool, args: Json): ToolResult {
  try {
    return tool.run(args);
  } catch (error) {
    return failure('The tool failed: ' + (error instanceof Error ? error.message : String(error)));
  }
}

// ---------------------------------------------------------------- tool result and argument helpers

/** Whether a decoded value is a plain record. */
function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A successful tool result: text for a reader plus structuredContent for the suite's REST parity checks. */
function success(value: Json, text?: string): ToolResult {
  return {
    content: [{ type: 'text', text: text ?? JSON.stringify(value, null, 2) }],
    structuredContent: value,
    resultType: 'complete',
  };
}

/** A failed tool result: isError true, the reason in the text block. */
function failure(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** The refusal a tool gives when required arguments are missing (the suite accepts isError for it). */
function missingArguments(tool: string, names: readonly string[]): ToolResult {
  return failure('Missing required argument' + (names.length === 1 ? '' : 's') + ' for ' + tool + ': ' + names.join(', ') + '.');
}

/** A string argument (numbers are rendered, absent or non-scalar values are the empty string). */
function textArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** A boolean argument, or undefined when it was not a boolean. */
function boolArg(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** An integer argument from a JSON number or a decimal string, or null. */
function intArg(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** A branch name out of an argument: `owner:branch` collapses to `branch`, `refs/heads/x` stays. */
function branchName(value: string): string {
  const trimmed = value.trim();
  const colon = trimmed.indexOf(':');
  return colon >= 0 ? trimmed.slice(colon + 1).trim() : trimmed;
}

/** The ref a branch name lives at in the store. */
function refKey(branch: string): string {
  return branch.startsWith('refs/') ? branch : 'refs/heads/' + branch;
}

// ---------------------------------------------------------------- tools

const TOOLS: readonly McpTool[] = [
  {
    name: 'create_repo',
    title: 'Create repository',
    description: 'Create a repository under the authenticated viewer. The new repository is served by the REST v3 API at the same path immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name, without the owner prefix.' },
        description: { type: 'string', description: 'Short repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'Owner login; defaults to the authenticated viewer.' },
      },
      required: ['name'],
    },
    run(args: Json): ToolResult {
      const name = textArg(args.name).trim();
      if (name === '') return missingArguments('create_repo', ['name']);
      const owner = textArg(args.owner).trim() || VIEWER.login;
      const repo = createRepo(owner, name, boolArg(args.private) === true, textArg(args.description));
      if (repo === null) return failure('Could not create ' + owner + '/' + name + ': it already exists, or the owner is not the authenticated viewer.');
      const view = repoView(repo);
      return success(view, 'Created ' + String(view.full_name) + ' (id ' + String(view.id) + ').');
    },
  },
  {
    name: 'get_repo',
    title: 'Get repository',
    description: 'Read one repository by owner and name: its id, visibility, description and default branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run(args: Json): ToolResult {
      const owner = textArg(args.owner).trim();
      const name = textArg(args.repo).trim();
      const missing: string[] = [];
      if (owner === '') missing.push('owner');
      if (name === '') missing.push('repo');
      if (missing.length > 0) return missingArguments('get_repo', missing);
      const repo = getRepo(owner, name);
      if (repo === null) return failure('Repository ' + owner + '/' + name + ' was not found.');
      return success(repoView(repo), 'Repository ' + repo.owner + '/' + repo.name + ' (id ' + String(1000 + repo.seq) + '), default branch ' + repo.defaultBranch + '.');
    },
  },
  {
    name: 'list_repos',
    title: 'List repositories',
    description: 'List the repositories this server holds, optionally filtered to one owner.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Only repositories owned by this login.' },
      },
    },
    run(args: Json): ToolResult {
      const wanted = textArg(args.owner).trim().toLowerCase();
      const views = listRepos()
        .filter((repo) => wanted === '' || repo.owner.toLowerCase() === wanted)
        .map((repo) => repoView(repo));
      return success({ total_count: views.length, repositories: views });
    },
  },
  {
    name: 'create_issue',
    title: 'Create issue',
    description: 'Open an issue in a repository; the REST v3 issues list serves it at once. Labels must already exist on the repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body (Markdown).' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names that already exist on the repository.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run(args: Json): ToolResult {
      const owner = textArg(args.owner).trim();
      const repoName = textArg(args.repo).trim();
      const title = textArg(args.title);
      const missing: string[] = [];
      if (owner === '') missing.push('owner');
      if (repoName === '') missing.push('repo');
      if (title.trim() === '') missing.push('title');
      if (missing.length > 0) return missingArguments('create_issue', missing);
      const repo = getRepo(owner, repoName);
      if (repo === null) return failure('Repository ' + owner + '/' + repoName + ' was not found.');
      const labels: Label[] = [];
      const wanted = Array.isArray(args.labels) ? args.labels : [];
      for (const entry of wanted) {
        const labelName = textArg(entry);
        const label = repo.labels.get(labelName);
        if (label === undefined) return failure('Label ' + labelName + ' does not exist on ' + repo.owner + '/' + repo.name + '.');
        labels.push(label);
      }
      const number = repo.nextIssue;
      repo.nextIssue += 1;
      const instant = nowIso();
      const issue: Issue = {
        number,
        title,
        body: textArg(args.body),
        state: 'open',
        labels,
        createdAt: instant,
        updatedAt: instant,
        closedAt: null,
        seq: number,
        comments: [],
      };
      repo.issues.set(number, issue);
      const view = issueView(repo, issue);
      return success(view, 'Created issue #' + String(number) + ' in ' + repo.owner + '/' + repo.name + ': ' + title + '.');
    },
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'List a repository\'s issues, filtered by state (open, closed or all) when one is given.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter; open when omitted.' },
      },
      required: ['owner', 'repo'],
    },
    run(args: Json): ToolResult {
      const owner = textArg(args.owner).trim();
      const repoName = textArg(args.repo).trim();
      const missing: string[] = [];
      if (owner === '') missing.push('owner');
      if (repoName === '') missing.push('repo');
      if (missing.length > 0) return missingArguments('list_issues', missing);
      const repo = getRepo(owner, repoName);
      if (repo === null) return failure('Repository ' + owner + '/' + repoName + ' was not found.');
      const state = (textArg(args.state).trim() || 'open').toLowerCase();
      let items = [...repo.issues.values()];
      if (state !== 'all') items = items.filter((issue) => issue.state === state);
      items.sort((left, right) => left.number - right.number);
      const views = items.map((issue) => issueView(repo, issue));
      return success({ total_count: views.length, issues: views });
    },
  },
  {
    name: 'get_issue',
    title: 'Get issue',
    description: 'Read one issue by number, with its state, labels and comment count.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        issue_number: { type: 'integer', description: 'Issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    run(args: Json): ToolResult {
      const owner = textArg(args.owner).trim();
      const repoName = textArg(args.repo).trim();
      const number = intArg(args.issue_number);
      const missing: string[] = [];
      if (owner === '') missing.push('owner');
      if (repoName === '') missing.push('repo');
      if (number === null) missing.push('issue_number');
      if (missing.length > 0) return missingArguments('get_issue', missing);
      const repo = getRepo(owner, repoName);
      if (repo === null) return failure('Repository ' + owner + '/' + repoName + ' was not found.');
      const issue = repo.issues.get(number as number);
      if (issue === undefined) return failure('Issue #' + String(number) + ' was not found in ' + repo.owner + '/' + repo.name + '.');
      return success(issueView(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    title: 'Create pull request',
    description: 'Open a pull request from a head branch into a base branch; both refs must already exist. The REST v3 API reads it back at /pulls/{number}.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body (Markdown).' },
        head: { type: 'string', description: 'Branch the change comes from.' },
        base: { type: 'string', description: 'Branch the change should land on; defaults to the repository default branch.' },
      },
      required: ['owner', 'repo', 'title', 'head'],
    },
    run(args: Json): ToolResult {
      const owner = textArg(args.owner).trim();
      const repoName = textArg(args.repo).trim();
      const title = textArg(args.title);
      const headRef = branchName(textArg(args.head));
      const missing: string[] = [];
      if (owner === '') missing.push('owner');
      if (repoName === '') missing.push('repo');
      if (title.trim() === '') missing.push('title');
      if (headRef === '') missing.push('head');
      if (missing.length > 0) return missingArguments('create_pull_request', missing);
      const repo = getRepo(owner, repoName);
      if (repo === null) return failure('Repository ' + owner + '/' + repoName + ' was not found.');
      const baseRef = branchName(textArg(args.base)) || repo.defaultBranch;
      const headSha = resolveRev(repo, headRef);
      const baseSha = resolveRev(repo, baseRef);
      if (headSha === null || baseSha === null) return failure('Validation Failed: no commits between ' + baseRef + ' and ' + headRef + ' (one of the refs does not exist).');
      const common = mergeBase(repo, headSha, baseSha);
      const number = repo.nextPull;
      repo.nextPull += 1;
      const pull: Pull = {
        number,
        title,
        body: textArg(args.body),
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
      const view = pullView(repo, pull);
      return success(view, 'Created pull request #' + String(number) + ': ' + headRef + ' -> ' + baseRef + '.');
    },
  },
  {
    name: 'merge_pull_request',
    title: 'Merge pull request',
    description: 'Merge a pull request into its base branch by number; the REST v3 API then reads merged:true. A conflicting pull request is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
        commit_title: { type: 'string', description: 'Title of the merge commit; defaults to the pull request title.' },
        commit_message: { type: 'string', description: 'Additional message body for the merge commit.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run(args: Json): ToolResult {
      const owner = textArg(args.owner).trim();
      const repoName = textArg(args.repo).trim();
      const number = intArg(args.pull_number);
      const missing: string[] = [];
      if (owner === '') missing.push('owner');
      if (repoName === '') missing.push('repo');
      if (number === null) missing.push('pull_number');
      if (missing.length > 0) return missingArguments('merge_pull_request', missing);
      const repo = getRepo(owner, repoName);
      if (repo === null) return failure('Repository ' + owner + '/' + repoName + ' was not found.');
      const pull = repo.pulls.get(number as number);
      if (pull === undefined) return failure('Pull request #' + String(number) + ' was not found in ' + repo.owner + '/' + repo.name + '.');
      return mergePull(repo, pull, textArg(args.commit_title), textArg(args.commit_message));
    },
  },
];

/** The tools/list payload, built once: two answers are byte-identical by construction. */
const TOOL_LIST: readonly Json[] = TOOLS.map((tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: tool.inputSchema,
}));

const TOOL_BY_NAME: ReadonlyMap<string, McpTool> = new Map(TOOLS.map((tool) => [tool.name, tool]));

// ---------------------------------------------------------------- REST-shaped views

/** A repository as MCP answers it: the ids rest.ts assigns, so both surfaces name the same object. */
function repoView(repo: Repo): Json {
  const id = 1000 + repo.seq;
  return {
    id,
    node_id: nodeId('Repository', id),
    name: repo.name,
    full_name: repo.owner + '/' + repo.name,
    owner: { id: VIEWER.id, login: repo.owner, type: 'User' },
    private: repo.private,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    visibility: repo.private ? 'private' : 'public',
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name,
    html_url: 'https://github.com/' + repo.owner + '/' + repo.name,
    clone_url: 'https://github.com/' + repo.owner + '/' + repo.name + '.git',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

/** A label as REST renders it. */
function labelView(label: Label): Json {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

/** An issue as MCP answers it: id 100000 + number, exactly the id rest.ts's issueJson uses. */
function issueView(repo: Repo, issue: Issue): Json {
  const base = '/api/v3/repos/' + repo.owner + '/' + repo.name + '/issues/' + issue.number;
  return {
    id: 100000 + issue.number,
    node_id: nodeId('Issue', 100000 + issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    locked: false,
    user: { id: VIEWER.id, login: VIEWER.login, type: 'User' },
    labels: issue.labels.map(labelView),
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
    url: base,
    comments_url: base + '/comments',
    events_url: base + '/events',
    labels_url: base + '/labels{/name}',
  };
}

/** A pull request as MCP answers it, keeping the head/base ref names REST compares. */
function pullView(repo: Repo, pull: Pull): Json {
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
    user: { id: VIEWER.id, login: VIEWER.login, type: 'User' },
    labels: [],
    milestone: null,
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    closed_at: pull.merged ? pull.mergedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    draft: false,
    head: { label: repo.owner + ':' + pull.headRef, ref: pull.headRef, sha: headSha },
    base: { label: repo.owner + ':' + pull.baseRef, ref: pull.baseRef, sha: baseSha },
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

// ---------------------------------------------------------------- pull request work on the store

/** Every file reachable from a commit, keyed by path (the same walk rest.ts uses for a diff). */
function filesOfCommit(repo: Repo, commitOid: string): Map<string, Buffer> {
  const tree = commitTree(repo, commitOid);
  if (tree === null) return new Map();
  return readFiles(repo, tree);
}

/** The added/removed line counts of one file, by multiset difference. */
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

/** The files a pull request changes between two commits. */
function diffFiles(repo: Repo, baseCommit: string | null, headCommit: string): PullFile[] {
  const baseFiles = baseCommit === null ? new Map<string, Buffer>() : filesOfCommit(repo, baseCommit);
  const headFiles = filesOfCommit(repo, headCommit);
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
      sha: hashBlob(after === undefined ? before ?? Buffer.alloc(0) : after),
    });
  }
  return files;
}

/**
 * Merge a pull request exactly as the REST route does: three-way merge the head into the base, write a
 * merge commit onto the base branch and mark the pull request merged. A conflicting file is a tool
 * error, not a partial write.
 */
function mergePull(repo: Repo, pull: Pull, commitTitle: string, commitMessage: string): ToolResult {
  if (pull.merged) return failure('Pull request #' + String(pull.number) + ' is already merged.');
  const baseTip = resolveRev(repo, pull.baseRef);
  const headTip = resolveRev(repo, pull.headRef);
  if (baseTip === null || headTip === null) return failure('Pull request #' + String(pull.number) + ' is not mergeable: a branch is missing.');
  const common = mergeBase(repo, headTip, baseTip);
  const baseFiles = common === null ? new Map<string, Buffer>() : filesOfCommit(repo, common);
  const ourFiles = filesOfCommit(repo, baseTip);
  const theirFiles = filesOfCommit(repo, headTip);
  const mergedFiles = new Map<string, Buffer>(ourFiles);
  for (const name of new Set([...baseFiles.keys(), ...theirFiles.keys()])) {
    const baseBytes = baseFiles.get(name);
    const theirBytes = theirFiles.get(name);
    const oursBytes = ourFiles.get(name);
    const baseKey = baseBytes === undefined ? null : baseBytes.toString('base64');
    const theirKey = theirBytes === undefined ? null : theirBytes.toString('base64');
    const ourKey = oursBytes === undefined ? null : oursBytes.toString('base64');
    if (baseKey === theirKey) continue;
    if (baseKey !== ourKey) return failure('Pull request #' + String(pull.number) + ' is not mergeable: ' + name + ' conflicts.');
    if (theirBytes === undefined) mergedFiles.delete(name);
    else mergedFiles.set(name, theirBytes);
  }
  const tree = writeTreeFromFiles(repo, mergedFiles);
  const instant = nextInstant();
  const seconds = Math.floor(Date.parse(instant) / 1000);
  const identity = { name: VIEWER.name, email: VIEWER.email, seconds, offset: '+0000' };
  const title = commitTitle.trim() === '' ? pull.title : commitTitle;
  const body = commitMessage.trim() === '' ? pull.body : commitMessage;
  const message = title + ' (#' + String(pull.number) + ')' + (body === '' ? '' : '\n\n' + body);
  const data = buildCommit({ tree, parents: [baseTip], author: identity, committer: identity, message });
  const mergeSha = putObject(repo, 'commit', data);
  repo.refs.set(refKey(pull.baseRef), mergeSha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = mergeSha;
  return success(pullView(repo, pull), 'Merged pull request #' + String(pull.number) + ' into ' + pull.baseRef + ' (' + mergeSha + ').');
}
