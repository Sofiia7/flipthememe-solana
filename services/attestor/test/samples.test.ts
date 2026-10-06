// Run: node --test "services/attestor/test/*.test.ts" (from the repo root). No network.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RoundStatus, type PriceSample } from '@flipthememe/client';
import { Refusal, type Reason } from '../src/check.ts';
import {
  MIN_OWN_SAMPLES,
  SAMPLE_MARGIN_MS,
  SLOT_MARGIN,
  activeWindows,
  compareSamples,
  meanPrice,
  nextSamplingStart,
  pendingWindows,
  windowOf,
  type Observation,
} from '../src/samples.ts';
import { makeRound, testAddress } from './helpers.ts';

const POOL = testAddress(1);
// Round 7 opens at T: strike window [T + 90, T + 100), exit window [T + 150, T + 160), in seconds.
const T = 1_800_000_000n;
const at = (secs: number): number => (Number(T) + secs) * 1000;
const round = makeRound(7n, T, POOL);

function refusal(fn: () => unknown): Reason {
  try {
    fn();
  } catch (error) {
    if (error instanceof Refusal) return error.reason;
    throw error;
  }
  assert.fail('expected a refusal');
}

describe('windows', () => {
  test('a round has its strike and exit windows in unix ms', () => {
    assert.deepEqual(windowOf(round, 'strike'), { roundId: 7n, kind: 'strike', pool: POOL, startMs: at(90), endMs: at(100) });
    assert.deepEqual(windowOf(round, 'exit'), { roundId: 7n, kind: 'exit', pool: POOL, startMs: at(150), endMs: at(160) });
  });

  test('pending: both windows while Open, the exit window while Live, none once Final', () => {
    const kinds = (status: RoundStatus) => pendingWindows([{ ...round, status }]).map((w) => w.kind);
    assert.deepEqual(kinds(RoundStatus.Open), ['strike', 'exit']);
    assert.deepEqual(kinds(RoundStatus.Live), ['exit']);
    assert.deepEqual(kinds(RoundStatus.Final), []);
  });

  test(`membership: [start - ${SAMPLE_MARGIN_MS} ms, end + ${SAMPLE_MARGIN_MS} ms)`, () => {
    const kinds = (ms: number) => activeWindows([round], ms).map((w) => w.kind);
    assert.deepEqual(kinds(at(90) - SAMPLE_MARGIN_MS - 1), []);
    assert.deepEqual(kinds(at(90) - SAMPLE_MARGIN_MS), ['strike']);
    assert.deepEqual(kinds(at(95)), ['strike']);
    assert.deepEqual(kinds(at(100) + SAMPLE_MARGIN_MS - 1), ['strike']);
    assert.deepEqual(kinds(at(100) + SAMPLE_MARGIN_MS), []);
    assert.deepEqual(kinds(at(155)), ['exit']);
    assert.deepEqual(activeWindows([{ ...round, status: RoundStatus.Final }], at(155)), []);
  });

  test('round N exit and round N+1 strike are the same seconds: one tick serves both', () => {
    const next = makeRound(8n, T + 60n, POOL);
    const due = activeWindows([round, next], at(155)).map((w) => `${w.roundId}:${w.kind}`);
    assert.deepEqual(due, ['7:exit', '8:strike']);
  });

  test('next sampling start: the earliest window start minus the margin still ahead', () => {
    assert.equal(nextSamplingStart([round], at(10)), at(90) - SAMPLE_MARGIN_MS);
    assert.equal(nextSamplingStart([round], at(95)), at(150) - SAMPLE_MARGIN_MS);
    assert.equal(nextSamplingStart([{ ...round, status: RoundStatus.Live }], at(10)), at(150) - SAMPLE_MARGIN_MS);
    assert.equal(nextSamplingStart([round], at(149)), null);
    assert.equal(nextSamplingStart([], at(10)), null);
  });
});

// Strike window [at(90), at(100)); the attestor read the even slots 1000..1024 once a second from
// 1.5 s before. Keeper samples default to the odd slots between them: no slot in common.
const WINDOW = { startMs: at(90), endMs: at(100) };
const PRICE = 1_000_000n;
function ownReads(price: (i: number) => bigint = () => PRICE): Observation[] {
  // Reads at -1.5 s, -0.5 s, +0.5 s ... +10.5 s around the window start: 10 inside, 3 in the margins.
  return Array.from({ length: 13 }, (_, i) => ({ atMs: at(90) - 1500 + i * 1000, slot: 1000n + BigInt(i) * 2n, price: price(i) }));
}
const keeperSamples = (n = 10, price: (i: number) => bigint = () => PRICE, firstSlot = 1005n): PriceSample[] =>
  Array.from({ length: n }, (_, i) => ({ slot: firstSlot + BigInt(i) * 2n, price: price(i) }));

