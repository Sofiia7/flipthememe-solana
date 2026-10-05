/**
 * Token choice: the most active fresh PumpSwap pool with enough SOL depth, held at least 15
 * minutes while it keeps passing; the most active deep pool of any age as a fallback.
 */
import {
  DEPTH_K,
  discoverPumpSwapPools,
  passesGate,
  quoteReserveLamports,
  type GeckoTerminalFetch,
  type PoolCandidate,
} from '@flipthememe/client';
import type { Address } from '@solana/kit';
import type { Logger } from './log.ts';
import { shortError, type FailoverRpc } from './rpc.ts';
import type { PoolRefs } from './sampler.ts';

export const HOLD_MS = 15 * 60 * 1000;
/** Depth checks per refresh (2 mainnet reads each, the first one cached). */
export const MAX_DEPTH_CHECKS = 6;
/** After a GeckoTerminal failure, skip this many refreshes (2 requests each, ~30 allowed per minute). */
export const DISCOVERY_FAILURE_SKIPS = 2;

export type Selection = {
  pool: Address;
  baseMint: Address;
  name: string;
  selectedAtMs: number;
  /** True when no fresh pool qualified and the keeper fell back to an older one. */
  fallback: boolean;
  quoteReserve: bigint;
  reserveAtMs: number;
};

export type PoolPlan = {
  /** A fresh current pool inside its hold time that still passes the age/activity gate. */
  keepCurrent: boolean;
  /** A fallback current pool inside its hold time that is still listed (used only when no fresh pool qualifies). */
  keepFallback: boolean;
  /** Fresh candidates (age and activity gate), most active first. */
  fresh: PoolCandidate[];
  /** Every candidate, most active first, for the fallback. */
  any: PoolCandidate[];
};

/**
 * Order of preference for one refresh; the depth check (on chain) is the caller's:
 * 1. keep the current fresh pool while it is held (15 min) and still passes;
 * 2. else the most active fresh pool that is deep enough;
 * 3. else keep the current fallback pool while it is held and still listed;
 * 4. else the most active pool of any age that is deep enough (fallback).
 */
export function poolPlan(
  candidates: readonly PoolCandidate[],
  current: Pick<Selection, 'pool' | 'selectedAtMs' | 'fallback'> | null,
  nowMs: number,
  holdMs: number = HOLD_MS,
): PoolPlan {
  const any = [...candidates].sort((a, b) => b.txM5 - a.txM5);
  const fresh = any.filter((c) => passesGate(c, nowMs));
  const held = current !== null && nowMs - current.selectedAtMs < holdMs;
  const keepCurrent = held && !current.fallback && fresh.some((c) => c.pool === current.pool);
  const keepFallback = held && current.fallback && any.some((c) => c.pool === current.pool);
  return { keepCurrent, keepFallback, fresh, any };
}

export class PoolSelector {
  current: Selection | null;
  private readonly refs: PoolRefs;
  private readonly mainnet: FailoverRpc;
  private readonly logger: Logger;
  private readonly override: Address | null;
  private readonly fetchFn: GeckoTerminalFetch;
  private readonly minBank: () => bigint;
  private readonly onChange: (s: Selection) => void;
  private skips = 0;

