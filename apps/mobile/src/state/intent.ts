// The first-tap intent: a visitor taps UP or DOWN, the top up sheet connects the wallet and approves in
// one wallet session, and the call they tapped goes in by itself once their account is ready, if that
// round is still open. Pure TypeScript (no React Native imports) for node:test: this file decides when to
// place, wait or forget; the arena screen still places the bet through the usual path (useBetting.place),
// with every guard the buttons have.
import type { Side } from '@flipthememe/client';

/** A wallet trip that took longer than this is not the tap the player remembers: the call is forgotten. */
export const INTENT_MAX_AGE_MS = 120_000;

export type BetIntent = {
  side: Side;
  /** The chip chosen when the side was tapped; the bet itself falls back to the largest chip that fits. */
  amount: bigint;
  /** The round that was open at the tap: the call goes in that round or not at all. */
  roundId: bigint;
  /** Local ms of the tap. */
  armedAt: number;
  /** The wallet session approved the top up; until then the sheet is still open and nothing is placed. */
  committed: boolean;
};

/** The call to remember for a tap, or null when no round is open to bind it to. */
export function armIntent(input: { side: Side; amount: bigint; roundId: bigint | null; nowMs: number }): BetIntent | null {
  if (input.roundId === null) return null;
  return { side: input.side, amount: input.amount, roundId: input.roundId, armedAt: input.nowMs, committed: false };
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
  /** The round open now (null between rounds) and the seconds left to enter it. */
  openRoundId: bigint | null;
  secondsLeft: number;
  /** The arena's own reason for refusing a bet right now: money not visible yet ('funds'), anything else ('other'), or none. */
  refusal: 'funds' | 'other' | null;
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
  | { kind: 'place'; side: Side }
  | { kind: 'drop'; reason: 'expired' | 'round-closed' | 'already-in' | 'no-wallet' | 'refused' };

/**
 * What to do with the remembered call right now. Waiting is silent and bounded: the call is dropped
 * when its round closes or INTENT_MAX_AGE_MS passes, so it can never turn into a bet the player does
 * not expect; a dropped call leaves the dock in its usual state, with no error.
 */
export function decideIntent(intent: BetIntent | null, ctx: IntentContext): IntentDecision {
  if (!intent) return { kind: 'idle' };
  // The sheet is still open and the wallet has not approved: nothing to do yet (closing the sheet forgets it).
  if (!intent.committed) return { kind: 'wait' };
  if (ctx.nowMs - intent.armedAt > INTENT_MAX_AGE_MS) return { kind: 'drop', reason: 'expired' };
  if (!ctx.connected) return { kind: 'drop', reason: 'no-wallet' };
  if (ctx.openRoundId === null || ctx.openRoundId !== intent.roundId) return { kind: 'drop', reason: 'round-closed' };
  if (ctx.alreadyIn) return { kind: 'drop', reason: 'already-in' };
  if (ctx.secondsLeft <= ctx.guardSecs) return { kind: 'drop', reason: 'round-closed' };
  // The top up just landed: my account read may still show the old balance or no session for a few seconds.
  if (!ctx.myReady || !ctx.sessionActive || ctx.working) return { kind: 'wait' };
  if (ctx.refusal === 'funds') return { kind: 'wait' };
  if (ctx.refusal === 'other') return { kind: 'drop', reason: 'refused' };
  return { kind: 'place', side: intent.side };
}
