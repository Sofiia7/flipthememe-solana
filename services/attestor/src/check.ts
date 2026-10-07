/**
 * What the attestor co-signs, as far as the transaction alone tells: decoding and every check that
 * needs no network. attestor.ts adds the round from devnet and the samples (samples.ts).
 *
 * Accepted: a legacy or v0 message without address lookup tables whose instructions are at most
 * one SetComputeUnitLimit and one SetComputeUnitPrice (ComputeBudget, no accounts) plus exactly one
 * FlipTheMeme instruction, set_strike or settle. Its data is the discriminator and a Borsh
 * Vec<PriceSample>: u32 count, then u64 slot and u64 price per sample (the client's samplesEncoder).
 * Its accounts are the program's PriceUpdate, in order: config, round, price_authority, oracle,
 * attestor. The attestor key must be a read-only signer that is not the fee payer (account 0).
 */
import { IX, PROGRAM_ID, RoundStatus, type PriceSample, type RoundAccount } from '@flipthememe/client';
import {
  address,
  getArrayDecoder,
  getCompiledTransactionMessageDecoder,
  getStructDecoder,
  getTransactionDecoder,
  getU64Decoder,
  type Address,
} from '@solana/kit';

export const COMPUTE_BUDGET_PROGRAM_ID: Address = address('ComputeBudget111111111111111111111111111111');
/** ComputeBudget instructions accepted, by kind byte: their data length. Each at most once. */
const COMPUTE_BUDGET_KINDS = new Map<number, number>([
  [2, 5], // SetComputeUnitLimit(u32)
  [3, 9], // SetComputeUnitPrice(u64)
]);
export const MAX_COMPUTE_BUDGET_INSTRUCTIONS = COMPUTE_BUDGET_KINDS.size;

/**
 * Accounts of set_strike and settle (PriceUpdate in programs/flip-the-meme), as the program agent
 * confirmed: 0 config PDA (read-only), 1 round PDA (writable), 2 price_authority (signer),
 * 3 oracle PDA (read-only), 4 attestor (read-only signer; the program id when absent).
 */
export const PRICE_UPDATE_ACCOUNTS = 5;
export const CONFIG_ACCOUNT_INDEX = 0;
export const ROUND_ACCOUNT_INDEX = 1;
export const ORACLE_ACCOUNT_INDEX = 3;
export const ATTESTOR_ACCOUNT_INDEX = 4;

/** The program's MIN_SAMPLES and MAX_SAMPLES (programs/flip-the-meme/src/lib.rs). */
export const PROGRAM_MIN_SAMPLES = 5;
export const PROGRAM_MAX_SAMPLES = 16;
/** Solana's packet size: no valid transaction is longer. */
const MAX_TRANSACTION_BYTES = 1232;

/** Reasons the attestor gives when it refuses to co-sign (HTTP 422). */
export const REASONS = [
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
  'round_not_found',
  'round_state',
  'window_open',
  'strike_too_late',
  'already_signed',
  'too_many_attempts',
  'unpriced',
  'too_few_samples',
  'samples_withheld',
  'slot_out_of_range',
  'slot_price_mismatch',
  'price_mismatch',
] as const;
export type Reason = (typeof REASONS)[number];

export class Refusal extends Error {
  readonly reason: Reason;
  /** For the attestor's own log line only, never for the HTTP answer. */
  readonly detail: Record<string, unknown>;
  constructor(reason: Reason, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'Refusal';
    this.reason = reason;
    this.detail = detail;
  }
}

export type PriceInstruction = 'set_strike' | 'settle';

export type AttestRequest = {
  /** What every signer signs; the attestor's signature covers exactly these bytes. */
  messageBytes: Uint8Array;
  instruction: PriceInstruction;
  samples: PriceSample[];
  /** Accounts of the FlipTheMeme instruction, in order. */
  accounts: Address[];
  feePayer: Address;
};

