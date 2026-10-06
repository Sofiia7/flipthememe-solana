/**
 * Price attestation. The independent attestor service co-signs set_strike and settle: the keeper
 * builds the transaction with the attestor (from the on-chain OracleConfig) as a required signer,
 * signs it with its own keys only, POSTs exactly that transaction to `${ATTEST_URL}/v1/attest` as
 * {"tx": "<base64 wire transaction>"}, checks the returned signature against the message and
 * sends the completed transaction. Nothing but the transaction ever goes to the attestor, plus
 * `authorization: Bearer <ATTEST_TOKEN>` when that shared secret is set.
 */
import { SYSTEM_PROGRAM_ID, sendAndConfirm } from '@flipthememe/client';
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  isTransactionWithinSizeLimit,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
  type Address,
  type Instruction,
  type Signature,
  type SignatureBytes,
  type Transaction,
  type TransactionSigner,
} from '@solana/kit';
import { TransactionTooLarge } from './chain.ts';
import type { SolanaRpc } from './rpc.ts';

/** Pubkey::default(): what OracleConfig holds while no attestor is set up. */
export const NO_ATTESTOR: Address = SYSTEM_PROGRAM_ID;
export const ATTEST_TIMEOUT_MS = 5_000;
/** Tries per step; the scheduler retries the step itself with backoff until the round's deadline. */
export const ATTEST_ATTEMPTS = 2;
export const ATTEST_PAUSE_MS = 500;

/**
 * How long the scheduler leaves a step alone after the attestor refused it (every request is one
 * Worker request on the free plan, so asking sooner than the answer can change is waste).
 *
 * Some refusals are transient: right after a window ends the attestor may not hold enough reads
 * yet (too_few_samples), may not know the round yet (round_not_found) or may still think the
 * window is open (window_open). Those retry at 5 s, 15 s, 60 s, then every 120 s. Others are a
 * verdict on samples that no longer change (price_mismatch, slot_out_of_range, slot_price_mismatch,
 * unpriced, samples_withheld, strike_too_late), a wrong ATTEST_TOKEN (unauthorized) or a transaction
 * the attestor will never sign (the structural reasons): they go straight to 120 s, and a step is
 * never asked more often than that. A reason this table does not know counts as transient.
 */
export const TRANSIENT_BACKOFF_MS = [5_000, 15_000, 60_000, 120_000] as const;
export const PERMANENT_BACKOFF_MS = 120_000;
export const PERMANENT_REFUSALS: ReadonlySet<string> = new Set([
  'price_mismatch',
  'slot_out_of_range',
  'slot_price_mismatch',
  'unpriced',
  'samples_withheld',
  'strike_too_late',
  'unauthorized',
  'bad_transaction',
  'unsupported_version',
  'lookup_tables',
  'attestor_is_fee_payer',
  'attestor_not_signer',
  'attestor_writable',
  'compute_budget',
  'foreign_instruction',
  'instruction_count',
  'unknown_discriminator',
  'bad_samples',
  'wrong_accounts',
  'attestor_not_in_instruction',
]);

/** The wait after the `refusals`-th refusal of one step (1 for the first), keyed by the reason string the attestor sent. */
export function refusalBackoffMs(reason: string, refusals: number): number {
  if (PERMANENT_REFUSALS.has(reason)) return PERMANENT_BACKOFF_MS;
  const index = Math.min(Math.max(refusals, 1), TRANSIENT_BACKOFF_MS.length) - 1;
  return TRANSIENT_BACKOFF_MS[index] ?? PERMANENT_BACKOFF_MS;
}

/** A required attestation the attestor refused: the step fails and the scheduler backs off by the reason. */
export class AttestRefused extends Error {
  readonly reason: string;
  readonly status: number;
  readonly attempts: number;

  constructor(reason: string, status: number, attempts: number) {
    super(`attestation refused: ${reason}`);
    this.name = 'AttestRefused';
    this.reason = reason;
    this.status = status;
    this.attempts = attempts;
  }
}

export type AttestOk = { kind: 'ok'; signature: SignatureBytes; attempts: number; ms: number };
export type AttestResult =
  | AttestOk
  | { kind: 'refused'; reason: string; status: number; attempts: number }
  | { kind: 'failed'; reason: string; attempts: number };

/** The slice of `fetch` the client uses, so tests can pass a fake. */
export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const base58 = getBase58Encoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function field(body: unknown, name: string): string | null {
  const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined;
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 200) : null;
}

/** The 64 signature bytes of a {"signature": "<base58>"} answer, or null. */
function signatureOf(body: unknown): SignatureBytes | null {
  const text = field(body, 'signature');
  if (!text) return null;
  try {
    const bytes = base58.encode(text);
    return bytes.length === 64 ? (bytes as SignatureBytes) : null;
  } catch {
    return null;
  }
}

export class AttestorClient {
  readonly url: string;
  private readonly fetch: FetchLike;
  /** ATTEST_TOKEN in a true private field, so not even JSON.stringify of the client shows it. */
  readonly #token: string | null;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly pauseMs: number;

