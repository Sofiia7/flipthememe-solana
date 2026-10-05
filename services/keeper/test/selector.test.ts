import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PoolCandidate } from '@flipthememe/client';
import type { Address } from '@solana/kit';
import type { DiscoveryResult } from '../src/discovery.ts';
import type { LogFields } from '../src/log.ts';
import { DEFAULT_GATE, type Rung } from '../src/poolgate.ts';
import { MAX_DEPTH_CHECKS, PoolSelector, type PoolChain, type Selection } from '../src/selector.ts';
import { HOUR, MINUTE, NOW, SOL, candidate, testAddress } from './pool-fixtures.ts';

const MIN_BANK = 20_000_000n; // 0.02 SOL, so the depth gate (2500 x min_bank) is 50 SOL
const DEEP = 80n * SOL;
const SHALLOW = 49n * SOL;

type Harness = {
  selector: PoolSelector;
  source: { result: DiscoveryResult; asked: (Address | null)[] };
  reserves: Map<Address, bigint>;
  reads: Address[];
  logs: LogFields[];
  changes: (Selection | null)[];
};

/** Every candidate is 80 SOL deep unless `reserves` says otherwise; unknown pools throw on read. */
function harness(
  candidates: PoolCandidate[],
  opts: { initial?: Selection | null; override?: Address | null; reserves?: [number, bigint][]; complete?: boolean } = {},
): Harness {
  const logs: LogFields[] = [];
  const changes: (Selection | null)[] = [];
  const reads: Address[] = [];
  const reserves = new Map<Address, bigint>();
  for (const c of candidates) reserves.set(c.pool, DEEP);
  if (opts.initial) reserves.set(opts.initial.pool, DEEP);
  for (const [i, r] of opts.reserves ?? []) reserves.set(testAddress(i), r);
  const source = {
    result: { candidates, complete: opts.complete ?? true },
    asked: [] as (Address | null)[],
    async refresh(_nowMs: number, current: Address | null): Promise<DiscoveryResult> {
      source.asked.push(current);
      return source.result;
    },
  };
  const chain: PoolChain = {
    async quoteReserve(pool) {
      reads.push(pool);
      const r = reserves.get(pool);
      if (r === undefined) throw new Error(`account ${pool} is not a wSOL PumpSwap pool`);
      return r;
    },
    async baseMint() {
      return testAddress(4000);
    },
  };
  const selector = new PoolSelector({
    source,
    chain,
    gate: DEFAULT_GATE,
    logger: (f) => logs.push(f),
    override: opts.override ?? null,
    minBank: () => MIN_BANK,
    initial: opts.initial ?? null,
    onChange: (s) => changes.push(s),
  });
  return { selector, source, reserves, reads, logs, changes };
}

function selection(i: number, rung: Rung, selectedAtMs: number): Selection {
  return { pool: testAddress(i), baseMint: testAddress(1000 + i), name: `T${i} / SOL`, selectedAtMs, rung, fallback: rung > 0, quoteReserve: DEEP, reserveAtMs: 0 };
}

const last = (h: Harness): LogFields | undefined => h.logs[h.logs.length - 1];

