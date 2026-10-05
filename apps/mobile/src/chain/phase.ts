// Pure round-phase logic shared by the screens: which round is open, which are in flight,
// what the one labelled timer shows, and how a position ended. No React Native imports.
import { Outcome, RefundReason, RoundStatus, Side, acceptedStake, positionPayout } from '@flipthememe/client';
import type { PositionAccount, RoundAccount } from '@flipthememe/client';

export type RoundRef = { id: bigint; account: RoundAccount };

export type RoundGroups<T extends RoundRef> = {
  /** Accepting entries now: opensAt <= now < cutoffAt. */
  open: T | null;
  /** Created ahead of its minute boundary, not open yet. */
  upcoming: T | null;
  /** Entry closed, not final yet; oldest first. */
  inFlight: T[];
  /** Final rounds, newest first. */
  finals: T[];
};

export function classifyRounds<T extends RoundRef>(rounds: readonly T[], nowSec: number): RoundGroups<T> {
  const now = BigInt(Math.floor(nowSec));
  let open: T | null = null;
  let upcoming: T | null = null;
  const inFlight: T[] = [];
  const finals: T[] = [];
  for (const r of rounds) {
    const a = r.account;
    if (a.status === RoundStatus.Final) {
      finals.push(r);
    } else if (now >= a.cutoffAt) {
      inFlight.push(r);
    } else if (now >= a.opensAt) {
      if (a.status === RoundStatus.Open && (open === null || r.id > open.id)) open = r;
    } else if (upcoming === null || r.id < upcoming.id) {
      upcoming = r;
    }
  }
  inFlight.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  finals.sort((x, y) => (x.id > y.id ? -1 : x.id < y.id ? 1 : 0));
  return { open, upcoming, inFlight, finals };
}

/** After exitEnd + this, an unsettled round counts as overdue. */
export const OVERDUE_SECS = 120;

export type TimerView =
  | { kind: 'entry'; label: 'ENTRY CLOSES IN'; roundId: bigint; secondsLeft: number; mine: boolean }
  | {
      kind: 'result';
      label: 'RESULT IN';
      roundId: bigint;
      secondsLeft: number;
      /** pause: waiting for the strike window; strike: strike window running; measuring: strike fixed. */
      stage: 'pause' | 'strike' | 'measuring';
    }
  | { kind: 'confirming'; label: 'CONFIRMING RESULT'; roundId: bigint }
  | { kind: 'next'; label: 'NEXT ROUND IN'; roundId: bigint; secondsLeft: number }
  | { kind: 'waiting'; label: 'WAITING FOR THE NEXT ROUND' };

/**
 * One labelled timer. It follows the player's earliest unresolved round (entry, then result,
 * then confirming); without one it shows the open round's entry deadline.
 */
export function selectTimer(input: {
  nowSec: number;
  open: RoundRef | null;
  upcoming: RoundRef | null;
  /** Rounds where the player holds a confirmed position and the round is not final. */
  myUnresolved: readonly RoundRef[];
}): TimerView {
  const now = input.nowSec;
  // A round the keeper has not settled 2 minutes after its exit window stops holding the timer.
  const mine = input.myUnresolved
    .filter((r) => now <= Number(r.account.exitEnd) + OVERDUE_SECS)
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const focus = mine[0];
  if (focus) {
    const a = focus.account;
    const cutoff = Number(a.cutoffAt);
    const exitEnd = Number(a.exitEnd);
    if (now < cutoff) return { kind: 'entry', label: 'ENTRY CLOSES IN', roundId: focus.id, secondsLeft: cutoff - now, mine: true };
    if (now < exitEnd) {
      // Live means the strike is on chain; before that the strike window is pending or running.
      const stage = a.status === RoundStatus.Live ? 'measuring' : now < Number(a.strikeStart) ? 'pause' : 'strike';
      return { kind: 'result', label: 'RESULT IN', roundId: focus.id, secondsLeft: exitEnd - now, stage };
    }
    return { kind: 'confirming', label: 'CONFIRMING RESULT', roundId: focus.id };
  }
  if (input.open) {
    return {
      kind: 'entry',
      label: 'ENTRY CLOSES IN',
      roundId: input.open.id,
      secondsLeft: Number(input.open.account.cutoffAt) - now,
      mine: false,
    };
  }
  if (input.upcoming) {
    return { kind: 'next', label: 'NEXT ROUND IN', roundId: input.upcoming.id, secondsLeft: Number(input.upcoming.account.opensAt) - now };
  }
  return { kind: 'waiting', label: 'WAITING FOR THE NEXT ROUND' };
}

