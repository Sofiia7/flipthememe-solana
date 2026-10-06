// Run: node --test "services/attestor/test/*.test.ts" (from the repo root). No network.
// The attestor signs with WebCrypto Ed25519; @noble/curves is the independent reference.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { getBase58Decoder } from '@solana/kit';
import { KeyError, loadAttestorKey } from '../src/key.ts';
import { ATTESTOR, ATTESTOR_PUBLIC, ATTESTOR_SECRET, ATTESTOR_SEED, ATTESTOR_SEED_SECRET } from './helpers.ts';

const base58 = getBase58Decoder();

test('both secret forms, 64-byte secret key and 32-byte seed, give the key @noble/curves derives', async () => {
  assert.equal((await loadAttestorKey(ATTESTOR_SECRET)).address, ATTESTOR);
  assert.equal((await loadAttestorKey(` ${ATTESTOR_SEED_SECRET}\n`)).address, ATTESTOR);
  assert.equal(ATTESTOR, base58.decode(ATTESTOR_PUBLIC));
});

test('WebCrypto signatures equal @noble/curves signatures, and each verifies the other', async () => {
  const fromSecretKey = await loadAttestorKey(ATTESTOR_SECRET);
  const fromSeed = await loadAttestorKey(ATTESTOR_SEED_SECRET);
  const verifier = await crypto.subtle.importKey('raw', ATTESTOR_PUBLIC, 'Ed25519', false, ['verify']);
  for (const message of [new Uint8Array(0), new TextEncoder().encode('set_strike'), crypto.getRandomValues(new Uint8Array(900))]) {
    const signature = await fromSecretKey.sign(message);
    assert.equal(signature.length, 64);
    // Ed25519 is deterministic (RFC 8032): both implementations must produce the same bytes.
    const reference = ed25519.sign(message, ATTESTOR_SEED);
    assert.deepEqual(signature, reference);
    assert.deepEqual(await fromSeed.sign(message), reference);
    assert.equal(ed25519.verify(signature, message, ATTESTOR_PUBLIC), true);
    assert.equal(await crypto.subtle.verify('Ed25519', verifier, reference, message), true);
    const other = new Uint8Array(message.length + 1);
    other.set(message, 0);
    assert.equal(ed25519.verify(signature, other, ATTESTOR_PUBLIC), false);
  }
});

test('bad secrets fail with a clear message that holds no part of the secret', async () => {
  const otherPublic = ed25519.getPublicKey(new Uint8Array(32).fill(8));
  const mismatched = new Uint8Array(64);
  mismatched.set(ATTESTOR_SEED, 0);
  mismatched.set(otherPublic, 32);
  const cases: [string | undefined, RegExp][] = [
    [undefined, /not set/],
    ['   ', /not set/],
    [`${ATTESTOR_SECRET.slice(0, 40)}0OIl${ATTESTOR_SECRET.slice(44)}`, /not base58/],
    [ATTESTOR_SEED_SECRET.slice(0, 30), /expected 64 \(secret key\) or 32 \(seed\)/],
    [base58.decode(mismatched), /not the public key/],
  ];
  for (const [secret, message] of cases) {
    await assert.rejects(loadAttestorKey(secret), (error: unknown) => {
      assert.ok(error instanceof KeyError);
      assert.match(error.message, message);
      for (let i = 0; secret && i + 6 <= secret.trim().length; i++) {
        assert.ok(!error.message.includes(secret.trim().slice(i, i + 6)), `the message quotes the secret: ${error.message}`);
      }
      assert.equal((error as { cause?: unknown }).cause, undefined);
      return true;
    });
  }
});
