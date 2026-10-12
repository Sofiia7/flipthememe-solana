import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PoolCandidate } from '@flipthememe/client';
import type { Address } from '@solana/kit';
import type { DiscoveryResult } from '../src/discovery.ts';
import type { LogFields } from '../src/log.ts';
import { DEFAULT_GATE, type Rung, type PoolGate } from '../src/poolgate.ts';
import { MAX_DEPTH_CHECKS, PoolSelector, type PoolChain, type Selection } from '../src/selector.ts';
import type { TokenVerdict } from '../src/tokencheck.ts';
import { HOUR, MINUTE, NOW, SOL, candidate, testAddress, withFlow } from './pool-fixtures.ts';

const MIN_BANK = 20_000_000n; // 0.02 SOL, so the depth gate (4 x 2500 x min_bank) is 200 SOL
const DEEP = 320n * SOL;
const SHALLOW = 199n * SOL;

type Harness = {
  selector: PoolSelector;
  source: { result: DiscoveryResult; asked: (Address | null)[] };
  reserves: Map<Address, bigint>;
  reads: Address[];
  logs: LogFields[];
  changes: (Selection | null)[];
  /** Pools the token check was asked about, in order. */
  tokenReads: Address[];
};

/** Every candidate is 320 SOL deep unless `reserves` says otherwise; unknown pools throw on read. */
function harness(
  candidates: PoolCandidate[],
  opts: {
    initial?: Selection | null;
    override?: Address | null;
    reserves?: [number, bigint][];
    complete?: boolean;
    gate?: PoolGate;
    reservePrice?: (pool: Address, nowMs: number) => bigint | null;
    marketSample?: (pool: Address, nowMs: number) => import('../src/market-reserve.ts').MarketSample;
    marketBias?: (pool: Address, nowMs: number) => string | null;
    marketWarming?: (pool: Address, nowMs: number) => boolean;
    /** The token check by pool number: a verdict, or an Error that is thrown (the RPC failed). Pools not listed pass. Absent: no token check at all. */
    tokens?: [number, TokenVerdict | Error][];
  } = {},
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
  const tokenReads: Address[] = [];
  const verdicts = new Map<Address, TokenVerdict | Error>((opts.tokens ?? []).map(([i, v]) => [testAddress(i), v]));
  const chain: PoolChain = {
    ...(opts.tokens
      ? {
          async tokenCheck(pool: Address): Promise<TokenVerdict> {
            tokenReads.push(pool);
            const verdict = verdicts.get(pool) ?? { ok: true, supply: 1_000_000_000_000_000n };
            if (verdict instanceof Error) throw verdict;
            return verdict;
          },
        }
      : {}),
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
    gate: opts.gate ?? DEFAULT_GATE,
    reservePrice: opts.reservePrice ?? (() => DEEP),
    marketSample: opts.marketSample,
    marketBias: opts.marketBias,
    marketWarming: opts.marketWarming,
    logger: (f) => logs.push(f),
    override: opts.override ?? null,
    minBank: () => MIN_BANK,
    initial: opts.initial ?? null,
    onChange: (s) => changes.push(s),
  });
  return { selector, source, reserves, reads, logs, changes, tokenReads };
}

function selection(i: number, rung: Rung, selectedAtMs: number): Selection {
  return { pool: testAddress(i), baseMint: testAddress(1000 + i), name: `T${i} / SOL`, selectedAtMs, rung, fallback: rung > 0, quoteReserve: DEEP, reserveAtMs: 0 };
}

const last = (h: Harness): LogFields | undefined => h.logs[h.logs.length - 1];

