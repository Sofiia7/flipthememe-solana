/**
 * Mainnet price sampling: once a second, read every pool the keeper still needs (the current pool, the
 * pool of each round that is not final, and the pool of each shadow round still to be evaluated) and keep
 * about 15 minutes of observations.
 *
 * The tick is fixed: a read that hangs does not hold the next one back. Each pool may have two reads in
 * flight at once (MAX_READS_IN_FLIGHT); a read is given up on after SAMPLE_TIMEOUT_MS (the failover then
 * moves on to the next endpoint) and its late answer, if one still comes, is thrown away. So one stuck
 * mainnet answer costs the one read, not the seconds around it: the attestor wants 70 % of its own reads in
 * a window, and a keeper that lost five of ten seconds to one slow endpoint was refused for it.
 * Two reads that come back with the same slot (concurrent reads, a slot that lasts longer than the tick)
 * are stored once.
 */
import { loadPool, observePrice, type PoolRef, type PriceObservation } from '@flipthememe/client';
import type { Address } from '@solana/kit';
import type { Logger } from './log.ts';
import { ObservationStore } from './observations.ts';
import { shortError, type FailoverRpc, type SolanaRpc } from './rpc.ts';

/** A read of one pool is abandoned after this long (the RPC's own timeout is longer). */
export const SAMPLE_TIMEOUT_MS = 3_000;
/** Reads of one pool in flight at the same time, at most. */
export const MAX_READS_IN_FLIGHT = 2;

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

/** `promise`, or a TimeoutError rejection after `ms` (the promise itself is left to finish on its own). */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DOMException('read timed out', 'TimeoutError')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class Sampler {
  readonly store: ObservationStore;
  private readonly refs: Pick<PoolRefs, 'get'>;
  private readonly mainnet: Pick<FailoverRpc, 'call'>;
  private readonly logger: Logger;
  private readonly observe: (rpc: SolanaRpc, ref: PoolRef) => Promise<PriceObservation>;
  private readonly timeoutMs: number;
  private readonly maxInFlight: number;
  private readonly lastErrorLogAt = new Map<string, number>();
  private readonly inFlight = new Map<string, number>();
  private readonly running = new Set<Promise<void>>();
  /** Answers thrown away because their slot was already stored. */
  duplicateSlots = 0;

  constructor(opts: {
    refs: Pick<PoolRefs, 'get'>;
    mainnet: Pick<FailoverRpc, 'call'>;
    store: ObservationStore;
    logger: Logger;
    /** Replaces observePrice (tests). */
    observe?: (rpc: SolanaRpc, ref: PoolRef) => Promise<PriceObservation>;
    timeoutMs?: number;
    maxInFlight?: number;
  }) {
    this.refs = opts.refs;
    this.mainnet = opts.mainnet;
    this.store = opts.store;
    this.logger = opts.logger;
    this.observe = opts.observe ?? ((rpc, ref) => observePrice(rpc, ref));
    this.timeoutMs = opts.timeoutMs ?? SAMPLE_TIMEOUT_MS;
    this.maxInFlight = opts.maxInFlight ?? MAX_READS_IN_FLIGHT;
  }

  /**
   * Starts one read per pool, in parallel, and returns at once. A pool that already has the maximum of reads
   * in flight is left for the next tick. A failed pool is logged at most every 30 s.
   */
  tick(pools: Iterable<Address>): void {
    for (const pool of new Set(pools)) {
      if ((this.inFlight.get(pool) ?? 0) >= this.maxInFlight) continue;
      this.inFlight.set(pool, (this.inFlight.get(pool) ?? 0) + 1);
      const read = this.read(pool).finally(() => {
        const left = (this.inFlight.get(pool) ?? 1) - 1;
        if (left > 0) this.inFlight.set(pool, left);
        else this.inFlight.delete(pool);
        this.running.delete(read);
      });
      this.running.add(read);
    }
    this.store.prune(Date.now());
  }

  /** Resolves when every read started so far has finished (shutdown, tests). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  private async read(pool: Address): Promise<void> {
    try {
      const ref = await this.refs.get(pool);
      const observation = await this.mainnet.call('observePrice', (rpc) => within(this.observe(rpc, ref), this.timeoutMs));
      if (this.store.hasSlot(pool, observation.slot)) {
        this.duplicateSlots++;
        return;
      }
      this.store.add(pool, observation);
    } catch (error) {
      const now = Date.now();
      if (now - (this.lastErrorLogAt.get(pool) ?? 0) >= 30_000) {
        this.lastErrorLogAt.set(pool, now);
        this.logger({ event: 'sample_failed', pool, error: shortError(error) });
      }
    }
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
