// Run: node --test services/link/test/*.test.ts
// The RPC is a mock: no network. Addresses and accounts are real mainnet ones, checked on chain once.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import {
  base58Decode,
  base58Encode,
  findPda,
  hashedName,
  isOnCurve,
  parseAddresses,
  pickName,
  reverseLookup,
  SKR_PARENT,
  SKR_TLD_HOUSE,
} from '../src/names.ts';

const ANS = 'ALTNSZ46uaAUU7XUV6awvdorLGqAsPwa9shm7h4uP2FK';
const TLD_HOUSE_PROGRAM = 'TLDHkysf5pCnKsVA4gXpNvmy7psXLPEu4LAdDJthT9S';
/** A Seeker whose wallet card shows oxbla.skr, its name record and the record's reverse lookup account. */
const SEEKER = '3tyWjZkd77NcqjsNzHqb16UGpB3WeqbKHeJX1b23zD7t';
const OXBLA_RECORD = '9T4w1v83FB6BQdJtuoPfhSxTCJxgdtjWqGTwv44hiVSA';
const OXBLA_REVERSE = '8x17cG87XckJCDaq7n1FeAqGpMNgQxLSEwh4GAEM3Sc2';
/** An address without a .skr name. */
const NOBODY = '3iv5z9pWawKpjafBLN5pyKzYzKkj375bKoj5TWmmn6BC';

const fake = (byte: number) => base58Encode(new Uint8Array(32).fill(byte));
const utf8 = (s: string) => new TextEncoder().encode(s);

/** What the mock chain holds: name records per owner, and the label in each reverse lookup account. */
type Chain = { records: Record<string, string[]>; labels: Record<string, string> };

class MemoryCache {
  entries = new Map<string, Response>();
  async match(key: string) {
    return this.entries.get(key)?.clone();
  }
  async put(key: string, res: Response) {
    this.entries.set(key, res);
  }
  ttl(address: string) {
    return this.entries.get(`https://sol.flipthememe.com/__names/${address}`)?.headers.get('cache-control') ?? null;
  }
}

type Rpc = { method: string; params: any[] };

function setup(t: TestContext, chain: Chain, fails: (host: string, method: string) => boolean = () => false) {
  const cache = new MemoryCache();
  Object.assign(globalThis, { caches: { default: cache } });
  t.after(() => void delete (globalThis as { caches?: unknown }).caches);
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (line: string) => void warnings.push(line));

  const calls: string[] = [];
  const sent: (Rpc & { at: number })[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const host = new URL(url).host;
    const { method, params } = JSON.parse(String(init.body)) as Rpc;
    calls.push(`${host} ${method}`);
    sent.push({ method, params, at: Date.now() });
    if (fails(host, method)) {
      return Response.json({ jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Too many requests' } }, { status: 429 });
    }
    let result: unknown;
    if (method === 'getProgramAccounts') {
      const owner = params[1].filters.find((f: { memcmp: { offset: number } }) => f.memcmp.offset === 40).memcmp.bytes;
      result = (chain.records[owner] ?? []).map((pubkey) => ({ pubkey, account: { data: ['', 'base64'], owner: ANS, space: 200 } }));
    } else {
      result = {
        context: { slot: 1 },
        value: (params[0] as string[]).map((key) => {
          const label = chain.labels[key];
          if (label === undefined) return null;
          const data = Buffer.concat([Buffer.alloc(200), Buffer.from(label)]).toString('base64');
          return { data: [data, 'base64'], owner: ANS, space: 200 + label.length };
        }),
      };
    }
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  });

  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const get = async (query: string, env: { MAINNET_RPC?: string } = {}, method = 'GET') => {
    const res = await worker.fetch(new Request(`https://sol.flipthememe.com/v1/names${query}`, { method }), env, ctx);
    await Promise.all(pending);
    return res;
  };
  return { cache, calls, sent, warnings, get };
}

const oxbla: Chain = { records: { [SEEKER]: [OXBLA_RECORD] }, labels: { [OXBLA_REVERSE]: 'oxbla' } };

