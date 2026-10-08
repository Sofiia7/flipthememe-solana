/**
 * Fresh PumpSwap pools from the free GeckoTerminal API (about 30 requests per minute per IP), at
 * most 4 requests per refresh; the selector refreshes once a minute.
 *
 * GeckoTerminal cannot sort one dex by creation time (`dexes/pumpswap/pools` takes only the 24 h
 * sorts), and a pool appears in the network-wide `new_pools` list only in its first minutes (on
 * 5 October 2026 a page of 20 spanned 35 s to 3 min). So pools are tracked from there:
 *
 * 0. the 5-minute trending list (optional, 1 request) only adds its PumpSwap pools to the tracked set.
 *    It is never a source of ranking numbers: a trending list is "what is rising right now", and a
 *    round that reads 2.5 minutes of price turns that momentum into UP. Every ranked candidate gets
 *    its numbers from `pools/multi` (or the top list) like any other tracked pool;
 * 1. `pools/multi` (1 request): current numbers of the current pool and of the tracked pools inside
 *    the entry age window, at most 30 (the 20 best scores, then the least recently refreshed);
 * 2. `dexes/pumpswap/pools` by 24 h transactions, one page per refresh, pages 1 and 2 every 5
 *    minutes: older pools for the fallback ladder;
 * 3. `new_pools` (every dex, newest first): pages 1..3 until a page reaches back to the newest
 *    pool seen by the previous refresh. Its PumpSwap pools quoted in wSOL are tracked until they
 *    pass the keep age (180 minutes). The set lives in memory: after a restart pools become
 *    candidates again once they are 10 minutes old, and the fallback ladder covers the gap.
 *
 * The client parses a row into a `PoolCandidate`, which keeps only the sum of the 5-minute trades. The
 * keeper wraps the fetch it hands to the client and notes the `buys` and `sells` of every row it passes
 * (`attributes.transactions.m5`), so candidates carry both numbers (poolgate.ts: a one-sided flow
 * scores low) without a change to the client package.
 *
 * A failed request ends the refresh and skips the next 1, 2, 4, then 8 refreshes (exponential
 * back-off; HTTP 429 is the usual cause). Numbers stay usable for 15 minutes, so the selector keeps
 * working from the last good list meanwhile.
 */
import {
  GECKOTERMINAL_MULTI_LIMIT,
  GeckoTerminalHttpError,
  fetchNewPumpSwapPools,
  fetchTrendingPumpSwapPools,
  fetchPumpSwapPoolsByAddress,
  fetchTopPumpSwapPools,
  type GeckoTerminalFetch,
  type PoolCandidate,
} from '@flipthememe/client';
import type { Address } from '@solana/kit';
import type { Logger } from './log.ts';
import { scoreOf, type Candidate, type PoolGate } from './poolgate.ts';
import { shortError } from './rpc.ts';

export const MAX_CALLS_PER_REFRESH = 4;
export const NEW_POOLS_MAX_PAGES = 3;
const NEW_POOLS_PAGE_SIZE = 20;
export const TOP_PAGES: readonly number[] = [1, 2];
export const TOP_REFRESH_MS = 5 * 60_000;
/** Numbers older than this are dropped: the selector never decides on them. */
export const STATS_MAX_AGE_MS = 15 * 60_000;
/** `pools/multi` slots for the best scores; the rest go to the least recently refreshed pools. */
export const HOT_SLOTS = 20;
export const MAX_SKIPPED_REFRESHES = 8;
const REQUEST_TIMEOUT_MS = 10_000;

type Tracked = { pool: Address; createdAtMs: number; score: number; refreshedAtMs: number };
type Numbers = { candidate: Candidate; atMs: number };
type Flow = { buys: number; sells: number; priceChangeM5?: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** The `buys` and `sells` of the last 5 minutes of every row of a GeckoTerminal answer, by pool address. */
export function flowsOf(body: unknown): Map<Address, Flow> {
  const out = new Map<Address, Flow>();
  const rows = isRecord(body) ? body.data : null;
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const attributes = isRecord(row) ? row.attributes : null;
    if (!isRecord(attributes) || typeof attributes.address !== 'string') continue;
    const transactions = isRecord(attributes.transactions) ? attributes.transactions : null;
    const m5 = transactions && isRecord(transactions.m5) ? transactions.m5 : null;
    const buys = m5 ? count(m5.buys) : null;
    const sells = m5 ? count(m5.sells) : null;
    const changes = isRecord(attributes.price_change_percentage) ? attributes.price_change_percentage : null;
    const raw = changes?.m5;
    const move = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (buys !== null && sells !== null) out.set(attributes.address as Address, { buys, sells, ...(Number.isFinite(move) ? { priceChangeM5: move } : {}) });
  }
  return out;
}

export type DiscoveryResult = {
  /** Pools with numbers at most 15 minutes old: this refresh's, or the last good ones. */
  candidates: Candidate[];
  /** True when this refresh ran and every request succeeded. */
  complete: boolean;
};

export type DiscoveryStatus = {
  tracked: number;
  candidates: number;
  lastOkAt: string | null;
  failures: number;
  skipRefreshes: number;
  requests: number;
};

