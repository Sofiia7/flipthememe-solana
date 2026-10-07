// Run: node --test services/link/test/*.test.ts
// The RPC is a mock: no network, and the keys are generated here, never real ones.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALREADY_FUNDED_LAMPORTS,
  DEFAULT_LAMPORTS,
  DEVNET_RPCS,
  MAX_BODY_BYTES,
  RESERVE_LAMPORTS,
  UNFUNDABLE,
  faucet,
  loadFaucetKey,
  parseLamports,
  resetFaucetState,
  transferMessage,
  walletBytes,
  wireTransaction,
  type FaucetEnv,
  type RateLimiter,
} from '../src/faucet.ts';
import worker from '../src/index.ts';
import { base58Decode, base58Encode, reverseLookup } from '../src/names.ts';

const SOL = 1_000_000_000;
const URL_FAUCET = 'https://sol.flipthememe.com/v1/faucet';
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** A fresh Ed25519 key: its 64-byte secret as FAUCET_KEY holds it (seed, public), and its address. */
async function newKey() {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  const seed = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer).slice(PKCS8_PREFIX.length);
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(pub, 32);
  return { secret: base58Encode(secret), address: base58Encode(pub), pub };
}

const FAUCET = await newKey();
const WALLET = await newKey();
/** Another valid wallet. */
const OTHER = await newKey();
/** The reverse lookup account of oxbla.skr: a PDA, so off the curve. */
const PDA = await reverseLookup('9T4w1v83FB6BQdJtuoPfhSxTCJxgdtjWqGTwv44hiVSA');
const BLOCKHASH = base58Encode(new Uint8Array(32).fill(9));

const ENV: FaucetEnv = { FAUCET_KEY: FAUCET.secret, EXPECTED_FAUCET_ADDRESS: FAUCET.address };

type Chain = {
  wallet: number | null;
  faucet: number | null;
  /** Hosts that answer with this status instead of a result. */
  failing: Map<string, number>;
  /** Methods that answer a JSON-RPC error. */
  rpcErrors: Set<string>;
};
type Call = { host: string; url: string; method: string; params: any[] };

function setup(t: TestContext, over: Partial<Chain> = {}) {
  resetFaucetState();
  const chain: Chain = { wallet: 0, faucet: 5 * SOL, failing: new Map(), rpcErrors: new Set(), ...over };
  const calls: Call[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  t.mock.method(console, 'warn', (line: string) => void warnings.push(line));
  t.mock.method(console, 'error', (line: string) => void errors.push(line));
  t.mock.method(console, 'log', (line: string) => void logs.push(line));
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body)) as { method: string; params: any[] };
    const host = new URL(url).host;
    calls.push({ host, url, method, params });
    const status = chain.failing.get(host);
    if (status !== undefined) return Response.json({ error: { message: 'blocked' } }, { status });
    if (chain.rpcErrors.has(method)) return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'simulation failed' } });
    let result: unknown;
    if (method === 'getMultipleAccounts') {
      const balance = (key: string) => {
        const lamports = key === FAUCET.address ? chain.faucet : chain.wallet;
        return lamports === null ? null : { lamports, owner: '11111111111111111111111111111111', data: ['', 'base64'], executable: false, space: 0 };
      };
      result = { context: { slot: 1 }, value: (params[0] as string[]).map(balance) };
    } else if (method === 'getLatestBlockhash') {
      result = { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } };
    } else if (method === 'sendTransaction') {
      result = 'signature-from-the-rpc';
    } else {
      throw new Error(`unexpected ${method}`);
    }
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  });
  const post = (body: unknown, env: FaucetEnv = ENV, headers: Record<string, string> = {}) =>
    faucet(
      new Request(URL_FAUCET, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      env,
    );
  return { chain, calls, warnings, errors, logs, post };
}

type Answer = { ok: boolean; error?: string; message?: string; signature?: string; lamports?: number };
const answer = async (res: Response) => (await res.json()) as Answer;

