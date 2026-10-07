// Node tests for how long the result overlays stay up (no React Native). Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REKT_GRACE_MS, REKT_HOLD_MAX_MS, REKT_MS, WIN_MS, rektCloseDelay } from '../state/resultTiming.ts';

test('a rekt without an offer keeps the old 6 seconds', () => {
  assert.equal(REKT_MS, 6_000);
  assert.equal(rektCloseDelay({ elapsedMs: 0, offerShown: false, queued: false }), 6_000);
  assert.equal(rektCloseDelay({ elapsedMs: 2_000, offerShown: false, queued: false }), 4_000);
});

test('a rekt that shows SAME CALL / FLIP IT is held: only the safety net closes it', () => {
  assert.equal(rektCloseDelay({ elapsedMs: 0, offerShown: true, queued: false }), REKT_HOLD_MAX_MS);
  assert.equal(rektCloseDelay({ elapsedMs: 10_000, offerShown: true, queued: false }), REKT_HOLD_MAX_MS - 10_000);
  // Never an instant close, even past the net.
  assert.equal(rektCloseDelay({ elapsedMs: REKT_HOLD_MAX_MS + 5_000, offerShown: true, queued: false }), REKT_GRACE_MS);
});

test('when the offer takes itself away the screen stays a moment, then closes: late offers do not snap it shut', () => {
  // The offer was there 12 s, then went: the 6 s are long over, so only the grace is left.
  assert.equal(rektCloseDelay({ elapsedMs: 12_000, offerShown: false, queued: false }), REKT_GRACE_MS);
  // It went after 2 s (a result that came with 7 s left): the rest of the usual time applies.
  assert.equal(rektCloseDelay({ elapsedMs: 2_000, offerShown: false, queued: false }), 4_000);
});

test('a result waiting behind a rekt is not held up by its offer', () => {
  assert.equal(rektCloseDelay({ elapsedMs: 0, offerShown: true, queued: true }), 6_000);
  assert.equal(rektCloseDelay({ elapsedMs: 9_000, offerShown: true, queued: true }), REKT_GRACE_MS);
});

test('a win keeps its 20 seconds (the offer does not hold a win: it goes away by itself 6 s before entry closes)', () => {
  assert.equal(WIN_MS, 20_000);
});