  constructor(opts: { url: string; token?: string | null; fetch?: FetchLike; timeoutMs?: number; attempts?: number; pauseMs?: number }) {
    this.url = opts.url.replace(/\/+$/, '');
    this.#token = opts.token ?? null;
    this.fetch = opts.fetch ?? (fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? ATTEST_TIMEOUT_MS;
    this.attempts = opts.attempts ?? ATTEST_ATTEMPTS;
    this.pauseMs = opts.pauseMs ?? ATTEST_PAUSE_MS;
  }

  /**
   * POSTs the transaction until the attestor signs or refuses, at most `attempts` times and never
   * past `deadlineMs`. An answer 4xx other than 429 is a refusal (`reason` or `error` from its
   * JSON; a 401 is `unauthorized`, a wrong or missing ATTEST_TOKEN) and is not repeated here; a
   * timeout, 429, 5xx or an answer without a signature is a failure and is.
   */
  async attest(wireBase64: string, deadlineMs: number): Promise<AttestResult> {
    const started = Date.now();
    let reason = 'round deadline passed';
    let attempts = 0;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.#token !== null) headers.authorization = `Bearer ${this.#token}`;
    while (attempts < this.attempts) {
      const left = deadlineMs - Date.now();
      if (left <= 0) break;
      attempts++;
      try {
        const res = await this.fetch(`${this.url}/v1/attest`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ tx: wireBase64 }),
          signal: AbortSignal.timeout(Math.min(this.timeoutMs, left)),
        });
        const body = parseJson(await res.text());
        const said = field(body, 'reason') ?? field(body, 'error');
        if (res.ok) {
          const signature = signatureOf(body);
          if (signature) return { kind: 'ok', signature, attempts, ms: Date.now() - started };
          reason = 'answer without a 64-byte base58 signature';
        } else if (res.status === 401) {
          return { kind: 'refused', reason: 'unauthorized', status: 401, attempts };
        } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          return { kind: 'refused', reason: said ?? `HTTP ${res.status}`, status: res.status, attempts };
        } else {
          reason = said ? `HTTP ${res.status}: ${said}` : `HTTP ${res.status}`;
        }
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : error instanceof Error ? error.message.slice(0, 200) : String(error);
      }
      if (attempts < this.attempts) await sleep(this.pauseMs);
    }
    return { kind: 'failed', reason, attempts };
  }
}

/** Signs with the keeper's own signers (fee payer, price authority); other signature slots stay empty. */
export async function signPartially(
  rpc: SolanaRpc,
  feePayer: TransactionSigner,
  instructions: Instruction[],
): Promise<{ transaction: Transaction; lastValidBlockHeight: bigint }> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await partiallySignTransactionMessageWithSigners(message);
  return { transaction, lastValidBlockHeight: blockhash.lastValidBlockHeight };
}

/** True when `signature` is `signer`'s ed25519 signature of the transaction message. */
export async function verifiesFor(transaction: Transaction, signer: Address, signature: SignatureBytes): Promise<boolean> {
  try {
    return await verifySignature(await getPublicKeyFromAddress(signer), signature, transaction.messageBytes);
  } catch {
    return false;
  }
}

export function withSignature<T extends Transaction>(transaction: T, signer: Address, signature: SignatureBytes): T {
  return { ...transaction, signatures: Object.freeze({ ...transaction.signatures, [signer]: signature }) };
}

export type AttestMiss = Exclude<AttestResult, AttestOk>;
export type AttestedSend = { kind: 'sent'; signature: Signature; attest: AttestOk } | { kind: 'not-attested'; attest: AttestMiss };

/**
 * One attested send: `instructions` must already name `attestor` as a signer without a signer
 * object (the client builders do that for a bare address). Without a valid signature it sends
 * nothing and returns the attestation result, so the caller decides between waiting (required)
 * and going ahead without the attestor (not required). A failure after the transaction was
 * complete carries its signature as `keeperSignature`, like sendInstructions.
 */
export async function sendAttested(
  rpc: SolanaRpc,
  feePayer: TransactionSigner,
  instructions: Instruction[],
  attestor: Address,
  client: AttestorClient,
  deadlineMs: number,
): Promise<AttestedSend> {
  const signed = await signPartially(rpc, feePayer, instructions);
  if (!isTransactionWithinSizeLimit(signed.transaction)) throw new TransactionTooLarge(instructions.length);
  const attest = await client.attest(getBase64EncodedWireTransaction(signed.transaction), deadlineMs);
  if (attest.kind !== 'ok') return { kind: 'not-attested', attest };
  if (!(await verifiesFor(signed.transaction, attestor, attest.signature))) {
    return { kind: 'not-attested', attest: { kind: 'failed', reason: 'signature does not verify for the attestor', attempts: attest.attempts } };
  }
  const transaction = withSignature(signed.transaction, attestor, attest.signature);
  try {
    const signature = await sendAndConfirm(rpc, { transaction, lastValidBlockHeight: signed.lastValidBlockHeight }, { timeoutMs: 45_000, pollMs: 1_200 });
    return { kind: 'sent', signature, attest };
  } catch (error) {
    if (typeof error === 'object' && error !== null) Object.assign(error, { keeperSignature: getSignatureFromTransaction(transaction) });
    throw error;
  }
}
