/**
 * Token choice, once a minute (rules and defaults in poolgate.ts, candidates from discovery.ts):
 *
 * 1. the current pool's SOL depth is read on chain every refresh; below K x min_bank (50 SOL) it
 *    is replaced at once, even inside its hold. With no deep enough replacement it is dropped: no
 *    pool, so no new round opens until one qualifies (its max_bank would be below min_bank). A
 *    failed read only replaces it: the scheduler checks the depth again before every round;
 * 2. otherwise it stays for its hold (10 minutes), and after that while it passes the keep gate
 *    (20+ trades in 5 minutes, at most 180 minutes old on the fresh rung) unless a deep enough
 *    candidate is clearly better: a lower rung of the ladder, or the same rung with 1.5x the score;
 * 3. a new pool is the best deep enough candidate: fresh first (10-120 minutes old, 50+ trades in
 *    5 minutes, best score), else the fallback ladder (up to 6 h old, up to 24 h, then the most
 *    active pool of any age). The rung is logged and kept in the state file;
 * 4. after a failed or skipped discovery refresh the current pool is not rotated (its depth still
 *    is checked); a replacement then comes from the last good candidate list.
 *
 * Rounds take the pool selected when they are created; rounds in flight keep theirs.
 */
import { DEPTH_K, quoteReserveLamports, type PoolCandidate } from '@flipthememe/client';
import type { Address } from '@solana/kit';
import type { DiscoveryResult } from './discovery.ts';
import type { Logger } from './log.ts';
import {
  MINUTE_MS,
  RUNG_NAMES,
  beats,
  keepFailure,
  rankCandidates,
  scoreOf,
  type PoolGate,
  type Ranked,
  type Rung,
} from './poolgate.ts';
import { shortError, type FailoverRpc } from './rpc.ts';
import type { PoolRefs } from './sampler.ts';

/** Depth checks of candidates per refresh (2 mainnet reads each, the first one cached). */
export const MAX_DEPTH_CHECKS = 6;

export type Selection = {
  pool: Address;
  baseMint: Address;
  name: string;
  selectedAtMs: number;
  /** Rung of the fallback ladder the pool was picked on (0 = fresh, see RUNG_NAMES). */
  rung: Rung;
  /** True when rung > 0: no fresh pool qualified and the keeper fell back to an older one. */
  fallback: boolean;
  quoteReserve: bigint;
  reserveAtMs: number;
};

/** The mainnet reads the selector needs. */
export type PoolChain = {
  /** wSOL in the quote vault, lamports; throws when the account is not a wSOL PumpSwap pool. */
  quoteReserve(pool: Address): Promise<bigint>;
  baseMint(pool: Address): Promise<Address>;
};

export function poolChain(refs: PoolRefs, mainnet: FailoverRpc): PoolChain {
  return {
    async quoteReserve(pool) {
      const ref = await refs.get(pool);
      return mainnet.call('quoteReserve', (rpc) => quoteReserveLamports(rpc, ref));
    },
    async baseMint(pool) {
      return (await refs.get(pool)).baseMint;
    },
  };
}

export type CandidateSource = { refresh(nowMs: number, current: Address | null): Promise<DiscoveryResult> };

const round1 = (value: number): number => Math.round(value * 10) / 10;

export class PoolSelector {
  current: Selection | null;
  private readonly source: CandidateSource;
  private readonly chain: PoolChain;
  private readonly gate: PoolGate;
  private readonly logger: Logger;
  private readonly override: Address | null;
  private readonly minBank: () => bigint;
  private readonly onChange: (s: Selection | null) => void;

