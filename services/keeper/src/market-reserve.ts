import { imbalanceOf, type Candidate } from './poolgate.ts';
export type MarketSample = { priced: number; up: number; down: number; dominantShare: number | null };
export function marketQuality(c: Candidate, sample: MarketSample) {
  const flow = imbalanceOf(c);
  const drift = Number.isFinite(c.priceChangeM5) ? Math.abs(c.priceChangeM5!) : null;
  const balanced = flow !== null && flow <= 0.3 && drift !== null && drift <= 1;
  const prepared = sample.priced >= 10;
  const biased = prepared && sample.dominantShare! >= 0.8;
  const tier = balanced && !biased ? prepared ? 0 : 1 : 2;
  const risk = (prepared ? (sample.dominantShare! - 0.5) * 10 : 1) + (flow ?? 1) * 3 + Math.min(drift ?? 10, 10) / 2;
  return { tier, risk, prepared, biased, sample };
}
/** Background pools need only the synchronized ten-second measurement window, plus RPC-latency margins. */
export function shadowSamplingWindow(nowMs: number) {
  const second = (nowMs % 60_000 + 60_000) % 60_000;
  return second >= 28_000 && second < 43_000;
}