describe('neutral selector rejects momentum before the hold and during incomplete discovery', () => {
  const gate = { ...DEFAULT_GATE, neutral: true, maxImbalance: 0.3, youthWeight: 0 };
  test('a healthy market finishes its warmup before a busier pool can replace it; bad flow still drops it', async () => {
    const list = [withFlow(candidate(1, 0, 30 * MINUTE), 40, 40), withFlow(candidate(2, 0, 48 * HOUR), 100, 100)];
    const h = harness(list, { gate, initial: selection(1, 0, NOW - HOUR), marketWarming: () => true });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(1));
    h.source.result.candidates = [withFlow(candidate(1, 0, 30 * MINUTE), 90, 10), list[1]!];
    await h.selector.refresh(NOW + MINUTE);
    assert.equal(h.selector.current?.pool, testAddress(2));
  });
  test('a one-sided current pool is replaced by a balanced mature pool immediately', async () => {
    const h = harness([withFlow(candidate(1, 0, 30 * MINUTE), 90, 10), withFlow(candidate(2, 0, 48 * HOUR), 50, 50)], { gate, initial: selection(1, 0, NOW - MINUTE), complete: false });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(2));
    assert.match(String(last(h)?.reason), /flow imbalance/);
  });
  test('no suitable pool drops the old one; it never falls back to the same rejected pool', async () => {
    const h = harness([withFlow(candidate(1, 0, 30 * MINUTE), 90, 10)], { gate, initial: selection(1, 0, NOW - MINUTE) });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current, null);
    assert.equal(last(h)?.event, 'pool_dropped');
  });
  test('observed price momentum veto applies to the current pool and new candidates', async () => {
    const list = [withFlow(candidate(1, 0, 30 * MINUTE), 90, 90), withFlow(candidate(2, 0, 48 * HOUR), 50, 50)];
    const h = harness(list, { gate, initial: selection(1, 0, NOW - MINUTE), marketBias: (pool) => pool === testAddress(1) ? 'observed momentum' : null });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(2));
    assert.equal(last(h)?.reason, 'observed momentum');
    const first = harness(list, { gate, marketBias: (pool) => pool === testAddress(1) ? 'observed momentum' : null });
    await first.selector.refresh(NOW);
    assert.equal(first.selector.current?.pool, testAddress(2));
  });
});

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
    assert.equal(last(shallow)?.reason, 'quote reserve below 200000000000 lamports or unreadable');

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
    assert.deepEqual(last(h), { event: 'pool_dropped', pool: testAddress(1), name: 'T1 / SOL', reason: 'quote reserve below 200000000000 lamports or unreadable', candidates: 0, depthChecks: 0, complete: true });

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
      assert.deepEqual(last(h), { event: 'pool_none_qualifies', reason: 'quote reserve below 200000000000 lamports or unreadable', candidates: 0, depthChecks: 0, complete, keeping: testAddress(1) });
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

const REFUSED = (reason: string): TokenVerdict => ({ ok: false, reason });

