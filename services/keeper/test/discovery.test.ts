import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { WSOL_MINT, type GeckoTerminalFetch, type PoolCandidate } from '@flipthememe/client';
import { address, type Address } from '@solana/kit';
import { HOT_SLOTS, MAX_CALLS_PER_REFRESH, MAX_SKIPPED_REFRESHES, PoolDiscovery, STATS_MAX_AGE_MS, TOP_REFRESH_MS, flowsOf } from '../src/discovery.ts';
import type { LogFields } from '../src/log.ts';
import { DEFAULT_GATE } from '../src/poolgate.ts';
import { HOUR, MINUTE, NOW, candidate, testAddress } from './pool-fixtures.ts';

/** Buys and sells of the last 5 minutes a pool's row reports (default: every trade a buy, sum = txM5). */
const flows = new Map<string, { buys: number; sells: number }>();

/** A GeckoTerminal pool row as the API sends it. */
function row(c: PoolCandidate, dex: string): Record<string, unknown> {
  return {
    id: `solana_${c.pool}`,
    type: 'pool',
    attributes: {
      address: c.pool,
      name: c.name,
      pool_created_at: new Date(c.createdAtMs).toISOString(),
      transactions: { m5: flows.get(c.pool) ?? { buys: c.txM5, sells: 0 } },
      reserve_in_usd: String(c.reserveUsd),
      volume_usd: { h1: String(c.volumeH1Usd) },
    },
    relationships: {
      base_token: { data: { id: `solana_${c.baseMint}`, type: 'token' } },
      quote_token: { data: { id: `solana_${WSOL_MINT}`, type: 'token' } },
      dex: { data: { id: dex, type: 'dex' } },
    },
  };
}

/** GeckoTerminal stand-in: `new_pools` from a list of launches, `pools/multi` from current numbers, a top list. */
class FakeGecko {
  readonly urls: string[] = [];
  launches: { c: PoolCandidate; dex: string }[] = [];
  top: PoolCandidate[] = [];
  trending: { c: PoolCandidate; dex: string }[] = [];
  readonly numbers = new Map<string, PoolCandidate>();
  clock = NOW;
  failWith: number | null = null;
  /** Requests whose URL matches answer HTTP 503. */
  failUrl: RegExp | null = null;
  newPoolsPage1: unknown = null;

  readonly fetchFn: GeckoTerminalFetch = async (url) => {
    this.urls.push(url);
    if (this.failWith !== null || this.failUrl?.test(url)) {
      const status = this.failWith ?? 503;
      return { ok: false, status, json: async () => ({ errors: [{ status: String(status), title: 'Too Many Requests' }] }) };
    }
    const u = new URL(url);
    const page = Number(u.searchParams.get('page') ?? '1');
    if (u.pathname.endsWith('/new_pools')) {
      if (this.newPoolsPage1 !== null) return { ok: true, status: 200, json: async () => (page === 1 ? structuredClone(this.newPoolsPage1) : { data: [] }) };
      const visible = this.launches.filter((l) => l.c.createdAtMs <= this.clock).sort((a, b) => b.c.createdAtMs - a.c.createdAtMs);
      return { ok: true, status: 200, json: async () => ({ data: visible.slice((page - 1) * 20, page * 20).map((l) => row(l.c, l.dex)) }) };
    }
    if (u.pathname.includes('/pools/multi/')) {
      const asked = (u.pathname.split('/pools/multi/')[1] ?? '').split(',');
      return { ok: true, status: 200, json: async () => ({ data: asked.flatMap((a) => (this.numbers.has(a) ? [row(this.numbers.get(a) as PoolCandidate, 'pumpswap')] : [])) }) };
    }
    if (u.pathname.endsWith('/trending_pools')) {
      return { ok: true, status: 200, json: async () => ({ data: this.trending.map((l) => row(l.c, l.dex)) }) };
    }
    if (u.pathname.endsWith('/dexes/pumpswap/pools')) {
      return { ok: true, status: 200, json: async () => ({ data: this.top.slice((page - 1) * 20, page * 20).map((c) => row(c, 'pumpswap')) }) };
    }
    throw new Error(`unexpected request ${url}`);
  };

