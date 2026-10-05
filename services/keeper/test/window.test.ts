import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PriceObservation } from '@flipthememe/client';
import { ObservationStore, RETAIN_MS, windowSamples } from '../src/observations.ts';

// Strike window [T, T + 10 s) in unix seconds, observations in ms.
const T = 1_800_000_090n;
const ms = (offsetSecs: number): number => (Number(T) + offsetSecs) * 1000;
const obs = (offsetSecs: number, slot: number, price: bigint = 1_000n + BigInt(slot)): PriceObservation => ({
  atMs: ms(offsetSecs),
  slot: BigInt(slot),
  baseAmount: 1n,
  quoteAmount: 1n,
  price,
});
const slots = (samples: { slot: bigint }[]): number[] => samples.map((s) => Number(s.slot));

describe('windowSamples', () => {
  test('one sample per slot (the first observation of a slot wins), sorted by slot', () => {
    const list = [obs(0, 100, 7n), obs(1, 100, 9n), obs(2, 101), obs(3, 103), obs(4, 102), obs(5, 103, 1n), obs(6, 104)];
    const samples = windowSamples(list, T, T + 10n);
    assert.deepEqual(slots(samples), [100, 101, 102, 103, 104]);
    assert.equal(samples[0]?.price, 7n);
    assert.equal(samples[3]?.price, 1_103n);
    assert.deepEqual(Object.keys(samples[0] ?? {}).sort(), ['price', 'slot']);
  });

  test('fewer than 5 distinct slots: empty list (the program refunds or marks NotActivated)', () => {
    const list = [obs(0, 100), obs(1, 100), obs(2, 101), obs(3, 101), obs(4, 102), obs(5, 103), obs(6, 103)];
    assert.deepEqual(windowSamples(list, T, T + 10n), []);
    assert.deepEqual(windowSamples([], T, T + 10n), []);
  });

  test('window is [start, end): observations before the start or at the end are left out', () => {
    const list = [obs(-0.001, 90), obs(0, 100), obs(2, 101), obs(4, 102), obs(6, 103), obs(9.999, 104), obs(10, 105)];
    assert.deepEqual(slots(windowSamples(list, T, T + 10n)), [100, 101, 102, 103, 104]);
  });

  test('zero prices are dropped rather than sent (the program rejects them)', () => {
    const list = [obs(0, 100), obs(1, 101, 0n), obs(2, 102), obs(3, 103), obs(4, 104)];
    assert.deepEqual(windowSamples(list, T, T + 10n), []);
    assert.deepEqual(slots(windowSamples([...list, obs(5, 105)], T, T + 10n)), [100, 102, 103, 104, 105]);
  });

  test('at most 16 samples, the lowest slots', () => {
    const list = Array.from({ length: 20 }, (_, i) => obs(i * 0.5, 200 + i));
    const samples = windowSamples(list, T, T + 10n);
    assert.equal(samples.length, 16);
    assert.deepEqual(slots(samples), Array.from({ length: 16 }, (_, i) => 200 + i));
  });
});

describe('ObservationStore', () => {
  test('keeps about 15 minutes per pool and drops empty pools', () => {
    const store = new ObservationStore();
    store.add('poolA', obs(0, 1));
    store.add('poolA', obs(1, 2));
    store.add('poolB', obs(1, 3));
    assert.equal(store.get('poolA').length, 2);
    assert.equal(store.latest('poolA')?.slot, 2n);
    store.add('poolA', { ...obs(0, 4), atMs: ms(0) + RETAIN_MS + 500 });
    assert.deepEqual(slots([...store.get('poolA')]), [2, 4]);
    store.prune(ms(1) + RETAIN_MS + 1);
    assert.deepEqual(store.pools(), ['poolA']);
    assert.equal(store.latest('poolB'), null);
    assert.deepEqual(store.get('missing'), []);
  });
});
