// The sampler keeps a fixed 1 s rhythm: a read that hangs holds back neither the next tick nor the window.
// Time is scaled down (a "second" is 25 ms, so a 5 s hang is 125 ms) to keep the tests quick.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { windowMean, type PoolRef, type PriceObservation } from '@flipthememe/client';
import type { LogFields } from '../src/log.ts';
import { ObservationStore } from '../src/observations.ts';
import { MAX_READS_IN_FLIGHT, SAMPLE_TIMEOUT_MS, Sampler } from '../src/sampler.ts';
import { testAddress } from './pool-fixtures.ts';

const POOL = testAddress(1);
const REF: PoolRef = { pool: POOL, baseMint: testAddress(2), quoteMint: testAddress(3), baseVault: testAddress(4), quoteVault: testAddress(5) };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TICK = 25;

type Behaviour = (call: number) => { delayMs: number; slot?: bigint; fail?: Error };

function setup(behaviour: Behaviour, opts: { timeoutMs?: number; maxInFlight?: number } = {}) {
  const store = new ObservationStore();
  const logs: LogFields[] = [];
  let calls = 0;
  const started: number[] = [];
  const sampler = new Sampler({
    refs: { get: async () => REF },
    mainnet: { call: async (_what, fn) => fn(undefined as never) },
    store,
    logger: (f) => logs.push(f),
    timeoutMs: opts.timeoutMs,
    maxInFlight: opts.maxInFlight,
    observe: async () => {
      const call = ++calls;
      started.push(Date.now());
      const plan = behaviour(call);
      await sleep(plan.delayMs);
      if (plan.fail) throw plan.fail;
      const observation: PriceObservation = { atMs: Date.now(), slot: plan.slot ?? BigInt(1_000 + call), baseAmount: 1_000_000n, quoteAmount: 400_000n, price: 1_000n + BigInt(call) };
      return observation;
    },
  });
  return { sampler, store, logs, calls: () => calls, started };
}

/** One tick every TICK ms, `count` times, the way main.ts's loop runs it; then waits for the reads still going. */
async function ticks(sampler: Sampler, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    sampler.tick([POOL]);
    await sleep(TICK);
  }
}