describe('PoolSelector: token check (authorities, Token-2022 extensions, holders)', () => {
  test('a refused token is skipped for the next candidate, and the refusal is logged once', async () => {
    const h = harness([candidate(1, 200, 30 * MINUTE), candidate(2, 120, 30 * MINUTE)], { tokens: [[1, REFUSED('freeze authority is not revoked')]] });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(2));
    assert.deepEqual(h.tokenReads, [testAddress(1), testAddress(2)]);
    const refused = h.logs.filter((l) => l.event === 'pool_rejected_unsafe');
    assert.deepEqual(refused, [{ event: 'pool_rejected_unsafe', pool: testAddress(1), reason: 'freeze authority is not revoked', current: false }]);
    // The next minute: asked again (the checker's own cache answers), logged again only after the cache's 30 minutes.
    h.source.result = { candidates: [candidate(1, 200, 31 * MINUTE), candidate(2, 120, 31 * MINUTE)], complete: true };
    await h.selector.refresh(NOW + MINUTE);
    assert.equal(h.logs.filter((l) => l.event === 'pool_rejected_unsafe').length, 1);
  });

  test('the depth check comes first: a shallow pool costs no token read', async () => {
    const h = harness([candidate(1, 200, 30 * MINUTE), candidate(2, 120, 30 * MINUTE)], { reserves: [[1, SHALLOW]], tokens: [] });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(2));
    assert.deepEqual(h.tokenReads, [testAddress(2)]);
  });

  test('fail closed: a candidate whose check cannot be read is skipped in this refresh, and no pool is made of it', async () => {
    const boom = new TypeError('fetch failed');
    const h = harness([candidate(1, 200, 30 * MINUTE)], { tokens: [[1, boom]] });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current, null);
    assert.equal(last(h)?.event, 'pool_none_qualifies');
    assert.deepEqual(h.logs.find((l) => l.event === 'token_check_failed'), { event: 'token_check_failed', pool: testAddress(1), error: 'fetch failed', current: false, action: 'skipped' });
  });

  test('a candidate that could not be checked is skipped for another one that can', async () => {
    const h = harness([candidate(1, 200, 30 * MINUTE), candidate(2, 120, 30 * MINUTE)], { tokens: [[1, new TypeError('HTTP 429')]] });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(2));
  });

  test('the current pool stays when its check cannot be read (an RPC failure changes nothing), and the failure is logged', async () => {
    const h = harness([candidate(1, 100, 60 * MINUTE), candidate(2, 60, 30 * MINUTE)], {
      initial: selection(1, 0, NOW - 30 * MINUTE),
      tokens: [[1, new TypeError('fetch failed')]],
    });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(1));
    assert.deepEqual(h.changes, []);
    assert.deepEqual(h.logs.find((l) => l.event === 'token_check_failed'), { event: 'token_check_failed', pool: testAddress(1), error: 'fetch failed', current: true, action: 'kept' });
    // The failure line is throttled: another refresh a minute later says nothing new.
    await h.selector.refresh(NOW + MINUTE);
    assert.equal(h.logs.filter((l) => l.event === 'token_check_failed').length, 1);
  });

  test('a current pool that fails the check is replaced at once, even inside its hold; with no replacement it is dropped', async () => {
    const replaced = harness([candidate(2, 60, 40 * MINUTE)], { initial: selection(1, 0, NOW - MINUTE), tokens: [[1, REFUSED('mint authority is not revoked')]] });
    await replaced.selector.refresh(NOW);
    assert.equal(replaced.selector.current?.pool, testAddress(2));
    assert.equal(last(replaced)?.reason, 'unsafe token: mint authority is not revoked');

    const dropped = harness([], { initial: selection(1, 0, NOW - 30 * MINUTE), tokens: [[1, REFUSED('top holder X has 31.5% of the supply (limit 20%)')]] });
    await dropped.selector.refresh(NOW);
    assert.equal(dropped.selector.current, null);
    assert.deepEqual(dropped.changes, [null]);
    assert.equal(last(dropped)?.event, 'pool_dropped');
    assert.equal(last(dropped)?.reason, 'unsafe token: top holder X has 31.5% of the supply (limit 20%)');
  });

  test('POOL_OVERRIDE is an operator decision: no token check', async () => {
    const h = harness([], { override: testAddress(9), reserves: [[9, DEEP]], tokens: [[9, REFUSED('mint authority is not revoked')]] });
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(9));
    assert.deepEqual(h.tokenReads, []);
  });

  test('without a token checker (TOKEN_CHECK=off) nothing is asked', async () => {
    const h = harness([candidate(1, 200, 30 * MINUTE)]);
    await h.selector.refresh(NOW);
    assert.equal(h.selector.current?.pool, testAddress(1));
    assert.deepEqual(h.tokenReads, []);
  });

  test('a selected pool logs the split of its trades when GeckoTerminal gave it', async () => {
    const balanced = { ...candidate(1, 100, 30 * MINUTE), buys: 52, sells: 48 };
    const h = harness([balanced]);
    await h.selector.refresh(NOW);
    assert.equal(last(h)?.event, 'pool_selected');
    assert.deepEqual([last(h)?.buys, last(h)?.sells, last(h)?.oneSided], [52, 48, false]);
  });
});


