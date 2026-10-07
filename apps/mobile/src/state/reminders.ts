// "Did your call win?": a local notification for each round of mine in play when the app goes to the
// background, fired 15 s after the round's exit window ends (the keeper settles within seconds), so
// the result - the strongest moment of the game - is not lost when the player puts the phone down. The
// text never says how it went. This file decides what to schedule and when to ask for the permission;
// lib/notify.ts does the native calls. Pure TypeScript (no React Native imports) for node:test.
import { RoundStatus, Side } from '@flipthememe/client';
import { RESULT_REMINDER_DELAY_SECS } from '../config.ts';

/** One call of mine whose round is not final yet; `exitEnd` is program time, unix seconds. */
export type InPlayCall = { roundId: bigint; side: number; exitEnd: number };

export type Reminder = {
  /** Stable per round, so a second plan for the same round replaces the first. */
  key: string;
  roundId: bigint;
  /** Local ms the notification fires. */
  fireAtMs: number;
  title: string;
  body: string;
};

/** At most this many rounds get a reminder (a player stacking bets is not buzzed once a minute for ever). */
export const MAX_REMINDERS = 3;
/** Under this lead the result is on screen before the notification could be: nothing is scheduled. */
export const REMINDER_MIN_LEAD_MS = 3_000;
/** A reminder further away than this is a clock error, not a round in play. */
export const REMINDER_HORIZON_MS = 15 * 60_000;

type RoundLike = { id: bigint; account: { status: number; exitEnd: bigint } };

/**
 * My calls whose round is not final: the confirmed positions, plus a bet that has been sent and is not
 * on chain yet (its round is looked up in the arena rounds). Oldest round first, one per round.
 */
export function collectInPlay(input: {
  positions: readonly { account: { side: number }; round: RoundLike | null }[];
  pending: { roundId: bigint; side: number } | null;
  rounds: readonly RoundLike[];
}): InPlayCall[] {
  const calls = new Map<bigint, InPlayCall>();
  for (const p of input.positions) {
    const r = p.round;
    if (!r || r.account.status === RoundStatus.Final) continue;
    calls.set(r.id, { roundId: r.id, side: p.account.side, exitEnd: Number(r.account.exitEnd) });
  }
  const pending = input.pending;
  if (pending && !calls.has(pending.roundId)) {
    const r = input.rounds.find((x) => x.id === pending.roundId);
    if (r && r.account.status !== RoundStatus.Final) calls.set(r.id, { roundId: r.id, side: pending.side, exitEnd: Number(r.account.exitEnd) });
  }
  return [...calls.values()].sort((a, b) => (a.roundId < b.roundId ? -1 : a.roundId > b.roundId ? 1 : 0));
}

/** "Round #123: did your UP call win?" */
export function reminderBody(roundId: bigint, side: number): string {
  return `Round #${roundId}: did your ${side === Side.Up ? 'UP' : 'DOWN'} call win?`;
}

/**
 * The reminders to schedule now, soonest first. `toLocalMs` turns a program time (unix seconds) into
 * local ms (chainToLocalMs with the clock offset), so the delay follows the chain's own clock.
 */
export function planReminders(input: {
  calls: readonly InPlayCall[];
  nowMs: number;
  toLocalMs: (chainSec: number) => number;
  delaySecs?: number;
  max?: number;
}): Reminder[] {
  const delay = input.delaySecs ?? RESULT_REMINDER_DELAY_SECS;
  const out: Reminder[] = [];
  for (const call of input.calls) {
    const fireAtMs = input.toLocalMs(call.exitEnd + delay);
    const lead = fireAtMs - input.nowMs;
    if (!Number.isFinite(fireAtMs) || lead < REMINDER_MIN_LEAD_MS || lead > REMINDER_HORIZON_MS) continue;
    out.push({
      key: `ftm-result-${call.roundId}`,
      roundId: call.roundId,
      fireAtMs,
      title: 'FlipTheMeme',
      body: reminderBody(call.roundId, call.side),
    });
  }
  return out.sort((a, b) => a.fireAtMs - b.fireAtMs).slice(0, input.max ?? MAX_REMINDERS);
}

/** What the system says about the notification permission (null: no notification module in this build). */
export type PermissionState = { granted: boolean; canAskAgain: boolean } | null;

/**
 * Whether to show the permission dialog now. It is asked once, after the first confirmed bet (the player
 * has just seen why a reminder helps); a refusal is final and never nags, and a build without the module
 * asks nothing.
 */
export function permissionStep(state: PermissionState, askedBefore: boolean): 'ask' | 'skip' {
  if (state === null || state.granted) return 'skip';
  if (!state.canAskAgain || askedBefore) return 'skip';
  return 'ask';
}
