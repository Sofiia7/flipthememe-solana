import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMarketStatus, waitingView } from '../lib/marketStatus.ts';
import { leaderboardFaceBytes } from '../lib/leaderboardFace.ts';
const now = 1_800_000_000_000;
const status = { updatedAt: new Date(now).toISOString(), phase: 'observing', reason: 'observing market: 9/10 priced shadow minutes', progress: { observed: 9, required: 10 }, observingPools: 3, pool: null };
test('waiting distinguishes measured progress, paused and unavailable status without promising a start time', () => {
  const parsed = parseMarketStatus(status)!;
  assert.ok(parsed);
  assert.equal(waitingView(parsed, now).progress?.observed, 9);
  assert.equal(waitingView(parsed, now + 240_001).progress, null);
  assert.equal(waitingView({ ...parsed, phase: 'paused' }, now).title, 'NEW BETS PAUSED');
  assert.equal(parseMarketStatus({ ...status, progress: { observed: 11, required: 10 } }), null);
  assert.equal(parseMarketStatus({ ...status, pool: { pool: 'oops', baseMint: 'oops', name: '' } }), null);
  assert.equal(parseMarketStatus({}), null);
});
test('leaderboard face accepts exactly eight hexadecimal bytes', () => {
  assert.deepEqual([...leaderboardFaceBytes('0001020304050607')!], [0,1,2,3,4,5,6,7]);
  for (const bad of [null, undefined, '0', 'gg01020304050607', '000102030405060708']) assert.equal(leaderboardFaceBytes(bad), null);
});
