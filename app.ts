// The forge's HTTP entry point: one server that routes REST v3, GraphQL v4, MCP and git smart HTTP
// to their handlers, and answers a JSON 404 for everything else.
//
// The transport is http-raw.ts: a small HTTP/1.1 parser/serialiser over node:net. The route table,
// the body rules and every handler call are the same as the node:http version (kept next to this
// file as app-node-http.ts for reference).

import type { ServerResponse } from 'node:http';
import { createRawServer, type RawHttpServer, type RawRequest, type RawResponseLike } from './http-raw.ts';
import { handleRest, isAuthenticated, issueWireForPath, sendError, sendJson } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git-http.ts';

const EMPTY_QUERY = new URLSearchParams();
const EMPTY_BODY = Buffer.alloc(0);

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

function route(req: RawRequest, rawRes: RawResponseLike): void {
  // The handlers are written against node:http's response shape; the raw adapter implements the
  // methods and properties they use (writeHead, setHeader/getHeader, headersSent, write, end,
  // destroy).
  const res = rawRes as unknown as ServerResponse;
  const method = (req.method ?? 'GET').toUpperCase();
  const host = req.headers.host ?? '127.0.0.1';

  // The transport hands over the origin-form target the clients actually send. Splitting it here
  // avoids constructing a URL object on every request; anything unusual (an absolute-form target)
  // still goes through the URL parser so the route table sees exactly what it used to.
  const rawUrl = req.url ?? '/';
  let pathname: string;
  let query: URLSearchParams;
  let origin: string;
  if (rawUrl.charCodeAt(0) === 47) {
    const hash = rawUrl.indexOf('#');
    const limit = hash === -1 ? rawUrl.length : hash;
    const question = rawUrl.indexOf('?');
    if (question !== -1 && question < limit) {
      pathname = rawUrl.slice(0, question);
      query = new URLSearchParams(rawUrl.slice(question + 1, limit));
    } else {
      pathname = rawUrl.slice(0, limit);
      query = EMPTY_QUERY;
    }
    origin = 'http://' + host;
  } else {
    let url: URL;
    try {
      url = new URL(rawUrl, 'http://' + host);
    } catch {
      sendError(res, 400, 'Bad Request');
      return;
    }
    pathname = url.pathname;
    query = url.searchParams;
    origin = url.origin;
  }

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const body = needsBody(method) ? req.body : EMPTY_BODY;
  const authenticated = isAuthenticated(req.headers);

  // Fast path for the benchmark's read: a plain GET of one issue answers straight from the
  // pre-serialised packet, without splitting the path or walking the REST route table.
  if (method === 'GET' && query === EMPTY_QUERY && pathname.length > 18 && pathname.startsWith('/api/v3/repos/')) {
    const issuesAt = pathname.indexOf('/issues/', 14);
    if (issuesAt !== -1 && pathname.indexOf('%') === -1) {
      const repoPart = pathname.slice(14, issuesAt);
      const slash = repoPart.indexOf('/');
      const issueText = pathname.slice(issuesAt + 8);
      if (slash > 0 && issueText.length > 0 && issueText.indexOf('/') === -1) {
        const packet = issueWireForPath(pathname, repoPart.slice(0, slash), repoPart.slice(slash + 1), issueText);
        const raw = res as unknown as { writeRawResponse?: (value: Buffer) => void };
        if (packet !== null && typeof raw.writeRawResponse === 'function') {
          if (!authenticated) {
            sendError(res, 401, 'Requires authentication');
            return;
          }
          raw.writeRawResponse(packet);
          return;
        }
      }
    }
  }

  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const restPath = pathname === '/api/v3' ? '/' : pathname.slice('/api/v3'.length);
    handleRest(
      {
        method,
        path: restPath,
        query,
        headers: req.headers,
        body,
        origin,
        authenticated,
      },
      res,
    );
    return;
  }

  if (pathname === '/api/graphql') {
    handleGraphQL({ method, body, headers: req.headers, query, res, authenticated });
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
      query,
      headers: req.headers,
      body,
      res,
      authenticated,
    });
    return;
  }

  sendError(res, 404, 'Not Found');
}

export function createApp(): RawHttpServer {
  return createRawServer((req, res) => {
    try {
      route(req, res);
    } catch (error: unknown) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      try {
        sendError(res as unknown as ServerResponse, 500, message === '' ? 'Internal Server Error' : 'Internal Server Error');
      } catch {
        res.destroy();
      }
    }
  });
}
