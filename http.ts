// Shared HTTP plumbing for the JSON surfaces (REST, GraphQL, MCP): body
// reading, JSON answers with the headers GitHub sends, and an ApiError type
// handlers throw to answer with a status and a GitHub-shaped error body.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** A unique, non-empty request id, as GitHub's X-GitHub-Request-Id. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `CF${requestCounter.toString(16).toUpperCase().padStart(6, '0')}`;
}

/** An error a handler throws to answer `status` with `{message}` (plus any extra fields). */
export class ApiError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;

  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function notFound(message = 'Not Found'): ApiError {
  return new ApiError(404, message);
}

export function validationFailed(message: string, errors: unknown[] = []): ApiError {
  return new ApiError(422, message, errors.length ? { errors } : {});
}

/** Answer with a JSON body; REST answers also carry the request-id header. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Answer with no body at all (a 204 delete, a 202 notification ack). */
export function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...headers });
  res.end();
}

/** Read a whole request body. Bodies in this contest are small; the cap is a guard rail. */
export async function readBody(req: IncomingMessage, cap = 512 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > cap) throw new ApiError(413, 'Request Entity Too Large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON request body; an empty body counts as an empty object, malformed JSON is a 400. */
export function parseJsonBody(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}
