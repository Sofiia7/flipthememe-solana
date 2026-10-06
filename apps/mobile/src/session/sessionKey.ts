// The device key: an ed25519 keypair made on this phone. The owner's wallet authorises it once
// (start_session) to place one-tap bets up to a max per bet; it can never withdraw. Signing is pure JS
// (@noble/curves), not WebCrypto, so it works the same on every Android build.
import * as SecureStore from 'expo-secure-store';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  getAddressDecoder,
  type Address,
  type SignatureBytes,
  type TransactionPartialSigner,
} from '@solana/kit';

const STORE_KEY = 'ftm.session.v1';

export type SessionKey = {
  address: Address;
  signer: TransactionPartialSigner;
};

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomSecret(): Uint8Array {
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  if (secret.every((b) => b === 0)) throw new Error('The secure random source returned zeros');
  return secret;
}

export function sessionKeyFromSecret(secret: Uint8Array): SessionKey {
  const publicKey = ed25519.getPublicKey(secret);
  const address = getAddressDecoder().decode(publicKey);
  const signer: TransactionPartialSigner = Object.freeze({
    address,
    signTransactions: async (transactions) =>
      transactions.map((tx) =>
        Object.freeze({ [address]: ed25519.sign(tx.messageBytes as unknown as Uint8Array, secret) as SignatureBytes }),
      ),
  });
  return { address, signer };
}

/** Loads the device key from secure storage, creating it on first use. */
export async function loadOrCreateSessionKey(): Promise<SessionKey> {
  const stored = await SecureStore.getItemAsync(STORE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as { v?: number; secret?: string };
      const secret = parsed.v === 1 && parsed.secret ? fromHex(parsed.secret) : null;
      if (secret) return sessionKeyFromSecret(secret);
    } catch {
      // Unreadable entry: replace it below. Funds never sit on the key beyond fee money.
    }
  }
  const secret = randomSecret();
  await SecureStore.setItemAsync(STORE_KEY, JSON.stringify({ v: 1, secret: toHex(secret) }));
  return sessionKeyFromSecret(secret);
}
