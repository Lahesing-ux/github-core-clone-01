// The Model Context Protocol endpoint, streamable HTTP, at /mcp.
//
// The suite's client probes `server/discover` first, so this server speaks the modern 2026-07-28
// revision: one JSON body per request, no session, no GET stream. A small legacy handshake is
// answered too, for clients that predate server/discover. The tools operate on the same store as
// REST, so a change made here is visible there immediately.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, createRepo, getRepo, type Pull, type Repo } from './store.ts';
import {
  createIssueForRepo,
  createPullForRepo,
  issueJson,
  listIssuesForRepo,
  mergePullForRepo,
  pullJson,
  repoJson,
  sendJson,
  userJson,
} from './rest.ts';

export interface McpRequest {
  method: string;
  body: Buffer;
  headers: IncomingMessage['headers'];
  res: ServerResponse;
  authenticated: boolean;
}

const PREFERRED_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge2-mcp', version: '1.0.0' };

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

const TOOLS: readonly Record<string, unknown>[] = Object.freeze([
  {
    name: 'create_repo',
    title: 'Create a repository',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    title: 'Get a repository',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    title: 'Create an issue',
    description: 'Open a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to attach.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    title: 'Create a pull request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The branch with the changes.' },
        base: { type: 'string', description: 'The branch to merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    title: 'Merge a pull request',
    description: 'Merge an open pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function numberArg(args: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string, data?: unknown): void {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error });
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

interface ToolOutcome {
  result?: Record<string, unknown>;
  /** A JSON-RPC error instead of a tool result (unknown tool, missing arguments). */
  code?: number;
  message?: string;
}

function repoFor(args: Record<string, unknown>): { repo: Repo } | { message: string } {
  const owner = stringArg(args, 'owner') ?? VIEWER.login;
  const name = stringArg(args, 'repo') ?? stringArg(args, 'name');
  if (name === null) return { message: 'missing required argument: repo' };
  const repo = getRepo(owner, name);
  if (repo === null) return { message: 'repository not found: ' + owner + '/' + name };
  return { repo };
}

function pullByNumber(repo: Repo, number: number): Pull | null {
  return repo.pulls.get(number) ?? null;
}

function callTool(name: string, args: Record<string, unknown>): ToolOutcome {
  if (name === 'create_repo') {
    const repoName = stringArg(args, 'name') ?? stringArg(args, 'repo');
    if (repoName === null) return { code: JSON_RPC_INVALID_PARAMS, message: 'missing required argument: name' };
    const owner = stringArg(args, 'owner') ?? VIEWER.login;
    const description = typeof args.description === 'string' ? args.description : '';
    const isPrivate = args.private === true;
    const repo = createRepo(owner, repoName, isPrivate, description);
    if (repo === null) {
      if (getRepo(owner, repoName) !== null) return { result: toolFailure('a repository named ' + repoName + ' already exists') };
      return { result: toolFailure('could not create repository ' + owner + '/' + repoName) };
    }
    return { result: toolResult(repoJson(repo)) };
  }

  if (name === 'get_repo') {
    if (stringArg(args, 'owner') === null) return { code: JSON_RPC_INVALID_PARAMS, message: 'missing required argument: owner' };
    if (stringArg(args, 'repo') === null) return { code: JSON_RPC_INVALID_PARAMS, message: 'missing required argument: repo' };
    const found = repoFor(args);
    if ('message' in found) return { result: toolFailure(found.message) };
    return { result: toolResult(repoJson(found.repo)) };
  }

  if (name === 'create_issue') {
    for (const key of ['owner', 'repo', 'title']) {
      if (stringArg(args, key) === null) return { code: JSON_RPC_INVALID_PARAMS, message: 'missing required argument: ' + key };
    }
    const owner = stringArg(args, 'owner')!;
    const repoName = stringArg(args, 'repo')!;
    const repo = getRepo(owner, repoName);
    if (repo === null) return { result: toolFailure('repository not found: ' + owner + '/' + repoName) };
    const labels = Array.isArray(args.labels) ? args.labels.filter((entry): entry is string => typeof entry === 'string') : [];
    const created = createIssueForRepo(repo, {
      title: stringArg(args, 'title')!,
      body: typeof args.body === 'string' ? args.body : '',
      labels,
    });
    if (!created.ok) return { result: toolFailure(created.error) };
    return { result: toolResult(issueJson(repo, created.value)) };
  }

  if (name === 'list_issues') {
    for (const key of ['owner', 'repo']) {
      if (stringArg(args, key) === null) return { code: JSON_RPC_INVALID_PARAMS, message: 'missing required argument: ' + key };
    }
    const owner = stringArg(args, 'owner')!;
    const repoName = stringArg(args, 'repo')!;
    const repo = getRepo(owner, repoName);
    if (repo === null) return { result: toolFailure('repository not found: ' + owner + '/' + repoName) };
    const state = typeof args.state === 'string' && args.state !== '' ? args.state : 'open';
    const issues = listIssuesForRepo(repo, { state }).map((issue) => issueJson(repo, issue));
    return { result: toolResult(issues) };
  }

  if (name === 'create_pull_request') {
    for (const key of ['owner', 'repo', 'title', 'head', 'base']) {
      if (stringArg(args, key) === null) return { code: JSON_RPC_INVALID_PARAMS, message: 'missing required argument: ' + key };
    }
    const owner = stringArg(args, 'owner')!;
    const repoName = stringArg(args, 'repo')!;
    const repo = getRepo(owner, repoName);
    if (repo === null) return { result: toolFailure('repository not found: ' + owner + '/' + repoName) };
    const created = createPullForRepo(repo, {
      title: stringArg(args, 'title')!,
      body: typeof args.body === 'string' ? args.body : '',
      head: stringArg(args, 'head')!,
      base: stringArg(args, 'base')!,
    });
    if (!created.ok) return { result: toolFailure(created.error) };
    return { result: toolResult(pullJson(repo, created.value)) };
  }

  if (name === 'merge_pull_request') {
    for (const key of ['owner', 'repo']) {
      if (stringArg(args, key) === null) return { code: JSON_RPC_INVALID_PARAMS, message: 'missing required argument: ' + key };
    }
    const number = numberArg(args, ['pull_number', 'pull_request_number', 'pr_number', 'number']);
    if (number === null) return { code: JSON_RPC_INVALID_PARAMS, message: 'missing required argument: pull_number' };
    const owner = stringArg(args, 'owner')!;
    const repoName = stringArg(args, 'repo')!;
    const repo = getRepo(owner, repoName);
    if (repo === null) return { result: toolFailure('repository not found: ' + owner + '/' + repoName) };
    const pull = pullByNumber(repo, number);
    if (pull === null) return { result: toolFailure('pull request not found: #' + number) };
    const merged = mergePullForRepo(repo, pull);
    if (!merged.ok) return { result: toolFailure(merged.error) };
    return { result: toolResult({ merged: true, sha: merged.value, message: 'Pull Request successfully merged' }) };
  }

  return { code: JSON_RPC_INVALID_PARAMS, message: 'unknown tool: ' + name };
}

export function handleMcp(request: McpRequest): void {
  const { res, method } = request;

  if (!request.authenticated) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  if (method === 'DELETE') {
    if (res.headersSent) return;
    res.writeHead(204, { 'content-type': 'application/json; charset=utf-8' });
    res.end();
    return;
  }

  if (method === 'GET') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(request.body.toString('utf8')) as unknown;
  } catch {
    rpcError(res, 400, null, JSON_RPC_PARSE_ERROR, 'Parse error');
    return;
  }

  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      rpcError(res, 200, null, JSON_RPC_INVALID_REQUEST, 'Invalid Request');
      return;
    }
    const responses: unknown[] = [];
    for (const entry of payload) {
      const answer = dispatch(entry);
      if (answer !== null) responses.push(answer);
    }
    if (responses.length === 0) {
      res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
      res.end();
      return;
    }
    sendJson(res, 200, responses);
    return;
  }

  if (!isRecord(payload)) {
    rpcError(res, 200, null, JSON_RPC_INVALID_REQUEST, 'Invalid Request');
    return;
  }

  const answer = dispatch(payload);
  if (answer === null) {
    res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
    res.end();
    return;
  }
  sendJson(res, 200, answer);
}

interface RpcAnswer {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: Record<string, unknown>;
}

/** One JSON-RPC message; null for a notification (no id). */
function dispatch(payload: unknown): RpcAnswer | null {
  if (!isRecord(payload)) {
    return { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_INVALID_REQUEST, message: 'Invalid Request' } };
  }
  const id = payload.id === undefined ? null : payload.id;
  const method = typeof payload.method === 'string' ? payload.method : '';
  const params = isRecord(payload.params) ? payload.params : {};
  const notification = payload.id === undefined || payload.id === null;

  if (notification) {
    // notifications/initialized and any other notification are accepted, then forgotten.
    return null;
  }

  if (method === 'server/discover') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        resultType: 'complete',
        supportedVersions: [PREFERRED_REVISION, ...LEGACY_REVISIONS],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
        instructions: 'GitHub-compatible forge tools. All state is shared with the REST v3 and GraphQL v4 surfaces.',
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      },
    };
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = LEGACY_REVISIONS.includes(offered) ? offered : (LEGACY_REVISIONS[0] ?? '2025-11-25');
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const outcome = callTool(name, args);
    if (outcome.result !== undefined) return { jsonrpc: '2.0', id, result: outcome.result };
    return {
      jsonrpc: '2.0',
      id,
      error: { code: outcome.code ?? JSON_RPC_INVALID_PARAMS, message: outcome.message ?? 'Invalid params' },
    };
  }

  return { jsonrpc: '2.0', id, error: { code: JSON_RPC_METHOD_NOT_FOUND, message: 'Method not found: ' + method } };
}

/** The authenticated viewer, for callers that need it (kept exported for completeness). */
export function mcpViewer(): Record<string, unknown> {
  return userJson();
}