test('derivation matches mainnet: the .skr accounts, the reverse lookup of oxbla.skr, the curve check', async () => {
  const origin = await findPda([await hashedName('ANS'), new Uint8Array(32), new Uint8Array(32)], ANS);
  assert.equal(origin, '3mX9b4AZaQehNoQGfckVcmgmA6bkBoFcbLj9RMmMyNcU');
  assert.equal(await findPda([await hashedName('.skr'), new Uint8Array(32), base58Decode(origin)!], ANS), SKR_PARENT);
  // Bump 253: the first two candidates are on the curve and must be skipped.
  assert.equal(await findPda([utf8('tld_house'), utf8('.skr')], TLD_HOUSE_PROGRAM), SKR_TLD_HOUSE);
  assert.equal(await reverseLookup(OXBLA_RECORD), OXBLA_REVERSE);
  assert.equal(isOnCurve(base58Decode(SEEKER)!), true);
  assert.equal(isOnCurve(base58Decode(OXBLA_REVERSE)!), false);
  assert.equal(base58Encode(new Uint8Array(32)), '11111111111111111111111111111111');
  assert.deepEqual(base58Decode('11111111111111111111111111111111'), new Uint8Array(32));
  assert.equal(base58Encode(base58Decode(SEEKER)!), SEEKER);
});