describe('PoolSelector: first choice', () => {
  test('the best fresh pool that is deep enough, logged with its rung', async () => {
    const h = harness(
      [
        candidate(1, 60, 30 * MINUTE), // fresh, score 105
        candidate(2, 200, 50 * MINUTE), // fresh, score ~317, but too shallow
        candidate(3, 100, 20 * MINUTE), // fresh, score ~183
        candidate(4, 900, 30 * HOUR), // any-age
        candidate(5, 999, 5 * MINUTE), // too young
      ],
      { reserves: [[2, SHALLOW]] },
    );
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(3));
    assert.equal(h.selector.current?.rung, 0);
    assert.equal(h.selector.current?.fallback, false);
    assert.equal(h.selector.current?.selectedAtMs, NOW);
    assert.equal(h.selector.current?.quoteReserve, DEEP);
    assert.deepEqual(h.reads, [testAddress(2), testAddress(3)]);
    assert.deepEqual(h.changes.map((s) => s?.pool), [testAddress(3)]);
    assert.deepEqual(
      { ...last(h), baseMint: undefined },
      { event: 'pool_selected', rung: 'fresh', reason: 'no pool yet', pool: testAddress(3), name: 'T3 / SOL', txM5: 100, ageMin: 20, score: 183.3, quoteReserve: DEEP, baseMint: undefined, previous: null },
    );
  });

  test('fallback ladder when nothing fresh qualifies: within 6 h, within 24 h, then the most active of any age', async () => {
    const within6h = candidate(1, 80, 3 * HOUR);
    const within24h = candidate(2, 300, 10 * HOUR);
    const anyAge = candidate(3, 900, 3 * 24 * HOUR);
    const quietYoung = candidate(4, 30, 30 * MINUTE); // too quiet for fresh: any-age rung, score 52.5
    const pick = async (list: PoolCandidate[], reserves: [number, bigint][] = []) => {
      const h = harness(list, { reserves });
      await h.selector.refresh(NOW);
      return { pool: h.selector.current?.pool, rung: last(h)?.rung, event: last(h)?.event, fallback: h.selector.current?.fallback };
    };
    assert.deepEqual(await pick([anyAge, within24h, within6h, quietYoung]), { pool: within6h.pool, rung: 'within-6h', event: 'pool_selected_fallback', fallback: true });
    assert.deepEqual(await pick([anyAge, within24h, quietYoung]), { pool: within24h.pool, rung: 'within-24h', event: 'pool_selected_fallback', fallback: true });
    assert.deepEqual(await pick([anyAge, quietYoung]), { pool: anyAge.pool, rung: 'any-age', event: 'pool_selected_fallback', fallback: true });
    assert.deepEqual(await pick([anyAge, quietYoung], [[3, SHALLOW]]), { pool: quietYoung.pool, rung: 'any-age', event: 'pool_selected_fallback', fallback: true });
  });

  test('nothing qualifies: no pool, and the reason is logged', async () => {
    const h = harness([candidate(1, 100, 30 * MINUTE)], { reserves: [[1, SHALLOW]] });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current, null);
    assert.deepEqual(last(h), { event: 'pool_none_qualifies', reason: 'no pool yet', candidates: 1, depthChecks: 1, complete: true, keeping: null });
  });

  test('depth checks are capped per refresh', async () => {
    const list = Array.from({ length: MAX_DEPTH_CHECKS + 3 }, (_, i) => candidate(i + 1, 100 + i, 30 * MINUTE));
    const h = harness(list, { reserves: list.map((_, i) => [i + 1, SHALLOW] as [number, bigint]) });
    await h.selector.refresh(NOW);
    assert.equal(h.reads.length, MAX_DEPTH_CHECKS);
    assert.equal(last(h)?.event, 'pool_none_qualifies');
  });
});

