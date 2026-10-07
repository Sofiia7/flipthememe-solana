// Mirror of programs/flip-the-meme/src/payout.rs. Both must agree on test/vectors.json.
import { Outcome, RefundReason, Side } from './constants.ts';

const BPS = 10_000n;

export function isActivated(rawUp: bigint, rawDown: bigint, minBank: bigint): boolean {
  const m = rawUp < rawDown ? rawUp : rawDown;
  return m > 0n && m * 2n >= minBank;
}

/** The part of `stake` that plays; floors on the larger side. `null` if stake exceeds its side. */
export function acceptedStake(rawUp: bigint, rawDown: bigint, side: Side, stake: bigint): bigint | null {
  const [mine, other] = side === Side.Up ? [rawUp, rawDown] : [rawDown, rawUp];
  if (stake > mine) return null;
  if (mine <= other) return stake;
  return (stake * other) / mine;
}

/**
 * What claim needs beyond the book. Only a matched round that ended without a price (Expired, or
 * Unpriceable: too few observations) looks at it: the house position then forfeits its stake and
 * the other positions share it (see `positionPayout`).
 */
export type HouseContext = {
  /** Round.refundReason. */
  refundReason: RefundReason;
  /** Round.houseAmount: everything the house put into the round. */
  houseAmount: bigint;
  /** Position.isHouse. */
  isHouse: boolean;
};

/** The `HouseContext` of one position, from its round account and its own account. */
export function houseContext(
  round: { refundReason: RefundReason; houseAmount: bigint },
  position: { isHouse: boolean },
): HouseContext {
  return { refundReason: round.refundReason, houseAmount: round.houseAmount, isHouse: position.isHouse };
}

/**
 * Lamports credited to a position once its round is final: the claim payout of the program
 * (`claim_payout` in payout.rs). Without `house` it is the plain payout of the book. With it, a
 * Refund that ended without a price (reason Expired or Unpriceable) also applies the house rule:
 *   house position:       0
 *   any other position:   its normal refund + floor(houseAmount * stake / otherStakes)
 * where otherStakes = rawUp + rawDown - houseAmount. If the house stake is the whole bank
 * (otherStakes = 0) there is nobody to compensate and nothing is forfeited. Every other outcome
 * and refund reason (a Tie, an unmatched NotActivated round, a priced round), and a round with no
 * house stake, pay exactly as without `house`.
 */
export function positionPayout(
  rawUp: bigint,
  rawDown: bigint,
  outcome: Outcome,
  feeWinBps: number,
  feeRefundBps: number,
  side: Side,
  stake: bigint,
  house?: HouseContext,
): bigint | null {
  const base = bookPayout(rawUp, rawDown, outcome, feeWinBps, feeRefundBps, side, stake);
  if (base === null || house === undefined) return base;
  const unpriced = house.refundReason === RefundReason.Expired || house.refundReason === RefundReason.Unpriceable;
  if (outcome !== Outcome.Refund || !unpriced || house.houseAmount === 0n) return base;
  const otherStakes = rawUp + rawDown - house.houseAmount;
  if (otherStakes < 0n) return null;
  if (otherStakes === 0n) return base;
  if (house.isHouse) return 0n;
  return base + (house.houseAmount * stake) / otherStakes;
}

function bookPayout(
  rawUp: bigint,
  rawDown: bigint,
  outcome: Outcome,
  feeWinBps: number,
  feeRefundBps: number,
  side: Side,
  stake: bigint,
): bigint | null {
  if (outcome === Outcome.Pending) return null;
  if (outcome === Outcome.NotActivated) return stake;
  const accepted = acceptedStake(rawUp, rawDown, side, stake);
  if (accepted === null) return null;
  const excess = stake - accepted;
  if (outcome === Outcome.Refund) return excess + (accepted * (BPS - BigInt(feeRefundBps))) / BPS;
  const won = (outcome === Outcome.Up && side === Side.Up) || (outcome === Outcome.Down && side === Side.Down);
  if (!won) return excess;
  return excess + (accepted * 2n * (BPS - BigInt(feeWinBps))) / BPS;
}

/** Multiplier paid on the accepted part of a winning stake, in basis points (19_600 = 1.96x). */
export function winMultiplierBps(feeWinBps: number): bigint {
  return 2n * (BPS - BigInt(feeWinBps));
}

export type BetPreview = {
  /** Plays if entry closed with the book as it is now (the house may still match the rest). */
  acceptedNow: bigint;
  returnedNow: bigint;
  /** Credited on a win, counting the returned surplus. */
  payoutIfWin: bigint;
  /** Credited on a win if the house matches the whole stake (cap permitting). */
  payoutIfMatched: bigint;
};

/** What a new stake would do in the current book, before the house fills the gap. */
export function previewBet(
  book: { rawUp: bigint; rawDown: bigint; feeWinBps: number },
  side: Side,
  stake: bigint,
): BetPreview {
  const rawUp = book.rawUp + (side === Side.Up ? stake : 0n);
  const rawDown = book.rawDown + (side === Side.Down ? stake : 0n);
  const acceptedNow = acceptedStake(rawUp, rawDown, side, stake) ?? 0n;
  const outcome = side === Side.Up ? Outcome.Up : Outcome.Down;
  return {
    acceptedNow,
    returnedNow: stake - acceptedNow,
    payoutIfWin: rawUp > 0n && rawDown > 0n ? (positionPayout(rawUp, rawDown, outcome, book.feeWinBps, 0, side, stake) ?? stake) : stake,
    payoutIfMatched: (stake * winMultiplierBps(book.feeWinBps)) / BPS,
  };
}
