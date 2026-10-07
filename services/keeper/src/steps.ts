/**
 * Which step a round needs next, decided only from its on-chain state and the clock, so a
 * restarted keeper simply carries on where the chain is.
 */
import { RoundStatus, type RoundAccount } from '@flipthememe/client';

/** Create the next round this long before its minute boundary. */
export const CREATE_LEAD_MS = 15_000;
/** House fill window, local clock: [cutoff + 2 s, strike_start - 3 s). */
export const FILL_AFTER_CUTOFF_MS = 2_000;
export const FILL_BEFORE_STRIKE_MS = 3_000;
/** Strike and settle are sent this long after their window ends (local clock). */
export const PRICE_AFTER_WINDOW_MS = 1_000;

export type RoundView = Pick<
  RoundAccount,
  | 'id'
  | 'status'
  | 'opensAt'
  | 'cutoffAt'
  | 'strikeStart'
  | 'strikeEnd'
  | 'exitStart'
  | 'exitEnd'
  | 'settleDeadline'
  | 'rawUp'
  | 'rawDown'
  | 'houseAmount'
  | 'totalPaid'
  | 'positionCount'
  | 'claimedCount'
  | 'feesSwept'
>;

export type StepContext = {
  /** Estimated devnet clock minus local clock, in ms (devnet usually lags, so this is negative). */
  chainOffsetMs: number;
};

export type StepKind = 'fill' | 'strike' | 'settle' | 'expire' | 'claim' | 'sweep' | 'close';
export type Step = { kind: StepKind } | { kind: 'wait' } | { kind: 'done' };

const WAIT: Step = { kind: 'wait' };
const ms = (secs: bigint): number => Number(secs) * 1000;

/**
 * The first step that is due for `round` at local time `nowMs`:
 *
 * - Final: claim every position, then sweep the fees; a round without positions is closed (after its
 *   sweep, when it still holds something to sweep).
 * - Not final and the devnet clock is past `settle_deadline`: refund_expired.
 * - Open after `strike_end` (+1 s locally, and the devnet clock past it too) and while the devnet
 *   clock is before `exit_start`: set_strike. The program itself turns a round without a matched
 *   bank into NotActivated. From `exit_start` on the program rejects set_strike (a strike set with
 *   the exit window already open could be chosen with the exit in sight), so the keeper waits
 *   and the round ends through refund_expired at `settle_deadline`, as above.
 * - Open in the fill window with unequal sides, at least one position and no house stake yet:
 *   house_fill (the amount and whether to skip are the house policy's call).
 * - Live after `exit_end` (+1 s locally, and the devnet clock past it too): settle.
 */
export function nextStep(round: RoundView, nowMs: number, ctx: StepContext): Step {
  if (round.status === RoundStatus.Final) {
    if (round.positionCount === 0) {
      // The program closes a round with no position left only once its fees are swept, or when
      // nothing is left to sweep (the whole bank was paid out). Positions closed early by anyone can
      // leave a played round here with the sweep still due.
      return round.feesSwept || round.totalPaid === round.rawUp + round.rawDown ? { kind: 'close' } : { kind: 'sweep' };
    }
    if (round.claimedCount < round.positionCount) return { kind: 'claim' };
    if (!round.feesSwept) return { kind: 'sweep' };
    return { kind: 'done' };
  }
  const chainMs = nowMs + ctx.chainOffsetMs;
  // Program: refund_expired needs now > settle_deadline (whole seconds).
  if (chainMs >= ms(round.settleDeadline) + 1000) return { kind: 'expire' };
  if (round.status === RoundStatus.Open) {
    if (nowMs >= ms(round.strikeEnd) + PRICE_AFTER_WINDOW_MS) {
      // Program: set_strike needs strike_end <= now < exit_start (whole seconds, devnet clock).
      if (chainMs >= ms(round.exitStart)) return WAIT;
      return chainMs >= ms(round.strikeEnd) ? { kind: 'strike' } : WAIT;
    }
    const inFillWindow =
      nowMs >= ms(round.cutoffAt) + FILL_AFTER_CUTOFF_MS &&
      nowMs < ms(round.strikeStart) - FILL_BEFORE_STRIKE_MS &&
      chainMs >= ms(round.cutoffAt) &&
      chainMs < ms(round.strikeStart) - 1000;
    if (inFillWindow && round.houseAmount === 0n && round.positionCount > 0 && round.rawUp !== round.rawDown) {
      return { kind: 'fill' };
    }
    return WAIT;
  }
  if (round.status === RoundStatus.Live) {
    if (nowMs >= ms(round.exitEnd) + PRICE_AFTER_WINDOW_MS && chainMs >= ms(round.exitEnd)) return { kind: 'settle' };
    return WAIT;
  }
  return WAIT;
}

/** Start of the next UTC minute after `nowMs`, in unix seconds. */
export function nextBoundarySecs(nowMs: number): bigint {
  return BigInt(Math.floor(nowMs / 60_000) * 60 + 60);
}

/**
 * The opening time of the round to create now, or null. Only the next upcoming minute is ever
 * created, never a minute that already started, so a keeper that was down does not backfill.
 */
export function createDue(nowMs: number, rounds: readonly Pick<RoundAccount, 'opensAt'>[]): { opensAt: bigint } | null {
  const boundary = nextBoundarySecs(nowMs);
  if (nowMs < ms(boundary) - CREATE_LEAD_MS) return null;
  if (rounds.some((r) => r.opensAt >= boundary)) return null;
  return { opensAt: boundary };
}

/**
 * The round that already stands at (or past) the upcoming minute boundary, once it is time to create that
 * round: createDue stays quiet then, and when this keeper did not create the round, someone else did.
 */
export function roundAhead(nowMs: number, rounds: readonly Pick<RoundAccount, 'id' | 'opensAt'>[]): { id: bigint; opensAt: bigint } | null {
  const boundary = nextBoundarySecs(nowMs);
  if (nowMs < ms(boundary) - CREATE_LEAD_MS) return null;
  const found = rounds.find((r) => r.opensAt >= boundary);
  return found ? { id: found.id, opensAt: found.opensAt } : null;
}
