import { readFile } from 'node:fs/promises';
import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit';

/** The keeper key pays every fee; the price and house roles may have keys of their own. */
export type RoleSigners = { keeper: KeyPairSigner; price: KeyPairSigner; house: KeyPairSigner };

/**
 * KEEPER_KEYPAIR, plus PRICE_KEYPAIR and HOUSE_KEYPAIR when set; an unset role falls back to the
 * keeper key. A role file holding the keeper's own key reuses the keeper signer, because kit
 * refuses two signer objects for one address in a transaction.
 */
export async function loadRoleSigners(paths: { keypairPath: string; priceKeypairPath: string | null; houseKeypairPath: string | null }): Promise<RoleSigners> {
  const keeper = await loadKeypairSigner(paths.keypairPath);
  const role = async (path: string | null): Promise<KeyPairSigner> => {
    if (path === null) return keeper;
    const signer = await loadKeypairSigner(path);
    return signer.address === keeper.address ? keeper : signer;
  };
  const price = await role(paths.priceKeypairPath);
  const house = await role(paths.houseKeypairPath);
  return { keeper, price, house: house.address === price.address ? price : house };
}

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