  /** Short names of the requests since `from`: multi, top1, new2, ... */
  kinds(from = 0): string[] {
    return this.urls.slice(from).map((url) => {
      const u = new URL(url);
      if (u.pathname.includes('/pools/multi/')) return 'multi';
      return `${u.pathname.endsWith('/new_pools') ? 'new' : 'top'}${u.searchParams.get('page')}`;
    });
  }
}

function discovery(gecko: FakeGecko, logs: LogFields[] = []): PoolDiscovery {
  return new PoolDiscovery({ gate: DEFAULT_GATE, logger: (f) => logs.push(f), fetchFn: gecko.fetchFn });
}

describe('PoolDiscovery: requests per refresh', () => {
  test('cold start on the real new_pools page: only its PumpSwap pool quoted in wSOL is tracked', async () => {
    const page = JSON.parse(readFileSync(new URL('../../../packages/client/test/fixtures/geckoterminal-new-pools-page1.json', import.meta.url), 'utf8'));
    const gecko = new FakeGecko();
    gecko.newPoolsPage1 = page;
    const fetchedAt = Date.parse('2026-10-05T13:15:41Z');
    const d = discovery(gecko);
    const result = await d.refresh(fetchedAt, null);
    assert.equal(result.complete, true);
    assert.deepEqual(gecko.kinds(), ['top1', 'new1', 'new2'], 'page 2 came back short: the list ended');
    assert.equal(d.status(fetchedAt).tracked, 1);
    const john = address('G1jURgdSVJXnFSjj1s3cPXowj7ERsTGnz27mtXpSUnc3'); // "John / SOL", created 13:13:44
    assert.deepEqual(d.poolsToRefresh(fetchedAt, null), [], 'two minutes old: not a candidate yet');
    assert.deepEqual(d.poolsToRefresh(Date.parse('2026-10-05T13:23:44Z'), null), [john]);
    assert.deepEqual(d.poolsToRefresh(Date.parse('2026-10-05T15:13:45Z'), null), [], 'past 120 minutes it is no longer asked for');
  });

  test('new_pools pages until the previous newest pool is reached, never more than 4 requests', async () => {
    // A launch every 2 s (30 a minute, like 5 October), every tenth one on PumpSwap.
    const gecko = new FakeGecko();
    for (let k = 0; k <= 600; k++) {
      gecko.launches.push({ c: candidate(k, 100, (300 - k) * 2_000), dex: k % 10 === 0 ? 'pumpswap' : 'pump-fun' });
    }
    const d = discovery(gecko);
    const tracked = () => d.status(gecko.clock).tracked;

    gecko.clock = NOW; // cold start: launches up to k = 300
    assert.equal((await d.refresh(gecko.clock, null)).complete, true);
    assert.deepEqual(gecko.kinds(), ['top1', 'new1', 'new2', 'new3']);
    assert.equal(tracked(), 6); // k = 250 .. 300

    let from = gecko.urls.length;
    gecko.clock = NOW + MINUTE; // up to k = 330: page 2 reaches back to k = 300
    await d.refresh(gecko.clock, null);
    assert.deepEqual(gecko.kinds(from), ['top2', 'new1', 'new2']);
    assert.equal(tracked(), 9);

    from = gecko.urls.length;
    gecko.clock = NOW + 2 * MINUTE;
    await d.refresh(gecko.clock, null);
    assert.deepEqual(gecko.kinds(from), ['new1', 'new2']);
    assert.equal(tracked(), 12);

    from = gecko.urls.length;
    gecko.clock = NOW + 5 * MINUTE; // three minutes since the last read and the top list is due
    await d.refresh(gecko.clock, null);
    assert.deepEqual(gecko.kinds(from), ['top1', 'new1', 'new2', 'new3']);
    assert.equal(tracked(), 18, 'k = 361..390 fell into the gap; k = 400..450 are tracked');
    assert.ok(TOP_REFRESH_MS === 5 * MINUTE);
  });

  test('a failed new_pools page does not move the mark: the next refresh reads back that far again', async () => {
    // A launch every 6 s (k = 100 at NOW), every tenth one on PumpSwap: a page of 20 spans 2 minutes.
    // k = 103 (NOW + 18 s) sits in the stretch that only the failed page would have covered.
    const gecko = new FakeGecko();
    for (let k = 0; k <= 200; k++) {
      gecko.launches.push({ c: candidate(k, 100, (100 - k) * 6_000), dex: k % 10 === 3 ? 'pumpswap' : 'pump-fun' });
    }
    const d = discovery(gecko);
    gecko.clock = NOW;
    await d.refresh(gecko.clock, null);

    gecko.clock = NOW + 150_000; // page 1 does not reach back to NOW, page 2 fails
    gecko.failUrl = /new_pools\?page=2/;
    let from = gecko.urls.length;
    assert.equal((await d.refresh(gecko.clock, null)).complete, false);
    assert.deepEqual(gecko.kinds(from), ['top2', 'new1', 'new2']);
    gecko.failUrl = null;
    await d.refresh(NOW + 210_000, null); // skipped (back-off)

    gecko.clock = NOW + 270_000;
    from = gecko.urls.length;
    assert.equal((await d.refresh(gecko.clock, null)).complete, true);
    // k = 43 is now over 10 minutes old, hence pools/multi; page 3 reaches back to NOW, the mark of the last full read
    assert.deepEqual(gecko.kinds(from), ['multi', 'new1', 'new2', 'new3']);
    const missing = [73, 83, 93, 103, 113, 123, 133, 143].filter((k) => !d.poolsToRefresh(NOW + 20 * MINUTE, null).includes(testAddress(k)));
    assert.deepEqual(missing, [], 'every PumpSwap launch up to NOW + 270 s is tracked');
  });

  test('pools/multi first: the current pool and the tracked pools that are 10-120 minutes old', async () => {
    const gecko = new FakeGecko();
    const d = discovery(gecko);
    const young = candidate(1, 300, 2 * MINUTE, NOW + 8 * MINUTE); // 4 minutes old at the refresh
    const ripe = candidate(2, 200, 2 * MINUTE); // 12 minutes old at the refresh
    d.track(young, NOW + 8 * MINUTE);
    d.track(ripe, NOW);
    const current = testAddress(77);
    gecko.numbers.set(current, candidate(77, 60, 50 * MINUTE, NOW + 10 * MINUTE));
    gecko.numbers.set(ripe.pool, { ...ripe, txM5: 90 });
    const result = await d.refresh(NOW + 10 * MINUTE, current);
    assert.deepEqual(gecko.kinds(), ['multi', 'top1', 'new1']);
    assert.ok(gecko.urls[0]?.endsWith(`/pools/multi/${current},${ripe.pool}`), gecko.urls[0]);
    assert.deepEqual(
      result.candidates.map((c) => `${c.name} ${c.txM5}`),
      ['T77 / SOL 60', 'T2 / SOL 90'],
    );
  });

  test('at most 30 pools per pools/multi: the best scores first, then the least recently refreshed', () => {
    const d = discovery(new FakeGecko());
    for (let i = 0; i < 40; i++) d.track(candidate(i, 100 + 5 * i, (11 + i) * MINUTE), NOW); // later i = higher score
    d.track(candidate(90, 999, 5 * MINUTE), NOW); // too young
    d.track(candidate(91, 999, 121 * MINUTE), NOW); // past the entry window
    const current = testAddress(500);
    const ask = d.poolsToRefresh(NOW, current);
    assert.equal(ask.length, 30);
    assert.equal(ask[0], current);
    const hot = Array.from({ length: HOT_SLOTS }, (_, j) => testAddress(39 - j));
    assert.deepEqual(ask.slice(1, 1 + HOT_SLOTS), hot);
    // never refreshed yet: the youngest first
    assert.deepEqual(ask.slice(1 + HOT_SLOTS), Array.from({ length: 9 }, (_, j) => testAddress(j)));
  });
});

