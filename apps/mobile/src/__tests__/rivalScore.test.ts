// Node tests for the personal score against a challenger (no React Native). Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Outcome, RoundStatus, Side } from '@flipthememe/client';
import { EMPTY_LEDGER, LEDGER_CAP, duelWinner, scoreLine, scoreOf, updateLedger } from '../state/rivalScore.ts';

const ME = 'ME11111111111111111111111111111111111111111';
const RIVAL = 'RIVAL1111111111111111111111111111111111111';
const OTHER = 'OTHER111111111111111111111111111111111111';

const round = (id: bigint, over: { status?: number; outcome?: number } = {}) => ({
  id,
  account: { status: over.status ?? RoundStatus.Final, outcome: over.outcome ?? Outcome.Up },
});
const player = (authority: string, side: number, isHouse = false) => ({ account: { authority, side, isHouse } });

test('opposite sides in a finished round: the side that won takes the point', () => {
  const players = [player(ME, Side.Up), player(RIVAL, Side.Down)];
  assert.equal(duelWinner(round(1n, { outcome: Outcome.Up }), players, ME, RIVAL), 'you');
  assert.equal(duelWinner(round(1n, { outcome: Outcome.Down }), players, ME, RIVAL), 'them');
});

test('no duel: same side, a refund, a round still going, one of us missing, the house, or me against myself', () => {
  const same = [player(ME, Side.Up), player(RIVAL, Side.Up)];
  assert.equal(duelWinner(round(1n), same, ME, RIVAL), null);
  const apart = [player(ME, Side.Up), player(RIVAL, Side.Down)];
  assert.equal(duelWinner(round(1n, { outcome: Outcome.Refund }), apart, ME, RIVAL), null);
  assert.equal(duelWinner(round(1n, { outcome: Outcome.NotActivated }), apart, ME, RIVAL), null);
  assert.equal(duelWinner(round(1n, { status: RoundStatus.Live, outcome: Outcome.Pending }), apart, ME, RIVAL), null);
  assert.equal(duelWinner(round(1n), [player(ME, Side.Up), player(OTHER, Side.Down)], ME, RIVAL), null);
  assert.equal(duelWinner(round(1n), [player(RIVAL, Side.Down)], ME, RIVAL), null);
  // A house position under the rival's address does not count as the rival playing.
  assert.equal(duelWinner(round(1n), [player(ME, Side.Up), player(RIVAL, Side.Down, true)], ME, RIVAL), null);
  assert.equal(duelWinner(round(1n), apart, ME, ME), null);
});

test('the ledger collects every finished duel of a read and keeps what it has seen', () => {
  const positions = new Map([
    [1n, [player(ME, Side.Up), player(RIVAL, Side.Down)]],
    [2n, [player(ME, Side.Down), player(RIVAL, Side.Up)]],
    [3n, [player(ME, Side.Up), player(RIVAL, Side.Down)]],
  ]);
  const rounds = [round(3n, { outcome: Outcome.Up }), round(2n, { outcome: Outcome.Up }), round(1n, { outcome: Outcome.Up })];
  const ledger = updateLedger(EMPTY_LEDGER, rounds, positions, ME, RIVAL);
  assert.deepEqual(scoreOf(ledger), { you: 2, them: 1 });
  // The window moved on and forgot the old rounds: the score stays.
  const later = updateLedger(ledger, [round(4n)], new Map(), ME, RIVAL);
  assert.equal(later, ledger, 'nothing new: the same ledger back');
  assert.deepEqual(scoreOf(later), { you: 2, them: 1 });
  // A round already counted is not counted twice.
  assert.equal(updateLedger(ledger, rounds, positions, ME, RIVAL), ledger);
});

test('no duel yet: no score; the ledger is bounded', () => {
  assert.equal(scoreOf(EMPTY_LEDGER), null);
  const positions = new Map<bigint, ReturnType<typeof player>[]>();
  const rounds = [];
  for (let i = 1n; i <= BigInt(LEDGER_CAP + 20); i++) {
    positions.set(i, [player(ME, Side.Up), player(RIVAL, Side.Down)]);
    rounds.push(round(i));
  }
  const ledger = updateLedger(EMPTY_LEDGER, rounds, positions, ME, RIVAL);
  assert.equal(ledger.size, LEDGER_CAP);
  assert.ok(ledger.has(BigInt(LEDGER_CAP + 20)), 'the newest rounds stay');
  assert.ok(!ledger.has(1n), 'the oldest go');
});

test('the score line names the rival, or says RIVAL when no name is known', () => {
  assert.equal(scoreLine({ you: 3, them: 1 }, 'oxbla'), 'YOU 3 : 1 oxbla');
  assert.equal(scoreLine({ you: 0, them: 2 }, null), 'YOU 0 : 2 RIVAL');
  assert.equal(scoreLine({ you: 0, them: 2 }, ''), 'YOU 0 : 2 RIVAL');
});
