import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  address,
  createSolanaRpcFromTransport,
  getAddressEncoder,
  type RpcTransport,
} from '@solana/kit';
import {
  DEFAULT_POOL_GATE,
  PRICE_SCALE,
  PUMPSWAP_PROGRAM_ID,
  WSOL_MINT,
  GECKOTERMINAL_MULTI_LIMIT,
  GeckoTerminalHttpError,
  decodePumpSwapPool,
  discoverPumpSwapPools,
  fetchNewPumpSwapPools,
  fetchPumpSwapPoolsByAddress,
  fetchTopPumpSwapPools,
  loadPool,
  observePrice,
  passesGate,
  priceOf,
  quoteReserveLamports,
  readTokenAmount,
  windowMean,
  type GeckoTerminalFetch,
  type PoolCandidate,
  type PoolRef,
  type PriceObservation,
} from '../src/pumpswap.ts';

// Fixtures, captured from mainnet on 2026-10-05 (see test/fixtures):
// - pumpswap-pool-higgs.json: getAccountInfo(HIGGS/SOL pool, base64, confirmed) at slot 453526007
// - pumpswap-vaults-higgs.json: getMultipleAccounts([base vault, quote vault], base64) at slot 453526171
// - pumpswap-vaults-higgs-parsed.json: the same call with jsonParsed, captured right before it
//   (slot 453526170, identical amounts): the RPC node's own token parser, used as the reference
// - geckoterminal-pumpswap-pools-page{1,2}.json: GET .../dexes/pumpswap/pools?page=N&sort=h24_tx_count_desc
//   at 2026-10-05T08:32:13Z (JSON re-indented, values unchanged)
// - geckoterminal-new-pools-page1.json: GET .../networks/solana/new_pools?page=1 at 2026-10-05T13:15:41Z
//   (served from the API cache, 54 s old; 20 rows spanning 35 s, every dex; re-indented)
// - geckoterminal-pools-multi-john.json: GET .../networks/solana/pools/multi/G1jURgdS... at 2026-10-05T13:35:27Z,
//   the PumpSwap pool of that page 22 minutes later: drained (re-indented)

type RpcAccountJson = { data: [string, string]; owner: string; lamports: number; space: number };
type RpcResponseJson<T> = { jsonrpc: '2.0'; id: number; result: { context: { slot: number }; value: T } };
type AccountInfoJson = RpcResponseJson<RpcAccountJson | null>;
type MultipleAccountsJson = RpcResponseJson<(RpcAccountJson | null)[]>;
type ParsedTokenAccountJson = { data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } };
type GeckoPageJson = { data: Record<string, unknown>[] };

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
}

const POOL_JSON = fixture<AccountInfoJson>('pumpswap-pool-higgs.json');
const VAULTS_JSON = fixture<MultipleAccountsJson>('pumpswap-vaults-higgs.json');
const VAULTS_PARSED_JSON = fixture<RpcResponseJson<ParsedTokenAccountJson[]>>('pumpswap-vaults-higgs-parsed.json');
const GECKO_PAGE_1 = fixture<GeckoPageJson>('geckoterminal-pumpswap-pools-page1.json');
const GECKO_PAGE_2 = fixture<GeckoPageJson>('geckoterminal-pumpswap-pools-page2.json');
const GECKO_SNAPSHOT_MS = Date.parse('2026-10-05T08:32:13Z');
const GECKO_NEW_POOLS = fixture<GeckoPageJson>('geckoterminal-new-pools-page1.json');
const NEW_POOLS_FETCHED_MS = Date.parse('2026-10-05T13:15:41Z');
const GECKO_API = 'https://api.geckoterminal.com/api/v2/networks/solana';

