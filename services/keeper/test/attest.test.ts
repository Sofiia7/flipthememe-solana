// The attestor contract: POST ${ATTEST_URL}/v1/attest with {"tx": "<base64 wire transaction>"},
// answer {"signature": "<base58>"} or an error JSON with a reason. Mock fetch, fake devnet.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setStrike } from '@flipthememe/client';
import { generateKeyPairSigner, getBase58Decoder, getPublicKeyFromAddress, verifySignature, type SignatureBytes } from '@solana/kit';
import { AttestorClient, sendAttested, type FetchLike } from '../src/attest.ts';
import { fakeAttestor, reply } from './fake-attestor.ts';
import { FakeChain } from './fake-chain.ts';

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
const SIG = getBase58Decoder().decode(new Uint8Array(64).fill(7));
const later = () => Date.now() + 60_000;

/** A fetch that answers from `answers` in turn and records what it was sent. */
function fakeFetch(answers: (() => ReturnType<typeof reply> | Promise<never>)[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (!next) throw new Error('no answer');
    return next();
  };
  return { fetch, calls };
}

describe('AttestorClient', () => {
  test('posts only the transaction and returns the signature bytes', async () => {
    const { fetch, calls } = fakeFetch([() => reply(200, { signature: SIG })]);
    const client = new AttestorClient({ url: 'https://attest.example/', fetch });
    const result = await client.attest('AQID', later());
    assert.equal(result.kind, 'ok');
    assert.deepEqual(result.kind === 'ok' ? [...result.signature] : [], new Array(64).fill(7));
    // No ATTEST_TOKEN: no authorization header.
    assert.deepEqual(calls, [{ url: 'https://attest.example/v1/attest', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"tx":"AQID"}' }]);
  });

  test('with ATTEST_TOKEN every POST carries it as a bearer token; a 401 is refused as unauthorized', async () => {
    const { fetch, calls } = fakeFetch([() => reply(503, {}), () => reply(200, { signature: SIG })]);
    const client = new AttestorClient({ url: 'https://attest.example', token: 's3cret-token', fetch, pauseMs: 1 });
    assert.equal((await client.attest('AQID', later())).kind, 'ok');
    assert.deepEqual(
      calls.map((c) => c.headers),
      [
        { 'content-type': 'application/json', authorization: 'Bearer s3cret-token' },
        { 'content-type': 'application/json', authorization: 'Bearer s3cret-token' },
      ],
    );
    assert.deepEqual(calls.map((c) => c.body), ['{"tx":"AQID"}', '{"tx":"AQID"}']);
    const denied = fakeFetch([() => reply(401, { error: 'missing or wrong bearer token' })]);
    const result = await new AttestorClient({ url: 'https://attest.example', token: 'wrong', fetch: denied.fetch }).attest('AQID', later());
    assert.deepEqual(result, { kind: 'refused', reason: 'unauthorized', status: 401, attempts: 1 });
    assert.equal(denied.calls.length, 1);
    // The client never shows the token: not in its own fields, not in a result.
    assert.doesNotMatch(JSON.stringify({ client, result }), /s3cret|wrong/);
  });

  test('a refusal comes back with its reason and is not repeated', async () => {
    const refused = fakeFetch([() => reply(422, { reason: 'samples disagree with the pool' })]);
    assert.deepEqual(await new AttestorClient({ url: 'https://a.example', fetch: refused.fetch }).attest('AQID', later()), {
      kind: 'refused',
      reason: 'samples disagree with the pool',
      status: 422,
      attempts: 1,
    });
    assert.equal(refused.calls.length, 1);
    const plain = fakeFetch([() => reply(403, { error: 'not a settle of this program' })]);
    const result = await new AttestorClient({ url: 'https://a.example', fetch: plain.fetch }).attest('AQID', later());
    assert.equal(result.kind === 'refused' ? result.reason : null, 'not a settle of this program');
  });

  test('5xx, 429 and answers without a signature are failures, retried up to the attempt limit', async () => {
    const recovers = fakeFetch([() => reply(503, {}), () => reply(200, { signature: SIG })]);
    const ok = await new AttestorClient({ url: 'https://a.example', fetch: recovers.fetch, pauseMs: 1 }).attest('AQID', later());
    assert.deepEqual([ok.kind, ok.attempts], ['ok', 2]);
    const limited = fakeFetch([() => reply(429, { error: 'slow down' })]);
    assert.deepEqual(await new AttestorClient({ url: 'https://a.example', fetch: limited.fetch, pauseMs: 1 }).attest('AQID', later()), {
      kind: 'failed',
      reason: 'HTTP 429: slow down',
      attempts: 2,
    });
    const garbled = fakeFetch([() => reply(200, { signature: 'not-base58-0OIl' })]);
    const bad = await new AttestorClient({ url: 'https://a.example', fetch: garbled.fetch, attempts: 1 }).attest('AQID', later());
    assert.deepEqual(bad, { kind: 'failed', reason: 'answer without a 64-byte base58 signature', attempts: 1 });
  });

  test('a silent attestor times out, and nothing is tried past the round deadline', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
    const slow = await new AttestorClient({ url: 'https://a.example', fetch: hang, timeoutMs: 20, attempts: 1 }).attest('AQID', later());
    assert.deepEqual(slow, { kind: 'failed', reason: 'timeout', attempts: 1 });
    const never = fakeFetch([() => reply(200, { signature: SIG })]);
    const late = await new AttestorClient({ url: 'https://a.example', fetch: never.fetch }).attest('AQID', Date.now() - 1);
    assert.deepEqual([late.kind, late.attempts, never.calls.length], ['failed', 0, 0]);
  });
});

describe('sendAttested', () => {
  test('sends the transaction completed with a signature that verifies for the attestor', async () => {
    const keeper = await generateKeyPairSigner();
    const chain = new FakeChain(keeper.address);
    const attestor = await fakeAttestor();
    const ix = await setStrike({ priceAuthority: keeper, roundId: 7n, samples: [{ slot: 1n, price: 2n }], attestor: attestor.address });
    const client = new AttestorClient({ url: 'https://a.example', fetch: attestor.fetch });
    const sent = await sendAttested(chain.rpc(), keeper, [ix], attestor.address, client, later());
    assert.equal(sent.kind, 'sent');
    assert.equal(attestor.seen.length, 1);
    assert.deepEqual(Object.keys(JSON.parse(attestor.seen[0] ?? '{}')), ['tx']);
    const [tx] = chain.signed;
    assert.ok(tx);
    // Fee payer first, then the attestor: both signatures present and valid for the message.
    assert.deepEqual(Object.keys(tx.signatures), [keeper.address, attestor.address]);
    const key = await getPublicKeyFromAddress(attestor.address);
    assert.equal(await verifySignature(key, tx.signatures[attestor.address] as SignatureBytes, tx.messageBytes), true);
  });

  test('a signature that does not verify is never sent', async () => {
    const keeper = await generateKeyPairSigner();
    const chain = new FakeChain(keeper.address);
    const attestor = await fakeAttestor();
    attestor.mode = 'forge';
    const ix = await setStrike({ priceAuthority: keeper, roundId: 7n, samples: [], attestor: attestor.address });
    const sent = await sendAttested(chain.rpc(), keeper, [ix], attestor.address, new AttestorClient({ url: 'https://a.example', fetch: attestor.fetch }), later());
    assert.deepEqual(sent, { kind: 'not-attested', attest: { kind: 'failed', reason: 'signature does not verify for the attestor', attempts: 1 } });
    assert.equal(chain.sent.length, 0);
  });
});
