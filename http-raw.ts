// A deliberately small HTTP/1.1 server on top of node:net.
//
// The forge's handlers only need a request's method, URL, headers and body, and answer with a
// status, a small set of headers and a body. That is a fraction of what node:http's
// IncomingMessage/ServerResponse pair does per request (stream state machines, timers, chunked
// encoder, header trailer bookkeeping), so this transport parses and serialises the wire format
// directly:
//
//   * one buffer per connection; requests are parsed as soon as their header block and
//     Content-Length body have arrived, and leftover bytes stay buffered for the next request;
//   * Content-Length is the only body framing. A Transfer-Encoding request is refused with 400
//     and the connection is closed rather than decoded;
//   * every response is serialised into a single Buffer (status line, headers, body) and handed
//     to one socket.write. Responses always carry Content-Length and are never chunked;
//   * HTTP/1.1 keep-alive is the default; Connection: close (and HTTP/1.0 without
//     Connection: keep-alive) ends the connection after one response.
//
// The server exposes the subset of the node:net Server surface main.ts and the conformance runner
// use: listen(port[, host][, callback]), address(), close([callback]), on() and once().

import { createServer } from 'node:net';
import type { AddressInfo, Server as NetServer, Socket } from 'node:net';

/** Bodies bigger than this are refused instead of buffered without bound (same limit as app.ts had). */
const MAX_BODY_BYTES = 128 * 1024 * 1024;
/** A header block larger than this is certainly not one of ours; refuse it instead of scanning forever. */
const MAX_HEADER_BYTES = 64 * 1024;
const EMPTY = Buffer.alloc(0);
const HEADER_END = Buffer.from('\r\n\r\n', 'latin1');

const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  411: 'Length Required',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  503: 'Service Unavailable',
};

export type RawHeaderValue = string | number | readonly string[];
export type RawHeaders = Record<string, string | string[] | undefined>;

/** The request view the route layer uses. Compatible with the IncomingMessage fields handlers read. */
export interface RawRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: RawHeaders;
  socket: Socket;
  /** The body parsed off the connection (empty when the request carried no Content-Length). */
  body: Buffer;
  /** Whether the connection stays open after this response. */
  keepAlive: boolean;
  /** Async body reader kept for the route layer's original body-handling shape. */
  readBody(): Promise<Buffer>;
}

export interface RawResponseLike {
  statusCode: number;
  statusMessage: string;
  headersSent: boolean;
  writableEnded: boolean;
  writeHead(status: number, headers?: Record<string, RawHeaderValue>): RawResponseLike;
  writeHead(status: number, statusMessage: string, headers?: Record<string, RawHeaderValue>): RawResponseLike;
  setHeader(name: string, value: RawHeaderValue): RawResponseLike;
  getHeader(name: string): RawHeaderValue | undefined;
  removeHeader(name: string): void;
  write(chunk: string | Uint8Array): boolean;
  end(body?: string | Uint8Array): RawResponseLike;
  destroy(): void;
}

type RequestHandler = (req: RawRequest, res: RawResponseLike) => void;

/** One complete request waiting for earlier responses on the same connection to finish. */
interface PendingRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: RawHeaders;
  body: Buffer;
  keepAlive: boolean;
}

