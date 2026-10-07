import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_GATE,
  MINUTE_MS,
  RUNG_NAMES,
  beats,
  imbalanceOf,
  isOneSided,
  keepFailure,
  keepMaxAgeMs,
  rankCandidates,
  rungOf,
  scoreOf,
} from '../src/poolgate.ts';
import { HOUR, NOW, candidate as pool, withFlow } from './pool-fixtures.ts';

const gate = DEFAULT_GATE;

describe('pool gate defaults', () => {
  test('10-120 minutes, 50 trades in 5 minutes, hold 10 minutes, 1.5x, keep at 20 trades and 180 minutes', () => {
    assert.deepEqual(
      { ...DEFAULT_GATE },
      { minAgeMs: 10 * MINUTE_MS, maxAgeMs: 120 * MINUTE_MS, minTxM5: 50, holdMs: 10 * MINUTE_MS, switchRatio: 1.5, keepMinTxM5: 20, keepMaxAgeMs: 180 * MINUTE_MS, pumpOnly: false, maxImbalance: 0.5, youthWeight: 1 },
    );
    assert.deepEqual(RUNG_NAMES, ['fresh', 'within-6h', 'within-24h', 'any-age']);
  });
});

describe('rungOf', () => {
  test('fresh rung: age 10..120 minutes inclusive with at least 50 trades', () => {
    assert.equal(rungOf(pool(1, 50, 10 * MINUTE_MS - 1), NOW, gate), null, 'younger than 10 minutes: no rung at all');
    assert.equal(rungOf(pool(1, 50, 10 * MINUTE_MS), NOW, gate), 0);
    assert.equal(rungOf(pool(1, 50, 40 * MINUTE_MS), NOW, gate), 0);
    assert.equal(rungOf(pool(1, 50, 120 * MINUTE_MS), NOW, gate), 0);
    assert.equal(rungOf(pool(1, 49, 40 * MINUTE_MS), NOW, gate), 3, 'too quiet for the fresh rung: only the any-age rung');
  });

  test('fallback ladder: up to 6 h, up to 24 h, then any age', () => {
    assert.equal(rungOf(pool(1, 50, 120 * MINUTE_MS + 1), NOW, gate), 1);
    assert.equal(rungOf(pool(1, 300, 6 * HOUR), NOW, gate), 1);
    assert.equal(rungOf(pool(1, 300, 6 * HOUR + 1), NOW, gate), 2);
    assert.equal(rungOf(pool(1, 300, 24 * HOUR), NOW, gate), 2);
    assert.equal(rungOf(pool(1, 300, 24 * HOUR + 1), NOW, gate), 3);
    assert.equal(rungOf(pool(1, 0, 30 * 24 * HOUR), NOW, gate), 3);
  });

  test('an undated or future pool has no rung', () => {
    assert.equal(rungOf({ ...pool(1, 500, HOUR), createdAtMs: Number.NaN }, NOW, gate), null);
    assert.equal(rungOf(pool(1, 500, -MINUTE_MS), NOW, gate), null);
  });

  test('the gate is configurable', () => {
    const wide = { ...gate, minAgeMs: 0, maxAgeMs: 30 * MINUTE_MS, minTxM5: 10 };
    assert.equal(rungOf(pool(1, 10, MINUTE_MS), NOW, wide), 0);
    assert.equal(rungOf(pool(1, 10, 31 * MINUTE_MS), NOW, wide), 1);
  });
});

describe('scoreOf', () => {
  test('trades in 5 minutes with a bonus for youth that ends at 120 minutes', () => {
    assert.equal(scoreOf(pool(1, 60, 0), NOW, gate), 120);
    assert.equal(scoreOf(pool(1, 60, 30 * MINUTE_MS), NOW, gate), 105); // 60 * (1 + 90/120)
    assert.equal(scoreOf(pool(1, 60, 60 * MINUTE_MS), NOW, gate), 90);
    assert.equal(scoreOf(pool(1, 60, 120 * MINUTE_MS), NOW, gate), 60);
    assert.equal(scoreOf(pool(1, 60, 20 * HOUR), NOW, gate), 60);
  });

  test('a younger pool wins at equal activity, a much busier older one still wins', () => {
    const young = scoreOf(pool(1, 100, 20 * MINUTE_MS), NOW, gate);
    const old = scoreOf(pool(2, 100, 100 * MINUTE_MS), NOW, gate);
    assert.ok(young > old);
    assert.ok(scoreOf(pool(3, 250, 110 * MINUTE_MS), NOW, gate) > young);
  });
});