test('a wallet without devnet SOL gets 0.2 SOL: a signed System Program transfer from the faucet key', async (t) => {
  const { calls, post, logs } = setup(t);
  const res = await post({ address: WALLET.address });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await answer(res);
  assert.equal(body.ok, true);
  assert.equal(body.lamports, DEFAULT_LAMPORTS);
  assert.equal(DEFAULT_LAMPORTS, 200_000_000);
  assert.match(body.signature!, /^[1-9A-HJ-NP-Za-km-z]{64,100}$/);

  // Balances of the wallet and the faucet in one read, then a blockhash, then the transfer.
  assert.deepEqual(
    calls.map((c) => `${c.host} ${c.method}`),
    ['solana-devnet.api.onfinality.io getMultipleAccounts', 'solana-devnet.api.onfinality.io getLatestBlockhash', 'solana-devnet.api.onfinality.io sendTransaction'],
  );
  assert.deepEqual(calls[0]!.params[0], [WALLET.address, FAUCET.address]);
  assert.equal(calls[0]!.params[1].dataSlice.length, 0);

  // The transaction that went out: one signature, a legacy message, valid under the faucet's public key.
  const [encoded, options] = calls[2]!.params as [string, { encoding: string; preflightCommitment: string }];
  assert.equal(options.encoding, 'base64');
  assert.equal(options.preflightCommitment, 'confirmed');
  const wire = Uint8Array.from(Buffer.from(encoded, 'base64'));
  assert.equal(wire.length, 215);
  assert.equal(wire[0], 1);
  const signature = wire.subarray(1, 65);
  const message = wire.subarray(65);
  assert.equal(base58Encode(signature), body.signature);
  const verifier = await crypto.subtle.importKey('raw', FAUCET.pub, 'Ed25519', false, ['verify']);
  assert.ok(await crypto.subtle.verify('Ed25519', verifier, signature, message));
  assert.deepEqual([...message.subarray(0, 4)], [1, 0, 1, 3]); // header, three accounts
  assert.equal(base58Encode(message.subarray(4, 36)), FAUCET.address); // fee payer and sender
  assert.equal(base58Encode(message.subarray(36, 68)), WALLET.address); // recipient
  assert.equal(base58Encode(message.subarray(68, 100)), '11111111111111111111111111111111'); // System Program
  assert.equal(base58Encode(message.subarray(100, 132)), BLOCKHASH);
  assert.deepEqual([...message.subarray(132, 137)], [1, 2, 2, 0, 1]); // one instruction: program 2, accounts 0 and 1
  assert.equal(message[137], 12);
  const data = new DataView(message.buffer, message.byteOffset + 138, 12);
  assert.equal(data.getUint32(0, true), 2); // Transfer
  assert.equal(data.getBigUint64(4, true), 200_000_000n);
  assert.equal(message.length, 150);
  assert.ok(logs.some((l) => l.includes('faucet_sent') && l.includes(WALLET.address)));
});

test('the amount comes from FAUCET_LAMPORTS; a value that is not whole lamports up to 1 SOL stops the faucet', async (t) => {
  assert.equal(parseLamports(undefined), DEFAULT_LAMPORTS);
  assert.equal(parseLamports(' 150000000 '), 150_000_000);
  for (const bad of ['abc', '0', '-5', '1.5', '1000000001', '99999999999', '2e8']) assert.equal(parseLamports(bad), null, bad);

  const { calls, post, errors } = setup(t);
  const res = await post({ address: WALLET.address }, { ...ENV, FAUCET_LAMPORTS: '150000000' });
  assert.equal((await answer(res)).lamports, 150_000_000);
  const wire = Buffer.from(calls.at(-1)!.params[0], 'base64');
  assert.equal(wire.readBigUInt64LE(65 + 138 + 4), 150_000_000n);

  resetFaucetState();
  const bad = await post({ address: OTHER.address }, { ...ENV, FAUCET_LAMPORTS: '5000000000' });
  assert.equal(bad.status, 503);
  assert.equal((await answer(bad)).error, 'unavailable');
  assert.match(errors.at(-1)!, /FAUCET_LAMPORTS/);
});

