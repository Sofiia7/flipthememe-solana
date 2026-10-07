// Run: node --test "services/attestor/test/*.test.ts" (from the repo root). No network.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RoundStatus, type PriceSample } from '@flipthememe/client';
import { Refusal, type Reason } from '../src/check.ts';
import {
  KEEPER_MIN_SHARE_PERCENT,
  MIN_OWN_SAMPLES,
  SAMPLE_MARGIN_MS,
  SLOT_MARGIN,
  activeWindows,
  compareSamples,
  isCorroboratedOutage,
  meanPrice,
  nextSamplingStart,
  pendingWindows,
  requiredKeeperSamples,
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
    assert.equal(compareSamples([{ slot: 1000n, price: PRICE }, ...keeperSamples(6)], own, WINDOW, 150).sharedSlots, 1);
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
    const samples = [{ slot: 1010n, price: PRICE }, ...keeperSamples(6, () => PRICE, 1013n)];
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
    // Seven samples: the least a keeper may send for ten own reads (see the withheld tests below).
    assert.ok(compareSamples(keeperSamples(7, () => PRICE, low), own, WINDOW, 150));
    assert.ok(compareSamples(keeperSamples(7, () => PRICE, high - 12n), own, WINDOW, 150));
    assert.equal(refusal(() => compareSamples(keeperSamples(7, () => PRICE, low - 1n), own, WINDOW, 150)), 'slot_out_of_range');
    assert.equal(refusal(() => compareSamples(keeperSamples(7, () => PRICE, high - 11n), own, WINDOW, 150)), 'slot_out_of_range');
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

  test('fewer than 5 keeper samples while the attestor read 5 or more: refused as unpriced', () => {
    assert.equal(refusal(() => compareSamples(keeperSamples(4), ownReads(), WINDOW, 150)), 'unpriced');
    assert.equal(refusal(() => compareSamples([], ownReads(), WINDOW, 150)), 'unpriced');
    assert.ok(compareSamples(keeperSamples(7), ownReads(), WINDOW, 150));
  });
});

// The reads inside the window of ownReads(), without the three in the margins.
const insideOf = (reads: Observation[]) => reads.filter((o) => o.atMs >= WINDOW.startMs && o.atMs < WINDOW.endMs);