describe('one-sided flow', () => {
  test('imbalance is |buys - sells| / txM5; no split or no trades counts as balanced', () => {
    assert.equal(imbalanceOf(withFlow(pool(1, 0, HOUR), 50, 50)), 0);
    assert.equal(imbalanceOf(withFlow(pool(1, 0, HOUR), 90, 10)), 0.8);
    assert.equal(imbalanceOf(withFlow(pool(1, 0, HOUR), 100, 0)), 1);
    assert.equal(imbalanceOf(withFlow(pool(1, 0, HOUR), 0, 0)), null, 'no trades: nothing to divide by');
    assert.equal(imbalanceOf(pool(1, 80, HOUR)), null, 'a candidate without the split');
  });

  test('score = txM5 * (1 - imbalance) * youth bonus; a pool that only buys scores 0', () => {
    const balanced = withFlow(pool(1, 0, 60 * MINUTE_MS), 40, 40); // 80 trades, bonus 1.5
    const lopsided = withFlow(pool(2, 0, 60 * MINUTE_MS), 70, 10); // 80 trades, imbalance 0.75
    assert.equal(scoreOf(balanced, NOW, gate), 120);
    assert.equal(scoreOf(lopsided, NOW, gate), 30);
    assert.equal(scoreOf(withFlow(pool(3, 0, 60 * MINUTE_MS), 80, 0), NOW, gate), 0);
    assert.equal(scoreOf(pool(4, 80, 60 * MINUTE_MS), NOW, gate), 120, 'no split: as before');
    // The youth bonus can be switched off, the flow penalty stays.
    const neutral = { ...gate, youthWeight: 0 };
    assert.equal(scoreOf(balanced, NOW, neutral), 80);
    assert.equal(scoreOf(lopsided, NOW, neutral), 20);
  });

  test('soft gate: beyond maxImbalance a pool is one-sided (the limit itself is not)', () => {
    assert.equal(isOneSided(withFlow(pool(1, 0, HOUR), 75, 25), gate), false, '|75 - 25| = 50 = 0.5 * 100');
    assert.equal(isOneSided(withFlow(pool(1, 0, HOUR), 76, 24), gate), true);
    assert.equal(isOneSided(withFlow(pool(1, 0, HOUR), 76, 24), { ...gate, maxImbalance: 0.6 }), false);
    assert.equal(isOneSided(pool(1, 100, HOUR), gate), false);
  });

  test('a one-sided pool ranks behind every balanced one while a balanced active pool exists, even a lower rung', () => {
    const list = [
      withFlow(pool(1, 0, 30 * MINUTE_MS), 190, 10), // fresh, 200 trades, one-sided
      withFlow(pool(2, 0, 100 * MINUTE_MS), 30, 30), // fresh, balanced, much quieter
      withFlow(pool(3, 0, 3 * HOUR), 40, 40), // within-6h, balanced
      withFlow(pool(4, 0, 4 * HOUR), 70, 10), // within-6h, one-sided
    ];
    const ranked = rankCandidates(list, NOW, gate);
    assert.deepEqual(
      ranked.map((r) => r.candidate.name + ' ' + RUNG_NAMES[r.rung] + (r.oneSided ? ' one-sided' : '')),
      ['T2 / SOL fresh', 'T3 / SOL within-6h', 'T1 / SOL fresh one-sided', 'T4 / SOL within-6h one-sided'],
    );
  });

  test('with no balanced pool of the entry or fallback rungs the one-sided ones serve as before', () => {
    const list = [
      withFlow(pool(1, 0, 30 * MINUTE_MS), 190, 10),
      withFlow(pool(2, 0, 3 * HOUR), 70, 10),
      withFlow(pool(3, 0, 30 * HOUR), 5, 5), // any-age rung: balanced, but not an active pool
    ];
    assert.deepEqual(rankCandidates(list, NOW, gate).map((r) => r.candidate.name), ['T1 / SOL', 'T2 / SOL', 'T3 / SOL']);
  });
});

describe('rankCandidates', () => {
  test('lower rung first, then higher score; too young pools left out; first row per pool', () => {
    const list = [
      pool(1, 400, 30 * HOUR), // any-age
      pool(2, 60, 100 * MINUTE_MS), // fresh, score 70
      pool(3, 80, 3 * HOUR), // within-6h
      pool(4, 55, 15 * MINUTE_MS), // fresh, score ~104
      pool(5, 900, 5 * MINUTE_MS), // too young
      pool(6, 90, 10 * HOUR), // within-24h
      pool(2, 999, 100 * MINUTE_MS), // duplicate row of pool 2: ignored
    ];
    const ranked = rankCandidates(list, NOW, gate);
    assert.deepEqual(
      ranked.map((r) => `${r.candidate.name} ${RUNG_NAMES[r.rung]}`),
      ['T4 / SOL fresh', 'T2 / SOL fresh', 'T3 / SOL within-6h', 'T6 / SOL within-24h', 'T1 / SOL any-age'],
    );
    assert.equal(ranked[1]?.score, 70);
  });
});

