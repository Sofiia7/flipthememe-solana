/**
 * Devnet side: account reads, transaction sending and the devnet clock estimate.
 */
import {
  ACCOUNT,
  OFFSETS,
  POSITION_ACCOUNT_SIZE,
  PROGRAM_ID,
  configAddress,
  decodeConfig,
  decodeHouseLimits,
  decodeOracleConfig,
  decodePosition,
  decodeRound,
  decodeVault,
  houseLimitsAddress,
  oracleAddress,
  programErrorName,
  roundAddress,
  sendAndConfirm,
  signLocally,
  vaultAddress,
  type ConfigAccount,
  type HouseLimitsAccount,
  type OracleConfigAccount,
  type PositionAccount,
  type RoundAccount,
  type VaultAccount,
} from '@flipthememe/client';
import {
  getBase58Decoder,
  getBase64Encoder,
  getSignatureFromTransaction,
  getU64Decoder,
  isTransactionWithinSizeLimit,
  type Address,
  type Base58EncodedBytes,
  type Instruction,
  type Signature,
  type TransactionSigner,
} from '@solana/kit';
import type { SolanaRpc } from './rpc.ts';

/** 8-byte discriminator + Round::INIT_SPACE (programs/flip-the-meme/src/lib.rs). */
export const ROUND_ACCOUNT_SIZE = 235;
/** Offset of `fees_swept` in Round account data; false on every round that is not fully done. */
export const ROUND_FEES_SWEPT_OFFSET = 212;
export const ROUND_ID_OFFSET = 8;
/** 8-byte discriminator + Position::INIT_SPACE, as the client defines it. */
export { POSITION_ACCOUNT_SIZE };
/** 8-byte discriminator + HouseLimits::INIT_SPACE, OracleConfig::INIT_SPACE and Vault::INIT_SPACE. */
export const HOUSE_LIMITS_ACCOUNT_SIZE = 41;
export const ORACLE_ACCOUNT_SIZE = 42;
export const VAULT_ACCOUNT_SIZE = 57;

const base64 = getBase64Encoder();
const base58 = getBase58Decoder();
const u64 = getU64Decoder();

type Base64Data = { data: readonly [string, 'base64'] | [string, 'base64']; lamports: bigint } | null;

function bytesOf(account: Base64Data): Uint8Array | null {
  return account ? (base64.encode(account.data[0]) as Uint8Array) : null;
}

const roundAddresses = new Map<bigint, Address>();
export async function cachedRoundAddress(id: bigint): Promise<Address> {
  let found = roundAddresses.get(id);
  if (!found) {
    found = await roundAddress(id);
    roundAddresses.set(id, found);
  }
  return found;
}

export type Snapshot = {
  config: ConfigAccount | null;
  /** The Vault of the house key (the keeper key unless HOUSE_KEYPAIR is set). */
  houseVault: VaultAccount | null;
  keeperLamports: bigint;
  /** Wallet of the house key: it pays the rent of house positions. */
  houseLamports: bigint;
  /** Null until init-house-limits / init-oracle ran after the October 2026 upgrade. */
  houseLimits: HouseLimitsAccount | null;
  oracle: OracleConfigAccount | null;
  /** Requested ids; null when the account does not exist (never created, or closed). */
  rounds: Map<bigint, RoundAccount | null>;
};

/**
 * Config, the house Vault, HouseLimits, OracleConfig, the keeper and house balances and the given
 * rounds in one getMultipleAccounts. `house` is the house key (default: the keeper key).
 */