test('bad_address: anything that is not a wallet, with no RPC call', async (t) => {
  const { calls, post } = setup(t);
  const cases: [string, unknown][] = [
    ['not JSON', 'nonsense'],
    ['no address', {}],
    ['null body', 'null'],
    ['a number', { address: 5 }],
    ['an array', { address: [WALLET.address] }],
    ['empty', { address: '' }],
    ['too short', { address: WALLET.address.slice(0, 20) }],
    ['not base58', { address: `0OIl${WALLET.address.slice(4)}` }],
    ['spaces', { address: ` ${WALLET.address}` }],
    ['too long', { address: `${WALLET.address}1` }],
    ['44 characters of 32 bytes plus one', { address: 'z'.repeat(44) }],
    ['a PDA: 32 bytes that are not a point on the curve', { address: PDA }],
    ['the System Program (on the curve, never funded)', { address: '11111111111111111111111111111111' }],
    ['the FlipTheMeme program', { address: '5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz' }],
    ['its Config PDA', { address: 'A6k9oP8NT249nCM1g6DupAKgVT7dHLyGwbFn5VLbA8RQ' }],
    ['the Token program', { address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }],
    ['the incinerator', { address: '1nc1nerator11111111111111111111111111111111' }],
    ['the faucet itself', { address: FAUCET.address }],
    ['the faucet by its public address', { address: 'DED8cZ5zo5yFSEgNAuGD4tFvrkd8se6t6i42SwWKgomp' }],
  ];
  for (const [name, body] of cases) {
    const res = await post(body);
    assert.equal(res.status, 400, name);
    const out = await answer(res);
    assert.equal(out.ok, false, name);
    assert.equal(out.error, 'bad_address', name);
    assert.ok(out.message && out.message.length < 100, name);
  }
  assert.deepEqual(calls, []);
});

test('the list of addresses that are never funded holds only 32-byte addresses', () => {
  for (const address of UNFUNDABLE) assert.equal(base58Decode(address)?.length, 32, address);
  assert.equal(walletBytes(WALLET.address)?.length, 32);
  assert.equal(walletBytes(PDA), null);
});

test('already_funded: 0.1 SOL or more on devnet needs no faucet; just under it does', async (t) => {
  const { chain, calls, post } = setup(t, { wallet: ALREADY_FUNDED_LAMPORTS });
  const res = await post({ address: WALLET.address });
  assert.equal(res.status, 409);
  const out = await answer(res);
  assert.equal(out.error, 'already_funded');
  assert.equal(out.ok, false);
  assert.ok(!calls.some((c) => c.method === 'sendTransaction'));

  chain.wallet = 3 * SOL;
  assert.equal((await post({ address: WALLET.address })).status, 409);
  chain.wallet = ALREADY_FUNDED_LAMPORTS - 1;
  assert.equal((await post({ address: WALLET.address })).status, 200);
});

test('a wallet that does not exist yet (no account) is funded', async (t) => {
  const { post } = setup(t, { wallet: null });
  assert.equal((await post({ address: WALLET.address })).status, 200);
});

test('faucet_empty: the faucet keeps 1 SOL, so it sends only while its balance after the transfer stays at or above it', async (t) => {
  assert.equal(RESERVE_LAMPORTS, SOL);
  const { chain, calls, post, errors } = setup(t, { faucet: 1.1 * SOL });
  const res = await post({ address: WALLET.address });
  assert.equal(res.status, 503);
  const out = await answer(res);
  assert.equal(out.error, 'faucet_empty');
  assert.ok(!calls.some((c) => c.method === 'sendTransaction'));
  assert.ok(errors.some((e) => e.includes('faucet_empty')));

  chain.faucet = RESERVE_LAMPORTS + DEFAULT_LAMPORTS - 1;
  assert.equal((await answer(await post({ address: WALLET.address }))).error, 'faucet_empty');
  chain.faucet = RESERVE_LAMPORTS + DEFAULT_LAMPORTS;
  assert.equal((await post({ address: WALLET.address })).status, 200);
  chain.faucet = null; // the faucet account does not exist
  assert.equal((await answer(await post({ address: OTHER.address }))).error, 'faucet_empty');
});