export class PoolDiscovery {
  private readonly gate: PoolGate;
  private readonly logger: Logger;
  private readonly fetchFn: GeckoTerminalFetch;
  private readonly maxCalls: number;
  private readonly newPoolsPages: number;
  private readonly trending: boolean;
  private readonly topPages: readonly number[];
  private readonly reservePools: () => readonly Address[];
  private readonly isolateNewPools: boolean;
  private newPoolsRetryAt = 0;
  private readonly tracked = new Map<Address, Tracked>();
  private readonly numbers = new Map<Address, Numbers>();
  /** Buys and sells of the last 5 minutes per pool, noted from the raw answers (see flowsOf). */
  private readonly flows = new Map<Address, Flow>();
  private newestSeenMs: number | null = null;
  private topPending: number[] = [];
  private topDueAtMs = Number.NEGATIVE_INFINITY;
  private failures = 0;
  private skips = 0;
  private lastOkAtMs: number | null = null;
  /** GeckoTerminal requests made so far. */
  requests = 0;

  constructor(opts: {
    gate: PoolGate;
    logger: Logger;
    fetchFn?: GeckoTerminalFetch;
    /** Request budget per refresh (default 4). */
    maxCalls?: number;
    /** `new_pools` pages per refresh at most (default 3; 0 turns tracking of new pools off). */
    newPoolsPages?: number;
    /**
     * Start every refresh with the 5-minute trending list (default off). It only adds pools to the
     * tracked set: the numbers that rank candidates come from `pools/multi` and the top list, never
     * from the trending rows. It costs one request of the budget.
     */
    trending?: boolean;
    topPages?: readonly number[];
    reservePools?: () => readonly Address[];
    isolateNewPools?: boolean;
  }) {
    this.gate = opts.gate;
    this.topPages = opts.topPages ?? TOP_PAGES;
    this.reservePools = opts.reservePools ?? (() => []);
    this.isolateNewPools = opts.isolateNewPools ?? false;
    this.logger = opts.logger;
    const base: GeckoTerminalFetch =
      opts.fetchFn ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
    this.fetchFn = async (url, init) => {
      this.requests++;
      const res = await base(url, init);
      return {
        ok: res.ok,
        status: res.status,
        json: async () => {
          const body = await res.json();
          for (const [pool, flow] of flowsOf(body)) this.flows.set(pool, flow);
          return body;
        },
      };
    };
    this.maxCalls = opts.maxCalls ?? MAX_CALLS_PER_REFRESH;
    this.newPoolsPages = Math.min(opts.newPoolsPages ?? NEW_POOLS_MAX_PAGES, NEW_POOLS_MAX_PAGES);
    this.trending = opts.trending ?? false;
  }

  async refresh(nowMs: number, current: Address | null): Promise<DiscoveryResult> {
    this.prune(nowMs);
    if (this.skips > 0) {
      this.skips--;
      return { candidates: this.candidates(nowMs), complete: false };
    }
    let budget = this.maxCalls;
    let step = 'pools/multi';
    try {
      if (this.trending && budget > 0) {
        step = 'trending';
        budget--;
        // Tracking only: its numbers are not used for the ranking (see the header).
        for (const c of await fetchTrendingPumpSwapPools(this.fetchFn, nowMs)) this.track(c, nowMs);
        step = 'pools/multi';
      }
      const ask = this.poolsToRefresh(nowMs, current);
      if (ask.length > 0 && budget > 0) {
        budget--;
        this.record(ask, await fetchPumpSwapPoolsByAddress(this.fetchFn, ask, nowMs), nowMs);
      }

      step = 'top pools';
      if (this.topPending.length === 0 && nowMs >= this.topDueAtMs) {
        this.topPending = [...this.topPages];
        this.topDueAtMs = nowMs + TOP_REFRESH_MS;
      }
      const topPage = this.topPending[0];
      if (topPage !== undefined && budget > (this.newPoolsPages > 0 ? 1 : 0)) {
        budget--;
        for (const c of await fetchTopPumpSwapPools(this.fetchFn, topPage, nowMs)) {
          this.numbers.set(c.pool, { candidate: this.withFlow(c), atMs: nowMs });
        }
        this.topPending.shift();
      }

      step = 'new_pools';
      const previousNewest = this.newestSeenMs;
      let newest = previousNewest;
      for (let page = 1; page <= this.newPoolsPages && budget > 0 && nowMs >= this.newPoolsRetryAt; page++) {
        budget--;
        const result = await fetchNewPumpSwapPools(this.fetchFn, page, nowMs);
        for (const c of result.pumpSwap) this.track(c, nowMs);
        if (result.newestCreatedAtMs !== null && (newest === null || result.newestCreatedAtMs > newest)) {
          newest = result.newestCreatedAtMs;
        }
        const reachedKnown =
          previousNewest !== null && result.oldestCreatedAtMs !== null && result.oldestCreatedAtMs <= previousNewest;
        if (reachedKnown || result.rows < NEW_POOLS_PAGE_SIZE) break;
      }
      // Only after every page read: a failed page means the next refresh reads back that far again.
      // Running out of pages instead leaves a gap, which is accepted.
      this.newestSeenMs = newest;
    } catch (error) {
      if (this.isolateNewPools && step === 'new_pools') {
        this.newPoolsRetryAt = nowMs + 5 * 60_000;
        this.lastOkAtMs = nowMs;
        this.logger({ event: 'new_pools_backoff', error: shortError(error), action: 'reserve and top-list refreshes continue' });
        return { candidates: this.candidates(nowMs), complete: false };
      }
      this.failures++;
      this.skips = Math.min(MAX_SKIPPED_REFRESHES, 2 ** Math.min(this.failures - 1, 10));
      this.logger({
        event: 'pool_discovery_failed',
        request: step,
        error: error instanceof GeckoTerminalHttpError ? `HTTP ${error.status}` : shortError(error),
        failures: this.failures,
        skipRefreshes: this.skips,
        keeping: current,
      });
      return { candidates: this.candidates(nowMs), complete: false };
    }
    this.failures = 0;
    this.lastOkAtMs = nowMs;
    return { candidates: this.candidates(nowMs), complete: true };
  }

