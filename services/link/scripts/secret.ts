// Turns a solana-keygen keypair file (a JSON array of 64 numbers) into the FAUCET_KEY value: base58
// of the 64 bytes, written to stdout only, so it can go straight into wrangler unseen. From
// services\link in cmd.exe:
//
//   node scripts\secret.ts C:\Users\sofia\.flipthememe\faucet.json | npx wrangler secret put FAUCET_KEY
//
// The public address goes to stderr, with a check against EXPECTED_FAUCET_ADDRESS in wrangler.jsonc
// (the Worker sends nothing when they differ). Nothing is written to disk and nothing else is printed.
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { base58Encode } from '../src/names.ts';

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/secret.ts <keypair.json>');
  process.exit(2);
}
const numbers: unknown = JSON.parse(readFileSync(path, 'utf8'));
if (!Array.isArray(numbers) || numbers.length !== 64 || !numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
  console.error(`${path} is not a keypair file: expected a JSON array of 64 numbers from 0 to 255`);
  process.exit(1);
}
const bytes = Uint8Array.from(numbers as number[]);

// The last 32 bytes must be the public key of the first 32 (the PKCS#8 prefix of an Ed25519 seed + the seed).
const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(bytes.subarray(0, 32))]);
const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' });
if (!Buffer.from(spki.subarray(spki.length - 32)).equals(Buffer.from(bytes.subarray(32)))) {
  console.error(`${path}: its last 32 bytes are not the public key of its first 32`);
  process.exit(1);
}

const address = base58Encode(bytes.subarray(32));
const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const expected = /"EXPECTED_FAUCET_ADDRESS"\s*:\s*"([^"]+)"/.exec(wrangler)?.[1];
console.error(`faucet public key: ${address}`);
console.error(
  expected === address
    ? 'matches EXPECTED_FAUCET_ADDRESS in wrangler.jsonc'
    : `DOES NOT MATCH EXPECTED_FAUCET_ADDRESS in wrangler.jsonc (${expected ?? 'not set'}): the faucet would answer "unavailable"`,
);
process.stdout.write(base58Encode(bytes));
