/**
 * HTTP side of the attestor Worker; the Durable Object does the work (attestor.ts).
 *
 *   POST /v1/attest     {"tx": "<base64 wire transaction>"}, body at most 4 KB
 *                       200 {"signature": "<base58>", "attestor": "<base58>"}
 *                       422 {"error": "...", "reason": "<code>"}: a check failed (check.ts REASONS)
 *   GET  /v1/attestor   {"attestor": "<base58>", "sampler": {...}}: the key and the sampler's health;
 *                       a 200 is served from the edge cache for 20 s, so the Durable Object is asked
 *                       once per 20 s per data centre however often it is polled (audit of
 *                       2026-10-07, M1: every uncached call is a Durable Object request, 100,000 a
 *                       day on the Free plan). POST /v1/attest is never cached.
 *
 * Other answers: 400 bad_request, 401 unauthorized (only with ATTEST_TOKEN set), 405, 413
 * body_too_large, 503 not_configured / devnet_unavailable / unavailable. Every error body is
 * {"error", "reason"}.
 */

export const MAX_BODY_BYTES = 4096;
/** How long the edge keeps a healthy GET /v1/attestor answer. */
export const HEALTH_CACHE_SECONDS = 20;

export type Result = { status: number; body: Record<string, unknown> };

/** The Durable Object as the Worker calls it. */
export interface AttestorApi {
  attest(tx: string): Promise<Result>;
  health(): Promise<Result>;
  certificate?(id: string, kind: 'strike' | 'exit'): Promise<Result>;
}

/** The slice of the Workers cache (`caches.default`) the health answer uses, so tests can pass a fake. */
export interface HealthCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** What the runtime offers the handler besides the Durable Object: both optional (node:test has neither). */
export type HttpContext = { cache?: HealthCache; waitUntil?(promise: Promise<unknown>): void };

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

const withCacheHeader = (response: Response, state: 'hit' | 'miss'): Response => {
  const headers = new Headers(response.headers);
  headers.set('x-cache', state);
  return new Response(response.body, { status: response.status, headers });
};

/**
 * GET /v1/attestor: from the edge cache while its answer is under HEALTH_CACHE_SECONDS old, else
 * from the Durable Object (and into the cache when it is a 200; an error is never cached). The
 * cache key is the URL without its query, so a "?x=1" cannot reach the Durable Object. A cache that
 * fails is skipped, never an error. `x-cache: hit | miss` says which one answered.
 */
async function health(request: Request, api: AttestorApi, ctx: HttpContext): Promise<Response> {
  const { origin, pathname } = new URL(request.url);
  const key = new Request(`${origin}${pathname}`);
  if (ctx.cache) {
    try {
      const hit = await ctx.cache.match(key);
      if (hit) return withCacheHeader(hit, 'hit');
    } catch {
      // fall through to the Durable Object
    }
  }
  const result = await api.health();
  const cacheable = result.status === 200;
  const response = answer(result, cacheable ? { 'cache-control': `public, max-age=${HEALTH_CACHE_SECONDS}` } : {});
  if (cacheable && ctx.cache) {
    const stored = ctx.cache.put(key, response.clone()).catch(() => undefined);
    if (ctx.waitUntil) ctx.waitUntil(stored);
    else await stored;
  }
  return withCacheHeader(response, 'miss');
}

export async function handle(request: Request, api: AttestorApi, env: HttpEnv = {}, ctx: HttpContext = {}): Promise<Response> {
  const { pathname } = new URL(request.url);
  try {
    if (pathname === '/live' || pathname === '/v1/attestor/live') return json({ live: true });
    if (pathname === '/ready' || pathname === '/v1/attestor/ready') {
      if (request.method !== 'GET') return answer(failure(405, 'method_not_allowed', 'GET only'));
      const result = await api.health();
      const ready = (result.body.readiness as { ready?: boolean } | undefined)?.ready === true;
      return json(result.body, ready && result.status === 200 ? 200 : 503);
    }
    if (pathname === '/v1/attestation') {
      if (request.method !== 'GET') return answer(failure(405, 'method_not_allowed', 'GET only'), { allow: 'GET' });
      const url = new URL(request.url);
      const id = url.searchParams.get('round') ?? '';
      const kind = url.searchParams.get('kind');
      if (!/^(0|[1-9][0-9]{0,15})$/.test(id) || (kind !== 'strike' && kind !== 'exit')) return answer(failure(400, 'bad_request', 'round and kind=strike|exit are required'));
      if (!api.certificate) return answer(failure(503, 'unavailable', 'certificates unavailable'));
      const key = new Request(`${url.origin}${pathname}?round=${id}&kind=${kind}`);
      const hit = await ctx.cache?.match(key).catch(() => undefined);
      if (hit) return hit;
      const result = await api.certificate(id, kind);
      const response = answer(result, result.status === 200 ? { 'cache-control': 'public, max-age=5' } : {});
      if (result.status === 200 && ctx.cache) {
        const stored = ctx.cache.put(key, response.clone()).catch(() => undefined);
        if (ctx.waitUntil) ctx.waitUntil(stored); else await stored;
      }
      return response;
    }
    if (pathname === '/v1/attest') return await attest(request, api, env);
    if (pathname === '/v1/attestor') {
      if (request.method !== 'GET') return answer(failure(405, 'method_not_allowed', 'GET only'), { allow: 'GET' });
      return await health(request, api, ctx);
    }
  } catch (error) {
    // The Durable Object could not be reached (overloaded, restarting) or threw.
    console.error(JSON.stringify({ event: 'handler_error', path: pathname, error: error instanceof Error ? error.message : String(error) }));
    return answer(failure(503, 'unavailable', 'the attestor is unavailable, try again'));
  }
  return answer(failure(404, 'not_found', 'not found'));
}