function refused(fn: () => unknown): Refusal {
  try {
    fn();
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  assert.fail('expected a refusal');
}

describe('compareSamples', () => {
  test('agree: same window, means within the tolerance', () => {
    const own = ownReads((i) => PRICE + BigInt(i) * 100n);
    const keeper = keeperSamples(10, (i) => PRICE + 250n + BigInt(i) * 100n, 1005n);
    const result = compareSamples(keeper, own, WINDOW, 150);
    assert.equal(result.ownSamples, 10); // the margin reads are left out of the mean
    assert.equal(result.ownMean, PRICE + 650n); // reads 2..11 inside the window
    assert.equal(result.keeperMean, PRICE + 700n);
    assert.equal(result.diffBps, 0);
    assert.equal(result.sharedSlots, 0);
    assert.deepEqual(result.slotRange, [1000n - SLOT_MARGIN, 1024n + SLOT_MARGIN]);
  });

  test('shared slots with the same price pass and are counted', () => {
    const own = ownReads((i) => PRICE + BigInt(i));
    // Five samples at slots the attestor read (1004..1012), at exactly its prices; five between them.
    const shared = Array.from({ length: 5 }, (_, i) => ({ slot: 1004n + BigInt(i) * 2n, price: PRICE + BigInt(i + 2) }));
    const between = keeperSamples(5, () => PRICE + 4n, 1015n);
    assert.equal(compareSamples([...shared, ...between], own, WINDOW, 150).sharedSlots, 5);
    // Every keeper sample at a slot the attestor read.
    const all = Array.from({ length: 10 }, (_, i) => ({ slot: 1004n + BigInt(i) * 2n, price: PRICE + BigInt(i + 2) }));
    assert.equal(compareSamples(all, own, WINDOW, 150).sharedSlots, 10);
    // The margin reads count for shared slots too (slot 1000 was read 1.5 s before the window).
    assert.equal(compareSamples([{ slot: 1000n, price: PRICE }, ...keeperSamples(4)], own, WINDOW, 150).sharedSlots, 1);
  });

  test('a shared slot with a price off by one unit is refused, though the means agree; the details are for the log only', () => {
    const own = ownReads();
    const samples = Array.from({ length: 10 }, (_, i) => ({ slot: 1004n + BigInt(i) * 2n, price: i === 3 ? PRICE + 1n : PRICE }));
    const refusal = refused(() => compareSamples(samples, own, WINDOW, 150));
    assert.equal(refusal.reason, 'slot_price_mismatch');
    assert.deepEqual(refusal.detail, { slot: 1010n, keeperPrice: PRICE + 1n, ownPrice: PRICE, sharedSlots: 10 });
    assert.ok(!refusal.message.includes('1010') && !refusal.message.includes(String(PRICE)), refusal.message);
    // One unit below is refused the same way.
    const below = samples.map((s, i) => (i === 3 ? { ...s, price: PRICE - 1n } : s));
    assert.equal(refused(() => compareSamples(below, own, WINDOW, 150)).reason, 'slot_price_mismatch');
  });

  test('two reads of the attestor at one slot that disagree: a keeper sample there is refused whichever it matches', () => {
    const own = [...ownReads(), { atMs: at(95) + 1, slot: 1010n, price: PRICE + 7n }].sort((a, b) => a.atMs - b.atMs);
    const samples = [{ slot: 1010n, price: PRICE }, ...keeperSamples(4, () => PRICE, 1013n)];
    assert.equal(refused(() => compareSamples(samples, own, WINDOW, 150)).reason, 'slot_price_mismatch');
  });

  test('no shared slots: the mean check decides alone', () => {
    const own = ownReads();
    const close = compareSamples(keeperSamples(10, () => PRICE + 1n), own, WINDOW, 150);
    assert.equal(close.sharedSlots, 0);
    assert.equal(close.keeperMean, PRICE + 1n);
    const far = refused(() => compareSamples(keeperSamples(10, () => PRICE + 15_001n), own, WINDOW, 150));
    assert.equal(far.reason, 'price_mismatch');
    assert.equal(far.detail.sharedSlots, 0);
  });

  test('exact shared slots do not excuse the others: the mean check still applies', () => {
    const own = ownReads();
    const exact = Array.from({ length: 5 }, (_, i) => ({ slot: 1004n + BigInt(i) * 2n, price: PRICE }));
    const pushed = keeperSamples(5, () => (PRICE * 104n) / 100n, 1015n);
    const refusal = refused(() => compareSamples([...exact, ...pushed], own, WINDOW, 150));
    assert.equal(refusal.reason, 'price_mismatch');
    assert.equal(refusal.detail.sharedSlots, 5);
  });

  test('the mean is the program mean: floor(sum / n)', () => {
    assert.equal(meanPrice([1n, 2n]), 1n);
    assert.equal(meanPrice([10n, 10n, 11n]), 10n);
    assert.throws(() => meanPrice([]));
  });

  test('mean mismatch: just inside the tolerance signs, just past it is refused', () => {
    const own = ownReads();
    // 150 bps of 1_000_000 is 15_000.
    assert.equal(compareSamples(keeperSamples(10, () => PRICE + 15_000n), own, WINDOW, 150).diffBps, 150);
    assert.equal(compareSamples(keeperSamples(10, () => PRICE - 15_000n), own, WINDOW, 150).diffBps, 150);
    assert.equal(refusal(() => compareSamples(keeperSamples(10, () => PRICE + 15_001n), own, WINDOW, 150)), 'price_mismatch');
    assert.equal(refusal(() => compareSamples(keeperSamples(10, () => PRICE - 15_001n), own, WINDOW, 150)), 'price_mismatch');
    assert.equal(refusal(() => compareSamples(keeperSamples(10, () => PRICE + 1n), own, WINDOW, 0)), 'price_mismatch');
  });

  test('slot outside the window: beyond the slots the attestor read, plus the margin', () => {
    const own = ownReads(); // slots 1000..1024, margin reads included
    const low = 1000n - SLOT_MARGIN;
    const high = 1024n + SLOT_MARGIN;
    assert.ok(compareSamples(keeperSamples(5, () => PRICE, low), own, WINDOW, 150));
    assert.ok(compareSamples(keeperSamples(5, () => PRICE, high - 8n), own, WINDOW, 150));
    assert.equal(refusal(() => compareSamples(keeperSamples(5, () => PRICE, low - 1n), own, WINDOW, 150)), 'slot_out_of_range');
    assert.equal(refusal(() => compareSamples(keeperSamples(5, () => PRICE, high - 7n), own, WINDOW, 150)), 'slot_out_of_range');
    // A replay of an older window: right prices, wrong slots.
    assert.equal(refusal(() => compareSamples(keeperSamples(10, () => PRICE, 500n), own, WINDOW, 150)), 'slot_out_of_range');
  });

  test(`too few samples: fewer than ${MIN_OWN_SAMPLES} own reads inside the window (margin reads do not count)`, () => {
    const own = ownReads();
    const margins = own.filter((o) => o.atMs < WINDOW.startMs || o.atMs >= WINDOW.endMs);
    assert.equal(margins.length, 3);
    const inside = own.filter((o) => !margins.includes(o));
    assert.equal(refusal(() => compareSamples(keeperSamples(), [...margins, ...inside.slice(0, 2)], WINDOW, 150)), 'too_few_samples');
    assert.equal(compareSamples(keeperSamples(), [...margins, ...inside.slice(0, 3)], WINDOW, 150).ownSamples, 3);
    assert.equal(refusal(() => compareSamples(keeperSamples(), [], WINDOW, 150)), 'too_few_samples');
  });

  test('own reads: one per slot (the first), zero prices left out', () => {
    const own = ownReads();
    const doubled = [...own, ...own.map((o) => ({ ...o, atMs: o.atMs + 1, price: o.price * 2n })), { atMs: at(95), slot: 999_999n, price: 0n }];
    const result = compareSamples(keeperSamples(), doubled.sort((a, b) => a.atMs - b.atMs), WINDOW, 150);
    assert.equal(result.ownSamples, 10);
    assert.equal(result.ownMean, PRICE);
  });

  test('fewer than 5 keeper samples price nothing: refused as unpriced, whatever the reads', () => {
    assert.equal(refusal(() => compareSamples(keeperSamples(4), ownReads(), WINDOW, 150)), 'unpriced');
    assert.equal(refusal(() => compareSamples([], ownReads(), WINDOW, 150)), 'unpriced');
    assert.ok(compareSamples(keeperSamples(5), ownReads(), WINDOW, 150));
  });
});
