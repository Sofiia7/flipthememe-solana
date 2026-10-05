/**
 * Mainnet price sampling: once a second, read every pool the keeper still needs (the current
 * pool and the pool of each round that is not final) and keep about 15 minutes of observations.
 */
import { loadPool, observePrice, type PoolRef } from '@flipthememe/client';
import type { Address } from '@solana/kit';
import type { Logger } from './log.ts';
import { ObservationStore } from './observations.ts';
import { shortError, type FailoverRpc } from './rpc.ts';

/** PumpSwap pool accounts never move their vaults, so each pool is loaded once. */
export class PoolRefs {
  private readonly cache = new Map<string, PoolRef>();
  private readonly mainnet: FailoverRpc;

  constructor(mainnet: FailoverRpc) {
    this.mainnet = mainnet;
  }

  async get(pool: Address): Promise<PoolRef> {
    const known = this.cache.get(pool);
    if (known) return known;
    const ref = await this.mainnet.call('loadPool', (rpc) => loadPool(rpc, pool));
    this.cache.set(pool, ref);
    return ref;
  }
}

export class Sampler {
  readonly store: ObservationStore;
  private readonly refs: PoolRefs;
  private readonly mainnet: FailoverRpc;
  private readonly logger: Logger;
  private readonly lastErrorLogAt = new Map<string, number>();

  constructor(opts: { refs: PoolRefs; mainnet: FailoverRpc; store: ObservationStore; logger: Logger }) {
    this.refs = opts.refs;
    this.mainnet = opts.mainnet;
    this.store = opts.store;
    this.logger = opts.logger;
  }

  /** One observation per pool, in parallel. A failed pool is logged at most every 30 s. */
  async sample(pools: Iterable<Address>): Promise<void> {
    const unique = [...new Set(pools)];
    await Promise.all(
      unique.map(async (pool) => {
        try {
          const ref = await this.refs.get(pool);
          const observation = await this.mainnet.call('observePrice', (rpc) => observePrice(rpc, ref));
          this.store.add(pool, observation);
        } catch (error) {
          const now = Date.now();
          if (now - (this.lastErrorLogAt.get(pool) ?? 0) >= 30_000) {
            this.lastErrorLogAt.set(pool, now);
            this.logger({ event: 'sample_failed', pool, error: shortError(error) });
          }
        }
      }),
    );
    this.store.prune(Date.now());
  }

  /** Age of the newest observation per pool, for status.json. */
  freshness(nowMs: number): Record<string, { ageMs: number; observations: number; slot: string; price: string }> {
    const out: Record<string, { ageMs: number; observations: number; slot: string; price: string }> = {};
    for (const pool of this.store.pools()) {
      const latest = this.store.latest(pool);
      if (!latest) continue;
      out[pool] = {
        ageMs: nowMs - latest.atMs,
        observations: this.store.get(pool).length,
        slot: latest.slot.toString(),
        price: latest.price.toString(),
      };
    }
    return out;
  }
}
