// Node tests for the first-tap intent (no React Native). Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Side } from '@flipthememe/client';
import {
  INTENT_MAX_AGE_MS,
  armIntent,
  commitIntent,
  decideIntent,
  intentAfterSheetClosed,
  intentText,
  type BetIntent,
  type IntentContext,
} from '../state/intent.ts';
import { formatSol } from '../lib/format.ts';

const T0 = 1_800_000_000_000;
const SOL = 1_000_000_000n;

const ready: IntentContext = {
  nowMs: T0 + 20_000,
  connected: true,
  myReady: true,
  sessionActive: true,
  openRoundId: 123n,
  secondsLeft: 30,
  refusal: null,
  working: false,
  alreadyIn: false,
  guardSecs: 1,
};

const armed = (over: Partial<BetIntent> = {}): BetIntent => ({ side: Side.Up, amount: (2n * SOL) / 100n, roundId: 123n, armedAt: T0, committed: true, ...over });

test('a tap remembers the side, the chip and the round open at that moment; with no open round there is nothing to bind it to', () => {
  const intent = armIntent({ side: Side.Down, amount: SOL / 50n, roundId: 7n, nowMs: T0 });
  assert.deepEqual(intent, { side: Side.Down, amount: SOL / 50n, roundId: 7n, armedAt: T0, committed: false });
  assert.equal(armIntent({ side: Side.Up, amount: SOL / 50n, roundId: null, nowMs: T0 }), null);
});

test('the call waits for the wallet: not approved yet means wait, and closing the sheet forgets it', () => {
  const intent = armed({ committed: false });
  assert.deepEqual(decideIntent(intent, ready), { kind: 'wait' });
  assert.equal(intentAfterSheetClosed(intent), null, 'a sheet closed without approval forgets the call');
  const approved = commitIntent(intent);
  assert.equal(approved?.committed, true);
  assert.equal(intentAfterSheetClosed(approved), approved, 'the sheet closing after the approval keeps it');
  assert.equal(commitIntent(null), null);
  assert.equal(commitIntent(approved), approved, 'committing twice changes nothing');
});

test('approved, ready, round still open: the remembered side is placed', () => {
  assert.deepEqual(decideIntent(armed(), ready), { kind: 'place', side: Side.Up });
  assert.deepEqual(decideIntent(armed({ side: Side.Down }), ready), { kind: 'place', side: Side.Down });
  assert.deepEqual(decideIntent(null, ready), { kind: 'idle' });
});

test('right after the top up the account is read late: no session or no balance yet means wait, not drop', () => {
  assert.deepEqual(decideIntent(armed(), { ...ready, myReady: false }), { kind: 'wait' });
  assert.deepEqual(decideIntent(armed(), { ...ready, sessionActive: false }), { kind: 'wait' });
  assert.deepEqual(decideIntent(armed(), { ...ready, refusal: 'funds' }), { kind: 'wait' });
  assert.deepEqual(decideIntent(armed(), { ...ready, working: true }), { kind: 'wait' });
});

test('the round closed: the call is dropped silently, whatever else is true', () => {
  // The open round moved on, or none is open.
  assert.deepEqual(decideIntent(armed(), { ...ready, openRoundId: 124n }), { kind: 'drop', reason: 'round-closed' });
  assert.deepEqual(decideIntent(armed(), { ...ready, openRoundId: null }), { kind: 'drop', reason: 'round-closed' });
  // Inside the entry guard the arena refuses the bet itself: the call is not placed into the last second.
  assert.deepEqual(decideIntent(armed(), { ...ready, secondsLeft: 1 }), { kind: 'drop', reason: 'round-closed' });
  assert.deepEqual(decideIntent(armed(), { ...ready, secondsLeft: 0.4 }), { kind: 'drop', reason: 'round-closed' });
  assert.deepEqual(decideIntent(armed(), { ...ready, secondsLeft: 1.01 }), { kind: 'place', side: Side.Up });
});

test('other refusals end the call too, with no error: paused, stale data, round limits; so do a second bet and a lost wallet', () => {
  assert.deepEqual(decideIntent(armed(), { ...ready, refusal: 'other' }), { kind: 'drop', reason: 'refused' });
  assert.deepEqual(decideIntent(armed(), { ...ready, alreadyIn: true }), { kind: 'drop', reason: 'already-in' });
  assert.deepEqual(decideIntent(armed(), { ...ready, connected: false }), { kind: 'drop', reason: 'no-wallet' });
});

test('a call is never kept past its age limit, even while everything else says wait', () => {
  const late = { ...ready, nowMs: T0 + INTENT_MAX_AGE_MS + 1, myReady: false };
  assert.deepEqual(decideIntent(armed(), late), { kind: 'drop', reason: 'expired' });
  assert.deepEqual(decideIntent(armed(), { ...late, nowMs: T0 + INTENT_MAX_AGE_MS, myReady: false }), { kind: 'wait' });
});

test('the line shown while it goes in uses the bet status words', () => {
  const name = (s: Side) => (s === Side.Up ? 'UP' : 'DOWN');
  assert.equal(intentText(armed(), name, formatSol), 'UP 0.02 SOL in #123');
  assert.equal(intentText(armed({ side: Side.Down, amount: SOL / 10n, roundId: 9n }), name, formatSol), 'DOWN 0.10 SOL in #9');
});
