// Turns a solana-keygen keypair file (a JSON array of 64 numbers) into the ATTESTOR_SECRET value:
// base58 of the 64 bytes, written to stdout only, so it can go straight into wrangler unseen:
//
//   node scripts\secret.ts C:\keys\attestor.json | npx wrangler secret put ATTESTOR_SECRET
//
// The public key goes to stderr: it is the attestor address that set_oracle needs. Nothing is
// written to disk and nothing else is printed.
import { readFileSync } from 'node:fs';
import { createKeyPairFromBytes, getAddressFromPublicKey, getBase58Decoder } from '@solana/kit';

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
let pair: CryptoKeyPair;
try {
  pair = await createKeyPairFromBytes(bytes);
} catch {
  console.error(`${path}: its last 32 bytes are not the public key of its first 32`);
  process.exit(1);
}
console.error(`attestor public key: ${await getAddressFromPublicKey(pair.publicKey)}`);
process.stdout.write(getBase58Decoder().decode(bytes));
