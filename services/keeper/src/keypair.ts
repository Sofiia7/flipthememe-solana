import { readFile } from 'node:fs/promises';
import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit';

/**
 * Loads a solana-keygen JSON file (an array of 64 numbers: secret key then public key).
 * Errors never quote the file contents, so a malformed key cannot leak into logs.
 */
export async function loadKeypairSigner(path: string): Promise<KeyPairSigner> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'read error';
    throw new Error(`cannot read keeper keypair file ${path} (${code})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`keeper keypair file ${path} is not valid JSON`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    throw new Error(`keeper keypair file ${path} must be a JSON array of 64 bytes (solana-keygen format)`);
  }
  const bytes = Uint8Array.from(parsed as number[]);
  try {
    return await createKeyPairSignerFromBytes(bytes);
  } catch {
    throw new Error(`keeper keypair file ${path} holds an invalid ed25519 key pair`);
  } finally {
    bytes.fill(0);
    (parsed as number[]).fill(0);
  }
}