describe('PoolDiscovery: failures', () => {
  test('HTTP 429: exponential back-off in refreshes, last good numbers kept, reset on success', async () => {
    const gecko = new FakeGecko();
    const logs: LogFields[] = [];
    const d = discovery(gecko, logs);
    const current = testAddress(5);
    gecko.numbers.set(current, candidate(5, 80, 30 * MINUTE));
    const ok = await d.refresh(NOW, current);
    assert.equal(ok.complete, true);
    assert.deepEqual(ok.candidates.map((c) => c.pool), [current]);

    gecko.failWith = 429;
    let t = NOW;
    const step = async () => {
      t += MINUTE;
      const before = gecko.urls.length;
      const r = await d.refresh(t, current);
      return { requests: gecko.urls.length - before, complete: r.complete, candidates: r.candidates.length };
    };
    assert.deepEqual(await step(), { requests: 1, complete: false, candidates: 1 });
    assert.deepEqual(logs.at(-1), { event: 'pool_discovery_failed', request: 'pools/multi', error: 'HTTP 429', failures: 1, skipRefreshes: 1, keeping: current });
    assert.deepEqual(await step(), { requests: 0, complete: false, candidates: 1 });
    assert.deepEqual(await step(), { requests: 1, complete: false, candidates: 1 });
    assert.equal(logs.at(-1)?.skipRefreshes, 2);
    assert.deepEqual([await step(), await step()].map((s) => s.requests), [0, 0]);
    assert.equal((await step()).requests, 1);
    assert.equal(logs.at(-1)?.skipRefreshes, 4);
    for (let i = 0; i < 4; i++) assert.equal((await step()).requests, 0);
    await step();
    assert.equal(logs.at(-1)?.skipRefreshes, MAX_SKIPPED_REFRESHES);
    assert.equal(d.status(t).failures, 4);

    for (let i = 0; i < MAX_SKIPPED_REFRESHES; i++) await step();
    gecko.failWith = null;
    const back = await step();
    assert.equal(back.complete, true);
    assert.equal(d.status(t).failures, 0);
    assert.ok(back.requests >= 1 && back.requests <= MAX_CALLS_PER_REFRESH);
  });

  test('a failure later in the refresh keeps what the earlier requests brought', async () => {
    const gecko = new FakeGecko();
    const logs: LogFields[] = [];
    gecko.top = [candidate(8, 120, 3 * HOUR)];
    let n = 0;
    const flaky = new PoolDiscovery({
      gate: DEFAULT_GATE,
      logger: (f) => logs.push(f),
      // the second request (new_pools page 1) fails
      fetchFn: async (url, init) => (++n === 2 ? { ok: false, status: 503, json: async () => ({}) } : gecko.fetchFn(url, init)),
    });
    const r = await flaky.refresh(NOW, null);
    assert.equal(r.complete, false);
    assert.deepEqual(r.candidates.map((c) => c.name), ['T8 / SOL']);
    assert.deepEqual(logs.at(-1), { event: 'pool_discovery_failed', request: 'new_pools', error: 'HTTP 503', failures: 1, skipRefreshes: 1, keeping: null });
    assert.equal(flaky.status(NOW).requests, 2);
  });

  test('numbers expire after 15 minutes, tracked pools after the 180 minute keep age', async () => {
    const gecko = new FakeGecko();
    const d = discovery(gecko);
    gecko.top = [candidate(8, 120, 3 * HOUR)];
    d.track(candidate(9, 100, MINUTE), NOW);
    assert.equal((await d.refresh(NOW, null)).candidates.length, 1);
    gecko.failWith = 500;
    assert.equal((await d.refresh(NOW + STATS_MAX_AGE_MS, null)).candidates.length, 1);
    const later = await d.refresh(NOW + STATS_MAX_AGE_MS + 1, null);
    assert.equal(later.candidates.length, 0);
    assert.equal(d.status(NOW + 179 * MINUTE).tracked, 1);
    await d.refresh(NOW + 179 * MINUTE + 1, null);
    assert.equal(d.status(NOW + 179 * MINUTE + 1).tracked, 0);
  });
});

