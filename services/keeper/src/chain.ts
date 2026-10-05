/**
 * Devnet side: account reads, transaction sending and the devnet clock estimate.
 */
import {
  ACCOUNT,
  OFFSETS,
  PROGRAM_ID,
  configAddress,
  decodeConfig,
  decodePosition,
  decodeRound,
  decodeVault,
  programErrorName,
  roundAddress,
  sendAndConfirm,
  signLocally,
  vaultAddress,
  type ConfigAccount,
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
/** 8-byte discriminator + Position::INIT_SPACE. */
export const POSITION_ACCOUNT_SIZE = 100;

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
  houseVault: VaultAccount | null;
  keeperLamports: bigint;
  /** Requested ids; null when the account does not exist (never created, or closed). */
  rounds: Map<bigint, RoundAccount | null>;
};

/** Config, the keeper's Vault, the keeper's balance and the given rounds in one getMultipleAccounts. */
export async function readSnapshot(rpc: SolanaRpc, keeper: Address, ids: readonly bigint[]): Promise<Snapshot> {
  const roundKeys = await Promise.all(ids.map((id) => cachedRoundAddress(id)));
  const keys = [await configAddress(), await vaultAddress(keeper), keeper, ...roundKeys];
  const { value } = await rpc.getMultipleAccounts(keys, { encoding: 'base64', commitment: 'confirmed' }).send();
  const [configAcc, vaultAcc, keeperAcc, ...roundAccs] = value;
  const configBytes = bytesOf(configAcc ?? null);
  const vaultBytes = bytesOf(vaultAcc ?? null);
  const rounds = new Map<bigint, RoundAccount | null>();
  ids.forEach((id, i) => {
    const bytes = bytesOf(roundAccs[i] ?? null);
    rounds.set(id, bytes ? decodeRound(bytes) : null);
  });
  return {
    config: configBytes ? decodeConfig(configBytes) : null,
    houseVault: vaultBytes ? decodeVault(vaultBytes) : null,
    keeperLamports: keeperAcc?.lamports ?? 0n,
    rounds,
  };
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