test('rate_limited: the Workers binding is asked per IP and per wallet, only for a valid request', async (t) => {
  const { calls, post } = setup(t);
  const asked: string[] = [];
  const blocked = new Set<string>();
  const limiter: RateLimiter = {
    limit: async ({ key }) => {
      asked.push(key);
      return { success: !blocked.has(key) };
    },
  };
  const env = { ...ENV, FAUCET_LIMITER: limiter };
  const ip = { 'cf-connecting-ip': '203.0.113.7' };

  // Garbage never reaches the limiter.
  assert.equal((await post({ address: 'nope' }, env, ip)).status, 400);
  assert.deepEqual(asked, []);

  assert.equal((await post({ address: WALLET.address }, env, ip)).status, 200);
  assert.deepEqual(asked, ['ip:203.0.113.7', `wallet:${WALLET.address}`]);

  // The same IP, another wallet.
  blocked.add('ip:203.0.113.7');
  const byIp = await post({ address: OTHER.address }, env, ip);
  assert.equal(byIp.status, 429);
  assert.equal(byIp.headers.get('retry-after'), '60');
  const out = await answer(byIp);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'rate_limited');
  // Another IP, the same wallet.
  blocked.clear();
  blocked.add(`wallet:${OTHER.address}`);
  assert.equal((await post({ address: OTHER.address }, env, { 'cf-connecting-ip': '198.51.100.2' })).status, 429);
  assert.equal(calls.filter((c) => c.method === 'sendTransaction').length, 1);

  // A binding that fails does not stop the faucet; neither does no binding at all.
  const broken: RateLimiter = {
    limit: async () => {
      throw new Error('limiter down');
    },
  };
  assert.equal((await post({ address: OTHER.address }, { ...ENV, FAUCET_LIMITER: broken }, ip)).status, 200);
});

