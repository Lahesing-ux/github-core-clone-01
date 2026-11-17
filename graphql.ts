import type { IncomingMessage, ServerResponse } from 'node:http';

export interface GraphQLRequest {
  method: string;
  body: Buffer;
  headers: IncomingMessage['headers'];
  query: URLSearchParams;
  res: ServerResponse;
  authenticated: boolean;
}

export function handleGraphQL(request: GraphQLRequest): void {
  const text = JSON.stringify({ errors: [{ message: 'not implemented' }] }) + '\n';
  request.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) });
  request.res.end(text);
}
