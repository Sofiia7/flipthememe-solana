// Node tests for the chart path helpers: gaps in the live line, and every piece split at the strike.
// Run from the repo root: node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaPath, linePath, splitAtGaps, splitAtLevel, splitLinesAtLevel } from '../ui/chartPath.ts';

test('a pause in the live data leaves a gap, and every piece still splits at the strike', () => {
  const times = [0, 1_500, 3_000, 30_000, 31_500, 60_000];
  assert.deepEqual(
    splitAtGaps(times, (t) => t, 15_000),
    [[0, 1_500, 3_000], [30_000, 31_500], [60_000]],
  );
  assert.deepEqual(splitAtGaps([], (t: number) => t, 15_000), []);
  const a = [
    { x: 0, y: 80 },
    { x: 10, y: 40 },
  ];
  const b = [
    { x: 30, y: 30 },
    { x: 40, y: 70 },
  ];
  assert.equal(linePath(a), 'M0.0 80.0L10.0 40.0');
  assert.equal(areaPath(a, 100), 'M0.0 80.0L10.0 40.0L10.0 100.0L0.0 100.0Z');
  assert.equal(areaPath([{ x: 1, y: 1 }], 100), '');
  const split = splitLinesAtLevel([a, b], 50);
  assert.deepEqual(split, {
    above: `${splitAtLevel(a, 50).above}${splitAtLevel(b, 50).above}`,
    below: `${splitAtLevel(a, 50).below}${splitAtLevel(b, 50).below}`,
  });
  assert.equal(split.below, 'M0.0 80.0L7.5 50.0M35.0 50.0L40.0 70.0');
  assert.equal(split.above, 'M7.5 50.0L10.0 40.0M30.0 30.0L35.0 50.0');
});