export type ResultLabel = 'UP' | 'DOWN' | 'TIE' | 'NO PRICE' | 'EXPIRED' | 'REFUND' | 'NO MATCH' | 'PENDING';

export function roundResultLabel(a: Pick<RoundAccount, 'status' | 'outcome' | 'refundReason'>): ResultLabel {
  if (a.status !== RoundStatus.Final) return 'PENDING';
  switch (a.outcome) {
    case Outcome.Up:
      return 'UP';
    case Outcome.Down:
      return 'DOWN';
    case Outcome.NotActivated:
      return 'NO MATCH';
    case Outcome.Refund:
      return a.refundReason === RefundReason.Tie
        ? 'TIE'
        : a.refundReason === RefundReason.Unpriceable
          ? 'NO PRICE'
          : a.refundReason === RefundReason.Expired
            ? 'EXPIRED'
            : 'REFUND';
    default:
      return 'PENDING';
  }
}

export type PositionResult = {
  kind: 'won' | 'lost' | 'refund' | 'full-refund' | 'pending';
  /** Credited (or to be credited) to the vault; null while the round is not final. */
  payout: bigint | null;
  /** Part of the stake that played; null before the book is fixed. */
  accepted: bigint | null;
};

/** Book is fixed once the house fill window has passed (strike window start). */
export function bookFixed(a: Pick<RoundAccount, 'status' | 'strikeStart'>, nowSec: number): boolean {
  return a.status !== RoundStatus.Open || nowSec >= Number(a.strikeStart);
}

export function positionResult(
  p: Pick<PositionAccount, 'side' | 'stake' | 'claimed' | 'payout'>,
  a: RoundAccount,
  nowSec: number,
): PositionResult {
  const accepted = bookFixed(a, nowSec) ? acceptedStake(a.rawUp, a.rawDown, p.side, p.stake) : null;
  if (a.status !== RoundStatus.Final) return { kind: 'pending', payout: null, accepted };
  const payout = p.claimed
    ? p.payout
    : positionPayout(a.rawUp, a.rawDown, a.outcome, a.feeWinBps, a.feeRefundBps, p.side, p.stake);
  if (a.outcome === Outcome.NotActivated) return { kind: 'full-refund', payout, accepted: 0n };
  if (a.outcome === Outcome.Refund) return { kind: 'refund', payout, accepted };
  const won = (a.outcome === Outcome.Up && p.side === Side.Up) || (a.outcome === Outcome.Down && p.side === Side.Down);
  return { kind: won ? 'won' : 'lost', payout, accepted };
}

/** Who is ahead right now against a fixed strike (instant price, not the exit window mean). */
export function standingNow(side: number, strike: bigint, price: bigint): 'winning' | 'losing' | 'tie' {
  if (price === strike) return 'tie';
  const upAhead = price > strike;
  return (side === Side.Up) === upAhead ? 'winning' : 'losing';
}

/** Where an in-flight round (entry closed, not final) is: fixing the strike, live against it, or settling. */
export type InFlightStage = 'fixing' | 'live' | 'settling';

export function inFlightStage(a: Pick<RoundAccount, 'status' | 'exitEnd'>, nowSec: number): InFlightStage {
  if (nowSec >= Number(a.exitEnd)) return 'settling';
  return a.status === RoundStatus.Live ? 'live' : 'fixing';
}

/**
 * The arena's main panel. My earliest in-flight round wins (the same round the timer follows);
 * without one the open round's players, then the upcoming round.
 */