const HIGGS_POOL = address('BFrSZakeqNzVtM3EFhroo4eRhagmmWN8BRntiQKFH6Ru');
const HIGGS_MINT = address('DoVAVzViX8Bjy3r15nwikSaSbzE6dV4ovd28aWpJpump');
const HIGGS_BASE_VAULT = address('GmYYs1RhDBwTE2pJaDs7ksqcUaTC4LUBVJBb7qgb6aMZ');
const HIGGS_QUOTE_VAULT = address('EeAL1aa1H4R2bz8Rb8Q1id89CSZuuTCsyZ2mNBVjFzFq');
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const HIGGS_REF: PoolRef = {
  pool: HIGGS_POOL,
  baseMint: HIGGS_MINT,
  quoteMint: WSOL_MINT,
  baseVault: HIGGS_BASE_VAULT,
  quoteVault: HIGGS_QUOTE_VAULT,
};
// Vault amounts in pumpswap-vaults-higgs.json.
const FIXTURE_BASE_AMOUNT = 47668820617664n;
const FIXTURE_QUOTE_AMOUNT = 640136793430n;

const bytesOf = (account: RpcAccountJson | null): Buffer => {
  assert.ok(account, 'fixture account is missing');
  return Buffer.from(account.data[0], 'base64');
};

type RpcCall = { method: string; params: unknown[] };

/** A real kit RPC (request and response transformers included) over a scripted transport. */
function scriptedRpc(respond: (call: RpcCall) => unknown) {
  const calls: RpcCall[] = [];
  const transport = (async ({ payload }: { payload: unknown }) => {
    const { method, params } = payload as RpcCall;
    calls.push({ method, params });
    return structuredClone(respond({ method, params }));
  }) as RpcTransport;
  return { rpc: createSolanaRpcFromTransport(transport), calls };
}

function accountInfoFromVaults(index: number): AccountInfoJson {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: { context: VAULTS_JSON.result.context, value: VAULTS_JSON.result.value[index] ?? null },
  };
}

const BASE64_CONFIRMED = { encoding: 'base64', commitment: 'confirmed' };

