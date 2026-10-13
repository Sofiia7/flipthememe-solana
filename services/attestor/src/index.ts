// FlipTheMeme price attestor: a second signer for set_strike and settle, apart from the keeper.
//
//   POST /v1/attest     {"tx": "<base64 wire transaction>"}  ->  {"signature", "attestor"} or 422 {"error", "reason"}
//   GET  /v1/attestor   the attestor's public key and the sampler's health (edge-cached for 20 s)
//
// One Durable Object ("attestor") samples the pools and holds the samples in SQLite; the Worker
// only routes (http.ts). A cron trigger pings the object every minute so its alarm loop restarts
// after an eviction. All logic lives in attestor.ts, which node:test drives without the runtime.

import { DurableObject } from 'cloudflare:workers';
import { AttestorCore, type AttestorEnv } from './attestor.ts';
import { handle, type HttpEnv, type Result } from './http.ts';
import { forward } from './proxy.ts';

export interface Env extends AttestorEnv, HttpEnv {
  ATTESTOR: DurableObjectNamespace<Attestor>;
  /**
   * Base URL of another deployment of this Worker. When set, this deployment only forwards the attestor
   * routes to it (proxy.ts) and its own Durable Object stops sampling: one attestor serves each window.
   */
  ATTEST_PROXY?: string;
}

export class Attestor extends DurableObject<Env> {
  private readonly core: AttestorCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new AttestorCore({ sql: ctx.storage.sql, alarms: ctx.storage, env });
  }

  attest(tx: string): Promise<Result> {
    return this.core.attest(tx);
  }

  certificate(id: string, kind: 'strike' | 'exit'): Promise<Result> {
    return this.core.certificate(id, kind);
  }

  health(): Promise<Result> {
    return this.core.health();
  }

  ready(): Promise<Result> {
    return this.core.ready();
  }

  ping(): Promise<Result> {
    return this.core.ping();
  }

  async alarm(): Promise<void> {
    // Proxy mode: not re-arming ends the sampling loop of an object that was running before the switch.
    if (this.env.ATTEST_PROXY) return;
    await this.core.tick();
  }
}

/** The one instance: a single sampler for the one devnet program. */
const attestor = (env: Env) => env.ATTESTOR.getByName('attestor');

/** Proxy mode: the same edge cache as the direct path, keyed by the public URL. */
async function proxied(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cacheable = request.method === 'GET';
  if (cacheable) {
    const hit = await caches.default.match(request).catch(() => undefined);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('x-cache', 'hit'); // the stored copy still says what the backup said when it was stored
      return new Response(hit.body, { status: hit.status, headers });
    }
  }
  const response = await forward(request, env.ATTEST_PROXY);
  response.headers.set('x-cache', 'miss');
  if (cacheable && response.status === 200 && /max-age=\d+/.test(response.headers.get('cache-control') ?? '')) {
    ctx.waitUntil(caches.default.put(request, response.clone()).catch(() => undefined));
  }
  return response;
}

export default {
  // caches.default serves the 20 s edge cache of GET /v1/attestor; it does nothing on workers.dev
  // hosts, only on the custom domain route (sol.flipthememe.com/v1/attestor).
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    env.ATTEST_PROXY ? proxied(request, env, ctx) : handle(request, attestor(env), env, { cache: caches.default, waitUntil: (promise) => ctx.waitUntil(promise) }),
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    // A proxy has no sampler to keep alive.
    if (!env.ATTEST_PROXY) ctx.waitUntil(attestor(env).ping());
  },
};