export type PanelView<T extends RoundRef> =
  | { kind: 'mine'; round: T; stage: InFlightStage; /** My other in-flight rounds, oldest first. */ others: T[] }
  | { kind: 'open'; round: T }
  | { kind: 'upcoming'; round: T }
  | { kind: 'empty' };

export function selectPanel<T extends RoundRef>(input: {
  nowSec: number;
  open: T | null;
  upcoming: T | null;
  /** Rounds where I hold a confirmed position and the round is not final. */
  myUnresolved: readonly T[];
}): PanelView<T> {
  const now = input.nowSec;
  const flying = input.myUnresolved
    .filter(
      (r) =>
        r.account.status !== RoundStatus.Final &&
        now >= Number(r.account.cutoffAt) &&
        // Same rule as the timer: a round the keeper left unsettled 2 minutes after its exit window stops holding the panel.
        now <= Number(r.account.exitEnd) + OVERDUE_SECS,
    )
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const [focus, ...others] = flying;
  if (focus) return { kind: 'mine', round: focus, stage: inFlightStage(focus.account, now), others };
  if (input.open) return { kind: 'open', round: input.open };
  if (input.upcoming) return { kind: 'upcoming', round: input.upcoming };
  return { kind: 'empty' };
}

/** The strike of an in-flight round as the chart shows it. */
export type StrikeState =
  | { kind: 'pending'; /** Until the strike window starts ("fixed 30 s after entry closes"). */ secondsLeft: number }
  | { kind: 'fixing' }
  | { kind: 'fixed'; strike: bigint }
  | { kind: 'none' };

export function strikeState(a: Pick<RoundAccount, 'status' | 'strikePrice' | 'strikeStart'>, nowSec: number): StrikeState {
  if (a.strikePrice > 0n && a.status !== RoundStatus.Open) return { kind: 'fixed', strike: a.strikePrice };
  if (a.status === RoundStatus.Final) return { kind: 'none' };
  // Pending until the strike window opens; fixing while it runs and until the keeper posts the strike.
  const left = Number(a.strikeStart) - nowSec;
  return left > 0 ? { kind: 'pending', secondsLeft: left } : { kind: 'fixing' };
}

/**
 * Whose strike the chart draws: my focus round when it is on the charted pool, else the latest
 * live round there (strike fixed), else the latest round there still fixing its strike.
 */
export function selectChartRound<T extends RoundRef>(input: { pool: string | null; focus: T | null; inFlight: readonly T[] }): T | null {
  const { pool, focus } = input;
  if (!pool) return null;
  if (focus && focus.account.pool === pool) return focus;
  const newestFirst = [...input.inFlight].filter((r) => r.account.pool === pool).sort((x, y) => (x.id > y.id ? -1 : x.id < y.id ? 1 : 0));
  return newestFirst.find((r) => r.account.status === RoundStatus.Live) ?? newestFirst.find((r) => r.account.status === RoundStatus.Open) ?? null;
}

/** The countdown tick: the whole second (5..1) while entry has 5 s or less left, else null. */
export function entryTick(secondsLeft: number): number | null {
  if (!Number.isFinite(secondsLeft) || secondsLeft <= 0) return null;
  const s = Math.ceil(secondsLeft);
  return s <= 5 ? s : null;
}

/** Matched amount per side: min(rawUp, rawDown). */
export function matchedPerSide(a: Pick<RoundAccount, 'rawUp' | 'rawDown'>): bigint {
  return a.rawUp < a.rawDown ? a.rawUp : a.rawDown;
}

/** Mirror of the program's depth rule: 2 * min(up, down) <= maxBank after adding the stake. */
export function fitsDepth(a: Pick<RoundAccount, 'rawUp' | 'rawDown' | 'maxBank'>, side: number, stake: bigint): boolean {
  const up = a.rawUp + (side === Side.Up ? stake : 0n);
  const down = a.rawDown + (side === Side.Down ? stake : 0n);
  const m = up < down ? up : down;
  return m * 2n <= a.maxBank;
}
