/**
 * Round windows and the price comparison.
 *
 * A window is the round's [start, end) in unix ms: strike_start..strike_end or exit_start..exit_end.
 * The sampler reads the round's pool from SAMPLE_MARGIN_MS before a window until SAMPLE_MARGIN_MS
 * after it: the strike window while the round is Open, the exit window until the round is Final.
 * The keeper takes its samples from the same [start, end) on its own clock (windowSamples in
 * services/keeper), so the margins absorb clock skew and the attestor's slot range covers the
 * keeper's even when an edge read fails.
 */
import { RoundStatus, type PriceSample, type RoundAccount } from '@flipthememe/client';
import { PROGRAM_MIN_SAMPLES, Refusal } from './check.ts';

export type WindowKind = 'strike' | 'exit';
export type RoundWindow = { roundId: bigint; kind: WindowKind; pool: string; startMs: number; endMs: number };
/** One of the attestor's own reads of a pool: local time of the reply, mainnet slot, price. */
export type Observation = { atMs: number; slot: bigint; price: bigint };
export type WindowRound = Pick<RoundAccount, 'id' | 'pool' | 'status' | 'strikeStart' | 'strikeEnd' | 'exitStart' | 'exitEnd'>;

/** Sampling starts this long before a window and goes on this long after it. */
export const SAMPLE_MARGIN_MS = 1_500;
/** Keeper slots may lie this many slots (about 0.4 s each) beyond the range the attestor read. */
export const SLOT_MARGIN = 10n;
/** The attestor's own reads inside the window it needs before it compares at all. */
export const MIN_OWN_SAMPLES = 3;
export const DEFAULT_TOLERANCE_BPS = 150;

export function windowOf(round: WindowRound, kind: WindowKind): RoundWindow {
  const [start, end] = kind === 'strike' ? [round.strikeStart, round.strikeEnd] : [round.exitStart, round.exitEnd];
  return { roundId: round.id, kind, pool: round.pool, startMs: Number(start) * 1000, endMs: Number(end) * 1000 };
}

/** Windows that may still be priced: the strike window while the round is Open, the exit window until it is Final. */
export function pendingWindows(rounds: Iterable<WindowRound>): RoundWindow[] {
  const out: RoundWindow[] = [];
  for (const round of rounds) {
    if (round.status === RoundStatus.Open) out.push(windowOf(round, 'strike'));
    if (round.status !== RoundStatus.Final) out.push(windowOf(round, 'exit'));
  }
  return out;
}

/** Windows to sample at `nowMs`: [start - margin, end + margin) holds it. */
export function activeWindows(rounds: Iterable<WindowRound>, nowMs: number, marginMs: number = SAMPLE_MARGIN_MS): RoundWindow[] {
  return pendingWindows(rounds).filter((w) => nowMs >= w.startMs - marginMs && nowMs < w.endMs + marginMs);
}

/** When sampling of the next window begins after `nowMs`; null when no known window lies ahead. */
export function nextSamplingStart(rounds: Iterable<WindowRound>, nowMs: number, marginMs: number = SAMPLE_MARGIN_MS): number | null {
  let next: number | null = null;
  for (const w of pendingWindows(rounds)) {
    const at = w.startMs - marginMs;
    if (at > nowMs && (next === null || at < next)) next = at;
  }
  return next;
}

/** floor(sum / n), as the program's mean_price. */
export function meanPrice(prices: readonly bigint[]): bigint {
  if (prices.length === 0) throw new Error('meanPrice: no prices');
  let sum = 0n;
  for (const p of prices) sum += p;
  return sum / BigInt(prices.length);
}

/** The first read of each slot, in the order given (by time). */
function firstPerSlot(reads: readonly Observation[]): Observation[] {
  const seen = new Set<bigint>();
  const out: Observation[] = [];
  for (const o of reads) {
    if (seen.has(o.slot)) continue;
    seen.add(o.slot);
    out.push(o);
  }
  return out;
}