describe('PoolSelector: rotation', () => {
  test('holds the current pool 10 minutes even against a far better candidate', async () => {
    const h = harness([candidate(1, 60, 40 * MINUTE), candidate(2, 600, 20 * MINUTE)], { initial: selection(1, 0, NOW - 9 * MINUTE) });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(1));
    assert.deepEqual(h.reads, [testAddress(1)], 'inside the hold only the current depth is read');
    assert.deepEqual(h.source.asked, [testAddress(1)]);
    assert.equal(h.changes.length, 0);

    await h.selector.refresh(NOW + MINUTE);
    assert.equal(h.selector.current?.pool, testAddress(2));
    assert.equal(h.selector.current?.selectedAtMs, NOW + MINUTE);
    assert.equal(last(h)?.event, 'pool_selected');
    assert.equal(last(h)?.previous, testAddress(1));
    assert.match(String(last(h)?.reason), /^better than fresh score /);
  });

  test('after the hold the same rung needs 1.5x the score', async () => {
    const current = selection(1, 0, NOW - 30 * MINUTE);
    const mine = candidate(1, 100, 60 * MINUTE); // score 150
    const slightly = harness([mine, candidate(2, 140, 60 * MINUTE)], { initial: current }); // 210 = 1.4x
    await slightly.selector.refresh(NOW);
    assert.equal(slightly.selector.current?.pool, testAddress(1));
    assert.equal(slightly.changes.length, 0);
    assert.deepEqual(slightly.reads, [testAddress(1)], 'a candidate that cannot win is not even read');

    const clearly = harness([mine, candidate(2, 150, 60 * MINUTE)], { initial: current }); // 225 = 1.5x
    await clearly.selector.refresh(NOW);
    assert.equal(clearly.selector.current?.pool, testAddress(2));
  });

  test('a better candidate that is too shallow does not unseat the current pool', async () => {
    const h = harness([candidate(1, 100, 60 * MINUTE), candidate(2, 900, 30 * MINUTE)], { initial: selection(1, 0, NOW - 30 * MINUTE), reserves: [[2, SHALLOW]] });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(1));
    assert.deepEqual(h.reads, [testAddress(1), testAddress(2)]);
  });

  test('a fresh candidate replaces a fallback pool after the hold, whatever the scores', async () => {
    const list = [candidate(1, 500, 4 * HOUR), candidate(2, 55, 30 * MINUTE)];
    const held = harness(list, { initial: selection(1, 1, NOW - 5 * MINUTE) });
    await held.selector.refresh(NOW);
    assert.equal(held.selector.current?.pool, testAddress(1));

    const h = harness(list, { initial: selection(1, 1, NOW - 11 * MINUTE) });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(2));
    assert.equal(h.selector.current?.rung, 0);
    assert.equal(h.selector.current?.fallback, false);
    assert.match(String(last(h)?.reason), /^better than within-6h score 500$/);
  });

  test('keep gate: below 20 trades the current pool gives way to the best candidate', async () => {
    const h = harness([candidate(1, 19, 90 * MINUTE), candidate(2, 60, 100 * MINUTE)], { initial: selection(1, 0, NOW - 30 * MINUTE) });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(2));
    assert.equal(last(h)?.reason, 'txM5 19 < 20');
  });

  test('keep gate: older than 180 minutes it gives way even to a lower score on the fresh rung', async () => {
    const h = harness([candidate(1, 300, 181 * MINUTE), candidate(3, 51, 115 * MINUTE)], { initial: selection(1, 0, NOW - 60 * MINUTE) });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(3));
    assert.equal(last(h)?.reason, 'age 181 min > 180 min');
  });

  test('keep gate failed and nothing better: the pool stays, relabelled to the rung it now qualifies for', async () => {
    const h = harness([candidate(1, 300, 181 * MINUTE)], { initial: selection(1, 0, NOW - 60 * MINUTE) });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(1));
    assert.equal(h.selector.current?.rung, 1);
    assert.equal(h.selector.current?.fallback, true);
    assert.equal(h.selector.current?.selectedAtMs, NOW - 60 * MINUTE, 'relabelling does not restart the hold');
    assert.equal(last(h)?.event, 'pool_kept_on_rung');
    assert.equal(last(h)?.rung, 'within-6h');
    assert.equal(h.changes.length, 1);
  });

  test('a pool that loses its depth or cannot be read is replaced at once, even inside the hold', async () => {
    const shallow = harness([candidate(1, 100, 30 * MINUTE), candidate(2, 60, 40 * MINUTE)], { initial: selection(1, 0, NOW - MINUTE), reserves: [[1, SHALLOW]] });
    await shallow.selector.refresh(NOW);
    assert.equal(shallow.selector.current?.pool, testAddress(2));
    assert.equal(last(shallow)?.reason, 'quote reserve below 50000000000 lamports or unreadable');

    const unreadable = harness([candidate(2, 60, 40 * MINUTE)], { initial: selection(1, 0, NOW - MINUTE) });
    unreadable.reserves.delete(testAddress(1));
    await unreadable.selector.refresh(NOW);
    assert.equal(unreadable.selector.current?.pool, testAddress(2));
    assert.deepEqual(unreadable.logs[0], { event: 'pool_check_failed', pool: testAddress(1), error: `account ${testAddress(1)} is not a wSOL PumpSwap pool` });
  });

  test('no candidates at all: the current pool, still deep enough, stays and the reason is logged', async () => {
    const h = harness([], { initial: selection(1, 0, NOW - 30 * MINUTE) });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(1));
    assert.deepEqual(last(h), { event: 'pool_none_qualifies', reason: 'unlisted', candidates: 0, depthChecks: 0, complete: true, keeping: testAddress(1) });
  });

  test('the reserve falls and the candidates are gone: the pool is dropped, no pool until one qualifies', async () => {
    const h = harness([candidate(1, 100, 30 * MINUTE)]);
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(1));
    // Audit A12: 80 SOL fell to 1 SOL, max_bank 1 SOL / 2500 = 0.0004 SOL against min_bank 0.02 SOL.
    h.reserves.set(testAddress(1), SOL);
    h.source.result = { candidates: [], complete: true };

    await h.selector.refresh(NOW + MINUTE);
    assert.equal(h.selector.current, null, 'no pool, so the scheduler opens no round');
    assert.deepEqual(h.changes.map((s) => s?.pool ?? null), [testAddress(1), null], 'the state file drops it too');
    assert.deepEqual(last(h), { event: 'pool_dropped', pool: testAddress(1), name: 'T1 / SOL', reason: 'quote reserve below 50000000000 lamports or unreadable', candidates: 0, depthChecks: 0, complete: true });

    await h.selector.refresh(NOW + 2 * MINUTE);
    assert.equal(h.selector.current, null);
    assert.deepEqual(last(h), { event: 'pool_none_qualifies', reason: 'no pool yet', candidates: 0, depthChecks: 0, complete: true, keeping: null });

    h.reserves.set(testAddress(2), DEEP);
    h.source.result = { candidates: [candidate(2, 60, 20 * MINUTE)], complete: true };
    await h.selector.refresh(NOW + 3 * MINUTE);
    assert.deepEqual(h.changes.map((s) => s?.pool ?? null), [testAddress(1), null, testAddress(2)], 'a pool that qualifies is picked again');
    assert.equal(last(h)?.event, 'pool_selected');
    assert.equal(last(h)?.previous, null);
  });

  test('a shallow pool is dropped also while it is still listed and the other candidates are too shallow', async () => {
    const h = harness([candidate(1, 100, 30 * MINUTE), candidate(2, 300, 40 * MINUTE)], { initial: selection(1, 0, NOW - 30 * MINUTE), reserves: [[1, SOL], [2, SHALLOW]] });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current, null);
    assert.deepEqual(h.reads, [testAddress(1), testAddress(2)], 'the current pool is read once');
    assert.equal(last(h)?.event, 'pool_dropped');
    assert.equal(last(h)?.depthChecks, 1);
  });

  test('a failed reserve read with no candidates keeps the pool: only a reserve read below the gate drops it', async () => {
    // Public mainnet RPCs and GeckoTerminal often answer 429 together; the scheduler still checks the
    // depth on a fresh sample before every round.
    const keptAfterFailedRead = async (complete: boolean) => {
      const h = harness([], { initial: selection(1, 0, NOW - 30 * MINUTE), complete });
      h.reserves.delete(testAddress(1)); // its reserve read throws
      await h.selector.refresh(NOW);
      assert.equal(h.selector.current?.pool, testAddress(1));
      assert.deepEqual(h.changes, [], 'onChange is not called, so never with null');
      assert.deepEqual(h.logs.map((l) => l.event), ['pool_check_failed', 'pool_none_qualifies']);
      assert.deepEqual(last(h), { event: 'pool_none_qualifies', reason: 'quote reserve below 50000000000 lamports or unreadable', candidates: 0, depthChecks: 0, complete, keeping: testAddress(1) });
    };
    await keptAfterFailedRead(true);
    await keptAfterFailedRead(false); // GeckoTerminal failed as well
  });
});

