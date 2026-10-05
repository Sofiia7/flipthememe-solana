import { getBase64Encoder, type Address, type Base58EncodedBytes } from '@solana/kit';
import {
  PROGRAM_ID,
  decodePosition,
  decodeRound,
  roundAddress,
  type PositionAccount,
  type RoundAccount,
} from '@flipthememe/client';
import type { SolanaRpc } from './rpc';

export type RoundView = { id: bigint; address: Address; account: RoundAccount };
export type PositionView = { address: Address; account: PositionAccount };
export type RawAccount = { data: Uint8Array; lamports: bigint };

/** Position = 8 + 32 + 32 + 1 + 8 + 8 + 1 + 1 + 8 + 1 bytes. */
export const POSITION_SIZE = 100n;

const base64 = getBase64Encoder();

export function accountBytes(data: readonly [string, string]): Uint8Array {
  return base64.encode(data[0]) as Uint8Array;
}

/** getMultipleAccounts (confirmed, base64) in chunks of 100; missing accounts come back as null. */
export async function fetchAccounts(rpc: SolanaRpc, addresses: readonly Address[]): Promise<(RawAccount | null)[]> {
  const out: (RawAccount | null)[] = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const { value } = await rpc.getMultipleAccounts(chunk, { encoding: 'base64', commitment: 'confirmed' }).send();
    for (const account of value) {
      out.push(account ? { data: accountBytes(account.data), lamports: BigInt(account.lamports) } : null);
    }
  }
  return out;
}

/** Positions whose 32-byte key at `offset` equals `key` (round @8, owner @40). */
export async function fetchPositionsBy(rpc: SolanaRpc, offset: number, key: Address): Promise<PositionView[]> {
  const rows = await rpc
    .getProgramAccounts(PROGRAM_ID, {
      encoding: 'base64',
      commitment: 'confirmed',
      filters: [
        { dataSize: POSITION_SIZE },
        { memcmp: { offset: BigInt(offset), bytes: key as unknown as Base58EncodedBytes, encoding: 'base58' } },
      ],
    })
    .send();
  const out: PositionView[] = [];
  for (const row of rows) {
    try {
      out.push({ address: row.pubkey, account: decodePosition(accountBytes(row.account.data)) });
    } catch {
      // Not a Position (wrong discriminator): skip.
    }
  }
  return out;
}

const roundAddressCache = new Map<bigint, Promise<Address>>();

export function roundAddressCached(id: bigint): Promise<Address> {
  let found = roundAddressCache.get(id);
  if (!found) {
    found = roundAddress(id);
    found.catch(() => roundAddressCache.delete(id));
    roundAddressCache.set(id, found);
  }
  return found;
}

export function decodeRoundSafe(raw: RawAccount | null): RoundAccount | null {
  if (!raw) return null;
  try {
    return decodeRound(raw.data);
  } catch {
    return null;
  }
}

export const byIdDesc = (a: { id: bigint }, b: { id: bigint }) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0);
