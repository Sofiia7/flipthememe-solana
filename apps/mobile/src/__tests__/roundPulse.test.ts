// Node tests for the "N IN · X SOL" social proof of the open round (no React Native). Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pulseText, roundPulse } from '../chain/roundPulse.ts';
import { formatSol } from '../lib/format.ts';

const SOL = 1_000_000_000n;
const player = { account: { isHouse: false } };
const house = { account: { isHouse: true } };

test('players and the total staked on both sides', () => {
  const p = roundPulse({ positions: [player, player, player], positionCount: 3, rawUp: (2n * SOL) / 10n, rawDown: SOL / 5n });
  assert.deepEqual(p, { players: 3, total: (4n * SOL) / 10n });
  assert.equal(pulseText(p, formatSol), '3 IN · 0.40 SOL');
});

test('the round count wins while the list of positions has not caught up', () => {
  const p = roundPulse({ positions: [player], positionCount: 4, rawUp: SOL / 10n, rawDown: SOL / 10n });
  assert.equal(p.players, 4);
  // And the list wins when it is the longer one.
  assert.equal(roundPulse({ positions: [player, player], positionCount: 1, rawUp: 0n, rawDown: 0n }).players, 2);
});

test('the house is not a player', () => {
  assert.equal(roundPulse({ positions: [player, house], positionCount: 2, rawUp: SOL, rawDown: SOL }).players, 1);
  // A house position the list has not shown yet is still taken off the count it knows about.
  assert.equal(roundPulse({ positions: [house], positionCount: 3, rawUp: SOL, rawDown: SOL }).players, 2);
});

test('nobody in: no text, so the panel keeps its invitation', () => {
  const p = roundPulse({ positions: [], positionCount: 0, rawUp: 0n, rawDown: 0n });
  assert.deepEqual(p, { players: 0, total: 0n });
  assert.equal(pulseText(p, formatSol), null);
  assert.equal(pulseText(roundPulse({ positions: [house], positionCount: 1, rawUp: SOL, rawDown: SOL }), formatSol), null);
});

test('one player reads the same way', () => {
  assert.equal(pulseText(roundPulse({ positions: [player], positionCount: 1, rawUp: SOL / 50n, rawDown: 0n }), formatSol), '1 IN · 0.02 SOL');
});
