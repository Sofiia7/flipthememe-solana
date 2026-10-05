import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PoolCandidate } from '@flipthememe/client';
import { address, type Address } from '@solana/kit';
import { HOLD_MS, poolPlan } from '../src/selector.ts';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const HOUR = 3_600_000;
const pools: Address[] = [
  address('11111111111111111111111111111112'),
  address('11111111111111111111111111111113'),
  address('11111111111111111111111111111114'),
  address('11111111111111111111111111111115'),
];
const mint = address('So11111111111111111111111111111111111111112');

function candidate(i: number, txM5: number, ageHours: number): PoolCandidate {
  const pool = pools[i];
  if (!pool) throw new Error('no pool');
  return { pool, baseMint: mint, name: `T${i}`, reserveUsd: 100_000, createdAtMs: NOW - ageHours * HOUR, txM5, volumeH1Usd: 10_000 };
}

describe('poolPlan', () => {
  const list = [candidate(0, 25, 10), candidate(1, 80, 30), candidate(2, 5, 2), candidate(3, 300, 24 * 30)];

  test('fresh = younger than 7 days with at least 20 trades in 5 minutes, most active first', () => {
    const plan = poolPlan(list, null, NOW);
    assert.deepEqual(plan.fresh.map((c) => c.name), ['T1', 'T0']);
    assert.deepEqual(plan.any.map((c) => c.name), ['T3', 'T1', 'T0', 'T2']);
    assert.equal(plan.keepCurrent, false);
    assert.equal(plan.keepFallback, false);
  });

  test('keeps the current pool for 15 minutes while it still passes', () => {
    const current = { pool: pools[0] as Address, selectedAtMs: NOW - HOLD_MS + 1, fallback: false };
    assert.equal(poolPlan(list, current, NOW).keepCurrent, true);
  });

  test('after the hold the most active fresh pool is picked again', () => {
    const current = { pool: pools[0] as Address, selectedAtMs: NOW - HOLD_MS, fallback: false };
    const plan = poolPlan(list, current, NOW);
    assert.equal(plan.keepCurrent, false);
    assert.equal(plan.fresh[0]?.name, 'T1');
  });

  test('a pool that stops passing is dropped even inside the hold', () => {
    const current = { pool: pools[2] as Address, selectedAtMs: NOW - 60_000, fallback: false };
    assert.equal(poolPlan(list, current, NOW).keepCurrent, false);
    const gone = { pool: pools[1] as Address, selectedAtMs: NOW - 60_000, fallback: false };
    assert.equal(poolPlan([candidate(0, 25, 10)], gone, NOW).keepCurrent, false);
  });

  test('nothing fresh: fallback to the most active pool of any age, held while still listed', () => {
    const old = [candidate(0, 50, 24 * 8), candidate(3, 300, 24 * 30)];
    const plan = poolPlan(old, null, NOW);
    assert.deepEqual(plan.fresh, []);
    assert.deepEqual(plan.any.map((c) => c.name), ['T3', 'T0']);
    const fallbackCurrent = { pool: pools[0] as Address, selectedAtMs: NOW - 60_000, fallback: true };
    const held = poolPlan(old, fallbackCurrent, NOW);
    assert.equal(held.keepCurrent, false);
    assert.equal(held.keepFallback, true);
  });
});
