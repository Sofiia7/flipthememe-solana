import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  type Transaction,
  type TransactionSigner,
} from '@solana/kit';

export type DevnetRpc = Rpc<SolanaRpcApi>;

/** Compiles an unsigned transaction for an external signer (the MWA wallet). */
export async function compileForWallet(rpc: DevnetRpc, feePayer: Address, instructions: Instruction[]): Promise<{ transaction: Transaction; lastValidBlockHeight: bigint }> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return { transaction: compileTransaction(message), lastValidBlockHeight: blockhash.lastValidBlockHeight };
}

/** Signs with local signers (keeper key, session key) found in the instructions plus the fee payer. */
export async function signLocally(rpc: DevnetRpc, feePayer: TransactionSigner, instructions: Instruction[]): Promise<{ transaction: Transaction; lastValidBlockHeight: bigint }> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  return { transaction, lastValidBlockHeight: blockhash.lastValidBlockHeight };
}

export class TransactionFailed extends Error {
  readonly signature: Signature;
  readonly detail: unknown;
  constructor(signature: Signature, detail: unknown) {
    super(`transaction ${signature} failed: ${stringify(detail)}`);
    this.signature = signature;
    this.detail = detail;
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/**
 * Sends a fully signed transaction and polls until it is confirmed, fails, or its blockhash expires.
 * Polling instead of websockets keeps it working in React Native and behind flaky mobile networks.
 */
export async function sendAndConfirm(
  rpc: DevnetRpc,
  signed: { transaction: Transaction; lastValidBlockHeight: bigint },
  opts: { skipPreflight?: boolean; pollMs?: number; timeoutMs?: number } = {},
): Promise<Signature> {
  const signature = getSignatureFromTransaction(signed.transaction);
  const wire = getBase64EncodedWireTransaction(signed.transaction);
  await rpc
    .sendTransaction(wire, { encoding: 'base64', skipPreflight: opts.skipPreflight ?? false, preflightCommitment: 'confirmed', maxRetries: 0n })
    .send();
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let resendAt = Date.now() + 2_000;
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new TransactionFailed(signature, status.err);
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return signature;
    if (Date.now() - started > timeoutMs) throw new TransactionFailed(signature, 'timeout');
    const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
    if (height > signed.lastValidBlockHeight) throw new TransactionFailed(signature, 'blockhash expired');
    if (Date.now() > resendAt) {
      // Same signature, so a resend can never double-spend; it only helps a dropped packet.
      await rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send().catch(() => undefined);
      resendAt = Date.now() + 2_000;
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 700));
  }
}

/** Reads the custom program error number out of a failed transaction, if there is one. */
export function programErrorCode(error: unknown): number | null {
  const text = error instanceof TransactionFailed ? stringify(error.detail) : error instanceof Error ? error.message + stringify((error as { context?: unknown }).context ?? null) : stringify(error);
  // Kit reports on-chain failures with bigint codes, which stringify() turns into quoted numbers.
  const match = text.match(/"Custom":\s*"?(\d+)"?/) ?? text.match(/custom program error: 0x([0-9a-f]+)/i);
  if (!match) return null;
  return match[0].includes('0x') ? parseInt(match[1], 16) : Number(match[1]);
}

/** Anchor error numbers start at 6000 in declaration order of ErrorCode in lib.rs. */
export const PROGRAM_ERRORS = [
  'InvalidAmount',
  'Arithmetic',
  'InsufficientAvailable',
  'SessionInvalid',
  'SessionCapExceeded',
  'InvalidSession',
  'RoundNotOpen',
  'InvalidRoundTime',
  'InvalidRoundId',
  'NotDue',
  'NotFinal',
  'AlreadyClaimed',
  'FeeTooHigh',
  'BankTooLargeForPool',
  'InvalidSamples',
  'Paused',
  'Unauthorized',
  'InvalidAccount',
  'NotFillWindow',
  'NothingToFill',
  'NotSweepable',
  'NotClosable',
  'Insolvent',
  // October 2026 upgrade; append only.
  'NotClaimed',
  'HouseRoundCapExceeded',
  'HouseDailyCapExceeded',
  'AttestorRequired',
  'InvalidAttestor',
  // Strike window and round bounds; append only.
  'StrikeWindowClosed',
  'RoundTooLong',
  'SettleDeadlineTooFar',
  'MaxBankBelowMin',
] as const;
export type ProgramErrorName = (typeof PROGRAM_ERRORS)[number];

export function programErrorName(error: unknown): ProgramErrorName | null {
  const code = programErrorCode(error);
  if (code === null || code < 6000) return null;
  return PROGRAM_ERRORS[code - 6000] ?? null;
}
