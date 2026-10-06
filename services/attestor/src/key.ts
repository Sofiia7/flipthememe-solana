/**
 * The attestor's Ed25519 key, from the ATTESTOR_SECRET Worker secret: base58 of the 64-byte Solana
 * secret key (the 64 numbers of a solana-keygen keypair JSON, as bytes, in base58: what wallets
 * export as a "private key") or of its 32-byte seed (the first half). WebCrypto signs.
 *
 * Nothing here logs the secret, and no error message carries any part of it: errors from the
 * decoders are replaced, not wrapped.
 */
import {
  createKeyPairFromBytes,
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
  getBase58Encoder,
  signBytes,
  type Address,
} from '@solana/kit';

export type AttestorKey = {
  address: Address;
  /** Ed25519 signature of `message`, 64 bytes. */
  sign(message: Uint8Array): Promise<Uint8Array>;
};

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyError';
  }
}

export async function loadAttestorKey(secret: string | undefined): Promise<AttestorKey> {
  const text = secret?.trim();
  if (!text) throw new KeyError('ATTESTOR_SECRET is not set');
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(getBase58Encoder().encode(text));
  } catch {
    throw new KeyError('ATTESTOR_SECRET is not base58');
  }
  let pair: CryptoKeyPair;
  try {
    if (bytes.length === 64) pair = await createKeyPairFromBytes(bytes);
    else if (bytes.length === 32) pair = await createKeyPairFromPrivateKeyBytes(bytes);
    else throw new KeyError(`ATTESTOR_SECRET decodes to ${bytes.length} bytes; expected 64 (secret key) or 32 (seed)`);
  } catch (error) {
    if (error instanceof KeyError) throw error;
    throw new KeyError(
      bytes.length === 64
        ? 'ATTESTOR_SECRET: its last 32 bytes are not the public key of its first 32'
        : 'ATTESTOR_SECRET is not a usable Ed25519 key',
    );
  } finally {
    bytes.fill(0);
  }
  const address = await getAddressFromPublicKey(pair.publicKey);
  const { privateKey } = pair;
  return { address, sign: async (message) => new Uint8Array(await signBytes(privateKey, message)) };
}