test('a prepared neutral pool replaces a warming pool even during the hold; a ready pool never rotates to a warming one', async () => {
  const gate = { ...DEFAULT_GATE, neutral: true, maxImbalance: 0.3, youthWeight: 0 };
  const list = [withFlow(candidate(1, 0, 30 * MINUTE), 100, 100), withFlow(candidate(2, 0, 48 * HOUR), 50, 50)];
  const h = harness(list, { gate, initial: selection(1, 0, NOW - MINUTE), marketWarming: p => p === testAddress(1) });
  await h.selector.refresh(NOW);
  assert.equal(h.selector.current?.pool, testAddress(2));
  assert.equal(h.selector.watching.length, 2);
  assert.equal(last(h)?.reason, 'prepared market available');
  await h.selector.refresh(NOW + HOUR);
  assert.equal(h.selector.current?.pool, testAddress(2));
});


const balancedGate = { ...DEFAULT_GATE, balanced: true, neutral: false, youthWeight: 0, maxImbalance: 0.3 };
const calm = (i: number) => ({ ...withFlow(candidate(i, 0, 48 * HOUR), 60, 60), priceChangeM5: 0.2 });
const sample = (up: number, down: number) => ({ priced: up + down, up, down, dominantShare: up + down ? Math.max(up, down) / (up + down) : null });
test('continuous reserve switches a biased current market to a prepared balanced pool during the hold', async () => {
  const h = harness([calm(1), calm(2)], { gate: balancedGate, initial: selection(1, 3, NOW - MINUTE), marketSample: p => p === testAddress(1) ? sample(16,4) : sample(5,5) });
  await h.selector.refresh(NOW);
  assert.equal(h.selector.current?.pool, testAddress(2));
  assert.equal(h.changes.some(p => p === null), false);
  assert.equal(h.selector.reserveStatus.find(p => p.pool === testAddress(2))?.prepared, true);
});
test('continuous reserve keeps serving when every candidate is biased or warming', async () => {
  for (const stats of [sample(10,0), sample(0,0), sample(0,10)]) {
    const h = harness([calm(1), calm(2)], { gate: balancedGate, initial: selection(1,3,NOW - MINUTE), marketSample: () => stats });
    await h.selector.refresh(NOW);
    assert.ok(h.selector.current);
    assert.equal(h.changes.some(p => p === null), false);
    assert.equal(h.selector.watching.length, 2);
  }
});
test('continuous reserve retains candidates while they warm and switches to lower observed risk symmetrically', async () => {
  const h = harness([calm(1),calm(2)], { gate: balancedGate, initial: selection(1,3,NOW - MINUTE), marketSample: p => p === testAddress(1) ? sample(2,18) : sample(5,5) });
  await h.selector.refresh(NOW);
  assert.equal(h.selector.current?.pool,testAddress(2));
  assert.equal(h.selector.watching.some(p => p.pool===testAddress(1)),true);
});
test('unsafe and shallow candidates never enter the continuous reserve even when perfectly balanced', async () => {
  const h = harness([calm(1),calm(2),calm(3)], { gate: balancedGate, initial: selection(1,3,NOW - MINUTE), marketSample: () => sample(5,5), reserves: [[2,SHALLOW]], tokens: [[3,{ok:false,reason:'freeze authority'}]] });
  await h.selector.refresh(NOW);
  assert.deepEqual(h.selector.watching.map(p => p.pool),[testAddress(1)]);
  assert.equal(h.selector.current?.pool,testAddress(1));
});
test('a current pool that truly fails depth is replaced directly from the qualified reserve', async () => {
  const h=harness([calm(1),calm(2)],{gate:balancedGate,initial:selection(1,3,NOW-MINUTE),marketSample:()=>sample(5,5),reserves:[[1,SHALLOW]]});
  await h.selector.refresh(NOW);
  assert.equal(h.selector.current?.pool,testAddress(2));
  assert.equal(h.changes.some(p=>p===null),false);
});


