import {
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE,
  SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_RENT,
  isSolanaError,
} from '@solana/kit';
import { PROGRAM_ERRORS, TransactionFailed, programErrorName, type ProgramErrorName } from '@flipthememe/client';

export type TxAction = 'bet' | 'topup' | 'withdraw' | 'revoke' | 'claim' | 'airdrop' | 'connect';

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? '';
  } catch {
    return String(value);
  }
}

/** Everything readable about an error: message, kit context (logs included), causes, tx detail. */
function errorText(error: unknown, depth = 0): string {
  if (depth > 5 || error === null || error === undefined) return '';
  if (error instanceof TransactionFailed) return `${error.message} ${stringify(error.detail)}`;
  if (error instanceof Error) {
    const context = (error as { context?: unknown }).context;
    return [error.message, context ? stringify(context) : '', errorText((error as { cause?: unknown }).cause, depth + 1)].join(' ');
  }
  return stringify(error);
}

/** Finds `Custom` (number, bigint or numeric string) anywhere inside a transaction error object. */
function customFromDetail(detail: unknown, depth = 0): number | null {
  if (depth > 6 || detail === null || typeof detail !== 'object') return null;
  for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
    if (key === 'Custom' && (typeof value === 'number' || typeof value === 'bigint' || (typeof value === 'string' && /^\d+$/.test(value)))) {
      return Number(value);
    }
    const nested = customFromDetail(value, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * Custom program error code of a failed transaction. Handles kit errors (cause chain), the
 * client's TransactionFailed (whose detail carries bigints) and simulation logs.
 */
export function customErrorCode(error: unknown): number | null {
  let current: unknown = error;
  for (let i = 0; i < 6 && current; i++) {
    if (isSolanaError(current, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) {
      return Number((current.context as { code: number }).code);
    }
    current = (current as { cause?: unknown }).cause;
  }
  if (error instanceof TransactionFailed) {
    const fromDetail = customFromDetail(error.detail);
    if (fromDetail !== null) return fromDetail;
  }
  const text = errorText(error);
  const hex = text.match(/custom program error: 0x([0-9a-f]+)/i);
  if (hex) return parseInt(hex[1], 16);
  const dec = text.match(/"Custom":\s*"?(\d+)"?/);
  return dec ? Number(dec[1]) : null;
}

export function programError(error: unknown): ProgramErrorName | null {
  const fromClient = programErrorName(error);
  if (fromClient) return fromClient;
  const code = customErrorCode(error);
  if (code === null || code < 6000) return null;
  return PROGRAM_ERRORS[code - 6000] ?? null;
}

export function httpStatus(error: unknown): number | null {
  if (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    return Number((error.context as { statusCode: number }).statusCode);
  }
  const match = errorText(error).match(/\b(429|5\d\d)\b/);
  return match ? Number(match[1]) : null;
}

function hasCode(error: unknown, code: number): boolean {
  let current: unknown = error;
  for (let i = 0; i < 6 && current; i++) {
    if (isSolanaError(current) && (current.context as { __code?: number }).__code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** MWA: the person closed or declined the wallet sheet. */
export function isWalletDecline(error: unknown): boolean {
  const e = error as { name?: string; code?: unknown; message?: string } | null;
  if (!e) return false;
  if (e.name === 'SolanaMobileWalletAdapterProtocolError' && (e.code === -1 || e.code === -3 || e.code === -4)) return true;
  if (e.name === 'SolanaMobileWalletAdapterError' && (e.code === 'ERROR_ASSOCIATION_CANCELLED' || e.code === 'ERROR_SESSION_CLOSED')) return true;
  return /declin|reject|cancel/i.test(e.message ?? '');
}

const PROGRAM_MESSAGES: Partial<Record<ProgramErrorName, string>> = {
  RoundNotOpen: 'Entry just closed - try the next round.',
  SessionCapExceeded: 'Session limit reached - tap Top up & play to renew it.',
  InsufficientAvailable: 'Not enough available balance - top up first.',
  BankTooLargeForPool: 'The pool is too shallow for a bigger matched bank - try a smaller amount or the other side.',
  SessionInvalid: 'Your play session expired or was revoked - renew it with Top up & play.',
  InvalidSession: 'The wallet rejected the session settings - try again.',
  InvalidAmount: 'Amount out of range: 0.01 - 0.1 SOL per bet.',
  Paused: 'Betting is paused by the operator. Settlement and withdrawals keep working.',
  AlreadyClaimed: 'Already claimed - the payout is in your balance.',
  NotFinal: 'The round is not final yet.',
  Insolvent: 'The program refused the payout as a safety check - try again later.',
  Unauthorized: 'This wallet is not allowed to do that.',
  NotDue: 'Too early for this step - wait a few seconds.',
};

/** Raw MWA error fields, shown next to the human sentence so wallet problems can be diagnosed on a phone. */
export function walletDetail(error: unknown): string {
  const e = error as { name?: string; code?: unknown; message?: string; cause?: unknown } | null;
  if (!e) return '';
  const cause = e.cause instanceof Error ? ` / cause: ${e.cause.message}` : '';
  return ` [${(e.name ?? typeof error).replace('SolanaMobileWalletAdapter', 'MWA')} ${String(e.code ?? '')}: ${String(e.message ?? error).slice(0, 160)}${cause.slice(0, 100)}]`;
}

/** One human sentence for a failed action. */
export function humanError(error: unknown, action: TxAction): string {
  console.warn('[ftm] action failed', action, error);
  if (isWalletDecline(error)) return `Request declined in the wallet.${walletDetail(error)}`;
  const e = error as { name?: string; code?: unknown } | null;
  if (e?.name === 'SolanaMobileWalletAdapterError' && e.code === 'ERROR_WALLET_NOT_FOUND') {
    return 'No Solana wallet app found on this phone. Install one that supports Mobile Wallet Adapter.';
  }
  if (e?.name === 'SolanaMobileWalletAdapterError' && e.code === 'ERROR_SESSION_TIMEOUT') {
    return 'The wallet did not answer in time - try again.';
  }

  const name = programError(error);
  if (name) return PROGRAM_MESSAGES[name] ?? `The program rejected the transaction (${name}).`;

  const text = errorText(error);
  if (action === 'bet' && /already in use/i.test(text)) return 'You already have a bet in this round - one bet per round.';
  if (
    hasCode(error, SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND) ||
    hasCode(error, SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE) ||
    hasCode(error, SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_RENT) ||
    /no record of a prior credit|insufficient lamports|insufficient funds/i.test(text)
  ) {
    if (action === 'bet' || action === 'claim') return 'The session key is out of devnet SOL for fees - Top up & play refills it.';
    return 'Not enough devnet SOL in the wallet - use Airdrop or faucet.solana.com.';
  }
  if (hasCode(error, SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND) || /blockhash expired/i.test(text)) {
    return 'The network was too slow and the transaction expired - nothing was taken. Try again.';
  }
  if (error instanceof TransactionFailed && error.detail === 'timeout') {
    return 'No confirmation after 60 s. It may still land - check History in a minute.';
  }
  const status = httpStatus(error);
  if (status === 429) {
    return action === 'airdrop'
      ? 'The devnet faucet is rate limited. Use https://faucet.solana.com to get test SOL.'
      : 'Devnet RPC is rate limiting - try again in a few seconds.';
  }
  if (/abort/i.test(text)) return 'Devnet did not answer in time - check your connection.';
  if (/network request failed|failed to fetch/i.test(text)) return 'No internet connection.';
  if (action === 'airdrop') return 'Airdrop failed. Use https://faucet.solana.com to get test SOL.';
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 160 ? `${message.slice(0, 160)}...` : message || 'Something went wrong.';
}

/** Short status for read failures (polling). */
export function describeNetworkError(error: unknown): string {
  const status = httpStatus(error);
  if (status === 429) return 'Devnet RPC is rate limiting, retrying';
  const text = errorText(error);
  if (/abort/i.test(text)) return 'RPC timed out, retrying';
  if (/network request failed|failed to fetch/i.test(text)) return 'No connection, retrying';
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 120 ? `${message.slice(0, 120)}...` : message;
}
