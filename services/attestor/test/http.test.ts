// Run: node --test "services/attestor/test/*.test.ts" (from the repo root). No network.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { MAX_BODY_BYTES, handle, type AttestorApi, type Result } from '../src/http.ts';

const URL_ATTEST = 'https://attestor.test/v1/attest';
const URL_HEALTH = 'https://attestor.test/v1/attestor';

function fakeApi(answer: Result = { status: 200, body: { signature: 'sig', attestor: 'key' } }) {
  const txs: string[] = [];
  const api: AttestorApi = {
    attest: async (tx) => {
      txs.push(tx);
      return answer;
    },
    health: async () => ({ status: 200, body: { attestor: 'key', sampler: {} } }),
  };
  return { api, txs };
}

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request(URL_ATTEST, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

test('POST /v1/attest hands the tx to the Durable Object and passes its answer through', async () => {
  const { api, txs } = fakeApi();
  const res = await handle(post(JSON.stringify({ tx: 'AQID' })), api);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { signature: 'sig', attestor: 'key' });
  assert.deepEqual(txs, ['AQID']);

  const refused = fakeApi({ status: 422, body: { error: 'keeper mean too far', reason: 'price_mismatch' } });
  const res422 = await handle(post(JSON.stringify({ tx: 'AQID' })), refused.api);
  assert.equal(res422.status, 422);
  assert.deepEqual(await res422.json(), { error: 'keeper mean too far', reason: 'price_mismatch' });
});

test(`oversized body: over ${MAX_BODY_BYTES} bytes is refused before the Durable Object, declared or streamed`, async () => {
  const { api, txs } = fakeApi();
  const exact = JSON.stringify({ tx: 'AQID' }).padEnd(MAX_BODY_BYTES, ' ');
  assert.equal((await handle(post(exact), api)).status, 200);

  const tooBig = await handle(post(`${exact} `), api);
  assert.equal(tooBig.status, 413);
  assert.deepEqual(await tooBig.json(), { error: `the body is limited to ${MAX_BODY_BYTES} bytes`, reason: 'body_too_large' });

  const declared = await handle(post(JSON.stringify({ tx: 'AQID' }), { 'content-length': '5000' }), api);
  assert.equal(declared.status, 413);

  // Streamed in chunks without a length: cut off once it passes the limit.
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(1024).fill(32));
      if (pulled === 64) controller.close();
    },
  });
  const streamed = await handle(new Request(URL_ATTEST, { method: 'POST', body: stream, duplex: 'half' } as RequestInit), api);
  assert.equal(streamed.status, 413);
  assert.ok(pulled < 10, `read ${pulled} chunks of a 64-chunk body`);
  assert.deepEqual(txs, ['AQID']);
});

test('bad bodies: not JSON, no tx, a tx that is not a string', async () => {
  const { api, txs } = fakeApi();
  // The last one is not UTF-8 at all: a 0xff byte between the braces.
  for (const body of ['not json', '{}', '{"tx": 5}', '{"tx": ""}', 'null', '[]', new Uint8Array([0x7b, 0xff, 0x7d])]) {
    const res = await handle(post(body), api);
    assert.equal(res.status, 400, String(body));
    assert.equal(((await res.json()) as { reason: string }).reason, 'bad_request');
  }
  assert.deepEqual(txs, []);
});

test('GET /v1/attestor is the health; wrong methods 405; other paths 404', async () => {
  const { api } = fakeApi();
  const health = await handle(new Request(URL_HEALTH), api);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { attestor: 'key', sampler: {} });

  const getAttest = await handle(new Request(URL_ATTEST), api);
  assert.equal(getAttest.status, 405);
  assert.equal(getAttest.headers.get('allow'), 'POST');
  const postHealth = await handle(new Request(URL_HEALTH, { method: 'POST', body: '{}' }), api);
  assert.equal(postHealth.status, 405);
  assert.equal((await handle(new Request('https://attestor.test/'), api)).status, 404);
  assert.equal((await handle(new Request('https://attestor.test/v1/attest/x', { method: 'POST', body: '{}' }), api)).status, 404);
});

test('ATTEST_TOKEN set: the bearer token is required', async () => {
  const { api, txs } = fakeApi();
  const env = { ATTEST_TOKEN: 's3cret-token' };
  const body = JSON.stringify({ tx: 'AQID' });
  assert.equal((await handle(post(body), api, env)).status, 401);
  assert.equal((await handle(post(body, { authorization: 'Bearer wrong' }), api, env)).status, 401);
  assert.equal((await handle(post(body, { authorization: 's3cret-token' }), api, env)).status, 401);
  assert.equal((await handle(post(body, { authorization: 'Bearer s3cret-token' }), api, env)).status, 200);
  assert.deepEqual(txs, ['AQID']);
  // The health stays public.
  assert.equal((await handle(new Request(URL_HEALTH), api, env)).status, 200);
});

test('a Durable Object that cannot be reached: 503 unavailable', async (t: TestContext) => {
  const errors: string[] = [];
  t.mock.method(console, 'error', (line: string) => void errors.push(line));
  const api: AttestorApi = {
    attest: async () => {
      throw new Error('Durable Object is overloaded');
    },
    health: async () => {
      throw new Error('Durable Object reset');
    },
  };
  for (const request of [post(JSON.stringify({ tx: 'AQID' })), new Request(URL_HEALTH)]) {
    const res = await handle(request, api);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { reason: string }).reason, 'unavailable');
  }
  assert.equal(errors.length, 2);
});
