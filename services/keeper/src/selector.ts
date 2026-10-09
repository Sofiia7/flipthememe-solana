import { marketQuality, reserveOrder, type MarketSample } from './market-reserve.ts';
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
 * 3. a pool must also pass the token check (tokencheck.ts: mint and freeze authority revoked, no dangerous
 *    Token-2022 extension, no outside holder above HOLDER_MAX_PCT of the supply), asked after the depth
 *    check and remembered 30 minutes per mint. A candidate that fails is skipped; one whose check could not be
 *    read (RPC error) is skipped for this refresh too (fail closed), while the current pool then stays as it is.
 *    A current pool that fails it is replaced like a shallow one;
 * 3b. a new pool is the best deep enough candidate: fresh first (10-120 minutes old, 50+ trades in
 *    5 minutes, best score), else the fallback ladder (up to 6 h old, up to 24 h, then the most
 *    active pool of any age). The rung is logged and kept in the state file;
 * 4. after a failed or skipped discovery refresh the current pool is not rotated (its depth still
 *    is checked); a replacement then comes from the last good candidate list.
 *
 * Rounds take the pool selected when they are created; rounds in flight keep theirs.
 */
import { DEPTH_K, quoteReserveLamports } from '@flipthememe/client';
import type { Address } from '@solana/kit';
import type { DiscoveryResult } from './discovery.ts';
import { throttled, type Logger } from './log.ts';
import {
  MINUTE_MS,
  RUNG_NAMES,
  beats,
  keepFailure,
  rankCandidates,
  scoreOf,
  type Candidate,
  type PoolGate,
  type Ranked,
  type Rung,
} from './poolgate.ts';
import { shortError, type FailoverRpc } from './rpc.ts';
import type { PoolRefs } from './sampler.ts';
import type { ShadowPool } from './shadow.ts';
import { TOKEN_CACHE_TTL_MS, type TokenChecker, type TokenVerdict } from './tokencheck.ts';

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
  /** The token's safety verdict (tokencheck.ts); throws when the RPC fails. Absent: no token check. */
  tokenCheck?(pool: Address): Promise<TokenVerdict>;
};