test('the same wallet twice (a double tap, or in flight together) is paid once', async (t) => {
  const { calls, post } = setup(t);
  const [a, b] = await Promise.all([post({ address: WALLET.address }), post({ address: WALLET.address })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(calls.filter((c) => c.method === 'sendTransaction').length, 1);
  // The balance does not show it yet: the isolate remembers.
  const again = await post({ address: WALLET.address });
  assert.equal(again.status, 409);
  assert.equal((await answer(again)).error, 'already_funded');
  assert.equal(calls.filter((c) => c.method === 'sendTransaction').length, 1);
});

test('unavailable without a usable key: nothing is sent, nothing secret is logged, no RPC is asked', async (t) => {
  const { calls, post, errors } = setup(t);
  const wrongHalves = new Uint8Array(64);
  wrongHalves.set(base58Decode(FAUCET.secret)!.subarray(0, 32), 0);
  wrongHalves.set(base58Decode(OTHER.secret)!.subarray(32), 32);
  const envs: [string, FaucetEnv][] = [
    ['no key', { EXPECTED_FAUCET_ADDRESS: FAUCET.address }],
    ['no expected address', { FAUCET_KEY: FAUCET.secret }],
    ['not base58', { ...ENV, FAUCET_KEY: 'not-a-key!' }],
    ['a 32-byte seed only', { ...ENV, FAUCET_KEY: base58Encode(base58Decode(FAUCET.secret)!.subarray(0, 32)) }],
    ['the halves of two keys', { ...ENV, FAUCET_KEY: base58Encode(wrongHalves) }],
    ['a key for another address', { ...ENV, EXPECTED_FAUCET_ADDRESS: OTHER.address }],
    ['the project faucet address expected, a test key given', { ...ENV, EXPECTED_FAUCET_ADDRESS: 'DED8cZ5zo5yFSEgNAuGD4tFvrkd8se6t6i42SwWKgomp' }],
  ];
  for (const [name, env] of envs) {
    const res = await post({ address: WALLET.address }, env);
    assert.equal(res.status, 503, name);
    const out = await answer(res);
    assert.equal(out.error, 'unavailable', name);
    assert.ok(!JSON.stringify(out).includes(FAUCET.address), `${name}: the answer names no address`);
  }
  assert.deepEqual(calls, []);
  assert.equal(errors.length, envs.length);
  for (const line of errors) {
    assert.ok(!line.includes(FAUCET.secret) && !line.includes(OTHER.secret), 'a secret was logged');
    assert.ok(!line.includes(base58Encode(base58Decode(FAUCET.secret)!.subarray(0, 32))), 'the seed was logged');
  }
  assert.match(errors[1]!, /EXPECTED_FAUCET_ADDRESS is not set/);
  assert.match(errors[5]!, /EXPECTED_FAUCET_ADDRESS/);
  // The right pair works.
  assert.equal((await post({ address: WALLET.address })).status, 200);
});

test('loadFaucetKey signs for the address it reports', async () => {
  const key = await loadFaucetKey(FAUCET.secret, FAUCET.address);
  assert.equal(key.address, FAUCET.address);
  const message = new TextEncoder().encode('hello');
  const verifier = await crypto.subtle.importKey('raw', FAUCET.pub, 'Ed25519', false, ['verify']);
  assert.ok(await crypto.subtle.verify('Ed25519', verifier, await key.sign(message), message));
  await assert.rejects(loadFaucetKey(FAUCET.secret, OTHER.address), /EXPECTED_FAUCET_ADDRESS/);
});

test('RPC: DEVNET_RPC first, then OnFinality, then api.devnet.solana.com; 403 and 429 move on; a keyed URL is never logged', async (t) => {
  const keyed = 'https://devnet.keyed.example/?api-key=super-secret-key';
  const { calls, post, warnings, errors } = setup(t, {
    failing: new Map([
      ['devnet.keyed.example', 429],
      ['solana-devnet.api.onfinality.io', 403],
    ]),
  });
  const res = await post({ address: WALLET.address }, { ...ENV, DEVNET_RPC: keyed });
  assert.equal(res.status, 200);
  assert.deepEqual(
    calls.map((c) => c.host),
    [
      'devnet.keyed.example',
      'solana-devnet.api.onfinality.io',
      'api.devnet.solana.com', // getMultipleAccounts answered by the third
      'devnet.keyed.example',
      'solana-devnet.api.onfinality.io',
      'api.devnet.solana.com', // getLatestBlockhash
      'devnet.keyed.example',
      'solana-devnet.api.onfinality.io',
      'api.devnet.solana.com', // sendTransaction
    ],
  );
  assert.deepEqual(DEVNET_RPCS, ['https://solana-devnet.api.onfinality.io/public', 'https://api.devnet.solana.com']);
  assert.ok(warnings.length >= 6 && warnings.every((w) => !w.includes('super-secret-key') && !w.includes('api-key')));
  assert.equal(errors.length, 0);

  // A DEVNET_RPC that is not https is ignored.
  calls.length = 0;
  resetFaucetState();
  await post({ address: OTHER.address }, { ...ENV, DEVNET_RPC: 'http://insecure.example/' });
  assert.ok(calls.every((c) => c.host !== 'insecure.example'));
});

test('unavailable: no RPC answers, or the transfer is refused; the wallet may ask again afterwards', async (t) => {
  const { chain, calls, post, errors } = setup(t, {
    failing: new Map([
      ['solana-devnet.api.onfinality.io', 403],
      ['api.devnet.solana.com', 429],
    ]),
  });
  const down = await post({ address: WALLET.address });
  assert.equal(down.status, 503);
  const out = await answer(down);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'unavailable');
  assert.deepEqual(calls.map((c) => c.host), ['solana-devnet.api.onfinality.io', 'api.devnet.solana.com']);
  assert.match(errors.at(-1)!, /getMultipleAccounts: no RPC answered/);

  chain.failing.clear();
  chain.rpcErrors.add('sendTransaction'); // every endpoint refuses the transfer
  const refused = await post({ address: WALLET.address });
  assert.equal(refused.status, 503);
  assert.equal((await answer(refused)).error, 'unavailable');
  assert.equal(calls.filter((c) => c.method === 'sendTransaction').length, 2); // one per endpoint

  chain.rpcErrors.clear();
  assert.equal((await post({ address: WALLET.address })).status, 200); // not remembered as funded
});

test('every RPC call has a 3 s timeout per endpoint, inside a budget under the 12 s the app waits', async (t) => {
  resetFaucetState();
  const asked: number[] = [];
  const real = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    asked.push(ms);
    return real(20);
  });
  t.mock.method(console, 'warn', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(globalThis, 'fetch', (_url: string, init: { signal: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }),
  );
  const keep = setTimeout(() => undefined, 10_000); // AbortSignal.timeout timers are unref'd
  try {
    const res = await faucet(
      new Request(URL_FAUCET, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: WALLET.address }) }),
      ENV,
    );
    assert.equal(res.status, 503);
    assert.equal((await answer(res)).error, 'unavailable');
  } finally {
    clearTimeout(keep);
  }
  assert.equal(asked.length, 2); // OnFinality and api.devnet.solana.com
  assert.ok(asked.every((ms) => ms <= 3_000 && ms > 2_000), asked.join());
});

