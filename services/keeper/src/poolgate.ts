/**
 * Which PumpSwap pool the arena plays, as pure functions over GeckoTerminal numbers (the SOL depth
 * gate is on chain, in the selector):
 *
 * - entry gate ("fresh" rung): pool age between 10 and 120 minutes and at least 50 trades in the
 *   last 5 minutes;
 * - fallback ladder when nothing fresh qualifies: the same activity minimum up to 6 h of age, then
 *   up to 24 h, then the most active pool of any age (no activity minimum). The 10 minute minimum
 *   age holds on every rung: the first minutes of a pool are bot sniping, not a price;
 * - score: trades in 5 minutes with a bonus for youth, `txM5 * (1 + (maxAge - age) / maxAge)`
 *   (twice the trades at age 0, no bonus from `maxAge` on);
 * - keep gate (looser than the entry gate, so the arena does not flap): the current pool is
 *   replaced after its hold when it drops below 20 trades in 5 minutes or gets older than 180
 *   minutes (fallback rungs: their age limit plus the same 60 minutes of grace).
 */
import type { PoolCandidate } from '@flipthememe/client';

export const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export type PoolGate = {
  /** Entry gate: pool age at least this ... */
  minAgeMs: number;
  /** ... and at most this ... */
  maxAgeMs: number;
  /** ... with at least this many trades (buys + sells) in the last 5 minutes. */
  minTxM5: number;
  /** The current pool stays at least this long (unless its SOL depth fails). */
  holdMs: number;
  /** After the hold, a candidate of the same rung must score this many times the current pool. */
  switchRatio: number;
  /** Keep gate: after the hold the current pool is replaced below this many trades in 5 minutes ... */
  keepMinTxM5: number;
  /** ... or when it is older than this (fresh rung). */
  keepMaxAgeMs: number;
  /** Only pump.fun graduates (vanity mints ending in "pump"); pools created on PumpSwap directly get drained fast. */
  pumpOnly: boolean;
};

export const DEFAULT_GATE: Readonly<PoolGate> = Object.freeze({
  minAgeMs: 10 * MINUTE_MS,
  maxAgeMs: 120 * MINUTE_MS,
  minTxM5: 50,
  holdMs: 10 * MINUTE_MS,
  switchRatio: 1.5,
  keepMinTxM5: 20,
  keepMaxAgeMs: 180 * MINUTE_MS,
  // On in production through POOL_PUMP_ONLY=true (deploy/docker-compose.yml); off here so fixtures stay plain.
  pumpOnly: false,
});

/** pump.fun mints are vanity addresses ending in "pump". */
export function isPumpFunMint(mint: string): boolean {
  return mint.endsWith('pump');
}

/** 0 fresh, 1 up to 6 h old, 2 up to 24 h old, 3 any age. */
export type Rung = 0 | 1 | 2 | 3;
export const RUNG_NAMES = ['fresh', 'within-6h', 'within-24h', 'any-age'] as const;
/** Age limits of the two widened rungs. */
export const FALLBACK_MAX_AGES_MS = [6 * HOUR_MS, 24 * HOUR_MS] as const;

export type Ranked = { candidate: PoolCandidate; rung: Rung; score: number };

export function isRung(value: unknown): value is Rung {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

/** The best rung a pool qualifies for by its numbers, or null while it is too young (or undated). */
export function rungOf(c: PoolCandidate, nowMs: number, gate: PoolGate): Rung | null {
  if (gate.pumpOnly && !isPumpFunMint(c.baseMint)) return null;
  const age = nowMs - c.createdAtMs;
  if (!(age >= gate.minAgeMs)) return null;
  if (c.txM5 >= gate.minTxM5) {
    if (age <= gate.maxAgeMs) return 0;
    if (age <= FALLBACK_MAX_AGES_MS[0]) return 1;
    if (age <= FALLBACK_MAX_AGES_MS[1]) return 2;
  }
  return 3;
}

/** Activity with a preference for younger pools: `txM5 * (1 + (maxAge - age) / maxAge)`, bonus >= 0. */
export function scoreOf(c: PoolCandidate, nowMs: number, gate: PoolGate): number {
  const age = Math.max(0, nowMs - c.createdAtMs);
  const bonus = Math.max(0, gate.maxAgeMs - age) / gate.maxAgeMs;
  return c.txM5 * (1 + bonus);
}

/** Pools that qualify for a rung, best first: lower rung, then higher score (first row per pool). */
export function rankCandidates(candidates: readonly PoolCandidate[], nowMs: number, gate: PoolGate): Ranked[] {
  const seen = new Set<string>();
  const ranked: Ranked[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.pool)) continue;
    seen.add(candidate.pool);
    const rung = rungOf(candidate, nowMs, gate);
    if (rung !== null) ranked.push({ candidate, rung, score: scoreOf(candidate, nowMs, gate) });
  }
  return ranked.sort((a, b) => a.rung - b.rung || b.score - a.score);
}

/** Age limit of the keep gate for a pool picked on `rung` (none for the any-age rung). */
export function keepMaxAgeMs(rung: Rung, gate: PoolGate): number {
  if (rung === 0) return gate.keepMaxAgeMs;
  if (rung === 3) return Number.POSITIVE_INFINITY;
  return FALLBACK_MAX_AGES_MS[rung - 1] + (gate.keepMaxAgeMs - gate.maxAgeMs);
}

/**
 * Why the current pool, picked on `rung`, no longer passes the keep gate (null while it passes).
 * `stats` are its latest GeckoTerminal numbers; without them the pool counts as unlisted.
 */
export function keepFailure(stats: PoolCandidate | undefined, rung: Rung, nowMs: number, gate: PoolGate): string | null {
  if (!stats) return 'unlisted';
  if (rung === 3) return null;
  if (stats.txM5 < gate.keepMinTxM5) return `txM5 ${stats.txM5} < ${gate.keepMinTxM5}`;
  const age = nowMs - stats.createdAtMs;
  const limit = keepMaxAgeMs(rung, gate);
  if (!(age <= limit)) return `age ${Math.round(age / MINUTE_MS)} min > ${Math.round(limit / MINUTE_MS)} min`;
  return null;
}

/** True when `candidate` should replace a current pool that still passes its keep gate. */
export function beats(candidate: Pick<Ranked, 'rung' | 'score'>, current: Pick<Ranked, 'rung' | 'score'>, gate: PoolGate): boolean {
  if (candidate.rung !== current.rung) return candidate.rung < current.rung;
  return candidate.score > current.score && candidate.score >= gate.switchRatio * current.score;
}