  /** `c` with the buys and sells noted for its pool, when there are any. */
  private withFlow(c: PoolCandidate): Candidate {
    const flow = this.flows.get(c.pool);
    return flow ? { ...c, ...flow } : c;
  }

  /** Adds pools to the tracked set (from a `new_pools` page or the trending list; also used by the dry-run script). */
  track(c: PoolCandidate, nowMs: number): void {
    if (this.tracked.has(c.pool) || !(nowMs - c.createdAtMs <= this.gate.keepMaxAgeMs)) return;
    this.tracked.set(c.pool, { pool: c.pool, createdAtMs: c.createdAtMs, score: scoreOf(c, nowMs, this.gate), refreshedAtMs: 0 });
  }

  status(nowMs: number): DiscoveryStatus {
    return {
      tracked: this.tracked.size,
      candidates: this.candidates(nowMs).length,
      lastOkAt: this.lastOkAtMs === null ? null : new Date(this.lastOkAtMs).toISOString(),
      failures: this.failures,
      skipRefreshes: this.skips,
      requests: this.requests,
    };
  }

  /**
   * The pools for `pools/multi`: the current one first, then the tracked pools inside the entry age
   * window, the best scores first and the least recently refreshed after them, 30 at most.
   */
  poolsToRefresh(nowMs: number, current: Address | null): Address[] {
    const eligible = [...this.tracked.values()].filter((t) => {
      const age = nowMs - t.createdAtMs;
      return age >= this.gate.minAgeMs && age <= this.gate.maxAgeMs && t.pool !== current;
    });
    const hot = [...eligible].sort((a, b) => b.score - a.score || b.createdAtMs - a.createdAtMs).slice(0, HOT_SLOTS);
    const hotPools = new Set(hot.map((t) => t.pool));
    const rest = eligible
      .filter((t) => !hotPools.has(t.pool))
      .sort((a, b) => a.refreshedAtMs - b.refreshedAtMs || b.createdAtMs - a.createdAtMs);
    const out: Address[] = [...new Set([...(current ? [current] : []), ...this.reservePools()])].slice(0, 8);
    for (const t of [...hot, ...rest]) {
      if (out.length >= GECKOTERMINAL_MULTI_LIMIT) break;
      if (!out.includes(t.pool)) out.push(t.pool);
    }
    return out;
  }

  private record(asked: readonly Address[], got: readonly PoolCandidate[], nowMs: number): void {
    const found = new Set<Address>();
    for (const c of got) {
      found.add(c.pool);
      this.numbers.set(c.pool, { candidate: this.withFlow(c), atMs: nowMs });
      const t = this.tracked.get(c.pool);
      if (t) {
        t.score = scoreOf(c, nowMs, this.gate);
        t.refreshedAtMs = nowMs;
      }
    }
    // Asked but not returned (unknown to GeckoTerminal, another dex, not wSOL): lowest priority.
    // Older numbers of such a pool simply run out after 15 minutes.
    for (const pool of asked) {
      const t = this.tracked.get(pool);
      if (t && !found.has(pool)) {
        t.score = 0;
        t.refreshedAtMs = nowMs;
      }
    }
  }

  private candidates(nowMs: number): Candidate[] {
    return [...this.numbers.values()].filter((n) => nowMs - n.atMs <= STATS_MAX_AGE_MS).map((n) => n.candidate);
  }

  private prune(nowMs: number): void {
    for (const [pool, t] of this.tracked) {
      if (!(nowMs - t.createdAtMs <= this.gate.keepMaxAgeMs)) this.tracked.delete(pool);
    }
    for (const [pool, n] of this.numbers) {
      if (nowMs - n.atMs > STATS_MAX_AGE_MS) this.numbers.delete(pool);
    }
    for (const pool of this.flows.keys()) {
      if (!this.tracked.has(pool) && !this.numbers.has(pool)) this.flows.delete(pool);
    }
  }
}
