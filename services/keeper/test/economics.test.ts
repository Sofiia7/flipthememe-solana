import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contribution, replay, wilson, spotMoveEstimate } from '../src/economics.ts';
test('fees are earned on matched stakes; house and infrastructure costs count against margin', () => {
  assert.deepEqual(contribution({ rawStake: 1000, matchedShare: .2, feeBps: 200, rpc: 1, transactions: 1, archive: 0, support: 1, acquisition: 0, houseNetCost: 2 }), { matched: 200, fees: 4, costs: 5, contribution: -1, units: 'all amounts must use the same currency' });
});
test('small samples show wide uncertainty; missing predictive features never become invented signals', () => {
  assert.equal(wilson(0, 0), null);
  assert.ok(wilson(5, 10)!.lower < .3 && wilson(5, 10)!.upper > .7);
  const result = replay(Array.from({ length: 10 }, (_, i) => ({ opensAt: i * 60, dir: 'up' as const })));
  assert.equal(result.temporalSplit.heldOut, 3);
  assert.equal(result.results.find(r => r.policy === 'momentum')!.skipped, 3);
  assert.equal(result.results.find(r => r.policy === 'always-down')!.netStakeUnits, -3);
});
test('a fee raises capital required to move constant-product spot; estimate is not window attack security', () => {
  assert.ok(spotMoveEstimate(100, .01, .003).quoteIn > spotMoveEstimate(100, .01, 0).quoteIn);
});