describe('keep gate', () => {
  test('fresh rung: at least 20 trades and at most 180 minutes old', () => {
    assert.equal(keepFailure(pool(1, 20, 180 * MINUTE_MS), 0, NOW, gate), null);
    assert.equal(keepFailure(pool(1, 19, 60 * MINUTE_MS), 0, NOW, gate), 'txM5 19 < 20');
    assert.equal(keepFailure(pool(1, 300, 181 * MINUTE_MS), 0, NOW, gate), 'age 181 min > 180 min');
    assert.equal(keepFailure(undefined, 0, NOW, gate), 'unlisted');
  });

  test('fallback rungs keep 60 minutes of grace past their age limit; any-age has no limit', () => {
    assert.equal(keepMaxAgeMs(1, gate), 7 * HOUR);
    assert.equal(keepMaxAgeMs(2, gate), 25 * HOUR);
    assert.equal(keepMaxAgeMs(3, gate), Number.POSITIVE_INFINITY);
    assert.equal(keepFailure(pool(1, 30, 7 * HOUR), 1, NOW, gate), null);
    assert.match(keepFailure(pool(1, 30, 7 * HOUR + MINUTE_MS), 1, NOW, gate) ?? '', /^age 421 min > 420 min$/);
    assert.equal(keepFailure(pool(1, 0, 90 * 24 * HOUR), 3, NOW, gate), null);
    assert.equal(keepFailure(undefined, 3, NOW, gate), 'unlisted');
  });
});

describe('beats', () => {
  test('a lower rung always wins, the same rung needs 1.5x the score, a higher rung never', () => {
    assert.equal(beats({ rung: 0, score: 10 }, { rung: 1, score: 500 }, gate), true);
    assert.equal(beats({ rung: 0, score: 150 }, { rung: 0, score: 100 }, gate), true);
    assert.equal(beats({ rung: 0, score: 149 }, { rung: 0, score: 100 }, gate), false);
    assert.equal(beats({ rung: 2, score: 9_000 }, { rung: 1, score: 50 }, gate), false);
    assert.equal(beats({ rung: 3, score: 0 }, { rung: 3, score: 0 }, gate), false, 'equal scores never switch');
  });
});

describe('neutral production ranking', () => {
  const neutral = { ...DEFAULT_GATE, neutral: true, youthWeight: 0, maxImbalance: 0.3 };
  test('activity wins across ages; youth and fallback rung give no advantage', () => {
    const young = withFlow(pool(1, 0, 20 * MINUTE_MS), 40, 40);
    const mature = withFlow(pool(2, 0, 48 * HOUR), 100, 100);
    assert.deepEqual(rankCandidates([young, mature], NOW, neutral).map((r) => r.candidate.pool), [mature.pool, young.pool]);
    assert.equal(scoreOf(young, NOW, { ...neutral, youthWeight: 100 }), 80);
    assert.equal(beats({ rung: 3, score: 200 }, { rung: 0, score: 80 }, neutral), true);
  });
  test('unknown flow, both directions of one-sided flow and quiet pools are refused with no fallback', () => {
    const list = [pool(1, 300, HOUR), withFlow(pool(2, 0, HOUR), 90, 10), withFlow(pool(3, 0, HOUR), 10, 90), withFlow(pool(4, 0, HOUR), 10, 10)];
    assert.deepEqual(rankCandidates(list, NOW, neutral), []);
    assert.match(keepFailure(list[1], 0, NOW, neutral)!, /flow imbalance/);
    assert.match(keepFailure(list[2], 3, NOW, neutral)!, /flow imbalance/);
  });
});

test('pump.fun graduates only when pumpOnly is set', () => {
  const gate = { ...DEFAULT_GATE, pumpOnly: true };
  const plain = pool(1, 100, 20 * MINUTE_MS);
  const graduate = { ...plain, baseMint: '8nKp4JkesNtDgu3PiSjdTdNSrtBt8YCHhW8BU14wpump' as typeof plain.baseMint };
  assert.equal(rungOf(plain, NOW, gate), null);
  assert.equal(rungOf(graduate, NOW, gate), 0);
  assert.equal(rungOf(plain, NOW, DEFAULT_GATE), 0);
});