  constructor(opts: {
    refs: PoolRefs;
    mainnet: FailoverRpc;
    logger: Logger;
    override: Address | null;
    minBank: () => bigint;
    initial: Selection | null;
    onChange: (s: Selection) => void;
    fetchFn?: GeckoTerminalFetch;
  }) {
    this.refs = opts.refs;
    this.mainnet = opts.mainnet;
    this.logger = opts.logger;
    this.override = opts.override;
    this.minBank = opts.minBank;
    this.current = opts.initial;
    this.onChange = opts.onChange;
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }));
  }

  /** Minimum quote reserve for a pool to qualify: K x min_bank (50 SOL at the devnet params). */
  minReserve(): bigint {
    return DEPTH_K * this.minBank();
  }

  async refresh(nowMs: number): Promise<void> {
    if (this.override) {
      await this.refreshOverride(this.override, nowMs);
      return;
    }
    if (this.skips > 0) {
      this.skips--;
      return;
    }
    let candidates: PoolCandidate[];
    try {
      candidates = await discoverPumpSwapPools(this.fetchFn, nowMs);
    } catch (error) {
      this.skips = DISCOVERY_FAILURE_SKIPS;
      this.logger({ event: 'pool_discovery_failed', error: shortError(error), keeping: this.current?.pool ?? null });
      return;
    }
    const plan = poolPlan(candidates, this.current, nowMs);
    const depth = new Map<string, bigint | null>();
    const deepEnough = async (pool: Address): Promise<bigint | null> => {
      if (!depth.has(pool)) depth.set(pool, await this.reserveIfDeep(pool));
      return depth.get(pool) ?? null;
    };

    const keep = async (): Promise<boolean> => {
      if (!this.current) return false;
      const reserve = await deepEnough(this.current.pool);
      if (reserve === null) return false;
      this.current = { ...this.current, quoteReserve: reserve, reserveAtMs: Date.now() };
      return true;
    };

    if (plan.keepCurrent && (await keep())) return;
    for (const c of plan.fresh.slice(0, MAX_DEPTH_CHECKS)) {
      const reserve = await deepEnough(c.pool);
      if (reserve !== null) return this.select(c, false, reserve, nowMs);
    }
    if (plan.keepFallback && (await keep())) return;
    for (const c of plan.any.slice(0, MAX_DEPTH_CHECKS)) {
      const reserve = await deepEnough(c.pool);
      if (reserve !== null) return this.select(c, true, reserve, nowMs);
    }
    this.logger({ event: 'pool_none_qualifies', candidates: candidates.length, fresh: plan.fresh.length, keeping: this.current?.pool ?? null });
  }

  private select(c: PoolCandidate, fallback: boolean, reserve: bigint, nowMs: number): void {
    if (this.current && this.current.pool === c.pool) {
      const flagChanged = this.current.fallback !== fallback;
      this.current = { ...this.current, name: c.name, fallback, quoteReserve: reserve, reserveAtMs: Date.now() };
      if (flagChanged) {
        this.logger({ event: fallback ? 'pool_kept_as_fallback' : 'pool_kept_as_fresh', pool: c.pool, name: c.name });
        this.onChange(this.current);
      }
      return;
    }
    const previous = this.current?.pool ?? null;
    this.current = { pool: c.pool, baseMint: c.baseMint, name: c.name, selectedAtMs: nowMs, fallback, quoteReserve: reserve, reserveAtMs: Date.now() };
    this.logger({
      event: fallback ? 'pool_selected_fallback' : 'pool_selected',
      pool: c.pool,
      baseMint: c.baseMint,
      name: c.name,
      txM5: c.txM5,
      ageHours: Math.round((nowMs - c.createdAtMs) / 360_000) / 10,
      quoteReserve: reserve,
      previous,
    });
    this.onChange(this.current);
  }

  /** The quote reserve in lamports when the pool is a wSOL PumpSwap pool deep enough, else null. */
  private async reserveIfDeep(pool: Address): Promise<bigint | null> {
    try {
      const ref = await this.refs.get(pool);
      const reserve = await this.mainnet.call('quoteReserve', (rpc) => quoteReserveLamports(rpc, ref));
      return reserve >= this.minReserve() ? reserve : null;
    } catch (error) {
      this.logger({ event: 'pool_check_failed', pool, error: shortError(error) });
      return null;
    }
  }

  private async refreshOverride(pool: Address, nowMs: number): Promise<void> {
    try {
      const ref = await this.refs.get(pool);
      const reserve = await this.mainnet.call('quoteReserve', (rpc) => quoteReserveLamports(rpc, ref));
      if (this.current?.pool === pool) {
        this.current = { ...this.current, quoteReserve: reserve, reserveAtMs: Date.now() };
        return;
      }
      this.current = { pool, baseMint: ref.baseMint, name: 'POOL_OVERRIDE', selectedAtMs: nowMs, fallback: false, quoteReserve: reserve, reserveAtMs: Date.now() };
      this.logger({ event: 'pool_selected_override', pool, baseMint: ref.baseMint, quoteReserve: reserve, belowDepthGate: reserve < this.minReserve() });
      this.onChange(this.current);
    } catch (error) {
      this.logger({ event: 'pool_check_failed', pool, error: shortError(error) });
    }
  }
}
