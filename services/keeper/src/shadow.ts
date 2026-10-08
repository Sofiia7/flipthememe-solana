/**
 * Shadow rounds: the outcome of a round that would have opened at every minute boundary, whether or not
 * anyone bet (or the keeper created it). This is the honest share of UP of the pools the arena plays: the
 * played rounds are few and picked by who bets, the shadow ones cover every minute.
 *
 * At CREATE_LEAD_MS before each boundary the pool that the selector holds at that moment is noted. When the
 * hypothetical round's exit window has closed (opens_at + 160 s, plus the 1 s the keeper waits before it
 * prices a window), the strike and exit means are computed from the observations the sampler already holds,
 * with the same window function the real rounds use (windowMean: one sample per slot, at most 16, zero prices
 * dropped, at least 5 or no price, a whole-number mean). The result is one line:
 *
 *   up        exit mean above the strike mean
 *   down      exit mean below it
 *   tie       equal (the program refunds a tie)
 *   unpriced  one of the two windows had fewer than 5 observations (the program refunds that too)
 *
 * written to the log as `shadow_round` and to shadow.jsonl (bounded, see jsonl.ts). status.json carries the
 * aggregate of the last 200 minutes. A pool that is dropped while its hypothetical round is still pending
 * stays in the sampler's list until the round is evaluated (pendingPools).
 */
import { roundTimes, windowMean, type PriceObservation } from '@flipthememe/client';
import type { Address } from '@solana/kit';
import type { JsonlFile } from './jsonl.ts';
import type { Logger } from './log.ts';
import { CREATE_LEAD_MS, PRICE_AFTER_WINDOW_MS, nextBoundarySecs } from './steps.ts';

/** The aggregate in status.json covers this many minutes. */
export const SHADOW_SUMMARY_MINUTES = 200;
/** Lines of shadow.jsonl read back at start: enough for the summary with room to spare. */
const RESTORE_LINES = SHADOW_SUMMARY_MINUTES * 5;

export type ShadowDir = 'up' | 'down' | 'tie' | 'unpriced';
const DIRS: ReadonlySet<string> = new Set(['up', 'down', 'tie', 'unpriced']);

export type ShadowRow = {
  /** When the outcome was computed (ISO). */
  ts: string;
  /** Unix seconds of the minute boundary the round would have opened at. */
  opensAt: number;
  pool: string;
  mint: string;
  name: string;
  /** Rung of the ladder the pool was picked on (fresh, within-6h, within-24h, any-age). */
  rung: string;
  /** Whole-number means (decimal strings), null when the window had fewer than 5 observations. */
  strikeMean: string | null;
  exitMean: string | null;
  strikeSamples: number;
  exitSamples: number;
  dir: ShadowDir;
  /** Candidate observation only; excluded from the selected-arena summary. */
  observedOnly?: true;
};

export type ShadowSummary = { windowMinutes: number; rounds: number; up: number; down: number; tie: number; unpriced: number; upShare: number | null };

/** What the book needs to know of the selector's current pool. */
export type ShadowPool = { pool: Address; baseMint: Address; name: string; rung: string };

type Pending = ShadowPool & { opensAt: number; observedOnly?: true };

/** The share of UP among the rounds that had a direction (up / (up + down)), three decimals; null with none. */
export function upShare(up: number, down: number): number | null {
  return up + down === 0 ? null : Math.round((up / (up + down)) * 1000) / 1000;
}

export function summarize(rows: readonly ShadowRow[], nowMs: number, minutes: number = SHADOW_SUMMARY_MINUTES): ShadowSummary {
  const since = nowMs - minutes * 60_000;
  const counts = { up: 0, down: 0, tie: 0, unpriced: 0 };
  let rounds = 0;
  for (const row of rows) {
    if (row.observedOnly || row.opensAt * 1000 < since) continue;
    rounds++;
    counts[row.dir]++;
  }
  return { windowMinutes: minutes, rounds, ...counts, upShare: upShare(counts.up, counts.down) };
}

