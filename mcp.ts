import type { IncomingMessage, ServerResponse } from 'node:http';

export interface McpRequest {
  method: string;
  body: Buffer;
  headers: IncomingMessage['headers'];
  res: ServerResponse;
  authenticated: boolean;
}

export function handleMcp(request: McpRequest): void {
  const text = JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'not implemented' }, id: null }) + '\n';
  request.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) });
  request.res.end(text);
}