/** The Config and OracleConfig PDAs of the program, which every set_strike and settle lists. */
export type ProgramPdas = { config: Address; oracle: Address };

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Wire bytes from the request's base64 text, or null when it is not base64. */
export function decodeBase64(text: string): Uint8Array | null {
  if (!text || !BASE64.test(text)) return null;
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

const sampleDecoder = getArrayDecoder(getStructDecoder([['slot', getU64Decoder()], ['price', getU64Decoder()]]));

/** The samples of set_strike / settle data, held to the program's rules (mean_price). */
export function parseSamples(data: Uint8Array): PriceSample[] {
  if (data.length < 12) throw new Refusal('bad_samples', 'instruction data ends before the sample count');
  const count = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(8, true);
  if (count > PROGRAM_MAX_SAMPLES) {
    throw new Refusal('bad_samples', `${count} samples; the program takes at most ${PROGRAM_MAX_SAMPLES}`);
  }
  const expected = 12 + 16 * count;
  if (data.length !== expected) {
    throw new Refusal('bad_samples', `instruction data is ${data.length} bytes; ${count} samples take ${expected}`);
  }
  const [decoded] = sampleDecoder.read(data, 8);
  const samples = decoded.map((s) => ({ slot: s.slot, price: s.price }));
  samples.forEach((s, i) => {
    if (s.price <= 0n) throw new Refusal('bad_samples', `sample ${i} has price 0`);
    const before = samples[i - 1];
    if (before && s.slot <= before.slot) throw new Refusal('bad_samples', 'sample slots must strictly increase');
  });
  return samples;
}

function hasDiscriminator(data: Uint8Array, discriminator: Uint8Array): boolean {
  return data.length >= 8 && discriminator.every((b, i) => data[i] === b);
}

/** A ComputeBudget instruction the attestor accepts: limit or price, no accounts, once each. */
function checkComputeBudget(indices: readonly number[], data: Uint8Array, seen: Set<number>): void {
  const kind = data[0];
  if (indices.length > 0 || kind === undefined || COMPUTE_BUDGET_KINDS.get(kind) !== data.length || seen.has(kind)) {
    throw new Refusal(
      'compute_budget',
      `at most ${MAX_COMPUTE_BUDGET_INSTRUCTIONS} ComputeBudget instructions: one SetComputeUnitLimit and one SetComputeUnitPrice, without accounts`,
    );
  }
  seen.add(kind);
}

/**
 * Decodes a wire transaction and checks everything about it that needs no network.
 * Throws a Refusal naming the first rule it breaks.
 */
export function parseAttestRequest(wire: Uint8Array, attestor: Address, pdas: ProgramPdas): AttestRequest {
  if (wire.length > MAX_TRANSACTION_BYTES) {
    throw new Refusal('bad_transaction', `${wire.length} bytes; a Solana transaction has at most ${MAX_TRANSACTION_BYTES}`);
  }
  let messageBytes: Uint8Array;
  try {
    messageBytes = new Uint8Array(getTransactionDecoder().decode(wire).messageBytes);
  } catch {
    throw new Refusal('bad_transaction', 'not a Solana wire transaction');
  }
  let message: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']>;
  let end: number;
  try {
    [message, end] = getCompiledTransactionMessageDecoder().read(messageBytes, 0);
  } catch {
    throw new Refusal('bad_transaction', 'the transaction message does not decode');
  }
  if (end !== messageBytes.length) throw new Refusal('bad_transaction', 'bytes left over after the transaction message');
  if (message.version !== 'legacy' && message.version !== 0) {
    throw new Refusal('unsupported_version', `transaction version ${String(message.version)}; only legacy and v0 are accepted`);
  }
  if ('addressTableLookups' in message && (message.addressTableLookups?.length ?? 0) > 0) {
    throw new Refusal('lookup_tables', 'address lookup tables are not accepted: every account must be in the message');
  }

  const keys = message.staticAccounts;
  const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } = message.header;
  if (
    new Set(keys).size !== keys.length ||
    numSignerAccounts < 1 ||
    numSignerAccounts > keys.length ||
    numReadonlySignerAccounts >= numSignerAccounts ||
    numReadonlyNonSignerAccounts > keys.length - numSignerAccounts
  ) {
    throw new Refusal('bad_transaction', 'malformed message header or account list');
  }
  const at = keys.indexOf(attestor);
  if (at === 0) throw new Refusal('attestor_is_fee_payer', 'the attestor never pays the fee: it must not be account 0');
  if (at < 0 || at >= numSignerAccounts) throw new Refusal('attestor_not_signer', `the attestor ${attestor} is not a required signer`);
  if (at < numSignerAccounts - numReadonlySignerAccounts) {
    throw new Refusal('attestor_writable', 'the attestor must be a read-only signer');
  }

  const own: { accounts: Address[]; data: Uint8Array }[] = [];
  const budget = new Set<number>();
  for (const ix of message.instructions) {
    const program = keys[ix.programAddressIndex];
    const indices = ix.accountIndices ?? [];
    if (program === undefined || indices.some((i) => i >= keys.length)) {
      throw new Refusal('bad_transaction', 'an instruction points past the account list');
    }
    const data = new Uint8Array(ix.data ?? []);
    if (program === COMPUTE_BUDGET_PROGRAM_ID) {
      checkComputeBudget(indices, data, budget);
      continue;
    }
    // Exact comparison with the program id (5kUCKYAY...): base58 of 32 bytes is canonical.
    if (program !== PROGRAM_ID) {
      throw new Refusal('foreign_instruction', `instruction to ${program}: only ComputeBudget and FlipTheMeme are accepted`);
    }
    own.push({ accounts: indices.map((i) => keys[i] as Address), data });
  }
  const ix = own[0];
  if (own.length !== 1 || !ix) throw new Refusal('instruction_count', `${own.length} FlipTheMeme instructions; exactly one is accepted`);
  const instruction = hasDiscriminator(ix.data, IX.setStrike) ? 'set_strike' : hasDiscriminator(ix.data, IX.settle) ? 'settle' : null;
  if (!instruction) throw new Refusal('unknown_discriminator', 'the FlipTheMeme instruction is neither set_strike nor settle');
  const samples = parseSamples(ix.data);

  const accounts = ix.accounts;
  if (accounts.length !== PRICE_UPDATE_ACCOUNTS) {
    throw new Refusal('wrong_accounts', `${instruction} lists ${accounts.length} accounts; it takes ${PRICE_UPDATE_ACCOUNTS}: config, round, price_authority, oracle, attestor`);
  }
  if (accounts[CONFIG_ACCOUNT_INDEX] !== pdas.config) {
    throw new Refusal('wrong_accounts', `account ${CONFIG_ACCOUNT_INDEX} is ${accounts[CONFIG_ACCOUNT_INDEX]}, not the Config PDA ${pdas.config}`);
  }
  if (accounts[ORACLE_ACCOUNT_INDEX] !== pdas.oracle) {
    throw new Refusal('wrong_accounts', `account ${ORACLE_ACCOUNT_INDEX} is ${accounts[ORACLE_ACCOUNT_INDEX]}, not the OracleConfig PDA ${pdas.oracle}`);
  }
  if (accounts[ATTESTOR_ACCOUNT_INDEX] !== attestor) {
    throw new Refusal('attestor_not_in_instruction', `account ${ATTESTOR_ACCOUNT_INDEX} of ${instruction} is not the attestor`);
  }
  return { messageBytes, instruction, samples, accounts, feePayer: keys[0] as Address };
}