test('a Seeker gets its .skr name, cached for 12 hours, and the next request needs no RPC', async (t) => {
  const { cache, calls, sent, get } = setup(t, oxbla);
  const res = await get(`?a=${SEEKER},${SEEKER}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  assert.deepEqual(await res.json(), { names: { [SEEKER]: 'oxbla.skr' } });
  assert.deepEqual(calls, ['api.mainnet-beta.solana.com getProgramAccounts', 'api.mainnet-beta.solana.com getMultipleAccounts']);
  assert.deepEqual(sent[0].params, [
    ANS,
    {
      encoding: 'base64',
      dataSlice: { offset: 0, length: 0 },
      filters: [{ memcmp: { offset: 8, bytes: SKR_PARENT } }, { memcmp: { offset: 40, bytes: SEEKER } }],
    },
  ]);
  assert.deepEqual(sent[1].params, [[OXBLA_REVERSE], { encoding: 'base64' }]);
  assert.equal(cache.ttl(SEEKER), 'public, max-age=43200');

  const again = await get(`?a=${SEEKER}`);
  assert.deepEqual(await again.json(), { names: { [SEEKER]: 'oxbla.skr' } });
  assert.equal(calls.length, 2);
});

test('an address without a .skr name gets null, cached for an hour, without a reverse lookup', async (t) => {
  const { cache, calls, get } = setup(t, oxbla);
  const res = await get(`?a=${NOBODY}`);
  assert.deepEqual(await res.json(), { names: { [NOBODY]: null } });
  assert.deepEqual(calls, ['api.mainnet-beta.solana.com getProgramAccounts']);
  assert.equal(cache.ttl(NOBODY), 'public, max-age=3600');
});

test('several names: the sorted first one, whatever order the RPC returns them in', async (t) => {
  const [zed, abc10, abc9, gone] = [fake(1), fake(2), fake(3), fake(4)];
  const [ownerA, ownerB] = [fake(5), fake(6)];
  const chain: Chain = {
    records: { [ownerA]: [zed, abc10, abc9, gone], [ownerB]: [gone, abc9, abc10, zed] },
    labels: {
      [await reverseLookup(zed)]: 'zed',
      [await reverseLookup(abc10)]: 'abc10',
      [await reverseLookup(abc9)]: 'abc9',
      // `gone` has no reverse lookup account: skipped.
    },
  };
  const { calls, sent, get } = setup(t, chain);
  const res = await get(`?a=${ownerA},${ownerB},${SEEKER}`);
  assert.deepEqual(await res.json(), { names: { [ownerA]: 'abc9.skr', [ownerB]: 'abc9.skr', [SEEKER]: null } });
  assert.equal(calls.filter((c) => c.endsWith('getMultipleAccounts')).length, 1, 'one batched reverse lookup');
  const starts = sent.filter((s) => s.method === 'getProgramAccounts').map((s) => s.at);
  assert.equal(starts.length, 3);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 200, 'getProgramAccounts paced under 5 a second');

  assert.equal(pickName(['Zed.skr', 'abc10.skr', 'abc9.skr']), 'abc9.skr');
  assert.equal(pickName(['b.skr', 'B.skr']), pickName(['B.skr', 'b.skr']));
  assert.equal(pickName([]), null);
});

test('input is strict: 400 for a bad list, 405 for anything but GET, no RPC call', async (t) => {
  const { calls, get } = setup(t, oxbla);
  const twenty = Array.from({ length: 20 }, (_, i) => fake(i + 1));
  assert.equal(parseAddresses(twenty.join(','))?.length, 20);
  assert.equal(parseAddresses([...twenty, fake(99)].join(',')), null);
  assert.deepEqual(parseAddresses(`${SEEKER},${SEEKER}`), [SEEKER]);
  for (const query of [
    '',
    '?a=',
    '?a=hello',
    `?a=${SEEKER},`,
    `?a=${SEEKER}, ${NOBODY}`,
    `?a=${SEEKER.slice(0, 31)}`,
    `?a=${SEEKER}1`,
    `?a=${'z'.repeat(44)}`,
    `?a=0OIl${SEEKER.slice(4)}`,
    `?a=${[...twenty, fake(99)].join(',')}`,
  ]) {
    const res = await get(query);
    assert.equal(res.status, 400, query);
    assert.match(((await res.json()) as { error: string }).error, /base58/);
  }
  for (const method of ['POST', 'HEAD']) {
    const res = await get(`?a=${SEEKER}`, {}, method);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET');
  }
  assert.deepEqual(calls, []);
});

test('an RPC failure is reported as missing, never cached as null, and a later request resolves it', async (t) => {
  let down = true;
  const { cache, calls, get } = setup(t, oxbla, (_, method) => down && method === 'getMultipleAccounts');
  const res = await get(`?a=${SEEKER},${NOBODY}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  // NOBODY's answer is complete (no records); SEEKER's names could not be read: left out, not null.
  assert.deepEqual(await res.json(), { names: { [NOBODY]: null } });
  assert.equal(cache.ttl(SEEKER), null);
  assert.ok(calls.includes('solana-rpc.publicnode.com getMultipleAccounts'), 'plain reads fall back to publicnode');

  down = false;
  const later = await get(`?a=${SEEKER},${NOBODY}`);
  assert.equal(later.headers.get('cache-control'), 'public, max-age=300');
  assert.deepEqual(await later.json(), { names: { [SEEKER]: 'oxbla.skr', [NOBODY]: null } });
  assert.equal(cache.ttl(SEEKER), 'public, max-age=43200');
});

test('MAINNET_RPC goes first, a failing endpoint is dropped for the request, publicnode never gets getProgramAccounts', async (t) => {
  const env = { MAINNET_RPC: 'https://rpc.example.com/?api-key=secret' };
  const failing = new Set(['rpc.example.com', 'api.mainnet-beta.solana.com']);
  const { cache, calls, warnings, get } = setup(t, oxbla, (host) => failing.has(host));
  const res = await get(`?a=${SEEKER},${NOBODY},${fake(7)}`, env);
  assert.deepEqual(await res.json(), { names: {} });
  // The first lookup finds both endpoints failing; the other two owners send nothing more.
  assert.deepEqual(calls, ['rpc.example.com getProgramAccounts', 'api.mainnet-beta.solana.com getProgramAccounts']);
  assert.equal(cache.entries.size, 0);
  assert.ok(warnings.length > 0 && warnings.every((w) => !w.includes('secret')), 'the key in MAINNET_RPC is never logged');

  failing.delete('api.mainnet-beta.solana.com');
  calls.length = 0;
  const next = await get(`?a=${SEEKER}`, env);
  assert.deepEqual(await next.json(), { names: { [SEEKER]: 'oxbla.skr' } });
  assert.deepEqual(calls, [
    'rpc.example.com getProgramAccounts',
    'api.mainnet-beta.solana.com getProgramAccounts',
    'api.mainnet-beta.solana.com getMultipleAccounts',
  ]);
});
