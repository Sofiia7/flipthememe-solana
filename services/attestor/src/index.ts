// FlipTheMeme price attestor: a second signer for set_strike and settle, apart from the keeper.
//
//   POST /v1/attest     {"tx": "<base64 wire transaction>"}  ->  {"signature", "attestor"} or 422 {"error", "reason"}
//   GET  /v1/attestor   the attestor's public key and the sampler's health
//
// One Durable Object ("attestor") samples the pools and holds the samples in SQLite; the Worker
// only routes (http.ts). A cron trigger pings the object every minute so its alarm loop restarts
// after an eviction. All logic lives in attestor.ts, which node:test drives without the runtime.

import { DurableObject } from 'cloudflare:workers';
import { AttestorCore, type AttestorEnv } from './attestor.ts';
import { handle, type HttpEnv, type Result } from './http.ts';

export interface Env extends AttestorEnv, HttpEnv {
  ATTESTOR: DurableObjectNamespace<Attestor>;
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

  health(): Promise<Result> {
    return this.core.health();
  }

  ping(): Promise<Result> {
    return this.core.ping();
  }

  async alarm(): Promise<void> {
    await this.core.tick();
  }
}

/** The one instance: a single sampler for the one devnet program. */
const attestor = (env: Env) => env.ATTESTOR.getByName('attestor');

export default {
  fetch: (request: Request, env: Env) => handle(request, attestor(env), env),
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(attestor(env).ping());
  },
};