export type Agreement = {
  keeperMean: bigint;
  ownMean: bigint;
  /** |keeperMean - ownMean| in basis points of ownMean, rounded down. */
  diffBps: number;
  ownSamples: number;
  /** Keeper samples at a slot the attestor read too; their prices were equal. */
  sharedSlots: number;
  /** Slots the keeper's samples had to lie in, margin included. */
  slotRange: [bigint, bigint];
};

/**
 * The keeper's samples against the attestor's own reads of the window. `own` holds every read the
 * attestor took for the window, margins included: the slot range and the shared slots come from
 * all of them, the count and the mean from the reads inside [start, end) (first read per slot,
 * like the keeper).
 *
 * Two lines of defence. Where the keeper and the attestor read the pool at the same context slot
 * (the same confirmed bank, so the same vault balances) the prices must be equal to the unit. Then
 * the means must agree within `toleranceBps`, which bounds what the keeper could do at the slots
 * only it read.
 */
export function compareSamples(
  keeper: readonly PriceSample[],
  own: readonly Observation[],
  window: { startMs: number; endMs: number },
  toleranceBps: number,
): Agreement {
  if (keeper.length < PROGRAM_MIN_SAMPLES) {
    throw new Refusal(
      'unpriced',
      `${keeper.length} keeper samples fix no price (the program needs ${PROGRAM_MIN_SAMPLES}); a round without a price ends through refund_expired, which needs no attestor`,
    );
  }
  const valid = own.filter((o) => o.price > 0n);
  const reads = firstPerSlot(valid);
  const inside = reads.filter((o) => o.atMs >= window.startMs && o.atMs < window.endMs);
  if (inside.length < MIN_OWN_SAMPLES) {
    throw new Refusal('too_few_samples', `the attestor holds ${inside.length} reads of this window; it needs ${MIN_OWN_SAMPLES}`);
  }
  let low = reads[0]!.slot;
  let high = low;
  for (const o of reads) {
    if (o.slot < low) low = o.slot;
    if (o.slot > high) high = o.slot;
  }
  low = low > SLOT_MARGIN ? low - SLOT_MARGIN : 0n;
  high += SLOT_MARGIN;
  const outside = keeper.find((s) => s.slot < low || s.slot > high);
  if (outside) {
    throw new Refusal('slot_out_of_range', `keeper slot ${outside.slot} lies outside ${low}..${high}, the slots the attestor read for this window`);
  }

  // First line: same slot, same price. Every read of the attestor at that slot must agree.
  const pricesAt = new Map<bigint, bigint[]>();
  for (const o of valid) {
    const list = pricesAt.get(o.slot);
    if (list) list.push(o.price);
    else pricesAt.set(o.slot, [o.price]);
  }
  const shared = keeper.filter((s) => pricesAt.has(s.slot));
  for (const s of shared) {
    const ownPrice = pricesAt.get(s.slot)!.find((p) => p !== s.price);
    if (ownPrice !== undefined) {
      throw new Refusal(
        'slot_price_mismatch',
        'a keeper sample differs from the attestor read of the same pool at the same slot (same confirmed bank, same vault balances)',
        { slot: s.slot, keeperPrice: s.price, ownPrice, sharedSlots: shared.length },
      );
    }
  }

  // Second line: the means, within the tolerance.
  const keeperMean = meanPrice(keeper.map((s) => s.price));
  const ownMean = meanPrice(inside.map((o) => o.price));
  const diff = keeperMean > ownMean ? keeperMean - ownMean : ownMean - keeperMean;
  const diffBps = Number((diff * 10_000n) / ownMean);
  if (diff * 10_000n > BigInt(toleranceBps) * ownMean) {
    throw new Refusal(
      'price_mismatch',
      `keeper mean ${keeperMean} and attestor mean ${ownMean} are ${diffBps} bps apart; the tolerance is ${toleranceBps}`,
      { keeperMean, ownMean, diffBps, sharedSlots: shared.length },
    );
  }
  return { keeperMean, ownMean, diffBps, ownSamples: inside.length, sharedSlots: shared.length, slotRange: [low, high] };
}