function headerValueText(value: RawHeaderValue): string {
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function asBuffer(chunk: string | Uint8Array): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

class RawResponse implements RawResponseLike {
  statusCode = 200;
  statusMessage = '';
  headersSent = false;
  writableEnded = false;
  socket: Socket;

  private _headers: Map<string, RawHeaderValue>;
  private _chunks: Buffer[];
  private _requestMethod: string;
  private _keepAlive: boolean;
  private _httpVersion: string;
  private _finish: () => void;
  private _finished = false;

  constructor(socket: Socket, request: PendingRequest, finish: () => void) {
    this.socket = socket;
    this._headers = new Map();
    this._chunks = [];
    this._requestMethod = request.method;
    this._keepAlive = request.keepAlive;
    this._httpVersion = request.httpVersion;
    this._finish = finish;
  }

  writeHead(
    status: number,
    headersOrMessage?: Record<string, RawHeaderValue> | string,
    maybeHeaders?: Record<string, RawHeaderValue>,
  ): RawResponseLike {
    this.statusCode = status;
    let headers: Record<string, RawHeaderValue> | undefined;
    if (typeof headersOrMessage === 'string') {
      this.statusMessage = headersOrMessage;
      headers = maybeHeaders;
    } else {
      headers = headersOrMessage;
    }
    if (headers !== undefined) {
      for (const name of Object.keys(headers)) {
        const value = headers[name];
        if (value !== undefined) this._headers.set(name.toLowerCase(), value);
      }
    }
    this.headersSent = true;
    return this;
  }

  setHeader(name: string, value: RawHeaderValue): RawResponseLike {
    if (this.headersSent) throw new Error('Cannot set headers after they are sent to the client');
    this._headers.set(name.toLowerCase(), value);
    return this;
  }

  getHeader(name: string): RawHeaderValue | undefined {
    return this._headers.get(name.toLowerCase());
  }

  removeHeader(name: string): void {
    this._headers.delete(name.toLowerCase());
  }

  write(chunk: string | Uint8Array): boolean {
    if (this.writableEnded) return false;
    this.headersSent = true;
    this._chunks.push(asBuffer(chunk));
    return true;
  }

  end(body?: string | Uint8Array): RawResponseLike {
    if (this.writableEnded) return this;
    this.writableEnded = true;
    this.headersSent = true;
    if (body !== undefined) this._chunks.push(asBuffer(body));
    try {
      this._send();
    } finally {
      this._complete();
    }
    return this;
  }

  /**
   * Write a complete response packet the handler has already serialised (status line, headers and
   * body in one Buffer). The hot read path uses this to skip header assembly entirely; the buffered
   * protocol headers and the content-length are already in the bytes, so none are added here.
   */
  writeRawResponse(packet: Buffer): void {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.headersSent = true;
    this._chunks.length = 0;
    const socket = this.socket;
    if (!socket.destroyed) {
      try {
        socket.write(packet);
        if (!this._keepAlive) socket.end();
      } catch {
        socket.destroy();
      }
    }
    this._complete();
  }

  destroy(): void {
    if (!this.writableEnded) {
      this.writableEnded = true;
      this.headersSent = true;
    }
    const socket = this.socket;
    if (!socket.destroyed) socket.destroy();
    this._complete();
  }

  /** Serialise status line + headers + body into one Buffer and write it once. */
  private _send(): void {
    let body: Buffer;
    if (this._chunks.length === 0) body = EMPTY;
    else if (this._chunks.length === 1) body = this._chunks[0]!;
    else body = Buffer.concat(this._chunks);

    const status = this.statusCode;
    const statusText = this.statusMessage !== '' ? this.statusMessage : (STATUS_TEXT[status] ?? 'Unknown');
    const bodyAllowed = this._requestMethod !== 'HEAD' && status !== 204 && status !== 304;
    const contentLength = body.length;

    const parts: string[] = ['HTTP/1.1 ', String(status), ' ', statusText, '\r\n'];
    let sawConnection = false;
    for (const [name, value] of this._headers) {
      // The body determines Content-Length; a handler-supplied one is ignored so the framing and
      // the bytes written can never disagree.
      if (name === 'content-length') continue;
      if (name === 'transfer-encoding') continue;
      if (name === 'connection') sawConnection = true;
      if (Array.isArray(value)) {
        if (name === 'set-cookie') {
          for (const entry of value) parts.push(name, ': ', String(entry), '\r\n');
          continue;
        }
        parts.push(name, ': ', value.join(', '), '\r\n');
        continue;
      }
      parts.push(name, ': ', String(value), '\r\n');
    }
    parts.push('content-length: ', String(contentLength), '\r\n');
    if (!sawConnection) {
      if (!this._keepAlive) parts.push('connection: close\r\n');
      else if (this._httpVersion === 'HTTP/1.0') parts.push('connection: keep-alive\r\n');
    }
    parts.push('\r\n');

    const head = Buffer.from(parts.join(''), 'latin1');
    const packet = bodyAllowed && body.length > 0 ? Buffer.concat([head, body], head.length + body.length) : head;
    const socket = this.socket;
    if (!socket.destroyed) {
      try {
        socket.write(packet);
        if (!this._keepAlive) socket.end();
      } catch {
        socket.destroy();
      }
    }
  }

  private _complete(): void {
    if (this._finished) return;
    this._finished = true;
    this._finish();
  }
}

/** Refuse a request before a response object exists; the connection is not reusable afterwards. */
function refuse(socket: Socket, status: number, message: string): void {
  const body = Buffer.from(message + '\n', 'utf8');
  const text = STATUS_TEXT[status] ?? 'Bad Request';
  const head = Buffer.from(
    'HTTP/1.1 ' + status + ' ' + text + '\r\n' +
      'content-type: text/plain; charset=utf-8\r\n' +
      'content-length: ' + body.length + '\r\n' +
      'connection: close\r\n\r\n',
    'latin1',
  );
  try {
    socket.end(Buffer.concat([head, body], head.length + body.length));
  } catch {
    socket.destroy();
  }
}

interface ParsedHead {
  method: string;
  url: string;
  httpVersion: string;
  headers: RawHeaders;
  contentLength: number;
  keepAlive: boolean;
  expectContinue: boolean;
}

/**
 * Parse the request line and header lines straight out of the connection buffer. The hot path is
 * one request then one response, so this avoids the intermediate `text.split('\r\n')` arrays a
 * string-based parser allocates for every request.
 */
/** Case-insensitive compare of a header name in the buffer against a lowercase literal. */
function headerEquals(buffer: Buffer, start: number, end: number, text: string): boolean {
  if (end - start !== text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    let code = buffer[start + index]!;
    if (code >= 65 && code <= 90) code += 32;
    if (code !== text.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * The only request headers the forge reads, as one small dispatch: everything else a client sends
 * (accept, user-agent, accept-encoding, …) is skipped without allocating a name or a value.
 */
function headerCode(buffer: Buffer, start: number, end: number): number {
  switch (end - start) {
    case 4:
      return headerEquals(buffer, start, end, 'host') ? 5 : 0;
    case 6:
      return headerEquals(buffer, start, end, 'expect') ? 3 : 0;
    case 10:
      return headerEquals(buffer, start, end, 'connection') ? 4 : 0;
    case 12:
      if (headerEquals(buffer, start, end, 'git-protocol')) return 7;
      if (headerEquals(buffer, start, end, 'content-type')) return 8;
      return 0;
    case 13:
      return headerEquals(buffer, start, end, 'authorization') ? 6 : 0;
    case 14:
      return headerEquals(buffer, start, end, 'content-length') ? 1 : 0;
    case 17:
      return headerEquals(buffer, start, end, 'transfer-encoding') ? 2 : 0;
    default:
      return 0;
  }
}

function parseHead(buffer: Buffer, headerEnd: number): ParsedHead | string {
  // Request line: METHOD SP request-target SP HTTP-version CRLF.
  let firstSpace = -1;
  let lastSpace = -1;
  let cursor = 0;
  for (; cursor < headerEnd; cursor += 1) {
    const code = buffer[cursor];
    if (code === 32) {
      if (firstSpace === -1) firstSpace = cursor;
      else {
        lastSpace = cursor;
        break;
      }
    } else if (code === 13 || code === 10) {
      break;
    }
  }
  if (firstSpace <= 0 || lastSpace <= firstSpace) return 'malformed request line';
  let lineEnd = lastSpace + 1;
  while (lineEnd < headerEnd && buffer[lineEnd] !== 13) lineEnd += 1;
  const versionLength = lineEnd - lastSpace - 1;
  let httpVersion: string;
  if (versionLength === 8 && buffer.toString('latin1', lastSpace + 1, lineEnd) === 'HTTP/1.1') httpVersion = 'HTTP/1.1';
  else if (versionLength === 8 && buffer.toString('latin1', lastSpace + 1, lineEnd) === 'HTTP/1.0') httpVersion = 'HTTP/1.0';
  else return 'unsupported request line';
  const method = buffer.toString('latin1', 0, firstSpace);
  const url = buffer.toString('latin1', firstSpace + 1, lastSpace);
  if (url === '') return 'malformed request line';

  const headers: RawHeaders = Object.create(null) as RawHeaders;
  let contentLength = 0;
  let sawContentLength = false;
  let transferEncoding = false;
  let expectContinue = false;

  let lineStart = lineEnd + 2;
  while (lineStart < headerEnd) {
    let lineStop = lineStart;
    while (lineStop < headerEnd && buffer[lineStop] !== 13) lineStop += 1;
    if (lineStop === lineStart) return 'malformed header';
    const first = buffer[lineStart];
    if (first === 32 || first === 9) return 'folded headers are not supported';
    let colon = lineStart;
    while (colon < lineStop && buffer[colon] !== 58) colon += 1;
    if (colon === lineStart || colon === lineStop) return 'malformed header';
    const code = headerCode(buffer, lineStart, colon);
    if (code === 0) {
      lineStart = lineStop + 2;
      continue;
    }
    let valueStart = colon + 1;
    while (valueStart < lineStop && (buffer[valueStart] === 32 || buffer[valueStart] === 9)) valueStart += 1;
    let valueEnd = lineStop;
    while (valueEnd > valueStart && (buffer[valueEnd - 1] === 32 || buffer[valueEnd - 1] === 9)) valueEnd -= 1;

    if (code === 1) {
      if (valueStart === valueEnd) return 'malformed content-length';
      let parsed = 0;
      for (let i = valueStart; i < valueEnd; i += 1) {
        const digit = buffer[i]! - 48;
        if (digit < 0 || digit > 9) return 'malformed content-length';
        parsed = parsed * 10 + digit;
        if (parsed > MAX_BODY_BYTES) return 'request body too large';
      }
      if (sawContentLength && parsed !== contentLength) return 'conflicting content-length';
      contentLength = parsed;
      sawContentLength = true;
    } else if (code === 2) {
      transferEncoding = true;
    } else if (code === 3) {
      if (/100-continue/i.test(buffer.toString('latin1', valueStart, valueEnd))) expectContinue = true;
    }

    if (code === 4 || code === 5 || code === 6 || code === 7 || code === 8) {
      const name = code === 4 ? 'connection' : code === 5 ? 'host' : code === 6 ? 'authorization' : code === 7 ? 'git-protocol' : 'content-type';
      const value = buffer.toString('latin1', valueStart, valueEnd);
      const previous = headers[name];
      if (previous === undefined) headers[name] = value;
      else if (Array.isArray(previous)) previous.push(value);
      else headers[name] = [previous, value];
    }
    lineStart = lineStop + 2;
  }

  if (transferEncoding) return 'transfer-encoding is not supported';

  const connection = headers['connection'];
  const connectionText = Array.isArray(connection) ? connection.join(', ') : (connection ?? '');
  const keepAlive =
    httpVersion === 'HTTP/1.1'
      ? !/(^|,)\s*close\s*(,|$)/i.test(connectionText)
      : /(^|,)\s*keep-alive\s*(,|$)/i.test(connectionText);

  return { method, url, httpVersion, headers, contentLength, keepAlive, expectContinue };
}

class RawServer {
  private _server: NetServer;
  private _sockets: Set<Socket>;
  private _handler: RequestHandler;
  private _error: ((error: Error) => void)[];

  constructor(handler: RequestHandler) {
    this._handler = handler;
    this._sockets = new Set();
    this._error = [];
    this._server = createServer((socket) => this._onConnection(socket));
    this._server.on('error', (error) => {
      for (const listener of this._error) listener(error);
    });
  }

  listen(port: number, hostOrCallback?: string | (() => void), callback?: () => void): this {
    if (typeof hostOrCallback === 'function') this._server.listen(port, hostOrCallback);
    else this._server.listen(port, hostOrCallback, callback);
    return this;
  }

  address(): AddressInfo | string | null {
    return this._server.address();
  }

  close(callback?: (error?: Error) => void): this {
    this._server.close(callback);
    for (const socket of this._sockets) socket.destroy();
    this._sockets.clear();
    return this;
  }

  on(event: string, listener: (...args: never[]) => void): this {
    if (event === 'connection') this._server.on('connection', listener as (...args: unknown[]) => void);
    else if (event === 'listening') this._server.on('listening', listener as () => void);
    else if (event === 'close') this._server.on('close', listener as () => void);
    else if (event === 'error') this._error.push(listener as unknown as (error: Error) => void);
    else this._server.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  once(event: string, listener: (...args: never[]) => void): this {
    if (event === 'error') {
      const wrapped = (error: Error): void => {
        const index = this._error.indexOf(wrapped);
        if (index !== -1) this._error.splice(index, 1);
        (listener as unknown as (error: Error) => void)(error);
      };
      this._error.push(wrapped);
      return this;
    }
    this._server.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  private _onConnection(socket: Socket): void {
    this._sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this._sockets.delete(socket);
    });

    let buffer: Buffer = EMPTY;
    let continueSent = false;
    let dead = false;
    let processing = false;
    let draining = false;
    const queue: PendingRequest[] = [];

    const pump = (): void => {
      if (draining) return;
      draining = true;
      while (!processing) {
        const request = queue.shift();
        if (request === undefined) break;
        processing = true;
        const response = new RawResponse(socket, request, () => {
          processing = false;
          if (!request.keepAlive) {
            queue.length = 0;
            return;
          }
          pump();
        });
        const rawRequest: RawRequest = {
          method: request.method,
          url: request.url,
          httpVersion: request.httpVersion,
          headers: request.headers,
          socket,
          body: request.body,
          keepAlive: request.keepAlive,
          readBody: () => Promise.resolve(request.body),
        };
        try {
          this._handler(rawRequest, response);
        } catch {
          if (!response.headersSent) {
            try {
              response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
              response.end(Buffer.from('{"message":"Internal Server Error"}', 'utf8'));
            } catch {
              response.destroy();
            }
          } else {
            response.destroy();
          }
        }
      }
      draining = false;
    };

    const parse = (): void => {
      while (!dead) {
        const headerEnd = buffer.indexOf(HEADER_END);
        if (headerEnd === -1) {
          if (buffer.length > MAX_HEADER_BYTES) {
            dead = true;
            refuse(socket, 431, 'Request Header Fields Too Large');
          }
          return;
        }
        const head = parseHead(buffer, headerEnd);
        if (typeof head === 'string') {
          dead = true;
          refuse(socket, 400, 'Bad Request');
          return;
        }
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + head.contentLength;
        if (buffer.length < bodyEnd) {
          if (head.expectContinue && !continueSent) {
            continueSent = true;
            try {
              socket.write('HTTP/1.1 100 Continue\r\n\r\n');
            } catch {
              dead = true;
              socket.destroy();
            }
          }
          return;
        }
        const body = head.contentLength === 0 ? EMPTY : buffer.subarray(bodyStart, bodyEnd);
        buffer = buffer.subarray(bodyEnd);
        continueSent = false;
        queue.push({
          method: head.method,
          url: head.url,
          httpVersion: head.httpVersion,
          headers: head.headers,
          body,
          keepAlive: head.keepAlive && !dead,
        });
        pump();
      }
    };

    socket.on('data', (chunk: Buffer) => {
      if (dead) return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      parse();
    });
    socket.on('end', () => {
      if (!dead) socket.end();
    });
  }
}

/** Build the raw transport with the server surface main.ts and the conformance runner use. */
export function createRawServer(handler: RequestHandler): RawServer {
  return new RawServer(handler);
}

export type RawHttpServer = RawServer;