export async function readSnapshot(rpc: SolanaRpc, keeper: Address, ids: readonly bigint[], house: Address = keeper): Promise<Snapshot> {
  const roundKeys = await Promise.all(ids.map((id) => cachedRoundAddress(id)));
  const keys = [await configAddress(), await vaultAddress(house), keeper, house, await houseLimitsAddress(), await oracleAddress(), ...roundKeys];
  const { value } = await rpc.getMultipleAccounts(keys, { encoding: 'base64', commitment: 'confirmed' }).send();
  const [configAcc, vaultAcc, keeperAcc, houseAcc, limitsAcc, oracleAcc, ...roundAccs] = value;
  const configBytes = bytesOf(configAcc ?? null);
  const vaultBytes = bytesOf(vaultAcc ?? null);
  const limitsBytes = bytesOf(limitsAcc ?? null);
  const oracleBytes = bytesOf(oracleAcc ?? null);
  const rounds = new Map<bigint, RoundAccount | null>();
  ids.forEach((id, i) => {
    const bytes = bytesOf(roundAccs[i] ?? null);
    rounds.set(id, bytes ? decodeRound(bytes) : null);
  });
  return {
    config: configBytes ? decodeConfig(configBytes) : null,
    houseVault: vaultBytes ? decodeVault(vaultBytes) : null,
    keeperLamports: keeperAcc?.lamports ?? 0n,
    houseLamports: houseAcc?.lamports ?? 0n,
    houseLimits: limitsBytes ? decodeHouseLimits(limitsBytes) : null,
    oracle: oracleBytes ? decodeOracleConfig(oracleBytes) : null,
    rounds,
  };
}

/** One account decoded with `decode`, or null when it does not exist (scripts). */
export async function readAccount<T>(rpc: SolanaRpc, address: Address, decode: (bytes: Uint8Array) => T): Promise<T | null> {
  const { value } = await rpc.getAccountInfo(address, { encoding: 'base64', commitment: 'confirmed' }).send();
  return value ? decode(base64.encode(value.data[0]) as Uint8Array) : null;
}

export type ClaimedPosition = { address: Address; position: PositionAccount; lamports: bigint };

/** Every claimed position of the program (dataSize + memcmp on `claimed`), with its balance. */
export async function fetchClaimedPositions(rpc: SolanaRpc): Promise<ClaimedPosition[]> {
  const accounts = await rpc
    .getProgramAccounts(PROGRAM_ID, {
      encoding: 'base64',
      commitment: 'confirmed',
      filters: [
        { dataSize: BigInt(POSITION_ACCOUNT_SIZE) },
        { memcmp: { offset: BigInt(OFFSETS.positionClaimed), bytes: base58.decode(new Uint8Array([1])) as Base58EncodedBytes, encoding: 'base58' } },
      ],
    })
    .send();
  const out: ClaimedPosition[] = [];
  for (const { pubkey, account } of accounts) {
    const position = decodePosition(base64.encode(account.data[0]) as Uint8Array);
    if (position.claimed) out.push({ address: pubkey, position, lamports: account.lamports });
  }
  return out;
}

/** Rounds by account address, 100 per getMultipleAccounts; null where there is none. */
export async function readRoundsAt(rpc: SolanaRpc, addresses: readonly Address[]): Promise<Map<Address, RoundAccount | null>> {
  const out = new Map<Address, RoundAccount | null>();
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const { value } = await rpc.getMultipleAccounts(chunk, { encoding: 'base64', commitment: 'confirmed' }).send();
    chunk.forEach((address, k) => {
      const bytes = bytesOf(value[k] ?? null);
      out.set(address, bytes ? decodeRound(bytes) : null);
    });
  }
  return out;
}

/** Every position of a round (dataSize + memcmp on `round` right after the discriminator). */
export async function fetchPositions(rpc: SolanaRpc, round: Address): Promise<PositionAccount[]> {
  const accounts = await rpc
    .getProgramAccounts(PROGRAM_ID, {
      encoding: 'base64',
      commitment: 'confirmed',
      filters: [
        { dataSize: BigInt(POSITION_ACCOUNT_SIZE) },
        { memcmp: { offset: BigInt(OFFSETS.positionRound), bytes: round as string as Base58EncodedBytes, encoding: 'base58' } },
      ],
    })
    .send();
  const out: PositionAccount[] = [];
  for (const { account } of accounts) {
    const bytes = base64.encode(account.data[0]) as Uint8Array;
    out.push(decodePosition(bytes));
  }
  return out;
}

/**
 * Ids of every round that is not fully processed yet (`fees_swept == false`): open, live, final
 * with unclaimed positions or unswept fees, or final and empty but not closed. Used at start-up to
 * pick up rounds older than the per-tick window.
 */
