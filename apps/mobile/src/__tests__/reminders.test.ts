// Node tests for the "did your call win?" reminders (no React Native). Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoundStatus, Side } from '@flipthememe/client';
import {
  MAX_REMINDERS,
  REMINDER_HORIZON_MS,
  REMINDER_MIN_LEAD_MS,
  collectInPlay,
  permissionStep,
  planReminders,
  reminderBody,
} from '../state/reminders.ts';
import { RESULT_REMINDER_DELAY_SECS } from '../config.ts';

const NOW_MS = 1_800_000_000_000;
const NOW_SEC = NOW_MS / 1000;
/** A chain clock that runs 2 s ahead of the phone's. */
const OFFSET = 2;
const toLocalMs = (chainSec: number) => (chainSec - OFFSET) * 1000;

const round = (id: bigint, exitEnd: number, status: number = RoundStatus.Live) => ({ id, account: { status, exitEnd: BigInt(exitEnd) } });
const position = (r: ReturnType<typeof round> | null, side: number = Side.Up) => ({ account: { side }, round: r });

test('the reminder fires 15 seconds after the exit window ends, on the chain clock, with the call in the words and no outcome', () => {
  assert.equal(RESULT_REMINDER_DELAY_SECS, 15);
  const exitEnd = NOW_SEC + OFFSET + 90;
  const [r, ...rest] = planReminders({ calls: [{ roundId: 123n, side: Side.Up, exitEnd }], nowMs: NOW_MS, toLocalMs });
  assert.equal(rest.length, 0);
  assert.equal(r.fireAtMs, NOW_MS + (90 + 15) * 1000);
  assert.equal(r.body, 'Round #123: did your UP call win?');
  assert.equal(r.title, 'FlipTheMeme');
  assert.equal(r.key, 'ftm-result-123');
  // A question, never the answer.
  assert.match(r.body, /\?$/);
  assert.ok(!/won|lost|rekt|profit/i.test(r.body));
  assert.equal(reminderBody(7n, Side.Down), 'Round #7: did your DOWN call win?');
});

test('nothing in play, nothing scheduled', () => {
  assert.deepEqual(planReminders({ calls: [], nowMs: NOW_MS, toLocalMs }), []);
});

test('a round whose reminder time is (nearly) here is skipped: the result will be on screen first', () => {
  const calls = [
    { roundId: 1n, side: Side.Up, exitEnd: NOW_SEC + OFFSET - 15 }, // fires now
    { roundId: 2n, side: Side.Up, exitEnd: NOW_SEC + OFFSET - 15 + REMINDER_MIN_LEAD_MS / 1000 - 1 }, // under the lead
    { roundId: 3n, side: Side.Down, exitEnd: NOW_SEC + OFFSET - 15 + REMINDER_MIN_LEAD_MS / 1000 }, // exactly the lead: kept
  ];
  assert.deepEqual(
    planReminders({ calls, nowMs: NOW_MS, toLocalMs }).map((r) => r.roundId),
    [3n],
  );
});

test('a time absurdly far ahead (a broken clock) is not scheduled', () => {
  const far = { roundId: 1n, side: Side.Up, exitEnd: NOW_SEC + OFFSET + REMINDER_HORIZON_MS / 1000 + 100 };
  assert.deepEqual(planReminders({ calls: [far], nowMs: NOW_MS, toLocalMs }), []);
  assert.deepEqual(planReminders({ calls: [{ ...far, exitEnd: Number.NaN }], nowMs: NOW_MS, toLocalMs }), []);
});

test('several rounds in play: soonest first, at most three', () => {
  const calls = [5n, 3n, 4n, 6n].map((id) => ({ roundId: id, side: Side.Up, exitEnd: NOW_SEC + OFFSET + 60 + Number(id) * 60 }));
  const plan = planReminders({ calls, nowMs: NOW_MS, toLocalMs });
  assert.equal(plan.length, MAX_REMINDERS);
  assert.deepEqual(
    plan.map((r) => r.roundId),
    [3n, 4n, 5n],
  );
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i].fireAtMs > plan[i - 1].fireAtMs);
  assert.equal(planReminders({ calls, nowMs: NOW_MS, toLocalMs, max: 1 }).length, 1);
});

test('the calls in play are my positions in rounds that are not final, oldest round first, one per round', () => {
  const live = round(10n, 1_000);
  const open = round(11n, 1_100, RoundStatus.Open);
  const done = round(9n, 900, RoundStatus.Final);
  const calls = collectInPlay({
    positions: [position(open, Side.Down), position(live), position(done), position(null), position(live, Side.Down)],
    pending: null,
    rounds: [],
  });
  assert.deepEqual(calls, [
    { roundId: 10n, side: Side.Down, exitEnd: 1_000 },
    { roundId: 11n, side: Side.Down, exitEnd: 1_100 },
  ]);
});

test('a bet that was sent but is not on chain yet counts through its round; a final or unknown round does not', () => {
  const open = round(20n, 2_000, RoundStatus.Open);
  assert.deepEqual(collectInPlay({ positions: [], pending: { roundId: 20n, side: Side.Down }, rounds: [open] }), [
    { roundId: 20n, side: Side.Down, exitEnd: 2_000 },
  ]);
  assert.deepEqual(collectInPlay({ positions: [], pending: { roundId: 21n, side: Side.Down }, rounds: [open] }), []);
  assert.deepEqual(collectInPlay({ positions: [], pending: { roundId: 20n, side: Side.Down }, rounds: [round(20n, 2_000, RoundStatus.Final)] }), []);
  // Already a position: the position's side stands.
  assert.deepEqual(collectInPlay({ positions: [position(open, Side.Up)], pending: { roundId: 20n, side: Side.Down }, rounds: [open] }), [
    { roundId: 20n, side: Side.Up, exitEnd: 2_000 },
  ]);
});

test('the permission is asked once, only when the system still lets us, and never again after a refusal', () => {
  assert.equal(permissionStep({ granted: false, canAskAgain: true }, false), 'ask');
  assert.equal(permissionStep({ granted: true, canAskAgain: true }, false), 'skip');
  assert.equal(permissionStep({ granted: false, canAskAgain: false }, false), 'skip');
  assert.equal(permissionStep({ granted: false, canAskAgain: true }, true), 'skip');
  assert.equal(permissionStep(null, false), 'skip');
});