describe('samples withheld: a keeper may not pick which of its reads to send', () => {
  const rising = (i: number) => PRICE + BigInt(i) * 300n;

  test(`the count to send: max(5, ${KEEPER_MIN_SHARE_PERCENT}% of the attestor's reads inside the window), at most the program's 16`, () => {
    assert.equal(KEEPER_MIN_SHARE_PERCENT, 60);
    assert.deepEqual([0, 3, 5, 8, 9].map(requiredKeeperSamples), [5, 5, 5, 5, 5]);
    assert.deepEqual([10, 11, 12, 14, 20, 22, 23].map(requiredKeeperSamples), [6, 6, 7, 8, 12, 13, 13]);
    assert.deepEqual([26, 27, 40, 1000].map(requiredKeeperSamples), [15, 16, 16, 16]);
  });

  test('an honest keeper that lost two of its ten reads (a failed request, a late one) passes', () => {
    const own = ownReads(rising);
    const keeper = keeperSamples(8, (i) => rising(i + 2));
    const result = compareSamples(keeper, own, WINDOW, 150);
    assert.equal(result.ownSamples, 10);
    assert.equal(result.sharedSlots, 0); // none of its slots is one the attestor read: counts only, never slots
  });

  test('a keeper on a slow RPC that lost four of its ten reads and holds 6 passes (60 percent, not 70)', () => {
    const own = ownReads(rising);
    const keeper = keeperSamples(6, (i) => rising(i + 2));
    assert.equal(compareSamples(keeper, own, WINDOW, 150).ownSamples, 10);
  });

  test('keeping only the 5 highest of 10 reads is refused, though the mean is inside the tolerance', () => {
    const own = ownReads(rising);
    const ownMean = meanPrice(insideOf(own).map((o) => o.price));
    // The keeper's real reads are at the odd slots between the attestor's, with prices on the same line.
    const real = keeperSamples(10, (i) => rising(i + 2));
    const picked = real.slice(5);
    const pickedMean = meanPrice(picked.map((x) => x.price));
    assert.ok(pickedMean > ownMean);
    assert.ok(((pickedMean - ownMean) * 10_000n) / ownMean < 150n, 'the tolerance alone would let this through');
    const error = refused(() => compareSamples(picked, own, WINDOW, 150));
    assert.equal(error.reason, 'samples_withheld');
    // The counts are for the log; the message names them too.
    assert.deepEqual(error.detail, { ownSamples: 10, required: 6 });
    assert.match(error.message, /5 samples/);
    // All ten pass.
    assert.ok(compareSamples(real, own, WINDOW, 150));
  });

  test('the same cut from the other side: the 5 lowest of 10 is refused too', () => {
    const own = ownReads(rising);
    const real = keeperSamples(10, (i) => rising(i + 2));
    assert.equal(refusal(() => compareSamples(real.slice(0, 5), own, WINDOW, 150)), 'samples_withheld');
  });

  test('the line for ten own reads: 6 samples pass, 5 are refused', () => {
    const own = ownReads(rising);
    const real = keeperSamples(10, (i) => rising(i + 2));
    assert.ok(compareSamples(real.slice(4), own, WINDOW, 150));
    assert.equal(refusal(() => compareSamples(real.slice(5), own, WINDOW, 150)), 'samples_withheld');
  });

  test('with 5 to 8 own reads inside the window the program minimum of 5 is all that is asked', () => {
    const own = ownReads(rising);
    for (const reads of [5, 6, 7, 8]) {
      const few = [...own.filter((o) => !insideOf(own).includes(o)), ...insideOf(own).slice(0, reads)];
      assert.ok(compareSamples(keeperSamples(5, () => PRICE + 900n), few, WINDOW, 150), `${reads} reads`);
    }
  });

  test('slots are not compared: a keeper that read other slots than the attestor is fine, and so is one that shares many', () => {
    const own = ownReads(rising);
    const sameSlots = insideOf(own).slice(0, 8).map((o) => ({ slot: o.slot, price: o.price }));
    assert.equal(compareSamples(sameSlots, own, WINDOW, 150).sharedSlots, 8);
    assert.equal(compareSamples(keeperSamples(8, (i) => rising(i + 2)), own, WINDOW, 150).sharedSlots, 0);
  });

  test('more reads than the program takes: the keeper is asked for 16, never more', () => {
    // 40 reads inside the window, a quarter second apart.
    const many: Observation[] = Array.from({ length: 40 }, (_, i) => ({ atMs: WINDOW.startMs + i * 250, slot: 1000n + BigInt(i), price: PRICE }));
    const keeper = (n: number): PriceSample[] => Array.from({ length: n }, (_, i) => ({ slot: 1000n + BigInt(i), price: PRICE }));
    assert.equal(compareSamples(keeper(16), many, WINDOW, 150).ownSamples, 40);
    assert.equal(refusal(() => compareSamples(keeper(15), many, WINDOW, 150)), 'samples_withheld');
  });
});

describe('a corroborated outage: fewer than 5 samples on both sides', () => {
  const margins = (reads: Observation[]) => reads.filter((o) => !insideOf(reads).includes(o));

  test('the keeper sent fewer than 5 and the attestor holds fewer than 5 reads inside the window: corroborated', () => {
    const own = ownReads();
    const withInside = (n: number) => [...margins(own), ...insideOf(own).slice(0, n)];
    for (const [keeper, reads] of [[0, 0], [0, 4], [4, 4], [3, 2], [4, 0]] as const) {
      assert.equal(isCorroboratedOutage(keeper, withInside(reads), WINDOW), true, `keeper ${keeper}, attestor ${reads}`);
    }
    assert.equal(isCorroboratedOutage(0, [], WINDOW), true);
  });

  test('the attestor holds 5 or more reads: the keeper is withholding or faulty, not corroborated', () => {
    const own = ownReads();
    for (const keeper of [0, 1, 4]) {
      assert.equal(isCorroboratedOutage(keeper, [...margins(own), ...insideOf(own).slice(0, 5)], WINDOW), false);
      assert.equal(isCorroboratedOutage(keeper, own, WINDOW), false);
    }
  });

  test('5 or more keeper samples are never an outage: they are compared', () => {
    assert.equal(isCorroboratedOutage(5, [], WINDOW), false);
    assert.equal(isCorroboratedOutage(10, margins(ownReads()), WINDOW), false);
  });

  test('the attestor count is what the comparison counts: inside the window, one per slot, no zero price', () => {
    const own = ownReads();
    const four = insideOf(own).slice(0, 4);
    // Margin reads and a repeated slot do not make five; a zero price does not either.
    assert.equal(isCorroboratedOutage(2, [...margins(own), ...four, { ...four[0]!, atMs: four[0]!.atMs + 1 }], WINDOW), true);
    assert.equal(isCorroboratedOutage(2, [...four, { atMs: at(95), slot: 999_999n, price: 0n }], WINDOW), true);
    assert.equal(isCorroboratedOutage(2, [...four, { atMs: at(95), slot: 999_999n, price: PRICE }], WINDOW), false);
  });
});
