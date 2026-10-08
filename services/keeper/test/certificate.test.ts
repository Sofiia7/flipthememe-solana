import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attestedPriceInstructions, ED25519_PROGRAM, priceMessage, type RoundAccount } from '@flipthememe/client';
import { address, generateKeyPair, getAddressFromPublicKey, getBase58Decoder, signBytes } from '@solana/kit';
import { certificateInstructions } from '../src/certificate.ts';

const round = { id: 42n, pool: address('11111111111111111111111111111112'), strikeStart: 100n, strikeEnd: 110n, exitStart: 160n, exitEnd: 170n } as RoundAccount;
const samples = [{ slot: 9n, price: 123n }];

test('public certificate is verified before relaying; context, prices and signatures cannot be replaced', async () => {
  const keys = await generateKeyPair();
  const attestor = await getAddressFromPublicKey(keys.publicKey);
  const signature = getBase58Decoder().decode(await signBytes(keys.privateKey, await priceMessage(round, 'strike', samples)));
  const packet = { roundId: '42', kind: 'strike', attestor, signature, samples: [{ slot: '9', price: '123' }] };
  const fetcher = (body: unknown): typeof fetch => async (url, init) => {
    assert.equal(String(url), 'https://att.example/v1/attestation?round=42&kind=strike');
    assert.equal(init?.headers, undefined, 'no keeper token or credentials');
    return Response.json(body);
  };
  const instructions = await certificateInstructions('https://att.example/', round, 'strike', attestor, fetcher(packet));
  assert.equal(instructions[0]?.programAddress, ED25519_PROGRAM);
  assert.deepEqual(instructions, await attestedPriceInstructions(round, 'strike', samples, attestor, signature));
  for (const replacement of [{ roundId: '43' }, { kind: 'exit' }, { samples: [{ slot: '9', price: '124' }] }, { signature: signature.slice(1) }, { samples: [{ slot: '-1', price: '123' }] }]) {
    await assert.rejects(certificateInstructions('https://att.example/', round, 'strike', attestor, fetcher({ ...packet, ...replacement })));
  }
  for (const context of [{ ...round, id: 43n }, { ...round, pool: address('11111111111111111111111111111113') }, { ...round, strikeEnd: 111n }]) {
    assert.notDeepEqual(await priceMessage(context, 'strike', samples), await priceMessage(round, 'strike', samples));
  }
  assert.notDeepEqual(await priceMessage(round, 'exit', samples), await priceMessage(round, 'strike', samples));
});

test('unavailable or oversized certificates cannot produce a transaction', async () => {
  const attestor = address('11111111111111111111111111111112');
  for (const response of [new Response('', { status: 503 }), new Response('a'.repeat(8193))]) {
    await assert.rejects(certificateInstructions('https://att.example', round, 'strike', attestor, async () => response));
  }
});
