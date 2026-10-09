import { imbalanceOf, type Candidate } from './poolgate.ts';
export type MarketSample = { priced: number; up: number; down: number; dominantShare: number | null };
export function marketQuality(c: Candidate, sample: MarketSample) {
  const flow = imbalanceOf(c);
  const drift = Number.isFinite(c.priceChangeM5) ? Math.abs(c.priceChangeM5!) : null;
  const balanced = flow !== null && flow <= 0.3 && drift !== null && drift <= 1;
  const prepared = sample.priced >= 10;
  // Five measured minutes already give actionable warning; warming is not a licence for 5/5.
  const biased = sample.priced >= 5 && sample.dominantShare! >= 0.8;
  const tier = balanced && !biased ? prepared ? 0 : 1 : 2;
  const risk = (sample.priced >= 5 ? (sample.dominantShare! - 0.5) * 10 : 1) + (flow ?? 1) * 3 + Math.min(drift ?? 10, 10) / 2;
  return { tier, risk, prepared, biased, sample };
}

/** Keep safe warming markets long enough to measure instead of replacing all backups every minute. */
export function reserveOrder<T extends { pool: string; priced: number }>(ranked: readonly T[], previous: ReadonlyMap<string, number>, nowMs: number, current: string | null): T[] {
  const active = ranked.filter(p => p.pool === current);
  const warming = ranked.filter(p => p.pool !== current && p.priced < 10 && previous.has(p.pool) && nowMs - previous.get(p.pool)! < 15 * 60_000);
  const held = new Set([...active, ...warming].map(p => p.pool));
  return [...active, ...warming, ...ranked.filter(p => !held.has(p.pool))].slice(0, 6);
}
/** Background pools need only the synchronized ten-second measurement window, plus RPC-latency margins. */
export function shadowSamplingWindow(nowMs: number) {
  const second = (nowMs % 60_000 + 60_000) % 60_000;
  return second >= 28_000 && second < 43_000;
}
