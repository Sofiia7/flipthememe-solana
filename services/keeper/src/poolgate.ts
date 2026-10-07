/**
 * Production enables PoolGate.neutral in loadConfig: rank by balanced activity across all ages,
 * reject missing flow / one-sided flow / low activity, and apply retention checks before the hold.
 * The age ladder below is retained only for the explicit POOL_NEUTRAL=false compatibility mode.
 * Which PumpSwap pool the arena plays, as pure functions over GeckoTerminal numbers (the SOL depth
 * gate is on chain, in the selector):
 *
 * - entry gate ("fresh" rung): pool age between 10 and 120 minutes and at least 50 trades in the
 *   last 5 minutes;
 * - fallback ladder when nothing fresh qualifies: the same activity minimum up to 6 h of age, then
 *   up to 24 h, then the most active pool of any age (no activity minimum). The 10 minute minimum
 *   age holds on every rung: the first minutes of a pool are bot sniping, not a price;
 * - score: trades in 5 minutes, penalised for one-sided flow and with a bonus for youth,
 *   `txM5 * (1 - |buys - sells| / txM5) * (1 + (maxAge - age) / maxAge)` (twice the trades at age 0, no
 *   bonus from `maxAge` on; a pool whose trades are all buys or all sells scores 0). A candidate
 *   without the buys and sells split counts as balanced;
 * - soft gate on one-sided flow: a candidate with `|buys - sells| > 0.5 * txM5` is ranked behind every
 *   balanced one while a balanced pool of the entry or fallback rungs exists (a one-sided stream is
 *   momentum, and momentum is what a 2.5 minute round reads as UP);
 * - keep gate (looser than the entry gate, so the arena does not flap): the current pool is
 *   replaced after its hold when it drops below 20 trades in 5 minutes or gets older than 180
 *   minutes (fallback rungs: their age limit plus the same 60 minutes of grace).
 */
import type { PoolCandidate } from '@flipthememe/client';

/**
 * A GeckoTerminal candidate with the split of its 5-minute trades. The client's `PoolCandidate` only
 * carries their sum (`txM5`); discovery.ts reads the two numbers from the raw rows and adds them here,
 * so a candidate that has no split (a test fixture, an old restore) simply scores as balanced.
 */
export type Candidate = PoolCandidate & { buys?: number; sells?: number };

export const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export type PoolGate = {
  /** Production selection: no age preference, hard flow/activity checks on entry and retention. */
  neutral?: boolean;
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
  /** One-sided flow: `|buys - sells| > maxImbalance * txM5` ranks a candidate behind the balanced ones (POOL_MAX_IMBALANCE). */
  maxImbalance: number;
  /** Weight of the youth bonus in the score: 1 as before, 0 no bonus (POOL_YOUTH_WEIGHT). */
  youthWeight: number;
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
  maxImbalance: 0.5,
  youthWeight: 1,
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

export type Ranked = { candidate: Candidate; rung: Rung; score: number; oneSided: boolean };

export function isRung(value: unknown): value is Rung {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

/** The best rung a pool qualifies for by its numbers, or null while it is too young (or undated). */
export function rungOf(c: Candidate, nowMs: number, gate: PoolGate): Rung | null {
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

/**
 * `|buys - sells| / txM5` of the last 5 minutes: 0 balanced, 1 one side only. Null when the split is
 * unknown or there were no trades; that counts as balanced (no number, no penalty).
 */
export function imbalanceOf(c: Candidate): number | null {
  if (c.buys === undefined || c.sells === undefined || !(c.txM5 > 0)) return null;
  return Math.min(1, Math.abs(c.buys - c.sells) / c.txM5);
}

/** True when the 5-minute flow is one-sided beyond the gate (the soft gate of rankCandidates). */
export function isOneSided(c: Candidate, gate: PoolGate): boolean {
  const imbalance = imbalanceOf(c);
  return imbalance !== null && imbalance > gate.maxImbalance;
}

/**
 * Activity, penalised for one-sided flow, with a preference for younger pools:
 * `txM5 * (1 - imbalance) * (1 + youthWeight * (maxAge - age) / maxAge)`, bonus >= 0.
 */
export function scoreOf(c: Candidate, nowMs: number, gate: PoolGate): number {
  const age = Math.max(0, nowMs - c.createdAtMs);
  const bonus = Math.max(0, gate.maxAgeMs - age) / gate.maxAgeMs;
  return c.txM5 * (1 - (imbalanceOf(c) ?? 0)) * (1 + (gate.neutral ? 0 : gate.youthWeight) * bonus);
}

export function neutralFailure(c: Candidate | undefined, gate: PoolGate, minimum: number): string | null {
  if (!c) return 'flow statistics unavailable';
  const flow = imbalanceOf(c);
  if (flow === null || !Number.isFinite(c.buys) || !Number.isFinite(c.sells) || c.buys! < 0 || c.sells! < 0 || c.buys! + c.sells! !== c.txM5) return 'flow statistics unavailable';
  if (c.txM5 < minimum) return `txM5 ${c.txM5} < ${minimum}`;
  return flow > gate.maxImbalance ? `flow imbalance ${flow.toFixed(3)} > ${gate.maxImbalance}` : null;
}

/**
 * Pools that qualify for a rung, best first: lower rung, then higher score (first row per pool).
 * Soft gate: while a balanced pool of the fresh or fallback rungs (not the any-age rung, which has no
 * activity minimum) is among them, the one-sided pools come after all balanced ones, each group in
 * rung and score order. They are not removed: with no balanced pool, or when the balanced ones fail
 * the depth check, they still serve as before.
 */
export function rankCandidates(candidates: readonly Candidate[], nowMs: number, gate: PoolGate): Ranked[] {
  const seen = new Set<string>();
  const ranked: Ranked[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.pool)) continue;
    seen.add(candidate.pool);
    if (gate.neutral && neutralFailure(candidate, gate, gate.minTxM5)) continue;
    const rung = rungOf(candidate, nowMs, gate);
    if (rung !== null) ranked.push({ candidate, rung, score: scoreOf(candidate, nowMs, gate), oneSided: isOneSided(candidate, gate) });
  }
  ranked.sort((a, b) => gate.neutral ? b.score - a.score || a.candidate.pool.localeCompare(b.candidate.pool) : a.rung - b.rung || b.score - a.score);
  if (gate.neutral) return ranked;
  if (!ranked.some((r) => !r.oneSided && r.rung < 3)) return ranked;
  return [...ranked.filter((r) => !r.oneSided), ...ranked.filter((r) => r.oneSided)];
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
export function keepFailure(stats: Candidate | undefined, rung: Rung, nowMs: number, gate: PoolGate): string | null {
  if (gate.neutral) return neutralFailure(stats, gate, gate.keepMinTxM5);
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
  if (!gate.neutral && candidate.rung !== current.rung) return candidate.rung < current.rung;
  return candidate.score > current.score && candidate.score >= gate.switchRatio * current.score;
}
