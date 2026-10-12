import { getBase64Encoder, type Address, type Base58EncodedBytes } from '@solana/kit';
import {
  OFFSETS,
  PROGRAM_ID,
  decodePosition,
  decodeRound,
  decodeSession,
  roundAddress,
  type PositionAccount,
  type RoundAccount,
  type SessionAccount,
} from '@flipthememe/client';
import { setBounded } from '../lib/limits.ts';
import { SESSION_SPACE } from '../wallet/sessionList.ts';
import type { SolanaRpc } from './rpc';

export type RoundView = { id: bigint; address: Address; account: RoundAccount };
export type PositionView = { address: Address; account: PositionAccount; lamports?: bigint };
export type SessionView = { address: Address; account: SessionAccount };
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
      out.push({ address: row.pubkey, account: decodePosition(accountBytes(row.account.data)), lamports: BigInt(row.account.lamports) });
    } catch {
      // Not a Position (wrong discriminator): skip.
    }
  }
  return out;
}

/**
 * Every Session account of `owner`, on any device: dataSize 138 and the owner at offset 8 (the
 * authority field; the vault follows at 40, the device signer at 72). Newest expiry first.
 */
export async function fetchSessionsOf(rpc: SolanaRpc, owner: Address): Promise<SessionView[]> {
  const rows = await rpc
    .getProgramAccounts(PROGRAM_ID, {
      encoding: 'base64',
      commitment: 'confirmed',
      filters: [
        { dataSize: BigInt(SESSION_SPACE) },
        { memcmp: { offset: BigInt(OFFSETS.sessionAuthority), bytes: owner as unknown as Base58EncodedBytes, encoding: 'base58' } },
      ],
    })
    .send();
  const out: SessionView[] = [];
  for (const row of rows) {
    try {
      const account = decodeSession(accountBytes(row.account.data));
      if (account.authority === owner) out.push({ address: row.pubkey, account });
    } catch {
      // Not a Session (wrong discriminator): skip.
    }
  }
  return out.sort((a, b) => (a.account.expiry > b.account.expiry ? -1 : a.account.expiry < b.account.expiry ? 1 : 0));
}

/** A new round every minute, so the cache keeps the newest few hundred ids only. */
const ROUND_ADDRESSES_KEPT = 256;
const roundAddressCache = new Map<bigint, Promise<Address>>();

export function roundAddressCached(id: bigint): Promise<Address> {
  let found = roundAddressCache.get(id);
  if (!found) {
    found = roundAddress(id);
    found.catch(() => roundAddressCache.delete(id));
    setBounded(roundAddressCache, id, found, ROUND_ADDRESSES_KEPT);
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