test('only POST with application/json and a body of at most 512 bytes', async (t) => {
  const { calls, post } = setup(t);
  const get = await faucet(new Request(URL_FAUCET), ENV);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await answer(get)).ok, false);
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    assert.equal((await faucet(new Request(URL_FAUCET, { method, body: '{}' }), ENV)).status, 405, method);
  }

  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonx', '']) {
    const res = await faucet(new Request(URL_FAUCET, { method: 'POST', headers: type ? { 'content-type': type } : {}, body: JSON.stringify({ address: WALLET.address }) }), ENV);
    assert.equal(res.status, 415, type);
    assert.equal((await answer(res)).error, 'unsupported_media_type');
  }
  assert.equal((await post({ address: WALLET.address }, ENV, { 'content-type': 'Application/JSON; charset=utf-8' })).status, 200);

  // Exactly 512 bytes pass, one more does not, declared or streamed.
  const exact = JSON.stringify({ address: OTHER.address }).padEnd(MAX_BODY_BYTES, ' ');
  assert.equal(exact.length, 512);
  assert.equal((await post(exact)).status, 200);
  const over = await post(`${exact} `);
  assert.equal(over.status, 413);
  assert.equal((await answer(over)).error, 'body_too_large');
  assert.equal((await post(JSON.stringify({ address: WALLET.address }), ENV, { 'content-length': '5000' })).status, 413);
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(256).fill(32));
      if (pulled === 64) controller.close();
    },
  });
  const streamed = await faucet(
    new Request(URL_FAUCET, { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit),
    ENV,
  );
  assert.equal(streamed.status, 413);
  assert.ok(pulled < 10, `read ${pulled} chunks of a 64-chunk body`);
  // A body that is not UTF-8.
  assert.equal((await post(new TextDecoder('latin1').decode(new Uint8Array([0x7b, 0xff, 0x7d])))).status, 400);
  assert.equal(calls.filter((c) => c.method === 'sendTransaction').length, 2);
});

test('the Worker routes /v1/faucet to the faucet and leaves the pages and /v1/names alone', async (t) => {
  const { post } = setup(t);
  const ctx = { waitUntil: () => undefined };
  const viaWorker = await worker.fetch(
    new Request(URL_FAUCET, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: WALLET.address }) }),
    ENV,
    ctx,
  );
  assert.equal(viaWorker.status, 200);
  assert.equal((await answer(viaWorker)).ok, true);
  assert.equal((await worker.fetch(new Request(URL_FAUCET), ENV, ctx)).status, 405);
  assert.equal((await worker.fetch(new Request('https://sol.flipthememe.com/get'), ENV, ctx)).status, 200);
  assert.equal((await worker.fetch(new Request('https://sol.flipthememe.com/v1/names?a=x'), ENV, ctx)).status, 400);
  assert.ok(post);
});

test('the message and the wire transaction have the layout of a legacy System transfer', () => {
  const payer = new Uint8Array(32).fill(1);
  const to = new Uint8Array(32).fill(2);
  const blockhash = new Uint8Array(32).fill(3);
  const message = transferMessage(payer, to, 123_456_789n, blockhash);
  assert.equal(message.length, 150);
  assert.deepEqual([...message.subarray(0, 4)], [1, 0, 1, 3]);
  assert.deepEqual([...message.subarray(4, 36)], [...payer]);
  assert.deepEqual([...message.subarray(36, 68)], [...to]);
  assert.deepEqual([...message.subarray(68, 100)], new Array(32).fill(0));
  assert.deepEqual([...message.subarray(100, 132)], [...blockhash]);
  assert.deepEqual([...message.subarray(132, 138)], [1, 2, 2, 0, 1, 12]);
  assert.deepEqual([...message.subarray(138, 146)], [2, 0, 0, 0, 0x15, 0xcd, 0x5b, 0x07]); // Transfer, 123456789 little-endian
  const signature = new Uint8Array(64).fill(7);
  const wire = wireTransaction(signature, message);
  assert.equal(wire.length, 215);
  assert.deepEqual([...wire.subarray(0, 2)], [1, 7]);
  assert.deepEqual([...wire.subarray(65)], [...message]);
});
