import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketStatus } from '../src/market-status.ts';
test('a rejected market exposes its observed imbalance instead of an unexplained empty arena', () => {
  const status = marketStatus(null, 'observed momentum 16 UP / 4 DOWN in 20 priced minutes', false, 1);
  assert.equal(status.phase, 'searching');
  assert.match(status.reason, /16 UP \/ 4 DOWN/);
  assert.equal(status.pool, null);
  assert.equal(status.progress, null);
  assert.match(marketStatus(null, null, true, 1).reason, /paused/);
});