const STATUS_NAMES = ['open', 'live', 'final'] as const;
export const statusName = (status: number): string => STATUS_NAMES[status] ?? `status ${status}`;

/**
 * set_strike needs an Open round with `strike_end <= now < exit_start`, settle a Live round past
 * exit_end (attestor clock). The upper bound of set_strike mirrors the program: once the exit
 * window has opened a strike could be chosen with the exit already in sight, so the program rejects
 * it and the round ends through refund_expired. The attestor never co-signs one, even for a round
 * that was never activated (the program checks the window before that).
 */
export function checkRound(
  instruction: PriceInstruction,
  round: Pick<RoundAccount, 'id' | 'status' | 'strikeEnd' | 'exitStart' | 'exitEnd'>,
  nowMs: number,
): void {
  const wanted = instruction === 'set_strike' ? RoundStatus.Open : RoundStatus.Live;
  if (round.status !== wanted) {
    throw new Refusal('round_state', `round ${round.id} is ${statusName(round.status)}; ${instruction} needs it ${statusName(wanted)}`);
  }
  const endMs = Number(instruction === 'set_strike' ? round.strikeEnd : round.exitEnd) * 1000;
  if (nowMs < endMs) {
    const window = instruction === 'set_strike' ? 'strike' : 'exit';
    throw new Refusal('window_open', `round ${round.id}: the ${window} window ends at ${new Date(endMs).toISOString()}`);
  }
  if (instruction === 'set_strike') {
    const lateMs = Number(round.exitStart) * 1000;
    if (nowMs >= lateMs) {
      throw new Refusal(
        'strike_too_late',
        `round ${round.id}: the exit window opened at ${new Date(lateMs).toISOString()}; a strike set after that is rejected, and the round ends through refund_expired`,
      );
    }
  }
}