/** Symmetric momentum veto: at least ten priced minutes, 80% in one direction, last 30 minutes. */
export function directionalBias(rows: readonly Pick<ShadowRow, 'pool' | 'opensAt' | 'dir'>[], pool: string, nowMs: number): string | null {
  const recent = rows.filter((r) => r.pool === pool && r.opensAt * 1000 >= nowMs - 30 * 60_000 && r.opensAt * 1000 <= nowMs && (r.dir === 'up' || r.dir === 'down')).sort((a, b) => a.opensAt - b.opensAt).slice(-20);
  if (recent.length < 10) return null;
  const up = recent.filter((r) => r.dir === 'up').length;
  const down = recent.length - up;
  return Math.max(up, down) / recent.length >= 0.8 ? `observed momentum ${up} UP / ${down} DOWN in ${recent.length} priced minutes` : null;
}

/** Observe an unfamiliar pool before accepting calls, rather than funding its first biased minutes. */
export function marketReadiness(rows: readonly Pick<ShadowRow, 'pool' | 'opensAt' | 'dir'>[], pool: string, nowMs: number): string | null {
  const priced = rows.filter((r) => r.pool === pool && r.opensAt * 1000 >= nowMs - 30 * 60_000 && r.opensAt * 1000 <= nowMs && (r.dir === 'up' || r.dir === 'down')).length;
  if (priced < 10) return `observing market: ${priced}/10 priced shadow minutes`;
  return directionalBias(rows, pool, nowMs);
}

/** A row of shadow.jsonl, or null when the object is not one. */
export function parseShadowRow(raw: Record<string, unknown>): ShadowRow | null {
  const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
  const mean = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' && /^\d+$/.test(v) ? v : undefined);
  const dir = text(raw.dir);
  const opensAt = whole(raw.opensAt);
  const strikeSamples = whole(raw.strikeSamples);
  const exitSamples = whole(raw.exitSamples);
  const strikeMean = mean(raw.strikeMean);
  const exitMean = mean(raw.exitMean);
  if (dir === null || !DIRS.has(dir) || opensAt === null || strikeSamples === null || exitSamples === null) return null;
  if (strikeMean === undefined || exitMean === undefined) return null;
  return {
    ts: text(raw.ts) ?? '',
    opensAt,
    pool: text(raw.pool) ?? '',
    mint: text(raw.mint) ?? '',
    name: text(raw.name) ?? '',
    rung: text(raw.rung) ?? '',
    strikeMean,
    exitMean,
    strikeSamples,
    exitSamples,
    dir: dir as ShadowDir,
    ...(raw.observedOnly === true ? { observedOnly: true as const } : {}),
  };
}

export class ShadowBook {
  private readonly store: { get(pool: string): readonly PriceObservation[] };
  private readonly logger: Logger;
  private readonly file: JsonlFile | null;
  private readonly pending = new Map<string, Pending>();
  /** Boundaries already handled (noted or skipped for lack of a pool), so a tick that repeats does nothing. */
  private readonly seen = new Set<number>();
  private rows: ShadowRow[] = [];
  private writeFailed = false;

  constructor(opts: { store: { get(pool: string): readonly PriceObservation[] }; logger: Logger; file?: JsonlFile | null }) {
    this.store = opts.store;
    this.logger = opts.logger;
    this.file = opts.file ?? null;
  }

  /** Loads the rows of the last minutes from shadow.jsonl, so the summary survives a restart. */
  restore(nowMs: number): void {
    if (!this.file) return;
    try {
      const rows: ShadowRow[] = [];
      for (const raw of this.file.read(RESTORE_LINES)) {
        const row = parseShadowRow(raw);
        if (row) rows.push(row);
      }
      this.rows = rows.filter((r) => r.opensAt * 1000 >= nowMs - SHADOW_SUMMARY_MINUTES * 60_000);
      this.logger({ event: 'shadow_restored', rounds: this.rows.length });
    } catch (error) {
      this.logger({ event: 'shadow_restore_failed', error: error instanceof Error ? error.message.slice(0, 200) : 'unreadable' });
    }
  }