export function poolChain(refs: PoolRefs, mainnet: FailoverRpc, tokens: TokenChecker | null = null): PoolChain {
  return {
    ...(tokens
      ? {
          async tokenCheck(pool: Address): Promise<TokenVerdict> {
            const ref = await refs.get(pool);
            return tokens.check(ref.baseMint, ref.baseVault);
          },
        }
      : {}),
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
  private readonly marketBias: (pool: Address, nowMs: number) => string | null;
  private readonly marketWarming: (pool: Address, nowMs: number) => boolean;
  private readonly marketSample: (pool: Address, nowMs: number) => MarketSample;
  private readonly reserveRejected = new Map<Address, number>();
  private reserveCursor = 0;
  private readonly reservePrice: (pool: Address, nowMs: number) => bigint | null;
  private handover: { r: Ranked; reserve: bigint; expires: number; reason: string } | null = null;
  private reserveInventory = new Map<Address, Ranked>();
  private watchStarted = new Map<string, number>();
  reserveStatus: { pool: Address; name: string; tier: number; risk: number; prepared: boolean; up: number; down: number }[] = [];
  current: Selection | null;
  /** Observe candidates together so a rejected pool does not reset all market preparation. */
  watching: ShadowPool[] = [];
  private readonly source: CandidateSource;
  private readonly chain: PoolChain;
  private readonly gate: PoolGate;
  private readonly logger: Logger;
  private readonly override: Address | null;
  private readonly minBank: () => bigint;
  private readonly onChange: (s: Selection | null) => void;
  /** Why a pool failed the token check, by pool (the latest verdict; only what the selector saw). */
  private readonly unsafe = new Map<Address, string>();
  private readonly warnUnsafe: (key: string, fields: Parameters<Logger>[0]) => void;
  private readonly warnUnreadable: (key: string, fields: Parameters<Logger>[0]) => void;

  constructor(opts: {
    source: CandidateSource;
    chain: PoolChain;
    gate: PoolGate;
    logger: Logger;
    override: Address | null;
    minBank: () => bigint;
    initial: Selection | null;
    reservePrice?: (pool: Address, nowMs: number) => bigint | null;
    marketSample?: (pool: Address, nowMs: number) => MarketSample;
    marketBias?: (pool: Address, nowMs: number) => string | null;
    marketWarming?: (pool: Address, nowMs: number) => boolean;
    /** Every new selection or rung; null when the current pool is dropped. */
    onChange: (s: Selection | null) => void;
  }) {
    this.source = opts.source;
    this.reservePrice = opts.reservePrice ?? (() => null);
    this.marketSample = opts.marketSample ?? (() => ({ priced: 0, up: 0, down: 0, dominantShare: null }));
    this.marketBias = opts.marketBias ?? (() => null);
    this.marketWarming = opts.marketWarming ?? (() => false);
    this.chain = opts.chain;
    this.gate = opts.gate;
    this.logger = opts.logger;
    this.override = opts.override;
    this.minBank = opts.minBank;
    this.current = opts.initial;
    this.onChange = opts.onChange;
    // A refused token is looked at again after the cache's 30 minutes; an unreadable check every 5 minutes at most.
    this.warnUnsafe = throttled(opts.logger, TOKEN_CACHE_TTL_MS);
    this.warnUnreadable = throttled(opts.logger, 5 * 60_000);
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
    if (this.gate.balanced && !this.gate.neutral) return this.refreshBalanced(candidates, nowMs);
    const ranked = rankCandidates(candidates, nowMs, this.gate);
    this.watching = this.gate.neutral ? ranked.slice(0, 3).map(r => ({ pool: r.candidate.pool, baseMint: r.candidate.baseMint, name: r.candidate.name, rung: RUNG_NAMES[r.rung] })) : [];
    const readyFirst = this.gate.neutral ? [...ranked.filter(r => !this.marketWarming(r.candidate.pool, nowMs)), ...ranked.filter(r => this.marketWarming(r.candidate.pool, nowMs))] : ranked;
    /** Per pool read: the reserve when deep enough, null when too shallow, 'unreadable' when the read failed. */
    const depth = new Map<Address, bigint | null | 'unreadable'>();
    let checks = 0;
    /** The reserve when deep enough, else null; at most MAX_DEPTH_CHECKS candidates besides the current pool. */
    const deepEnough = async (pool: Address): Promise<bigint | null | undefined> => {
      if (this.gate.neutral && this.marketBias(pool, nowMs)) { depth.set(pool, null); return null; }
      if (!depth.has(pool)) {
        if (pool !== current?.pool) {
          if (checks >= MAX_DEPTH_CHECKS) return undefined;
          checks++;
        }
        depth.set(pool, await this.qualify(pool, pool === current?.pool));
      }
      const reserve = depth.get(pool);
      return typeof reserve === 'bigint' ? reserve : null;
    };

    let reason: string;
    const neutralReject = current && this.gate.neutral ? keepFailure(candidates.find((c) => c.pool === current.pool), current.rung, nowMs, this.gate) ?? this.marketBias(current.pool, nowMs) : null;
    if (current && neutralReject) {
      reason = neutralReject;
    } else if (current) {
      const reserve = await deepEnough(current.pool);
      if (typeof reserve === 'bigint') {
        this.current = { ...current, quoteReserve: reserve, reserveAtMs: Date.now() };
        if (this.gate.neutral && this.marketWarming(current.pool, nowMs)) {
          for (const r of readyFirst) {
            if (r.candidate.pool === current.pool || this.marketWarming(r.candidate.pool, nowMs)) continue;
            const deep = await deepEnough(r.candidate.pool);
            if (deep === undefined) break;
            if (deep !== null) return this.select(r, deep, nowMs, 'prepared market available');
          }
        }
        if (nowMs - current.selectedAtMs < this.gate.holdMs || !complete || this.marketWarming(current.pool, nowMs)) return;
        const stats = candidates.find((c) => c.pool === current.pool);
        const failure = keepFailure(stats, current.rung, nowMs, this.gate);
        if (failure === null && stats) {
          const mine = { rung: current.rung, score: scoreOf(stats, nowMs, this.gate) };
          for (const r of rankCandidates(candidates, nowMs, this.gate)) {
            if (r.candidate.pool === current.pool || (this.gate.neutral && this.marketWarming(r.candidate.pool, nowMs))) continue;
            if (!beats(r, mine, this.gate)) break; // ranked best first: nothing later beats it either
            const deep = await deepEnough(r.candidate.pool);
            if (deep === undefined) break;
            if (deep !== null) return this.select(r, deep, nowMs, `better than ${RUNG_NAMES[mine.rung]} score ${round1(mine.score)}`);
          }
          return;
        }
        reason = failure ?? 'unlisted';
      } else {
        reason = this.unsafe.get(current.pool) ?? `quote reserve below ${this.minReserve()} lamports or unreadable`;
      }
    } else {
      reason = 'no pool yet';
    }

    for (const r of readyFirst) {
      const deep = await deepEnough(r.candidate.pool);
      if (deep === undefined) break;
      if (deep !== null) return this.select(r, deep, nowMs, reason);
    }
    if (current && (neutralReject || depth.get(current.pool) === null)) {
      // No suitable neutral pool means no new rounds. Active rounds still use their original pools.
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

  /** Preparation changes the preferred next market; it never blocks the scheduler. */
  private async refreshBalanced(candidates: Candidate[], nowMs: number): Promise<void> {
    const current = this.current;
    this.handover = null;
    const ranked = rankCandidates(candidates, nowMs, this.gate).filter(r => r.candidate.txM5 >= this.gate.keepMinTxM5);
    // A discovery outage does not erase already checked backups. Recheck their actual liquidity/token.
    for (const r of this.reserveInventory.values()) if (!ranked.some(p => p.candidate.pool === r.candidate.pool)) {
      ranked.push({ ...r, candidate: { ...r.candidate, buys: undefined, sells: undefined, priceChangeM5: undefined } });
    }
    const prepared = new Map<Address, { r: Ranked; reserve: bigint }>();
    const invalidWatch = new Set<Address>();
    let currentReserve: bigint | null | 'unreadable' = null;
    if (current) {
      currentReserve = await this.qualify(current.pool, true);
      if (typeof currentReserve === 'bigint') this.current = { ...current, quoteReserve: currentReserve, reserveAtMs: nowMs };
    }
    // Recheck all five backups before exploration; their ten-minute measurement must survive refreshes.
    const retained = this.watching.flatMap(p => ranked.find(r => r.candidate.pool === p.pool) ?? []).filter(r => r.candidate.pool !== current?.pool);
    const rest = ranked.filter(r => r.candidate.pool !== current?.pool && !(typeof currentReserve === 'bigint' && r.candidate.baseMint === current?.baseMint) && !retained.some(k => k.candidate.pool === r.candidate.pool));
    const pivot = rest.length ? this.reserveCursor % rest.length : 0;
    const exploring = [...rest.slice(pivot), ...rest.slice(0, pivot)];
    this.reserveCursor += 2;
    let checks = 0;
    const currentRank = ranked.find(r => r.candidate.pool === current?.pool);
    if (currentRank && typeof currentReserve === 'bigint') prepared.set(current!.pool, { r: currentRank, reserve: currentReserve });
    for (const r of [...retained, ...exploring]) {
      const pool = r.candidate.pool;
      if (pool === current?.pool || prepared.has(pool) || nowMs < (this.reserveRejected.get(pool) ?? 0)) continue;
      if (++checks > MAX_DEPTH_CHECKS) break;
      const reserve = await this.qualify(pool, false);
      if (typeof reserve === 'bigint') prepared.set(pool, { r, reserve });
      else {
        if (reserve === null) invalidWatch.add(pool);
        this.reserveRejected.set(pool, nowMs + (this.unsafe.has(pool) ? TOKEN_CACHE_TTL_MS : 60_000));
      }
    }
    const seenMints = new Set<Address>();
    const choices = [...prepared.values()].map(p => ({ ...p, quality: marketQuality(p.r.candidate, this.marketSample(p.r.candidate.pool, nowMs)) }))
      .sort((a,b) => a.quality.tier - b.quality.tier || a.quality.risk - b.quality.risk || b.r.score - a.r.score)
      .filter(p => {
        const c = p.r.candidate;
        if (typeof currentReserve === 'bigint' && c.baseMint === current?.baseMint && c.pool !== current.pool) return false;
        if (seenMints.has(c.baseMint)) return false;
        seenMints.add(c.baseMint);
        return true;
      });
    // An unreadable check cannot authorize a handover, but need not discard ongoing measurements.
    const observationOnly = retained.filter(r => !prepared.has(r.candidate.pool) && !invalidWatch.has(r.candidate.pool) && !this.unsafe.has(r.candidate.pool)).map(r => ({ r, reserve: 0n, quality: marketQuality(r.candidate, this.marketSample(r.candidate.pool, nowMs)) }));
    const watching = reserveOrder([...choices, ...observationOnly].map(p => ({ ...p, pool: p.r.candidate.pool, priced: p.quality.sample.priced })), this.watchStarted, nowMs, current?.pool ?? null);
    this.watchStarted = new Map(watching.map(p => [p.pool, this.watchStarted.get(p.pool) ?? nowMs]));
    this.reserveInventory = new Map(watching.map(p => [p.r.candidate.pool, p.r]));
    this.watching = watching.map(p => ({ pool: p.r.candidate.pool, baseMint: p.r.candidate.baseMint, name: p.r.candidate.name, rung: RUNG_NAMES[p.r.rung] }));
    this.reserveStatus = watching.map(p => ({ pool: p.r.candidate.pool, name: p.r.candidate.name, tier: p.quality.tier, risk: round1(p.quality.risk), prepared: p.quality.prepared, up: p.quality.sample.up, down: p.quality.sample.down }));
    const best = choices.find(p => watching.some(w => w.pool === p.r.candidate.pool));
    if (current && currentReserve === 'unreadable') {
      if (this.reservePrice(current.pool, nowMs) !== null) return;
      if (best) {
        this.handover = { r: best.r, reserve: best.reserve, expires: nowMs + 90_000, reason: 'fresh reserve; active price source unavailable' };
        this.activateReserve(nowMs);
      }
      return;
    }
    if (current && typeof currentReserve === 'bigint') {
      const mine = choices.find(p => p.r.candidate.pool === current.pool);
      if (!best || best.r.candidate.pool === current.pool) return;
      const betterQuality = !mine || best.quality.tier < mine.quality.tier || (mine.quality.tier === 2 && best.quality.risk + 0.5 < mine.quality.risk);
      const held = nowMs - current.selectedAtMs >= this.gate.holdMs;
      if (betterQuality || (held && mine && best.quality.tier === mine.quality.tier && best.r.score >= mine.r.score * this.gate.switchRatio && best.quality.risk <= mine.quality.risk)) {
        this.handover = { r: best.r, reserve: best.reserve, expires: nowMs + 90_000, reason: betterQuality ? 'better measured market; continuous handover' : 'higher balanced activity' };
        this.activateReserve(nowMs);
      }
      return;
    }
    if (best) return this.select(best.r, best.reserve, nowMs, 'qualified reserve; continuous handover');
    if (current && currentReserve === null) {
      this.current = null;
      this.onChange(null);
      this.logger({ event: 'pool_dropped', pool: current.pool, reason: this.unsafe.get(current.pool) ?? 'no safe liquid pool', candidates: candidates.length });
    }
  }

  /** Switch only after the standby's feed is live, while the old pool continues serving. */
  activateReserve(nowMs: number): void {
    const next = this.handover;
    if (!next) return;
    if (nowMs > next.expires) { this.handover = null; return; }
    const reserve = this.reservePrice(next.r.candidate.pool, nowMs);
    if (reserve === null || reserve < this.minReserve()) return;
    this.handover = null;
    this.select(next.r, reserve, nowMs, next.reason);
  }

  private select(r: Ranked, reserve: bigint, nowMs: number, reason: string): void {
    const c: Candidate = r.candidate;
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
      // The split of the 5-minute trades, when GeckoTerminal gave it (and whether it was lopsided).
      ...(c.buys !== undefined && c.sells !== undefined ? { buys: c.buys, sells: c.sells, oneSided: r.oneSided } : {}),
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

  /**
   * The quote reserve when the pool is deep enough and its token passes the token check; null when it is too
   * shallow or the token is refused; 'unreadable' when a read failed. A token check that could not be read
   * counts as a pass for the current pool (it is not changed because an RPC failed) and as 'unreadable' for any
   * other candidate (fail closed: it is skipped in this refresh).
   */
  private async qualify(pool: Address, isCurrent: boolean): Promise<bigint | null | 'unreadable'> {
    this.unsafe.delete(pool);
    const reserve = await this.reserveIfDeep(pool);
    if (typeof reserve !== 'bigint' || !this.chain.tokenCheck) return reserve;
    try {
      const verdict = await this.chain.tokenCheck(pool);
      if (verdict.ok) return reserve;
      const reason = `unsafe token: ${verdict.reason}`;
      this.unsafe.set(pool, reason);
      this.warnUnsafe(`unsafe:${pool}`, { event: 'pool_rejected_unsafe', pool, reason: verdict.reason, current: isCurrent });
      return null;
    } catch (error) {
      this.warnUnreadable(`unreadable:${pool}`, { event: 'token_check_failed', pool, error: shortError(error), current: isCurrent, action: isCurrent ? 'kept' : 'skipped' });
      return isCurrent ? reserve : 'unreadable';
    }
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