describe('constants', () => {
  test('program, mint and price scale', () => {
    assert.equal(PUMPSWAP_PROGRAM_ID, 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
    assert.equal(WSOL_MINT, 'So11111111111111111111111111111111111111112');
    assert.equal(PRICE_SCALE, 1_000_000_000_000n);
  });
});

describe('decodePumpSwapPool', () => {
  const poolData = bytesOf(POOL_JSON.result.value);

  test('decodes the real HIGGS/SOL pool account', () => {
    assert.equal(poolData.length, 301);
    assert.deepEqual(decodePumpSwapPool(poolData), {
      baseMint: HIGGS_MINT,
      quoteMint: WSOL_MINT,
      baseVault: HIGGS_BASE_VAULT,
      quoteVault: HIGGS_QUOTE_VAULT,
    });
  });

  test('needs at least 203 bytes', () => {
    assert.throws(() => decodePumpSwapPool(poolData.subarray(0, 202)), /202 bytes/);
    assert.throws(() => decodePumpSwapPool(new Uint8Array(0)), /0 bytes/);
    assert.equal(decodePumpSwapPool(poolData.subarray(0, 203)).quoteVault, HIGGS_QUOTE_VAULT);
  });

  test('rejects data without the Pool discriminator', () => {
    const other = Buffer.from(poolData);
    other[0] ^= 0xff;
    assert.throws(() => decodePumpSwapPool(other), /discriminator/);
  });
});

describe('readTokenAmount', () => {
  test('matches the RPC jsonParsed amounts for Token-2022 and SPL Token vaults', () => {
    const [base, quote] = VAULTS_JSON.result.value;
    const [baseParsed, quoteParsed] = VAULTS_PARSED_JSON.result.value;
    assert.ok(baseParsed && quoteParsed);
    assert.equal(base?.owner, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    assert.equal(bytesOf(base).length, 170); // Token-2022 account with the ImmutableOwner extension
    assert.equal(quote?.owner, TOKEN_PROGRAM);
    assert.equal(bytesOf(quote).length, 165);
    assert.equal(readTokenAmount(bytesOf(base)), BigInt(baseParsed.data.parsed.info.tokenAmount.amount));
    assert.equal(readTokenAmount(bytesOf(quote)), BigInt(quoteParsed.data.parsed.info.tokenAmount.amount));
    assert.equal(readTokenAmount(bytesOf(base)), FIXTURE_BASE_AMOUNT);
    assert.equal(readTokenAmount(bytesOf(quote)), FIXTURE_QUOTE_AMOUNT);
  });

  test('rejects data shorter than a token account', () => {
    assert.throws(() => readTokenAmount(bytesOf(VAULTS_JSON.result.value[1] ?? null).subarray(0, 164)), /164 bytes/);
  });
});

describe('priceOf', () => {
  test('HIGGS pool at slot 453522229', () => {
    const base = 44664560221943n;
    const quote = 683457535696n;
    const price = priceOf(base, quote);
    assert.equal(price, 15302009743n);
    // floor: price * base <= quote * scale < (price + 1) * base
    assert.ok(price * base <= quote * PRICE_SCALE);
    assert.ok((price + 1n) * base > quote * PRICE_SCALE);
  });

  test('fixture vault amounts', () => {
    assert.equal(priceOf(FIXTURE_BASE_AMOUNT, FIXTURE_QUOTE_AMOUNT), 13428836399n);
  });

  test('empty quote side prices at zero', () => {
    assert.equal(priceOf(1n, 0n), 0n);
  });

  test('throws on a zero or negative base amount and on a negative quote amount', () => {
    assert.throws(() => priceOf(0n, 683457535696n), /base amount/);
    assert.throws(() => priceOf(-1n, 1n), /base amount/);
    assert.throws(() => priceOf(1n, -1n), /quote amount/);
  });

  test('throws when the price does not fit in u64', () => {
    assert.equal(priceOf(1n, 18_446_744n), 18_446_744_000_000_000_000n);
    assert.throws(() => priceOf(1n, 18_446_745n), /u64/);
  });
});

describe('loadPool', () => {
  test('reads the pool with base64 at confirmed commitment and returns its vaults', async () => {
    const { rpc, calls } = scriptedRpc(() => POOL_JSON);
    assert.deepEqual(await loadPool(rpc, HIGGS_POOL), HIGGS_REF);
    assert.deepEqual(calls, [{ method: 'getAccountInfo', params: [HIGGS_POOL, BASE64_CONFIRMED] }]);
  });

  test('throws when the account is missing', async () => {
    const missing: AccountInfoJson = { ...POOL_JSON, result: { ...POOL_JSON.result, value: null } };
    const { rpc } = scriptedRpc(() => missing);
    await assert.rejects(loadPool(rpc, HIGGS_POOL), /not found/);
  });

  test('throws when the account is not owned by PumpSwap', async () => {
    const foreign = structuredClone(POOL_JSON);
    assert.ok(foreign.result.value);
    foreign.result.value.owner = TOKEN_PROGRAM;
    const { rpc } = scriptedRpc(() => foreign);
    await assert.rejects(loadPool(rpc, HIGGS_POOL), /owned by TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA/);
  });

  test('throws when the pool is not quoted in wSOL', async () => {
    const data = bytesOf(POOL_JSON.result.value);
    data.set(getAddressEncoder().encode(HIGGS_MINT), 75);
    const notSol = structuredClone(POOL_JSON);
    assert.ok(notSol.result.value);
    notSol.result.value.data[0] = data.toString('base64');
    const { rpc } = scriptedRpc(() => notSol);
    await assert.rejects(loadPool(rpc, HIGGS_POOL), /not in wSOL/);
  });
});

describe('observePrice', () => {
  test('reads both vaults in one call and stamps the context slot and arrival time', async () => {
    const { rpc, calls } = scriptedRpc(() => VAULTS_JSON);
    const observation = await observePrice(rpc, HIGGS_REF, () => 1_759_653_000_123);
    assert.deepEqual(observation, {
      atMs: 1_759_653_000_123,
      slot: 453526171n,
      baseAmount: FIXTURE_BASE_AMOUNT,
      quoteAmount: FIXTURE_QUOTE_AMOUNT,
      price: 13428836399n,
    });
    assert.deepEqual(calls, [
      { method: 'getMultipleAccounts', params: [[HIGGS_BASE_VAULT, HIGGS_QUOTE_VAULT], BASE64_CONFIRMED] },
    ]);
  });

  test('throws when a vault holds another mint', async () => {
    const { rpc } = scriptedRpc(() => VAULTS_JSON);
    const wrongBase: PoolRef = { ...HIGGS_REF, baseMint: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') };
    await assert.rejects(observePrice(rpc, wrongBase), /base vault .* holds mint DoVAVzViX8Bjy3r15nwikSaSbzE6dV4ovd28aWpJpump/);
  });

  test('throws when a vault is missing', async () => {
    const oneMissing = structuredClone(VAULTS_JSON);
    oneMissing.result.value[1] = null;
    const { rpc } = scriptedRpc(() => oneMissing);
    await assert.rejects(observePrice(rpc, HIGGS_REF), /quote vault .* not found/);
  });

  test('throws when a vault is not a token account', async () => {
    const foreign = structuredClone(VAULTS_JSON);
    const base = foreign.result.value[0];
    assert.ok(base);
    base.owner = PUMPSWAP_PROGRAM_ID;
    const { rpc } = scriptedRpc(() => foreign);
    await assert.rejects(observePrice(rpc, HIGGS_REF), /not a token program/);
  });
});

describe('quoteReserveLamports', () => {
  test('returns the wSOL amount of the quote vault', async () => {
    const { rpc, calls } = scriptedRpc(() => accountInfoFromVaults(1));
    assert.equal(await quoteReserveLamports(rpc, HIGGS_REF), FIXTURE_QUOTE_AMOUNT);
    assert.deepEqual(calls, [{ method: 'getAccountInfo', params: [HIGGS_QUOTE_VAULT, BASE64_CONFIRMED] }]);
  });
});

describe('windowMean', () => {
  const obs = (slot: number, atMs: number, price: bigint): PriceObservation => ({
    atMs,
    slot: BigInt(slot),
    baseAmount: 1n,
    quoteAmount: 1n,
    price,
  });
  const run = (n: number, price: (i: number) => bigint, atMs = (i: number) => 1_000 + i * 1_000) =>
    Array.from({ length: n }, (_, i) => obs(100 + i, atMs(i), price(i)));

  test('returns null with fewer than 5 observations in the window', () => {
    assert.equal(windowMean([], 0, 10_000), null);
    const four = run(4, () => 10n);
    assert.equal(windowMean(four, 0, 10_000), null);
    // a fifth one outside the window does not help
    assert.equal(windowMean([...four, obs(200, 10_000, 10n)], 0, 10_000), null);
  });

  test('includes startMs and excludes endMs', () => {
    const series = run(7, (i) => BigInt(i)); // atMs 1000..7000, price 0..6
    const mean = windowMean(series, 2_000, 7_000); // atMs 2000..6000, price 1..5
    assert.ok(mean);
    assert.deepEqual(mean.samples.map((s) => s.atMs), [2_000, 3_000, 4_000, 5_000, 6_000]);
    assert.equal(mean.price, 3n);
  });

  test('floors the mean', () => {
    assert.equal(windowMean(run(5, (i) => (i === 4 ? 4n : 3n)), 0, 10_000)?.price, 3n); // 16 / 5
    assert.equal(windowMean(run(5, (i) => (i === 4 ? 9n : 10n)), 0, 10_000)?.price, 9n); // 49 / 5
  });

  test('keeps the first observation per slot, and duplicates do not count', () => {
    const fiveWithDuplicate = [...run(4, () => 10n), obs(103, 4_500, 99n)];
    assert.equal(windowMean(fiveWithDuplicate, 0, 10_000), null);
    const mean = windowMean([...fiveWithDuplicate, obs(104, 5_000, 20n)], 0, 10_000);
    assert.ok(mean);
    assert.deepEqual(mean.samples.map((s) => s.slot), [100n, 101n, 102n, 103n, 104n]);
    assert.equal(mean.samples[3]?.price, 10n);
    assert.equal(mean.price, 12n); // (10 * 4 + 20) / 5
  });

  test('drops zero prices, which the program rejects as samples', () => {
    const withZero = [...run(4, () => 10n), obs(104, 5_000, 0n)];
    assert.equal(windowMean(withZero, 0, 10_000), null);
    const mean = windowMean([...withZero, obs(105, 6_000, 20n)], 0, 10_000);
    assert.ok(mean);
    assert.deepEqual(mean.samples.map((s) => s.slot), [100n, 101n, 102n, 103n, 105n]);
    assert.equal(mean.price, 12n);
  });

  test('sorts by slot and caps at the first 16', () => {
    const twenty = run(20, (i) => BigInt(i + 1)).reverse(); // slots 119 down to 100, price = slot - 99
    const mean = windowMean(twenty, 0, 100_000);
    assert.ok(mean);
    assert.equal(mean.samples.length, 16);
    assert.deepEqual(
      mean.samples.map((s) => s.slot),
      Array.from({ length: 16 }, (_, i) => BigInt(100 + i)),
    );
    assert.equal(mean.price, 8n); // (1 + ... + 16) / 16 = 136 / 16 = 8.5
  });
});

describe('passesGate', () => {
  const NOW = Date.parse('2026-10-05T12:00:00Z');
  const HOUR = 60 * 60 * 1000;
  const candidate = (createdAtMs: number, txM5: number): PoolCandidate => ({
    pool: HIGGS_POOL,
    baseMint: HIGGS_MINT,
    name: 'HIGGS / SOL',
    reserveUsd: 150_000,
    createdAtMs,
    txM5,
    volumeH1Usd: 300_000,
  });

  test('defaults: younger than 7 days and at least 20 transactions in 5 minutes', () => {
    assert.deepEqual(DEFAULT_POOL_GATE, { maxAgeMs: 7 * 24 * HOUR, minTxM5: 20 });
    assert.equal(passesGate(candidate(NOW - HOUR, 20), NOW), true);
    assert.equal(passesGate(candidate(NOW - HOUR, 19), NOW), false);
    assert.equal(passesGate(candidate(NOW - 7 * 24 * HOUR + 1, 500), NOW), true);
    assert.equal(passesGate(candidate(NOW - 7 * 24 * HOUR, 500), NOW), false);
    assert.equal(passesGate(candidate(Number.NaN, 500), NOW), false);
  });

  test('custom options', () => {
    const old = candidate(NOW - 30 * 24 * HOUR, 25);
    assert.equal(passesGate(old, NOW), false);
    assert.equal(passesGate(old, NOW, { maxAgeMs: Number.POSITIVE_INFINITY, minTxM5: 20 }), true);
    assert.equal(passesGate(old, NOW, { maxAgeMs: Number.POSITIVE_INFINITY, minTxM5: 30 }), false);
  });
});

describe('discoverPumpSwapPools', () => {
  type FetchCall = { url: string; headers: Record<string, string> };

  function geckoFetch(pages: Record<number, unknown>, status = 200) {
    const calls: FetchCall[] = [];
    const fetchFn: GeckoTerminalFetch = async (url, init) => {
      calls.push({ url, headers: init.headers });
      const page = Number(new URL(url).searchParams.get('page'));
      return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(pages[page]) };
    };
    return { fetchFn, calls };
  }

  const higgsRow = (): Record<string, unknown> => {
    const row = GECKO_PAGE_1.data.find((r) => r.id === `solana_${HIGGS_POOL}`);
    assert.ok(row);
    return structuredClone(row);
  };

  test('parses the two real pages, sorted by 5-minute transactions', async () => {
    const { fetchFn, calls } = geckoFetch({ 1: GECKO_PAGE_1, 2: GECKO_PAGE_2 });
    const pools = await discoverPumpSwapPools(fetchFn, GECKO_SNAPSHOT_MS);

    const base = 'https://api.geckoterminal.com/api/v2/networks/solana/dexes/pumpswap/pools';
    assert.deepEqual(
      calls.map((c) => c.url),
      [`${base}?page=1&sort=h24_tx_count_desc`, `${base}?page=2&sort=h24_tx_count_desc`],
    );
    assert.match(calls[0]?.headers.accept ?? '', /^application\/json/);

    assert.equal(pools.length, 40);
    assert.equal(new Set(pools.map((p) => p.pool)).size, 40);
    for (let i = 1; i < pools.length; i++) {
      assert.ok((pools[i - 1]?.txM5 ?? 0) >= (pools[i]?.txM5 ?? 0), 'not sorted by txM5');
    }
    assert.equal(pools[0]?.name, 'AGENTCAT / SOL');
    assert.equal(pools[0]?.txM5, 303);
    assert.deepEqual(
      pools.find((p) => p.pool === HIGGS_POOL),
      {
        pool: HIGGS_POOL,
        baseMint: HIGGS_MINT,
        name: 'HIGGS / SOL',
        reserveUsd: 157418.2123,
        createdAtMs: Date.parse('2026-10-04T12:36:16Z'),
        txM5: 28, // 15 buys + 13 sells
        volumeH1Usd: 310929.316791207,
      },
    );
  });

  test('gate over the captured snapshot', async () => {
    const { fetchFn } = geckoFetch({ 1: GECKO_PAGE_1, 2: GECKO_PAGE_2 });
    const pools = await discoverPumpSwapPools(fetchFn, GECKO_SNAPSHOT_MS);
    const passing = pools.filter((p) => passesGate(p, GECKO_SNAPSHOT_MS));
    assert.deepEqual(
      passing.map((p) => `${p.name} ${p.txM5}`),
      [
        'AGENTCAT / SOL 303',
        'BATONROGUE / SOL 184',
        'AIKOL / SOL 164',
        'UDR / SOL 107',
        'DOTF / SOL 106',
        'ATFS / SOL 100',
        'SM / SOL 66',
        'Agency / SOL 47',
        'Human / SOL 35',
        'HIGGS / SOL 28',
        'Ash / SOL 21',
        'Attention+ / SOL 21',
      ],
    );
  });

  test('de-duplicates pools that show up on both pages', async () => {
    const { fetchFn } = geckoFetch({ 1: GECKO_PAGE_1, 2: GECKO_PAGE_1 });
    assert.equal((await discoverPumpSwapPools(fetchFn, GECKO_SNAPSHOT_MS)).length, 20);
  });

  test('skips malformed rows and pools not quoted in wSOL', async () => {
    const attrs = (row: Record<string, unknown>) => row.attributes as Record<string, unknown>;
    const rels = (row: Record<string, unknown>) => row.relationships as Record<string, unknown>;
    // Each broken row gets its own real pool address, so a row accepted by mistake would show up.
    const spareAddresses = GECKO_PAGE_2.data.map((row) => attrs(row).address);
    const patched = (patch: (row: Record<string, unknown>) => void): Record<string, unknown> => {
      const row = higgsRow();
      attrs(row).address = spareAddresses.shift();
      patch(row);
      return row;
    };
    const page = {
      data: [
        null,
        42,
        { id: 'solana_x', type: 'pool' },
        patched((r) => { attrs(r).address = 'not-an-address'; }),
        patched((r) => { delete rels(r).base_token; }),
        patched((r) => { rels(r).base_token = { data: { id: `solana_${WSOL_MINT}`, type: 'token' } }; }),
        patched((r) => {
          rels(r).quote_token = { data: { id: 'solana_EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', type: 'token' } };
        }),
        patched((r) => { attrs(r).name = null; }),
        patched((r) => { attrs(r).pool_created_at = 'yesterday-ish'; }),
        patched((r) => { attrs(r).transactions = { m5: { buys: '15', sells: 13 } }; }),
        patched((r) => { attrs(r).reserve_in_usd = null; }),
        patched((r) => { attrs(r).volume_usd = { h1: '-5' }; }),
        higgsRow(),
      ],
    };
    const { fetchFn } = geckoFetch({ 1: page, 2: { data: [] } });
    const pools = await discoverPumpSwapPools(fetchFn, GECKO_SNAPSHOT_MS);
    assert.deepEqual(pools.map((p) => p.pool), [HIGGS_POOL]);
  });

  test('skips pools dated more than 5 minutes after nowMs', async () => {
    const { fetchFn } = geckoFetch({ 1: { data: [higgsRow()] }, 2: { data: [] } });
    // HIGGS pool_created_at is 2026-10-04T12:36:16Z
    assert.equal((await discoverPumpSwapPools(fetchFn, Date.parse('2026-10-04T12:31:00Z'))).length, 0);
    assert.equal((await discoverPumpSwapPools(fetchFn, Date.parse('2026-10-04T12:32:00Z'))).length, 1);
  });

  test('throws on an HTTP error or a body without data', async () => {
    const limited = geckoFetch({ 1: GECKO_PAGE_1, 2: GECKO_PAGE_2 }, 429);
    await assert.rejects(discoverPumpSwapPools(limited.fetchFn, GECKO_SNAPSHOT_MS), /HTTP 429/);
    const noData = geckoFetch({ 1: GECKO_PAGE_1, 2: { errors: [{ status: '401' }] } });
    await assert.rejects(discoverPumpSwapPools(noData.fetchFn, GECKO_SNAPSHOT_MS), /page=2.*no data array/);
  });
});

describe('single-request GeckoTerminal readers', () => {
  const JOHN_POOL = address('G1jURgdSVJXnFSjj1s3cPXowj7ERsTGnz27mtXpSUnc3');
  const PUMP_FUN_POOL = address('svuuMBPGFQznDEVHDk5G2J5dZKEAnbfdDfd1JmUYa7Q'); // bonding curve, dex pump-fun
  const JOHN: PoolCandidate = {
    pool: JOHN_POOL,
    baseMint: address('EtGKPxsypmvZfqRHT4y5d7JintuaHTwcShJcazDdjups'),
    name: 'John / SOL',
    reserveUsd: 20589.4486,
    createdAtMs: Date.parse('2026-10-05T13:13:44Z'),
    txM5: 111, // 106 buys + 5 sells, two minutes after graduating
    volumeH1Usd: 42.5182270926,
  };

  function serve(body: unknown, status = 200) {
    const urls: string[] = [];
    const fetchFn: GeckoTerminalFetch = async (url, init) => {
      urls.push(url);
      assert.match(init.headers.accept ?? '', /^application\/json;version=/);
      return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) };
    };
    return { fetchFn, urls };
  }
  const rowOf = (page: GeckoPageJson, pool: string): Record<string, unknown> => {
    const row = page.data.find((r) => r.id === `solana_${pool}`);
    assert.ok(row, pool);
    return structuredClone(row);
  };

  test('fetchNewPumpSwapPools: the PumpSwap pool of a real page and the time span of the whole page', async () => {
    const { fetchFn, urls } = serve(GECKO_NEW_POOLS);
    const page = await fetchNewPumpSwapPools(fetchFn, 1, NEW_POOLS_FETCHED_MS);
    assert.deepEqual(urls, [`${GECKO_API}/new_pools?page=1`]);
    assert.equal(page.rows, 20);
    assert.equal(page.newestCreatedAtMs, Date.parse('2026-10-05T13:14:17Z'));
    assert.equal(page.oldestCreatedAtMs, Date.parse('2026-10-05T13:13:42Z'));
    assert.deepEqual(page.pumpSwap, [JOHN]);
  });

  test('fetchNewPumpSwapPools: pages 1..10 only, errors carry the HTTP status', async () => {
    const { fetchFn, urls } = serve(GECKO_NEW_POOLS);
    await assert.rejects(fetchNewPumpSwapPools(fetchFn, 0, NEW_POOLS_FETCHED_MS), RangeError);
    await assert.rejects(fetchNewPumpSwapPools(fetchFn, 11, NEW_POOLS_FETCHED_MS), RangeError);
    assert.deepEqual(urls, []);
    const limited = serve({ errors: [{ status: '429', title: 'Too Many Requests' }] }, 429);
    await assert.rejects(
      fetchNewPumpSwapPools(limited.fetchFn, 3, NEW_POOLS_FETCHED_MS),
      (e: unknown) => e instanceof GeckoTerminalHttpError && e.status === 429 && /new_pools\?page=3 answered HTTP 429$/.test(e.message),
    );
    const empty = serve({ data: [] });
    assert.deepEqual(await fetchNewPumpSwapPools(empty.fetchFn, 2, NEW_POOLS_FETCHED_MS), { pumpSwap: [], rows: 0, newestCreatedAtMs: null, oldestCreatedAtMs: null });
  });

  test('fetchPumpSwapPoolsByAddress: one pools/multi request, asked order, other dexes dropped', async () => {
    const higgs = rowOf(GECKO_PAGE_1, HIGGS_POOL);
    const johnWithoutDex = rowOf(GECKO_NEW_POOLS, JOHN_POOL);
    delete (johnWithoutDex.relationships as Record<string, unknown>).dex;
    const { fetchFn, urls } = serve({ data: [higgs, rowOf(GECKO_NEW_POOLS, PUMP_FUN_POOL), johnWithoutDex] });
    const unknown = address('11111111111111111111111111111112');
    const pools = await fetchPumpSwapPoolsByAddress(fetchFn, [JOHN_POOL, PUMP_FUN_POOL, HIGGS_POOL, unknown, JOHN_POOL], NEW_POOLS_FETCHED_MS);
    assert.deepEqual(urls, [`${GECKO_API}/pools/multi/${JOHN_POOL},${PUMP_FUN_POOL},${HIGGS_POOL},${unknown}`]);
    assert.deepEqual(pools.map((p) => p.name), ['John / SOL', 'HIGGS / SOL']);
    assert.deepEqual(pools[0], JOHN);
  });

  test('fetchPumpSwapPoolsByAddress: the real answer for the same pool 22 minutes later', async () => {
    const { fetchFn } = serve(fixture<GeckoPageJson>('geckoterminal-pools-multi-john.json'));
    const at = Date.parse('2026-10-05T13:35:27Z');
    assert.deepEqual(await fetchPumpSwapPoolsByAddress(fetchFn, [JOHN_POOL], at), [
      { ...JOHN, reserveUsd: 0.0000006150608462, txM5: 0, volumeH1Usd: 2907.7481442464 },
    ]);
  });

  test('fetchPumpSwapPoolsByAddress: no request for an empty list, at most 30 pools', async () => {
    const { fetchFn, urls } = serve({ data: [] });
    assert.deepEqual(await fetchPumpSwapPoolsByAddress(fetchFn, [], NEW_POOLS_FETCHED_MS), []);
    const many = GECKO_PAGE_1.data.concat(GECKO_PAGE_2.data).map((r) => (r.attributes as { address: string }).address as ReturnType<typeof address>);
    assert.equal(GECKOTERMINAL_MULTI_LIMIT, 30);
    await assert.rejects(fetchPumpSwapPoolsByAddress(fetchFn, many.slice(0, 31), NEW_POOLS_FETCHED_MS), RangeError);
    assert.deepEqual(urls, []);
    await fetchPumpSwapPoolsByAddress(fetchFn, many.slice(0, 30), NEW_POOLS_FETCHED_MS);
    assert.equal(urls.length, 1);
  });

  test('fetchTopPumpSwapPools: one page by 24 h transactions, in API order', async () => {
    const { fetchFn, urls } = serve(GECKO_PAGE_2);
    const pools = await fetchTopPumpSwapPools(fetchFn, 2, GECKO_SNAPSHOT_MS);
    assert.deepEqual(urls, [`${GECKO_API}/dexes/pumpswap/pools?page=2&sort=h24_tx_count_desc`]);
    assert.equal(pools.length, 20);
    assert.deepEqual(
      pools.map((p) => p.pool),
      GECKO_PAGE_2.data.map((r) => (r.attributes as { address: string }).address),
    );
  });
});