test('temporary discovery outage does not erase qualified reserve pools or stop the current market',async()=>{
  const h=harness([calm(1),calm(2)],{gate:balancedGate,initial:selection(1,3,NOW-MINUTE),marketSample:()=>sample(5,5)});
  await h.selector.refresh(NOW);
  h.source.result={candidates:[],complete:false};
  await h.selector.refresh(NOW+MINUTE);
  assert.ok(h.selector.current);
  assert.equal(h.selector.watching.length,2);
  assert.equal(h.changes.some(p=>p===null),false);
});


test('handover keeps the active market until a reserve has a fresh sufficiently deep price feed',async()=>{
  let live: bigint | null=null;
  const h=harness([calm(1),calm(2)],{gate:balancedGate,initial:selection(1,3,NOW-MINUTE),marketSample:p=>p===testAddress(1)?sample(16,4):sample(5,5),reservePrice:()=>live});
  await h.selector.refresh(NOW);
  assert.equal(h.selector.current?.pool,testAddress(1));
  live=SHALLOW;h.selector.activateReserve(NOW+1000);
  assert.equal(h.selector.current?.pool,testAddress(1));
  live=DEEP;h.selector.activateReserve(NOW+2000);
  assert.equal(h.selector.current?.pool,testAddress(2));
  assert.equal(h.changes.some(p=>p===null),false);
});
test('expired handover cannot switch using a no longer validated reserve',async()=>{
  let live: bigint | null=null;
  const h=harness([calm(1),calm(2)],{gate:balancedGate,initial:selection(1,3,NOW-MINUTE),marketSample:p=>p===testAddress(1)?sample(16,4):sample(5,5),reservePrice:()=>live});
  await h.selector.refresh(NOW);
  live=DEEP;h.selector.activateReserve(NOW+91_000);
  assert.equal(h.selector.current?.pool,testAddress(1));
});


test('reserve diversifies base tokens rather than treating two pools of the same coin as independent markets',async()=>{
  const same={...calm(2),baseMint:calm(1).baseMint};
  const initial={...selection(1,3,NOW-MINUTE),baseMint:calm(1).baseMint};
  const h=harness([calm(1),same,calm(3)],{gate:balancedGate,initial,marketSample:p=>p===testAddress(1)?sample(16,4):sample(5,5)});
  await h.selector.refresh(NOW);
  assert.equal(h.selector.current?.pool,testAddress(3));
  assert.equal(h.selector.watching.some(p=>p.pool===testAddress(2)),false);
  assert.equal(new Set(h.selector.watching.map(p=>p.baseMint)).size,h.selector.watching.length);
});


test('an unreadable current pool with a stale feed hands over to a freshly priced safe reserve',async()=>{
  const h=harness([calm(1),calm(2)],{gate:balancedGate,initial:selection(1,3,NOW-MINUTE),marketSample:()=>sample(5,5),reservePrice:p=>p===testAddress(1)?null:DEEP});
  h.reserves.delete(testAddress(1));
  await h.selector.refresh(NOW);
  assert.equal(h.selector.current?.pool,testAddress(2));
  assert.equal(h.changes.some(p=>p===null),false);
});

test('measured balanced outcomes beat misleading low-drift flow proxies during the hold',async()=>{
  const reserve={...calm(2),buys:95,sells:5,priceChangeM5:4};
  const h=harness([calm(1),reserve],{gate:balancedGate,initial:selection(1,3,NOW-MINUTE),marketSample:p=>p===testAddress(1)?sample(11,4):sample(5,5)});
  await h.selector.refresh(NOW);
  assert.equal(h.selector.current?.pool,testAddress(2));
  assert.equal(h.changes.some(p=>p===null),false);
});
