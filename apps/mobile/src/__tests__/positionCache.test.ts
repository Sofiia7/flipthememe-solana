import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsPositionScan } from '../chain/positionCache.ts';
test('hidden-tab partial and empty caches must refill after final; full cache gets one final scan', () => {
  for (const count of [null, 0, 1]) assert.equal(needsPositionScan(count, 2, true, false), true);
  assert.equal(needsPositionScan(2, 2, true, false), true);
  assert.equal(needsPositionScan(2, 2, true, true), false);
  assert.equal(needsPositionScan(1, 2, true, true), true);
});
