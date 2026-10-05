// Mirror of programs/flip-the-meme/src/payout.rs. Both must agree on test/vectors.json.
import { Outcome, Side } from './constants.ts';

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

export function positionPayout(
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
