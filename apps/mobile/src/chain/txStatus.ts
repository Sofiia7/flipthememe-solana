// What became of a transaction this app signed and sent, read from the chain alone: confirmed,
// refused, still able to land, or expired for good. Money actions settle an earlier transaction
// this way before anything new is signed, so a lost answer never turns into a second payment.
// Pure TypeScript (no React Native imports), so node:test covers it.
import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
  isSolanaError,
  type GetBlockHeightApi,
  type GetSignatureStatusesApi,
  type Rpc,
  type Signature,
} from '@solana/kit';
import { TransactionFailed } from '@flipthememe/client';

/**
 * confirmed: landed and succeeded.
 * failed: the program refused it (on chain, only the fee was paid; or in simulation, nothing was sent).
 * pending: not found yet (or only processed) while its blockhash can still land it: check again.
 * expired: not found and the chain is past its last valid block height: it can never land, so
 *   a new transaction is safe.
 */
export type TxVerdict = 'confirmed' | 'failed' | 'pending' | 'expired';

export type TxCheck = { verdict: TxVerdict; /** The on-chain error of a failed transaction, else null. */ err: unknown };

/** A signature status as getSignatureStatuses returns it; null when the signature is not found. */
export type TxStatusLike = { err: unknown; confirmationStatus?: string | null } | null;

/** Records kept before lastValidBlockHeight was stored: a blockhash lives about 150 blocks (about a minute). */
export const LEGACY_EXPIRY_MS = 5 * 60_000;

export function classifyTx(input: {
  status: TxStatusLike;
  /** Confirmed block height, read BEFORE the status. */
  blockHeight: bigint | null;
  lastValidBlockHeight: bigint | null;
  /** Local ms when the transaction was signed. */
  sentAt: number;
  now: number;
}): TxVerdict {
  const { status } = input;
  if (status) {
    // A processed-only result can still be dropped with its fork: wait for confirmed.
    if (status.confirmationStatus === 'processed') return 'pending';
    return status.err ? 'failed' : 'confirmed';
  }
  if (input.lastValidBlockHeight !== null && input.blockHeight !== null) {
    return input.blockHeight > input.lastValidBlockHeight ? 'expired' : 'pending';
  }
  return input.now - input.sentAt > LEGACY_EXPIRY_MS ? 'expired' : 'pending';
}

/**
 * What an error thrown while sending or confirming proves by itself.
 * failed: the transaction landed and failed (the client's TransactionFailed with an on-chain error).
 * refused: the RPC refused it in simulation (preflight), so that node never forwarded it.
 * unknown: anything else (timeout, dropped connection, 429/5xx, a failed status poll): it may have landed.
 */
export type SendProof = 'failed' | 'refused' | 'unknown';

export function sendErrorProof(error: unknown): SendProof {
  if (error instanceof TransactionFailed) {
    return error.detail === 'timeout' || error.detail === 'blockhash expired' ? 'unknown' : 'failed';
  }
  if (isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) {
    // "Already processed": an earlier send of this same transaction got it in.
    const cause = (error as { cause?: unknown }).cause;
    return isSolanaError(cause, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED) ? 'unknown' : 'refused';
  }
  return 'unknown';
}

/**
 * The outcome once sending threw: the error's own proof, settled by one look at the chain
 * (`check`, null when that look failed too). 'pending' keeps the action on CHECKING.
 */
export function settleSendError(proof: SendProof, check: TxVerdict | null): TxVerdict {
  if (proof === 'failed') return 'failed';
  if (check === 'confirmed' || check === 'failed') return check;
  // Not on chain. After a refused simulation nothing was forwarded: the refusal is the answer.
  if (proof === 'refused') return 'failed';
  return check === 'expired' ? 'expired' : 'pending';
}

/**
 * One look at the chain: the block height first, then the signature status with history (so an
 * old transaction is still found). A transaction lands at or below its lastValidBlockHeight, so a
 * height already past it followed by no status proves it never will.
 */
export async function checkSignature(
  rpc: Rpc<GetBlockHeightApi & GetSignatureStatusesApi>,
  tx: { signature: string; lastValidBlockHeight: bigint | null; at: number },
): Promise<TxCheck> {
  const blockHeight = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
  const { value } = await rpc.getSignatureStatuses([tx.signature as Signature], { searchTransactionHistory: true }).send();
  const status = value[0] ?? null;
  const verdict = classifyTx({
    status,
    blockHeight: BigInt(blockHeight),
    lastValidBlockHeight: tx.lastValidBlockHeight,
    sentAt: tx.at,
    now: Date.now(),
  });
  return { verdict, err: status?.err ?? null };
}

/** The error that explains a settled failure or expiry (humanError reads both shapes). */
export function settledError(signature: string, verdict: TxVerdict, check: TxCheck | null, original: unknown): unknown {
  if (verdict === 'expired') return new TransactionFailed(signature as Signature, 'blockhash expired');
  if (check?.verdict === 'failed') return new TransactionFailed(signature as Signature, check.err);
  return original;
}