describe('Sampler: fixed tick, two reads in flight', () => {
  test('defaults: two reads in flight per pool, a read abandoned after 3 s', () => {
    assert.equal(MAX_READS_IN_FLIGHT, 2);
    assert.equal(SAMPLE_TIMEOUT_MS, 3_000);
  });

  test('tick returns at once: it does not wait for the reads it started', async () => {
    const { sampler, calls } = setup(() => ({ delayMs: 80 }));
    const before = Date.now();
    sampler.tick([POOL]);
    assert.ok(Date.now() - before < 40);
    assert.equal(calls(), 0, 'the read starts after the pool ref is loaded, not inside tick');
    await sampler.idle();
    assert.equal(calls(), 1);
  });

  test('one read that hangs for "5 s" does not zero the window: the ticks around it still bring their samples', async () => {
    // Ten 25 ms ticks stand for a 10 s window; the third read hangs for 5 ticks (the 5 s hang). Sequentially, nothing
    // would have started for those five ticks: 4 of 10 would be left, below the 5 observations a window needs.
    const { sampler, store } = setup((call) => ({ delayMs: call === 3 ? 5 * TICK : 3 }), { timeoutMs: 10 * TICK });
    const start = Date.now();
    await ticks(sampler, 10);
    await sampler.idle();
    const end = Date.now() + 1;
    const observations = store.get(POOL);
    assert.ok(observations.length >= 8, `${observations.length} observations`);
    const mean = windowMean(observations, start, end);
    assert.ok(mean && mean.samples.length >= 8, 'the window is priced, with samples to spare over the minimum of 5');
  });

  test('a pool has at most two reads in flight; the ticks while both hang are skipped, then reads resume', async () => {
    const { sampler, store, calls } = setup((call) => (call <= 2 ? { delayMs: 8 * TICK } : { delayMs: 2 }), { timeoutMs: 20 * TICK });
    await ticks(sampler, 6); // reads 1 and 2 hang; ticks 3..6 find the pool at its maximum
    assert.equal(calls(), 2);
    await sleep(4 * TICK); // the hung reads finish
    await ticks(sampler, 3);
    await sampler.idle();
    assert.ok(calls() >= 5, `${calls()} reads`);
    assert.ok(store.get(POOL).length >= 4);
  });

  test('a read that outlasts the timeout is given up on (logged, once per 30 s) and its late answer is thrown away', async () => {
    const { sampler, store, logs } = setup((call) => (call === 1 ? { delayMs: 12 * TICK, slot: 50n } : { delayMs: 2 }), { timeoutMs: 4 * TICK });
    await ticks(sampler, 8);
    await sleep(8 * TICK); // the hung read answers after its timeout
    await sampler.idle();
    assert.equal(store.get(POOL).some((o) => o.slot === 50n), false, 'the late answer is not stored');
    const failures = logs.filter((l) => l.event === 'sample_failed');
    assert.equal(failures.length, 1);
    assert.match(String(failures[0]?.error), /timed out/);
    assert.ok(store.get(POOL).length >= 6, 'the other reads were stored');
  });

  test('a failed read is logged at most every 30 s per pool and the rest of the ticks go on', async () => {
    const { sampler, store, logs } = setup((call) => (call <= 3 ? { delayMs: 1, fail: new TypeError('fetch failed') } : { delayMs: 1 }));
    await ticks(sampler, 8);
    await sampler.idle();
    assert.equal(logs.filter((l) => l.event === 'sample_failed').length, 1);
    assert.equal(logs[0]?.error, 'fetch failed');
    assert.ok(store.get(POOL).length >= 4);
  });

  test('two reads that come back with the same slot are stored once', async () => {
    const { sampler, store } = setup(() => ({ delayMs: 2, slot: 777n }));
    await ticks(sampler, 4);
    await sampler.idle();
    assert.equal(store.get(POOL).length, 1);
    assert.equal(sampler.duplicateSlots, 3);
    assert.equal(store.hasSlot(POOL, 777n), true);
    assert.equal(store.hasSlot(POOL, 778n), false);
  });

  test('observations that arrive out of order are all kept (their slots differ), in the order they arrived', async () => {
    // The first read is slow and carries the older slot: it arrives after the second one.
    const { sampler, store } = setup((call) => (call === 1 ? { delayMs: 3 * TICK, slot: 10n } : { delayMs: 2, slot: BigInt(10 + call) }), { timeoutMs: 20 * TICK });
    await ticks(sampler, 2);
    await sampler.idle();
    assert.deepEqual(store.get(POOL).map((o) => o.slot), [12n, 10n]);
    // windowMean sorts them by slot, so the order of arrival does not matter to the price.
    const mean = windowMean(store.get(POOL), 0, Number.MAX_SAFE_INTEGER);
    assert.equal(mean, null, 'two samples are below the minimum of 5');
  });

  test('every pool of the tick is read, each once; a pool listed twice counts once', async () => {
    const reads: string[] = [];
    const other = testAddress(9);
    const store = new ObservationStore();
    const sampler = new Sampler({
      refs: { get: async (pool) => ({ ...REF, pool }) },
      mainnet: { call: async (_what, fn) => fn(undefined as never) },
      store,
      logger: () => undefined,
      observe: async (_rpc, ref) => {
        reads.push(ref.pool);
        return { atMs: Date.now(), slot: BigInt(reads.length), baseAmount: 1n, quoteAmount: 1n, price: 5n };
      },
    });
    sampler.tick([POOL, other, POOL]);
    await sampler.idle();
    assert.deepEqual(reads.sort(), [POOL, other].sort());
    assert.deepEqual(store.pools().sort(), [POOL, other].sort());
  });
});