  /**
   * Called every second: notes the pool for the next boundary once it is CREATE_LEAD_MS away, and
   * evaluates every hypothetical round whose exit window has closed.
   */
  tick(nowMs: number, current: ShadowPool | null, watching: readonly ShadowPool[] = []): void {
    const boundary = Number(nextBoundarySecs(nowMs));
    if (nowMs >= boundary * 1000 - CREATE_LEAD_MS && !this.seen.has(boundary)) {
      this.seen.add(boundary);
      const pools = new Map<string, Pending>(watching.map(p => [p.pool, { ...p, opensAt: boundary, observedOnly: true }]));
      if (current) pools.set(current.pool, { ...current, opensAt: boundary });
      for (const p of pools.values()) this.pending.set(`${boundary}:${p.pool}`, p);
    }
    for (const [key, round] of this.pending) {
      const times = roundTimes(BigInt(round.opensAt));
      if (nowMs < Number(times.exitEnd) * 1000 + PRICE_AFTER_WINDOW_MS) continue;
      this.pending.delete(key);
      this.evaluate(round, nowMs);
    }
    for (const b of this.seen) if (b < boundary - 10) this.seen.delete(b);
  }

  /** Pools whose hypothetical round is not evaluated yet: the sampler keeps reading them. */
  pendingPools(): Address[] {
    return [...new Set([...this.pending.values()].map((p) => p.pool))];
  }

  summary(nowMs: number): ShadowSummary {
    return summarize(this.rows, nowMs);
  }

  bias(pool: string, nowMs: number): string | null {
    return directionalBias(this.rows, pool, nowMs);
  }

  readiness(pool: string, nowMs: number): string | null {
    return marketReadiness(this.rows, pool, nowMs);
  }

  private evaluate(round: Pending, nowMs: number): void {
    const times = roundTimes(BigInt(round.opensAt));
    const observations = this.store.get(round.pool);
    const strike = windowMean(observations, Number(times.strikeStart) * 1000, Number(times.strikeEnd) * 1000);
    const exit = windowMean(observations, Number(times.exitStart) * 1000, Number(times.exitEnd) * 1000);
    let dir: ShadowDir = 'unpriced';
    if (strike && exit) dir = exit.price > strike.price ? 'up' : exit.price < strike.price ? 'down' : 'tie';
    const row: ShadowRow = {
      ts: new Date(nowMs).toISOString(),
      opensAt: round.opensAt,
      pool: round.pool,
      mint: round.baseMint,
      name: round.name,
      rung: round.rung,
      strikeMean: strike ? strike.price.toString() : null,
      exitMean: exit ? exit.price.toString() : null,
      strikeSamples: strike ? strike.samples.length : 0,
      exitSamples: exit ? exit.samples.length : 0,
      dir,
      ...(round.observedOnly ? { observedOnly: true as const } : {}),
    };
    this.rows.push(row);
    const cutoff = nowMs - SHADOW_SUMMARY_MINUTES * 60_000;
    while (this.rows.length > 0 && (this.rows[0]?.opensAt ?? 0) * 1000 < cutoff) this.rows.shift();
    this.logger({ event: 'shadow_round', ...row });
    if (!this.file) return;
    try {
      this.file.append(row);
      this.writeFailed = false;
    } catch (error) {
      // One line when it starts failing, not one per minute.
      if (!this.writeFailed) this.logger({ event: 'shadow_write_failed', file: this.file.path, error: error instanceof Error ? error.message.slice(0, 200) : 'unwritable' });
      this.writeFailed = true;
    }
  }
}
