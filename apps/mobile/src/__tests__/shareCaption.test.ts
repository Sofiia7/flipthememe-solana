// Node tests for what the share card says besides the amount (no React Native). Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionSuffix, pickCardCaption } from '../share/shareCaption.ts';

test('a run of wins is the headline; the score against the rival rides under it', () => {
  assert.deepEqual(pickCardCaption({ winStreak: 3, score: { you: 3, them: 1 }, rivalName: 'oxbla' }), { headline: '3 IN A ROW', sub: 'YOU 3 : 1 oxbla' });
});

test('with no score data only the run is shown', () => {
  assert.deepEqual(pickCardCaption({ winStreak: 5, score: null, rivalName: null }), { headline: '5 IN A ROW', sub: null });
  // A duel score of nothing is no data.
  assert.deepEqual(pickCardCaption({ winStreak: 2, score: { you: 0, them: 0 }, rivalName: 'oxbla' }), { headline: '2 IN A ROW', sub: null });
});

test('with no run worth showing the score takes the headline; with neither the card stays as it was', () => {
  assert.deepEqual(pickCardCaption({ winStreak: 1, score: { you: 1, them: 0 }, rivalName: 'oxbla' }), { headline: 'YOU 1 : 0 oxbla', sub: null });
  assert.deepEqual(pickCardCaption({ winStreak: 0, score: { you: 0, them: 2 }, rivalName: null }), { headline: 'YOU 0 : 2 RIVAL', sub: null });
  assert.deepEqual(pickCardCaption({ winStreak: 1, score: null, rivalName: null }), { headline: null, sub: null });
  assert.deepEqual(pickCardCaption({ winStreak: 0, score: null, rivalName: 'oxbla' }), { headline: null, sub: null });
});

test('the message that travels with the picture carries the same facts, and nothing when there are none', () => {
  assert.equal(captionSuffix({ winStreak: 3, score: { you: 3, them: 1 }, rivalName: 'oxbla' }), ' 3 wins in a row. Score vs oxbla: 3 : 1.');
  assert.equal(captionSuffix({ winStreak: 4, score: null, rivalName: null }), ' 4 wins in a row.');
  assert.equal(captionSuffix({ winStreak: 1, score: { you: 2, them: 2 }, rivalName: null }), ' Score vs my rival: 2 : 2.');
  assert.equal(captionSuffix({ winStreak: 1, score: null, rivalName: null }), '');
});

test('no long dashes in any caption', () => {
  const all = [
    ...Object.values(pickCardCaption({ winStreak: 3, score: { you: 3, them: 1 }, rivalName: 'oxbla' })),
    captionSuffix({ winStreak: 3, score: { you: 3, them: 1 }, rivalName: 'oxbla' }),
  ];
  const dashes = new RegExp('[' + String.fromCharCode(0x2013) + String.fromCharCode(0x2014) + ']');
  for (const text of all) assert.ok(!dashes.test(text ?? ''));
});