describe('PoolDiscovery: trending is for tracking only', () => {
  test('a trending pool is tracked and gets its numbers from pools/multi, never from the trending row', async () => {
    const gecko = new FakeGecko();
    const hot = candidate(500, 900, 20 * MINUTE); // trending says 900 trades
    gecko.trending = [
      { c: hot, dex: 'pumpswap' },
      { c: candidate(501, 2000, 6 * MINUTE), dex: 'raydium' },
    ];
    gecko.numbers.set(hot.pool, { ...hot, txM5: 70 }); // what pools/multi reports for it
    const logs: LogFields[] = [];
    const d = new PoolDiscovery({ gate: DEFAULT_GATE, logger: (f) => logs.push(f), fetchFn: gecko.fetchFn, trending: true, newPoolsPages: 1 });
    const r = await d.refresh(NOW, null);
    assert.ok(gecko.urls[0]?.includes('/trending_pools?duration=5m'), gecko.urls[0]);
    assert.equal(gecko.kinds()[1], 'multi', 'the pool is asked for right after the trending list');
    assert.equal(r.complete, true);
    assert.deepEqual(r.candidates.map((c) => [c.pool, c.txM5]), [[hot.pool, 70]]);
    assert.equal(d.status(NOW).tracked, 1, 'the raydium row is not a PumpSwap pool: not tracked');
    assert.equal(logs.length, 0);
  });

  test('when pools/multi fails the trending numbers do not stand in for it: no candidates, an incomplete refresh', async () => {
    const gecko = new FakeGecko();
    const hot = candidate(510, 900, 20 * MINUTE);
    gecko.trending = [{ c: hot, dex: 'pumpswap' }];
    gecko.failUrl = /pools.multi/;
    const logs: LogFields[] = [];
    const d = new PoolDiscovery({ gate: DEFAULT_GATE, logger: (f) => logs.push(f), fetchFn: gecko.fetchFn, trending: true, newPoolsPages: 1 });
    const r = await d.refresh(NOW, null);
    assert.equal(r.complete, false);
    assert.deepEqual(r.candidates, []);
    assert.equal(logs.at(-1)?.event, 'pool_discovery_failed');
    assert.equal(logs.at(-1)?.request, 'pools/multi');
  });

  test('candidates carry the buys and sells of their row (read from the raw answer), not only the sum', async () => {
    const gecko = new FakeGecko();
    const lopsided = candidate(520, 80, 30 * MINUTE);
    const plain = candidate(521, 60, 30 * MINUTE);
    flows.set(lopsided.pool, { buys: 70, sells: 10 });
    flows.set(plain.pool, { buys: 30, sells: 30 });
    for (const c of [lopsided, plain]) {
      gecko.launches.push({ c, dex: 'pumpswap' });
      gecko.numbers.set(c.pool, c);
    }
    const d = new PoolDiscovery({ gate: DEFAULT_GATE, logger: () => undefined, fetchFn: gecko.fetchFn, newPoolsPages: 1 });
    await d.refresh(NOW, null); // tracks both from new_pools (and asks for numbers only inside the age window: they are 30 minutes old)
    const r = await d.refresh(NOW + 1_000, null);
    const byPool = new Map(r.candidates.map((c) => [c.pool, c]));
    assert.deepEqual([byPool.get(lopsided.pool)?.buys, byPool.get(lopsided.pool)?.sells, byPool.get(lopsided.pool)?.txM5], [70, 10, 80]);
    assert.deepEqual([byPool.get(plain.pool)?.buys, byPool.get(plain.pool)?.sells], [30, 30]);
  });

  test('flowsOf: buys and sells per pool address, rows without them skipped', () => {
    const body = {
      data: [
        { attributes: { address: 'A', transactions: { m5: { buys: 3, sells: 4 } } } },
        { attributes: { address: 'B', transactions: { m5: { buys: -1, sells: 4 } } } },
        { attributes: { address: 'C', transactions: {} } },
        { attributes: { transactions: { m5: { buys: 1, sells: 1 } } } },
        'junk',
      ],
    };
    assert.deepEqual([...flowsOf(body)], [['A', { buys: 3, sells: 4 }]]);
    assert.equal(flowsOf(null).size, 0);
    assert.equal(flowsOf({ data: 'x' }).size, 0);
  });

  test('off by default: no trending request', async () => {
    const gecko = new FakeGecko();
    await discovery(gecko).refresh(NOW, null);
    assert.ok(gecko.urls.every((u) => !u.includes('trending_pools')));
  });
});
