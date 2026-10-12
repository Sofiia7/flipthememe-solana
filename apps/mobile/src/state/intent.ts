// The first-tap intent: a visitor taps UP or DOWN, the top up sheet connects the wallet and approves in
// one wallet session, and the call they tapped goes in by itself once their account is ready. The wallet
// trip can outlast the round that was open at the tap (entry lasts 60 s), so the call is bound to the COIN,
// not to the round number: it goes into the round open when the account is ready if that round is on the
// same pool, waits for the next round when the current one is about to close, and is refused with a
// visible notice when the open round is on another coin. Pure TypeScript (no React Native imports) for node:test: this file decides when to
// place, wait or forget; the arena screen still places the bet through the usual path (useBetting.place),
// with every guard the buttons have.
import type { Side } from '@flipthememe/client';

/** A wallet trip that took longer than this is not the tap the player remembers: the call is forgotten. */
export const INTENT_MAX_AGE_MS = 180_000;

export type BetIntent = {
  side: Side;
  /** The chip chosen when the side was tapped; the bet itself falls back to the largest chip that fits. */
  amount: bigint;
  /** The round that was open at the tap, for the words on the sheet; the call itself goes into whichever round of the same pool is open when the account is ready. */
  roundId: bigint;
  /** The pool (the coin) of that round: the call is never placed on another coin. */
  pool: string;
  /** Local ms of the tap. */
  armedAt: number;
  /** The wallet session approved the top up; until then the sheet is still open and nothing is placed. */
  committed: boolean;
};

/** The call to remember for a tap, or null when no round is open to bind it to. */
export function armIntent(input: { side: Side; amount: bigint; roundId: bigint | null; pool: string | null; nowMs: number }): BetIntent | null {
  if (input.roundId === null || input.pool === null) return null;
  return { side: input.side, amount: input.amount, roundId: input.roundId, pool: input.pool, armedAt: input.nowMs, committed: false };
}

/** The wallet session came back approved: from here the call waits for the account, whatever happens to the sheet. */
export function commitIntent(intent: BetIntent | null): BetIntent | null {
  return intent && !intent.committed ? { ...intent, committed: true } : intent;
}

/** A closed sheet that never approved forgets its call; an approved one keeps it. */
export function intentAfterSheetClosed(intent: BetIntent | null): BetIntent | null {
  return intent && !intent.committed ? null : intent;
}

/** "UP 0.02 SOL in #123": the same words the bet status line uses once the bet is signing. */
export function intentText(intent: Pick<BetIntent, 'side' | 'amount' | 'roundId'>, name: (side: Side) => string, formatSol: (lamports: bigint) => string): string {
  return `${name(intent.side)} ${formatSol(intent.amount)} SOL in #${intent.roundId}`;
}

export type IntentContext = {
  nowMs: number;
  /** A wallet is connected. */
  connected: boolean;
  /** My account data belongs to that wallet. */
  myReady: boolean;
  /** The one-tap session is active for this round's stake. */
  sessionActive: boolean;
  /** The round open now (null between rounds), its pool and the seconds left to enter it. */
  openRoundId: bigint | null;
  openRoundPool: string | null;
  secondsLeft: number;
  /** The arena's own reason for refusing a bet right now: money not visible yet ('funds'), a passing state such as the device key still loading or arena data a few seconds old ('transient'), anything else ('other'), or none. */
  refusal: 'funds' | 'transient' | 'other' | null;
  /** A bet of this phone is signing, sending or confirming. */
  working: boolean;
  /** I already hold a position in the open round, or one is pending. */
  alreadyIn: boolean;
  /** Bets are refused this long before the cutoff (config ENTRY_GUARD_SECS). */
  guardSecs: number;
};

export type IntentDecision =
  | { kind: 'idle' }
  | { kind: 'wait' }
  /** carried: the round to place into is not the one open at the tap, but it is on the same coin. */
  | { kind: 'place'; side: Side; carried: boolean }
  | { kind: 'drop'; reason: 'expired' | 'token-changed' | 'already-in' | 'no-wallet' | 'refused' };

/**
 * What to do with the remembered call right now. Waiting is bounded: the call is dropped when
 * INTENT_MAX_AGE_MS passes or the open round is on another coin, so it can never turn into a bet the
 * player did not choose. Between rounds, or in the last second of one, it waits for the next round
 * (they open every minute) instead of being thrown away.
 */
export function decideIntent(intent: BetIntent | null, ctx: IntentContext): IntentDecision {
  if (!intent) return { kind: 'idle' };
  // The sheet is still open and the wallet has not approved: nothing to do yet (closing the sheet forgets it).
  if (!intent.committed) return { kind: 'wait' };
  if (ctx.nowMs - intent.armedAt > INTENT_MAX_AGE_MS) return { kind: 'drop', reason: 'expired' };
  if (!ctx.connected) return { kind: 'drop', reason: 'no-wallet' };
  // Between rounds: the next one opens within the minute.
  if (ctx.openRoundId === null) return { kind: 'wait' };
  // The coin is the call: another coin is another bet, never placed by itself.
  if (ctx.openRoundPool !== intent.pool) return { kind: 'drop', reason: 'token-changed' };
  if (ctx.alreadyIn) return { kind: 'drop', reason: 'already-in' };
  // The last second of a round is refused by the arena itself: the next round is a few seconds away.
  if (ctx.secondsLeft <= ctx.guardSecs) return { kind: 'wait' };
  // The top up just landed: my account read may still show the old balance or no session for a few seconds.
  if (!ctx.myReady || !ctx.sessionActive || ctx.working) return { kind: 'wait' };
  if (ctx.refusal === 'funds' || ctx.refusal === 'transient') return { kind: 'wait' };
  if (ctx.refusal === 'other') return { kind: 'drop', reason: 'refused' };
  return { kind: 'place', side: intent.side, carried: ctx.openRoundId !== intent.roundId };
}
