// Node tests for the chart history (GeckoTerminal reference line) and the chart path helpers.
// Run from the repo root: node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceOf } from '@flipthememe/client';
import { ohlcvScale, ohlcvUrl, parseOhlcv } from '../chain/poolHistory.ts';
import { areaPath, clipSeries, linePath, splitAtGaps, splitAtLevel, splitLinesAtLevel, withinFactor } from '../ui/chartPath.ts';

// A real answer (pool BhheeH8Uu7FQYV98MLuKPsdeDVuza4r7htrYpMFLcz94, base TvRpo...pump, 6 decimals),
// fetched 2026-10-06 06:16:14 UTC with currency=token: newest first, SOL per whole token.
const POOL = 'BhheeH8Uu7FQYV98MLuKPsdeDVuza4r7htrYpMFLcz94';
const MINT = 'TvRpoQE6WqdpnTJ9Kh9WxsEPmNm63gJtSqEd9ympump';
const FETCHED_AT = 1_791_267_374_000;
const BODY = {
  data: {
    id: 'x',
    type: 'ohlcv_request_response',
    attributes: {
      ohlcv_list: [
        [1791267300, 1.52848738381382e-5, 1.55937237137182e-5, 1.52848738381382e-5, 1.54879918112314e-5, 0.305814244],
        [1791267240, 1.48692872785252e-5, 1.54776004456145e-5, 1.48692872785252e-5, 1.52848738381382e-5, 17.347123757],
        [1791267180, 1.43281823025118e-5, 1.50513099726471e-5, 1.43280734241255e-5, 1.48692872785252e-5, 18.335197946],
      ],
    },
  },
  meta: { base: { symbol: 'Google', address: MINT }, quote: { symbol: 'SOL', address: 'So11111111111111111111111111111111111111112' } },
};

const close = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 1e-9;

test('GeckoTerminal candles come out in the live price units: SOL per token times 10^(21 - decimals)', () => {
  assert.equal(ohlcvScale(6), 1e15);
  assert.equal(ohlcvScale(9), 1e12);
  assert.equal(
    ohlcvUrl(POOL, MINT),
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${POOL}/ohlcv/minute?aggregate=1&limit=10&currency=token&token=${MINT}`,
  );
  const points = parseOhlcv(BODY, 6, FETCHED_AT);
  // Oldest first: the oldest open at its candle start, then every close at the end of its minute.
  assert.deepEqual(
    points.map((p) => p.atMs),
    [1_791_267_180_000, 1_791_267_240_000, 1_791_267_300_000, 1_791_267_360_000],
  );
  assert.ok(close(points[0].price, 14_328_182_302.5118));
  assert.ok(close(points[3].price, 15_487_991_811.2314));
  // The live read of the same pool 11 s earlier (06:16:03): quote 515542779944 lamports, base 33142406719627 raw.
  const live = priceOf(33_142_406_719_627n, 515_542_779_944n);
  assert.equal(live, 15_555_381_487n);
  // Same units: the last close sits 0.4% from the vault price, not a power of ten away.
  assert.ok(withinFactor(points[3].price, Number(live), 1.01));
});

test('a candle still running ends at the fetch time; bad rows and a phone clock behind are dropped', () => {
  const running = parseOhlcv(BODY, 6, 1_791_267_330_000);
  assert.equal(running[running.length - 1].atMs, 1_791_267_330_000);
  assert.ok(close(running[running.length - 1].price, 15_487_991_811.2314));
  // Fetched before the newest candle started (clock behind): that candle is left out, times stay increasing.
  const behind = parseOhlcv(BODY, 6, 1_791_267_290_000);
  assert.deepEqual(
    behind.map((p) => p.atMs),
    [1_791_267_180_000, 1_791_267_240_000, 1_791_267_290_000],
  );
  const messy = {
    data: { attributes: { ohlcv_list: [[1791267300, 0, 0, 0, 0, 0], 'x', [1791267240, '0.5', 0, 0, '0.25', 1], [null, 1, 1, 1, 1, 1]] } },
  };
  assert.deepEqual(parseOhlcv(messy, 6, FETCHED_AT), [
    { atMs: 1_791_267_240_000, price: 5e14 },
    { atMs: 1_791_267_300_000, price: 2.5e14 },
  ]);
  assert.deepEqual(parseOhlcv({ errors: [{ status: '429' }] }, 6, FETCHED_AT), []);
  assert.deepEqual(parseOhlcv(BODY, 40, FETCHED_AT), []);
});

test('the history is clipped to the visible time before the live line, cut exactly at both ends', () => {
  const s = [
    { t: 0, v: 10 },
    { t: 60, v: 20 },
    { t: 120, v: 30 },
  ];
  assert.deepEqual(clipSeries(s, 30, 90), [
    { t: 30, v: 15 },
    { t: 60, v: 20 },
    { t: 90, v: 25 },
  ]);
  assert.deepEqual(clipSeries(s, 0, 60), [
    { t: 0, v: 10 },
    { t: 60, v: 20 },
  ]);
  assert.deepEqual(clipSeries(s, 6, 12), [
    { t: 6, v: 11 },
    { t: 12, v: 12 },
  ]);
  assert.deepEqual(clipSeries(s, 90, 500), [
    { t: 90, v: 25 },
    { t: 120, v: 30 },
  ]);
  assert.deepEqual(clipSeries(s, 130, 200), []);
  assert.deepEqual(clipSeries(s, 50, 50), []);
  assert.deepEqual(clipSeries([], 0, 10), []);
  // A broken source (wrong unit) is caught by the factor check before it can squash the live line.
  assert.equal(withinFactor(15_487_991_811, 15_555_381_487, 10), true);
  assert.equal(withinFactor(15_487_991_811_000, 15_555_381_487, 10), false);
  assert.equal(withinFactor(0, 1, 10), false);
});

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
