/**
 * HTTP side of the attestor Worker; the Durable Object does the work (attestor.ts).
 *
 *   POST /v1/attest     {"tx": "<base64 wire transaction>"}, body at most 4 KB
 *                       200 {"signature": "<base58>", "attestor": "<base58>"}
 *                       422 {"error": "...", "reason": "<code>"}: a check failed (check.ts REASONS)
 *   GET  /v1/attestor   {"attestor": "<base58>", "sampler": {...}}: the key and the sampler's health
 *
 * Other answers: 400 bad_request, 401 unauthorized (only with ATTEST_TOKEN set), 405, 413
 * body_too_large, 503 not_configured / devnet_unavailable / unavailable. Every error body is
 * {"error", "reason"}.
 */

export const MAX_BODY_BYTES = 4096;

export type Result = { status: number; body: Record<string, unknown> };

/** The Durable Object as the Worker calls it. */
export interface AttestorApi {
  attest(tx: string): Promise<Result>;
  health(): Promise<Result>;
}

export type HttpEnv = {
  /**
   * Shared secret: when set, POST /v1/attest needs "Authorization: Bearer <token>". Required in
   * production: with none set every caller is let in.
   */
  ATTEST_TOKEN?: string;
};

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export const failure = (status: number, reason: string, error: string): Result => ({ status, body: { error, reason } });

const answer = (r: Result, headers: Record<string, string> = {}) => json(r.body, r.status, headers);

/** The body, or null as soon as it passes `max` bytes (declared or actually sent). */
export async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** Compares digests, so the time taken does not depend on where the header differs. */
async function authorized(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return true;
  const [given, wanted] = await Promise.all([sha256(request.headers.get('authorization') ?? ''), sha256(`Bearer ${token}`)]);
  let diff = 0;
  for (let i = 0; i < wanted.length; i++) diff |= (given[i] ?? 0) ^ (wanted[i] ?? 0);
  return diff === 0;
}

async function attest(request: Request, api: AttestorApi, env: HttpEnv): Promise<Response> {
  if (request.method !== 'POST') return answer(failure(405, 'method_not_allowed', 'POST only'), { allow: 'POST' });
  if (!(await authorized(request, env.ATTEST_TOKEN))) return answer(failure(401, 'unauthorized', 'missing or wrong bearer token'));
  const body = await readCapped(request, MAX_BODY_BYTES);
  if (!body) return answer(failure(413, 'body_too_large', `the body is limited to ${MAX_BODY_BYTES} bytes`));
  let tx: unknown;
  try {
    tx = (JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)) as { tx?: unknown } | null)?.tx;
  } catch {
    return answer(failure(400, 'bad_request', 'the body must be JSON: {"tx": "<base64 wire transaction>"}'));
  }
  if (typeof tx !== 'string' || tx.length === 0) {
    return answer(failure(400, 'bad_request', 'the body must be JSON: {"tx": "<base64 wire transaction>"}'));
  }
  return answer(await api.attest(tx));
}

export async function handle(request: Request, api: AttestorApi, env: HttpEnv = {}): Promise<Response> {
  const { pathname } = new URL(request.url);
  try {
    if (pathname === '/v1/attest') return await attest(request, api, env);
    if (pathname === '/v1/attestor') {
      if (request.method !== 'GET') return answer(failure(405, 'method_not_allowed', 'GET only'), { allow: 'GET' });
      return answer(await api.health());
    }
  } catch (error) {
    // The Durable Object could not be reached (overloaded, restarting) or threw.
    console.error(JSON.stringify({ event: 'handler_error', path: pathname, error: error instanceof Error ? error.message : String(error) }));
    return answer(failure(503, 'unavailable', 'the attestor is unavailable, try again'));
  }
  return answer(failure(404, 'not_found', 'not found'));
}
