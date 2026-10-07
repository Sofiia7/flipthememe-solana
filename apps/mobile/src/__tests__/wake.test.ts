// Node tests for the deadline picker behind useWakeAt: a History row sleeps until its next deadline.
// Run from the repo root: node --test apps/mobile/src/__tests__/wake.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soonestAfter } from '../ui/useWakeAt.ts';

test('the next deadline is the earliest one still ahead; none ahead means no timer', () => {
  assert.equal(soonestAfter(1_000, [5_000, 3_000, 9_000]), 3_000);
  // Passed deadlines, null and undefined never count; one exactly now has passed.
  assert.equal(soonestAfter(1_000, [500, 1_000, null, undefined, 4_000]), 4_000);
  assert.equal(soonestAfter(1_000, [500, 1_000]), null);
  assert.equal(soonestAfter(1_000, []), null);
  assert.equal(soonestAfter(1_000, [Number.NaN, Number.POSITIVE_INFINITY, 2_000]), 2_000);
});