  constructor(opts: {
    source: CandidateSource;
    chain: PoolChain;
    gate: PoolGate;
    logger: Logger;
    override: Address | null;
    minBank: () => bigint;
    initial: Selection | null;
    /** Every new selection or rung; null when the current pool is dropped. */
    onChange: (s: Selection | null) => void;
  }) {
    this.source = opts.source;
    this.chain = opts.chain;
    this.gate = opts.gate;
    this.logger = opts.logger;
    this.override = opts.override;
    this.minBank = opts.minBank;
    this.current = opts.initial;
    this.onChange = opts.onChange;
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
    const current = this.current;
    const { candidates, complete } = await this.source.refresh(nowMs, current?.pool ?? null);
    /** Per pool read: the reserve when deep enough, null when too shallow, 'unreadable' when the read failed. */
    const depth = new Map<Address, bigint | null | 'unreadable'>();
    let checks = 0;
    /** The reserve when deep enough, else null; at most MAX_DEPTH_CHECKS candidates besides the current pool. */
    const deepEnough = async (pool: Address): Promise<bigint | null | undefined> => {
      if (!depth.has(pool)) {
        if (pool !== current?.pool) {
          if (checks >= MAX_DEPTH_CHECKS) return undefined;
          checks++;
        }
        depth.set(pool, await this.reserveIfDeep(pool));
      }
      const reserve = depth.get(pool);
      return typeof reserve === 'bigint' ? reserve : null;
    };

    let reason: string;
    if (current) {
      const reserve = await deepEnough(current.pool);
      if (typeof reserve === 'bigint') {
        this.current = { ...current, quoteReserve: reserve, reserveAtMs: Date.now() };
        if (nowMs - current.selectedAtMs < this.gate.holdMs || !complete) return;
        const stats = candidates.find((c) => c.pool === current.pool);
        const failure = keepFailure(stats, current.rung, nowMs, this.gate);
        if (failure === null && stats) {
          const mine = { rung: current.rung, score: scoreOf(stats, nowMs, this.gate) };
          for (const r of rankCandidates(candidates, nowMs, this.gate)) {
            if (r.candidate.pool === current.pool) continue;
            if (!beats(r, mine, this.gate)) break; // ranked best first: nothing later beats it either
            const deep = await deepEnough(r.candidate.pool);
            if (deep === undefined) break;
            if (deep !== null) return this.select(r, deep, nowMs, `better than ${RUNG_NAMES[mine.rung]} score ${round1(mine.score)}`);
          }
          return;
        }
        reason = failure ?? 'unlisted';
      } else {
        reason = `quote reserve below ${this.minReserve()} lamports or unreadable`;
      }
    } else {
      reason = 'no pool yet';
    }

    for (const r of rankCandidates(candidates, nowMs, this.gate)) {
      const deep = await deepEnough(r.candidate.pool);
      if (deep === undefined) break;
      if (deep !== null) return this.select(r, deep, nowMs, reason);
    }
    if (current && depth.get(current.pool) === null) {
      // Read and below the depth gate. Kept, it would get new rounds whose max_bank (reserve / K) is
      // below min_bank: rounds that can never activate. A failed read does not drop it (public RPCs
      // often answer 429): the scheduler checks the depth again on a fresh sample before each round.
      // Rounds in flight keep their pool and are served as before.
      this.current = null;
      this.logger({ event: 'pool_dropped', pool: current.pool, name: current.name, reason, candidates: candidates.length, depthChecks: checks, complete });
      this.onChange(null);
      return;
    }
    this.logger({
      event: 'pool_none_qualifies',
      reason,
      candidates: candidates.length,
      depthChecks: checks,
      complete,
      keeping: current?.pool ?? null,
    });
  }

  private select(r: Ranked, reserve: bigint, nowMs: number, reason: string): void {
    const c: PoolCandidate = r.candidate;
    const fallback = r.rung > 0;
    const facts = {
      rung: RUNG_NAMES[r.rung],
      reason,
      pool: c.pool,
      name: c.name,
      txM5: c.txM5,
      ageMin: round1((nowMs - c.createdAtMs) / MINUTE_MS),
      score: round1(r.score),
      quoteReserve: reserve,
    };
    if (this.current && this.current.pool === c.pool) {
      const rungChanged = this.current.rung !== r.rung;
      this.current = { ...this.current, name: c.name, rung: r.rung, fallback, quoteReserve: reserve, reserveAtMs: Date.now() };
      if (rungChanged) {
        this.logger({ event: 'pool_kept_on_rung', ...facts });
        this.onChange(this.current);
      }
      return;
    }
    const previous = this.current?.pool ?? null;
    this.current = { pool: c.pool, baseMint: c.baseMint, name: c.name, selectedAtMs: nowMs, rung: r.rung, fallback, quoteReserve: reserve, reserveAtMs: Date.now() };
    this.logger({ event: fallback ? 'pool_selected_fallback' : 'pool_selected', ...facts, baseMint: c.baseMint, previous });
    this.onChange(this.current);
  }

  /** The quote reserve in lamports when the pool is a wSOL PumpSwap pool deep enough, null when too shallow, 'unreadable' when the read fails. */
  private async reserveIfDeep(pool: Address): Promise<bigint | null | 'unreadable'> {
    try {
      const reserve = await this.chain.quoteReserve(pool);
      return reserve >= this.minReserve() ? reserve : null;
    } catch (error) {
      this.logger({ event: 'pool_check_failed', pool, error: shortError(error) });
      return 'unreadable';
    }
  }

  private async refreshOverride(pool: Address, nowMs: number): Promise<void> {
    try {
      const reserve = await this.chain.quoteReserve(pool);
      if (this.current?.pool === pool) {
        this.current = { ...this.current, quoteReserve: reserve, reserveAtMs: Date.now() };
        return;
      }
      const baseMint = await this.chain.baseMint(pool);
      this.current = { pool, baseMint, name: 'POOL_OVERRIDE', selectedAtMs: nowMs, rung: 0, fallback: false, quoteReserve: reserve, reserveAtMs: Date.now() };
      this.logger({ event: 'pool_selected_override', pool, baseMint, quoteReserve: reserve, belowDepthGate: reserve < this.minReserve() });
      this.onChange(this.current);
    } catch (error) {
      this.logger({ event: 'pool_check_failed', pool, error: shortError(error) });
    }
  }
}
