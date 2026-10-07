// Node tests for the project's test SOL faucet client: the response parser and the request with a fake
// fetch (no React Native). Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAUCET_TEXT, FaucetError, isFaucetError, parseFaucetResponse, requestFaucet } from '../wallet/faucet.ts';
import { humanError } from '../lib/errors.ts';

const SIGNATURE = '5'.repeat(88);
const ADDRESS = '11111111111111111111111111111111';

test('a 200 with ok:true is a drip: the signature is kept, the amount is exact lamports', () => {
  const out = parseFaucetResponse(200, { ok: true, signature: SIGNATURE, lamports: 200_000_000 });
  assert.deepEqual(out, { ok: true, signature: SIGNATURE, lamports: 200_000_000n });
  // An amount as a string (a server that keeps u64 safe) reads the same.
  const text = parseFaucetResponse(200, { ok: true, signature: SIGNATURE, lamports: '200000000' });
  assert.deepEqual(text, { ok: true, signature: SIGNATURE, lamports: 200_000_000n });
});

test('a success without a usable signature still is a success; one without an amount is not trusted', () => {
  assert.deepEqual(parseFaucetResponse(200, { ok: true, signature: 'not a signature!', lamports: 5 }), { ok: true, signature: null, lamports: 5n });
  assert.deepEqual(parseFaucetResponse(200, { ok: true, lamports: 5 }), { ok: true, signature: null, lamports: 5n });
  const noAmount = parseFaucetResponse(200, { ok: true, signature: SIGNATURE });
  assert.equal(noAmount.ok, false);
  for (const bad of [-1, 1.5, 'x', null, 2 ** 60]) {
    assert.equal(parseFaucetResponse(200, { ok: true, signature: SIGNATURE, lamports: bad }).ok, false, String(bad));
  }
});

test('ok:true on an error status is not a drip', () => {
  assert.equal(parseFaucetResponse(500, { ok: true, signature: SIGNATURE, lamports: 1 }).ok, false);
});

test('every error code gets our own sentence, never the server text; only the three dead ends show the other ways', () => {
  const codes = ['bad_address', 'already_funded', 'rate_limited', 'faucet_empty', 'unavailable'] as const;
  for (const code of codes) {
    const out = parseFaucetResponse(code === 'rate_limited' ? 429 : 400, { ok: false, error: code, message: 'RAW SERVER TEXT 0xdeadbeef' });
    assert.equal(out.ok, false);
    if (out.ok) continue;
    assert.equal(out.code, code);
    assert.equal(out.message, FAUCET_TEXT[code].message);
    assert.ok(!/RAW|0x/.test(out.message), 'no server tail');
  }
  const fallbacks = codes.filter((c) => FAUCET_TEXT[c].fallbacks);
  assert.deepEqual(fallbacks, ['rate_limited', 'faucet_empty', 'unavailable']);
  const funded = parseFaucetResponse(409, { ok: false, error: 'already_funded', message: 'x' });
  assert.equal(funded.ok === false && funded.message, 'Your wallet already has devnet SOL.');
  assert.equal(funded.ok === false && funded.fallbacks, false);
});

test('an unknown code, an empty body or a bare status is "unavailable"; a bare 429 is a rate limit', () => {
  for (const [status, body] of [
    [500, { ok: false, error: 'something_new', message: 'hi' }],
    [502, null],
    [503, '<html>bad gateway</html>'],
    [400, {}],
    [200, []],
  ] as const) {
    const out = parseFaucetResponse(status, body);
    assert.equal(out.ok === false && out.code, 'unavailable', `${status}`);
    assert.equal(out.ok === false && out.fallbacks, true);
  }
  const limited = parseFaucetResponse(429, null);
  assert.equal(limited.ok === false && limited.code, 'rate_limited');
});

test('the request posts the address as JSON and reads the answer', async () => {
  let seen: { url: string; method: string; body: string; type: string | undefined } | null = null;
  const out = await requestFaucet(ADDRESS, {
    url: 'https://faucet.example/v1/faucet',
    timeoutMs: 1_000,
    fetchImpl: async (url, init) => {
      seen = { url, method: init.method, body: init.body, type: init.headers['content-type'] };
      return { status: 200, json: async () => ({ ok: true, signature: SIGNATURE, lamports: 200_000_000 }) };
    },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(seen, { url: 'https://faucet.example/v1/faucet', method: 'POST', body: JSON.stringify({ address: ADDRESS }), type: 'application/json' });
});

test('a network error, a body that is not JSON and a silent server all end as "unavailable"', async () => {
  const boom = await requestFaucet(ADDRESS, {
    url: 'x',
    timeoutMs: 1_000,
    fetchImpl: async () => {
      throw new TypeError('Network request failed');
    },
  });
  assert.equal(boom.ok === false && boom.code, 'unavailable');

  const html = await requestFaucet(ADDRESS, {
    url: 'x',
    timeoutMs: 1_000,
    fetchImpl: async () => ({
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }),
  });
  assert.equal(html.ok === false && html.code, 'unavailable');

  // A server that never answers: the timeout aborts the request (the keep-alive timer holds the loop open until then).
  const keep = setTimeout(() => undefined, 2_000);
  const silent = await requestFaucet(ADDRESS, {
    url: 'x',
    timeoutMs: 30,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  clearTimeout(keep);
  assert.equal(silent.ok === false && silent.code, 'unavailable');
  assert.equal(silent.ok === false && silent.fallbacks, true);
});

test('the wallet action throws the faucet sentence and humanError shows it unchanged', () => {
  for (const code of Object.keys(FAUCET_TEXT) as (keyof typeof FAUCET_TEXT)[]) {
    const error = new FaucetError({ ok: false, code, ...FAUCET_TEXT[code] });
    assert.ok(isFaucetError(error));
    assert.equal(humanError(error, 'faucet'), FAUCET_TEXT[code].message);
  }
  assert.ok(!isFaucetError(new Error('x')));
  assert.ok(!isFaucetError(null));
});