export async function fetchUnfinishedRoundIds(rpc: SolanaRpc): Promise<bigint[]> {
  const accounts = await rpc
    .getProgramAccounts(PROGRAM_ID, {
      encoding: 'base64',
      commitment: 'confirmed',
      dataSlice: { offset: ROUND_ID_OFFSET, length: 8 },
      filters: [
        { dataSize: BigInt(ROUND_ACCOUNT_SIZE) },
        { memcmp: { offset: 0n, bytes: base58.decode(ACCOUNT.Round) as Base58EncodedBytes, encoding: 'base58' } },
        { memcmp: { offset: BigInt(ROUND_FEES_SWEPT_OFFSET), bytes: base58.decode(new Uint8Array([0])) as Base58EncodedBytes, encoding: 'base58' } },
      ],
    })
    .send();
  return accounts.map(({ account }) => u64.decode(base64.encode(account.data[0]))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export class TransactionTooLarge extends Error {
  constructor(instructions: number) {
    super(`transaction with ${instructions} instructions is too large`);
    this.name = 'TransactionTooLarge';
  }
}

/**
 * signLocally + sendAndConfirm from the shared client, with a size check before sending. Status
 * polling every 1.2 s (instead of 0.7 s) keeps bursts under the public devnet RPC limits. A
 * failure after signing carries the signature as `keeperSignature`: a transport error (HTTP 429,
 * timeout) during confirmation does not mean the transaction did not land.
 */
export async function sendInstructions(rpc: SolanaRpc, signer: TransactionSigner, instructions: Instruction[]): Promise<Signature> {
  const signed = await signLocally(rpc, signer, instructions);
  if (!isTransactionWithinSizeLimit(signed.transaction)) throw new TransactionTooLarge(instructions.length);
  try {
    return await sendAndConfirm(rpc, signed, { timeoutMs: 45_000, pollMs: 1_200 });
  } catch (error) {
    if (typeof error === 'object' && error !== null) Object.assign(error, { keeperSignature: getSignatureFromTransaction(signed.transaction) });
    throw error;
  }
}

/** HTTP 429 from an RPC endpoint (kit puts the status code into the error context). */
export function isRateLimited(error: unknown): boolean {
  const status = (error as { context?: { statusCode?: unknown } })?.context?.statusCode;
  if (status === 429) return true;
  const text = error instanceof Error ? error.message : String(error);
  return /\b429\b|too many requests/i.test(text);
}

export function isTooLarge(error: unknown): boolean {
  if (error instanceof TransactionTooLarge) return true;
  const text = error instanceof Error ? error.message : String(error);
  return /too large|exceeds.*size/i.test(text);
}

/**
 * A short reason for a failed step: the program error name when there is one (also read from
 * the simulation logs and the error cause), else a trimmed message.
 */
export function describeError(error: unknown): string {
  const named = programErrorName(error) ?? programErrorName((error as { cause?: unknown })?.cause ?? null);
  if (named) return named;
  const logs = (error as { context?: { logs?: unknown } })?.context?.logs;
  if (Array.isArray(logs)) {
    for (const line of logs) {
      const match = typeof line === 'string' ? line.match(/Error Code: (\w+)/) : null;
      if (match?.[1]) return match[1];
    }
  }
  const cause = (error as { cause?: unknown })?.cause;
  const parts = [error instanceof Error ? error.message : String(error)];
  if (cause instanceof Error && cause.message && !parts[0]?.includes(cause.message)) parts.push(cause.message);
  const text = parts.join(': ');
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/**
 * Devnet clock estimate: block time of the latest confirmed slot against the local clock.
 * The estimate runs a little behind the real devnet clock (whole seconds, confirmation lag),
 * which errs on the safe side for "the devnet clock has passed X" checks.
 */
export class ChainClock {
  offsetMs: number;
  measuredAtMs = 0;

  constructor(initialOffsetMs = -2_000) {
    this.offsetMs = initialOffsetMs;
  }

  async refresh(rpc: SolanaRpc): Promise<number> {
    const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
    const blockTime = await rpc.getBlockTime(slot).send();
    const localMs = Date.now();
    if (blockTime === null) throw new Error(`no block time for slot ${slot}`);
    this.offsetMs = Number(blockTime) * 1000 - localMs;
    this.measuredAtMs = localMs;
    return this.offsetMs;
  }
}
