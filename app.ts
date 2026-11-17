// The forge's HTTP surface: one server that answers the REST v3 API, GraphQL v4, MCP over
// streamable HTTP and git smart HTTP, all from the same store. main.ts owns the trial lifecycle;
// this file is the server it starts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest, isAuthenticated, sendError, sendJson, type ApiRequest } from './rest.ts';
import { handleGit } from './git-http.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const API_PREFIX = '/api/v3';

/** Bodies are small in this trial (contents are the largest); a cap keeps a stray upload bounded. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return 'http://' + (typeof host === 'string' && host !== '' ? host : '127.0.0.1');
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === API_PREFIX || path.startsWith(API_PREFIX + '/')) {
    const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    const request: ApiRequest = {
      method,
      path: path.slice(API_PREFIX.length),
      query: queryOf(req),
      headers: req.headers,
      body,
      origin: originOf(req),
      authenticated: isAuthenticated(req.headers),
    };
    handleRest(request, res);
    return;
  }

  if (path === '/api/graphql') {
    const body = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    handleGraphQL({ method, body, headers: req.headers, query: queryOf(req), res, authenticated: isAuthenticated(req.headers) });
    return;
  }

  if (path === '/mcp' || path.startsWith('/mcp/')) {
    const body = method === 'GET' || method === 'DELETE' ? Buffer.alloc(0) : await readBody(req);
    handleMcp({ method, body, headers: req.headers, res, authenticated: isAuthenticated(req.headers) });
    return;
  }

  const git = /^\/([^/]+)\/([^/]+?)\.git(\/.*)?$/.exec(path);
  if (git !== null) {
    const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    handleGit({
      owner: decodeURIComponent(git[1]),
      repo: decodeURIComponent(git[2]),
      rest: git[3] ?? '/',
      method,
      query: queryOf(req),
      headers: req.headers,
      body,
      res,
      authenticated: isAuthenticated(req.headers),
    });
    return;
  }

  sendError(res, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ message: 'Internal Server Error: ' + message }) + '\n');
      } else {
        res.end();
      }
    });
  });
}
