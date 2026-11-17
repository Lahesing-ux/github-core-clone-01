// The forge's HTTP entry point: one server that routes REST v3, GraphQL v4, MCP and git smart HTTP
// to their handlers, and answers a JSON 404 for everything else.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { handleRest, isAuthenticated, sendError, sendJson } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git-http.ts';

/** A request body larger than this is refused rather than buffered without bound. */
const MAX_BODY_BYTES = 128 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(error);
    };
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error('request body too large'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => fail(error));
    req.on('aborted', () => fail(new Error('request aborted')));
  });
}

function decodePathSegment(value: string | undefined): string {
  if (value === undefined) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function needsBody(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const host = req.headers.host ?? '127.0.0.1';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://' + host);
  } catch {
    sendError(res, 400, 'Bad Request');
    return;
  }
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const body = needsBody(method) ? await readBody(req) : Buffer.alloc(0);
  const authenticated = isAuthenticated(req.headers);

  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const restPath = pathname === '/api/v3' ? '/' : pathname.slice('/api/v3'.length);
    handleRest(
      {
        method,
        path: restPath,
        query: url.searchParams,
        headers: req.headers,
        body,
        origin: url.origin,
        authenticated,
      },
      res,
    );
    return;
  }

  if (pathname === '/api/graphql') {
    handleGraphQL({ method, body, headers: req.headers, query: url.searchParams, res, authenticated });
    return;
  }

  if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
    handleMcp({ method, body, headers: req.headers, res, authenticated });
    return;
  }

  const git = /^\/([^/]+)\/([^/]+)\.git(?=\/|$)(.*)$/.exec(pathname);
  if (git !== null) {
    const owner = decodePathSegment(git[1]);
    const repo = decodePathSegment(git[2]);
    let rest = git[3] ?? '';
    if (rest === '') rest = '/';
    if (!rest.startsWith('/')) rest = '/' + rest;
    handleGit({
      owner,
      repo,
      rest,
      method,
      query: url.searchParams,
      headers: req.headers,
      body,
      res,
      authenticated,
    });
    return;
  }

  sendError(res, 404, 'Not Found');
}

export function createApp(): Server {
  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      try {
        sendError(res, 500, message === '' ? 'Internal Server Error' : 'Internal Server Error');
      } catch {
        res.destroy();
      }
    });
  });
  // Nagle would add a delayed ACK per small reply on a bridge network; every request is latency-bound.
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });
  return server;
}