describe('PoolSelector: failed discovery', () => {
  test('no rotation on stale numbers, but a shallow pool is still replaced from the last good list', async () => {
    const list = [candidate(1, 10, 90 * MINUTE), candidate(2, 400, 30 * MINUTE)];
    const stale = harness(list, { initial: selection(1, 0, NOW - 30 * MINUTE), complete: false });
    await stale.selector.refresh(NOW);
    assert.equal(stale.selector.current?.pool, testAddress(1), 'keep gate fails, but the numbers are not from this refresh');
    assert.equal(stale.changes.length, 0);

    const shallow = harness(list, { initial: selection(1, 0, NOW - 30 * MINUTE), complete: false, reserves: [[1, SHALLOW]] });
    await shallow.selector.refresh(NOW);
    assert.equal(shallow.selector.current?.pool, testAddress(2));
  });
});

describe('PoolSelector: POOL_OVERRIDE', () => {
  test('one fixed pool, no discovery, reserve refreshed in place', async () => {
    const pool = testAddress(9);
    const h = harness([], { override: pool, reserves: [[9, SHALLOW]] });
    await h.selector.refresh(NOW);
    await h.selector.refresh(NOW + MINUTE);
    assert.deepEqual(h.source.asked, []);
    assert.equal(h.selector.current?.pool, pool);
    assert.equal(h.selector.current?.name, 'POOL_OVERRIDE');
    assert.equal(h.selector.current?.rung, 0);
    assert.equal(h.selector.current?.selectedAtMs, NOW);
    assert.equal(h.changes.length, 1);
    assert.deepEqual(h.logs, [{ event: 'pool_selected_override', pool, baseMint: testAddress(4000), quoteReserve: SHALLOW, belowDepthGate: true }]);
  });
});
