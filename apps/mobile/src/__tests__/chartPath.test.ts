// Node tests for the chart path helpers: gaps in the live line, every piece split at the strike, and when the chart redraws.
// Run from the repo root: node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  areaPath,
  chartPropsEqual,
  linePath,
  monoTextWidth,
  splitAtGaps,
  splitAtLevel,
  splitLinesAtLevel,
  type ChartPropsView,
} from '../ui/chartPath.ts';

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

test('the chart redraws for new data or a changed window, not for every half second of the arena clock', () => {
  const points = [{ atMs: 1 }];
  const base: ChartPropsView = {
    points,
    nowMs: 10_200,
    strike: 5n,
    strikeLabel: 'START #7',
    pairLabel: 'PEPE / SOL',
    strikeWindow: { range: [20_000, 30_000], label: 'START PRICE IN 0:10', strong: true },
    exitWindow: [80_000, 90_000],
    cutoffMs: 15_000,
    stale: false,
    height: 150,
  };
  // The arena builds fresh window objects on every render: same values must count as equal.
  const again = (patch: Partial<ChartPropsView> = {}): ChartPropsView => ({
    ...base,
    strikeWindow: { range: [20_000, 30_000], label: 'START PRICE IN 0:10', strong: true },
    exitWindow: [80_000, 90_000],
    ...patch,
  });
  assert.equal(chartPropsEqual(base, again()), true);
  assert.equal(chartPropsEqual(base, again({ nowMs: 10_999 })), true, 'same whole second');
  assert.equal(chartPropsEqual(base, again({ nowMs: 11_000 })), false, 'next second');
  assert.equal(chartPropsEqual(base, again({ points: [...points] })), false, 'a new price point');
  assert.equal(chartPropsEqual(base, again({ strike: 6n })), false);
  assert.equal(chartPropsEqual(base, again({ strikeWindow: { range: [20_000, 30_000], label: 'LOCKING START', strong: true } })), false);
  assert.equal(chartPropsEqual(base, again({ strikeWindow: { range: [21_000, 30_000], label: 'START PRICE IN 0:10', strong: true } })), false);
  assert.equal(chartPropsEqual(base, again({ strikeWindow: null })), false);
  assert.equal(chartPropsEqual(base, again({ exitWindow: [80_000, 95_000] })), false);
  assert.equal(chartPropsEqual(base, again({ cutoffMs: null })), false);
  assert.equal(chartPropsEqual(base, again({ stale: true })), false);
  // Missing and explicit defaults are the same drawing.
  assert.equal(chartPropsEqual({ ...base, stale: undefined, cutoffMs: undefined }, { ...base, stale: false, cutoffMs: null }), true);
  assert.equal(
    chartPropsEqual({ ...base, strikeWindow: { range: [1, 2], label: 'x' } }, { ...base, strikeWindow: { range: [1, 2], label: 'x', strong: true } }),
    true,
  );
});

test('monospace labels are about 0.6 em per glyph, so 10sp BET BY needs 36 px', () => {
  assert.equal(monoTextWidth('BET BY', 10), 36);
  assert.equal(monoTextWidth('', 10), 0);
});
