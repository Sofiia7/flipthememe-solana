// Run: node --test "services/attestor/test/*.test.ts" (from the repo root). No network.
// Transactions are built with the client's builders (set_strike and settle with the oracle and
// attestor accounts) and compiled by kit, as the keeper builds them.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  IX,
  PROGRAM_ID,
  RoundStatus,
  configAddress,
  oracleAddress,
  roundAddress,
  setStrike,
  settle,
  transferSol,
  type PriceSample,
} from '@flipthememe/client';
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from '@solana/kit';
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  MAX_COMPUTE_BUDGET_INSTRUCTIONS,
  PROGRAM_MAX_SAMPLES,
  REASONS,
  ROUND_ACCOUNT_INDEX,
  Refusal,
  checkRound,
  decodeBase64,
  parseAttestRequest,
  parseSamples,
  type Reason,
} from '../src/check.ts';
import { ATTESTOR, BLOCKHASH, makeRound, testAddress, toBytes, wire } from './helpers.ts';

const KEEPER = testAddress(10);
const SAMPLES: PriceSample[] = Array.from({ length: 10 }, (_, i) => ({ slot: 1_000n + BigInt(i), price: 5_000_000n + BigInt(i) }));
const PDAS = { config: await configAddress(), oracle: await oracleAddress() };

type StrikeOptions = { samples?: PriceSample[]; roundId?: bigint; attestor?: Address | null; programId?: Address };
const strikeIx = (o: StrikeOptions = {}) =>
  setStrike({
    priceAuthority: KEEPER,
    roundId: o.roundId ?? 7n,
    samples: o.samples ?? SAMPLES,
    attestor: o.attestor === undefined ? ATTESTOR : o.attestor,
    programId: o.programId,
  });

/** `ix` with the account at `address` given another role. */
function withRole(ix: Instruction, address: Address, role: AccountRole): Instruction {
  return { ...ix, accounts: ix.accounts?.map((a) => (a.address === address ? { address, role } : a)) } as Instruction;
}

/** `ix` with its account list rewritten. */
function withAccounts(ix: Instruction, edit: (accounts: NonNullable<Instruction['accounts']>) => NonNullable<Instruction['accounts']>): Instruction {
  return { ...ix, accounts: edit([...(ix.accounts ?? [])]) } as Instruction;
}

function computeBudget(kind: number, payload: number[]): Instruction {
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ID, data: Uint8Array.from([kind, ...payload]) } as Instruction;
}
const computeUnitLimit = (units: number) => computeBudget(2, [units & 255, (units >> 8) & 255, (units >> 16) & 255, 0]);
const computeUnitPrice = (microLamports: number) => computeBudget(3, [microLamports & 255, (microLamports >> 8) & 255, 0, 0, 0, 0, 0, 0]);
const requestHeapFrame = () => computeBudget(1, [0, 0, 1, 0]);
const loadedAccountsDataSize = () => computeBudget(4, [0, 0, 1, 0]);

const parse = (instructions: Instruction[], feePayer: Address = KEEPER) => parseAttestRequest(toBytes(wire(instructions, feePayer).tx), ATTESTOR, PDAS);
const parseBytes = (bytes: Uint8Array) => parseAttestRequest(bytes, ATTESTOR, PDAS);

function refusal(fn: () => unknown): Reason {
  try {
    fn();
  } catch (error) {
    if (error instanceof Refusal) return error.reason;
    throw error;
  }
  assert.fail('expected a refusal');
}

function message(instructions: Instruction[]) {
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(KEEPER, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000n }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
}

/** Wire bytes of a compiled message, with an empty signature per required signer. */
function rawWire(compiled: Parameters<ReturnType<typeof getCompiledTransactionMessageEncoder>['encode']>[0]): Uint8Array {
  const messageBytes = getCompiledTransactionMessageEncoder().encode(compiled);
  const signers = compiled.header.numSignerAccounts;
  const out = new Uint8Array(1 + 64 * signers + messageBytes.length);
  out[0] = signers;
  out.set(messageBytes, 1 + 64 * signers);
  return out;
}

test('the program id and the PDAs are exactly the devnet deployment', () => {
  assert.equal(PROGRAM_ID, '5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz');
  assert.equal(PDAS.config, 'A6k9oP8NT249nCM1g6DupAKgVT7dHLyGwbFn5VLbA8RQ');
  assert.equal(PDAS.oracle, 'EMXqXiGXcuzvf9ZD1P6B4HjDVF7earLVNJqah7YLwDZ1');
  assert.equal(ROUND_ACCOUNT_INDEX, 1);
});

describe('accepted transactions', () => {
  test('set_strike from the client builder: instruction, samples, accounts, message bytes', async () => {
    const { tx, messageBytes } = wire([await strikeIx()], KEEPER);
    const request = parseAttestRequest(toBytes(tx), ATTESTOR, PDAS);
    assert.equal(request.instruction, 'set_strike');
    assert.deepEqual(request.samples, SAMPLES);
    assert.deepEqual(request.messageBytes, messageBytes);
    assert.equal(request.feePayer, KEEPER);
    // 0 config, 1 round, 2 price_authority, 3 oracle, 4 attestor (PriceUpdate in programs/flip-the-meme)
    assert.deepEqual(request.accounts, [PDAS.config, await roundAddress(7n), KEEPER, PDAS.oracle, ATTESTOR]);
  });

  test('settle, a legacy message, and up to two ComputeBudget instructions around it', async () => {
    const ix = await settle({ priceAuthority: KEEPER, roundId: 7n, samples: SAMPLES, attestor: ATTESTOR });
    assert.equal(parse([ix]).instruction, 'settle');
    assert.equal(parseBytes(toBytes(wire([ix], KEEPER, 'legacy').tx)).instruction, 'settle');
    assert.equal(parse([computeUnitLimit(60_000), ix, computeUnitPrice(1_000)]).instruction, 'settle');
    assert.equal(parse([computeUnitPrice(1_000), ix]).instruction, 'settle');
  });

  test('an empty sample list parses (whether it is co-signed depends on the round)', async () => {
    assert.deepEqual(parse([await strikeIx({ samples: [] })]).samples, []);
  });
});

describe('refused transactions', () => {
  test('wrong program: the same instruction sent to another program', async () => {
    const ix = await strikeIx({ programId: testAddress(77) });
    assert.equal(refusal(() => parse([ix])), 'foreign_instruction');
  });

  test('extra instruction: a transfer, a second set_strike', async () => {
    const ix = await strikeIx();
    assert.equal(refusal(() => parse([ix, transferSol({ from: KEEPER, to: testAddress(5), lamports: 1n })])), 'foreign_instruction');
    const second = await strikeIx({ roundId: 8n });
    assert.equal(refusal(() => parse([ix, second])), 'instruction_count');
  });

  test(`ComputeBudget: at most ${MAX_COMPUTE_BUDGET_INSTRUCTIONS}, one limit and one price, no accounts`, async () => {
    const ix = await strikeIx();
    assert.equal(MAX_COMPUTE_BUDGET_INSTRUCTIONS, 2);
    for (const budget of [
      [computeUnitLimit(1), computeUnitLimit(2)],
      [computeUnitPrice(1), computeUnitPrice(2)],
      [computeUnitLimit(1), computeUnitPrice(1), computeUnitLimit(3)],
      [requestHeapFrame()],
      [loadedAccountsDataSize()],
      [computeBudget(2, [1, 0, 0])], // a limit one byte short
      [computeBudget(3, [1, 0, 0, 0, 0, 0, 0, 0, 0])], // a price one byte long
      [{ programAddress: COMPUTE_BUDGET_PROGRAM_ID } as Instruction],
      [{ ...computeUnitLimit(1), accounts: [{ address: testAddress(6), role: AccountRole.READONLY }] } as Instruction],
    ]) {
      assert.equal(refusal(() => parse([...budget, ix])), 'compute_budget');
    }
  });

  test('attestor as fee payer', async () => {
    const ix = await strikeIx();
    assert.equal(refusal(() => parse([ix], ATTESTOR)), 'attestor_is_fee_payer');
  });

  test('attestor missing, not a signer, or writable', async () => {
    const ix = await strikeIx();
    assert.equal(refusal(() => parse([withRole(ix, ATTESTOR, AccountRole.READONLY)])), 'attestor_not_signer');
    const withoutAttestor = await strikeIx({ attestor: null }); // the program id stands in the slot
    assert.equal(refusal(() => parse([withoutAttestor])), 'attestor_not_signer');
    assert.equal(refusal(() => parse([withRole(ix, ATTESTOR, AccountRole.WRITABLE_SIGNER)])), 'attestor_writable');
  });

  test('wrong accounts: account 0 not the Config PDA, account 3 not the OracleConfig PDA, a missing or extra account', async () => {
    const ix = await strikeIx();
    const other = testAddress(66);
    assert.equal(refusal(() => parse([withAccounts(ix, (a) => a.map((x, i) => (i === 0 ? { ...x, address: other } : x)))])), 'wrong_accounts');
    assert.equal(refusal(() => parse([withAccounts(ix, (a) => a.map((x, i) => (i === 3 ? { ...x, address: other } : x)))])), 'wrong_accounts');
    // Config and round swapped.
    assert.equal(refusal(() => parse([withAccounts(ix, (a) => [a[1]!, a[0]!, ...a.slice(2)])])), 'wrong_accounts');
    assert.equal(refusal(() => parse([withAccounts(ix, (a) => [...a, { address: other, role: AccountRole.READONLY }])])), 'wrong_accounts');
    assert.equal(refusal(() => parse([withAccounts(ix, (a) => [...a.slice(0, 3), a[4]!])])), 'wrong_accounts');
  });

  test('the attestor signs but is not account 4', async () => {
    const ix = await strikeIx();
    // Price authority and attestor swapped: the attestor is still a read-only signer.
    assert.equal(refusal(() => parse([withAccounts(ix, (a) => [a[0]!, a[1]!, a[4]!, a[3]!, a[2]!])])), 'attestor_not_in_instruction');
    // A second instruction makes the attestor a signer and is then cut from the compiled message.
    const listsAttestor = { programAddress: PROGRAM_ID, accounts: [{ address: ATTESTOR, role: AccountRole.READONLY_SIGNER }], data: IX.claim } as Instruction;
    const compiled = compileTransactionMessage(message([await strikeIx({ attestor: null }), listsAttestor]));
    const bytes = rawWire({ ...compiled, instructions: compiled.instructions.slice(0, 1) });
    assert.equal(refusal(() => parseBytes(bytes)), 'attestor_not_in_instruction');
  });

  test('unknown discriminator', async () => {
    const ix = await strikeIx();
    for (const other of [IX.claim, IX.houseFill, IX.createRound, new Uint8Array(8)]) {
      const data = new Uint8Array(ix.data!);
      data.set(other, 0);
      assert.equal(refusal(() => parse([{ ...ix, data } as Instruction])), 'unknown_discriminator');
    }
    assert.equal(refusal(() => parse([{ ...ix, data: IX.setStrike.slice(0, 7) } as Instruction])), 'unknown_discriminator');
  });

  test('samples the program would reject: unordered slots, a repeated slot, a zero price, too many, stray bytes', async () => {
    for (const samples of [
      [...SAMPLES].reverse(),
      [SAMPLES[0]!, SAMPLES[0]!],
      [...SAMPLES.slice(0, 4), { slot: 2_000n, price: 0n }],
      Array.from({ length: PROGRAM_MAX_SAMPLES + 1 }, (_, i) => ({ slot: BigInt(i + 1), price: 1n })),
    ]) {
      const ix = await strikeIx({ samples });
      assert.equal(refusal(() => parse([ix])), 'bad_samples');
    }
    const ix = await strikeIx();
    const stray = new Uint8Array(ix.data!.length + 1);
    stray.set(ix.data!, 0);
    assert.equal(refusal(() => parse([{ ...ix, data: stray } as Instruction])), 'bad_samples');
    assert.equal(refusal(() => parseSamples(IX.settle)), 'bad_samples');
  });

  test('address lookup tables', async () => {
    const compressed = compressTransactionMessageUsingAddressLookupTables(message([await strikeIx()]), {
      [testAddress(40)]: [PDAS.config],
    });
    const compiled = compileTransactionMessage(compressed);
    assert.ok('addressTableLookups' in compiled && (compiled.addressTableLookups?.length ?? 0) > 0);
    assert.equal(refusal(() => parseBytes(rawWire(compiled))), 'lookup_tables');
  });

  test('not a transaction: garbage, trailing bytes, a repeated account, oversized', async () => {
    assert.equal(refusal(() => parseBytes(new Uint8Array([1, 2, 3]))), 'bad_transaction');
    assert.equal(refusal(() => parseBytes(new Uint8Array())), 'bad_transaction');
    const good = toBytes(wire([await strikeIx()], KEEPER).tx);
    const trailing = new Uint8Array(good.length + 1);
    trailing.set(good, 0);
    assert.equal(refusal(() => parseBytes(trailing)), 'bad_transaction');
    const compiled = compileTransactionMessage(message([await strikeIx()]));
    const repeated = rawWire({ ...compiled, staticAccounts: [...compiled.staticAccounts.slice(0, -1), compiled.staticAccounts[0]!] });
    assert.equal(refusal(() => parseBytes(repeated)), 'bad_transaction');
    assert.equal(refusal(() => parseBytes(new Uint8Array(1300))), 'bad_transaction');
  });

  test('every refusal reason is listed once', () => {
    assert.equal(new Set(REASONS).size, REASONS.length);
  });
});

describe('round state', () => {
  const round = makeRound(7n, 1_800_000_000n, testAddress(1));
  const strikeEndMs = Number(round.strikeEnd) * 1000;
  const exitEndMs = Number(round.exitEnd) * 1000;

  test('set_strike: Open and past strike_end; settle: Live and past exit_end', () => {
    assert.doesNotThrow(() => checkRound('set_strike', round, strikeEndMs));
    assert.equal(refusal(() => checkRound('set_strike', round, strikeEndMs - 1)), 'window_open');
    assert.equal(refusal(() => checkRound('set_strike', { ...round, status: RoundStatus.Live }, strikeEndMs)), 'round_state');
    assert.equal(refusal(() => checkRound('settle', round, exitEndMs)), 'round_state');
    const live = { ...round, status: RoundStatus.Live };
    assert.doesNotThrow(() => checkRound('settle', live, exitEndMs));
    assert.equal(refusal(() => checkRound('settle', live, exitEndMs - 1)), 'window_open');
    assert.equal(refusal(() => checkRound('settle', { ...round, status: RoundStatus.Final }, exitEndMs)), 'round_state');
  });
});

test('base64: strict, padded text only', () => {
  assert.deepEqual(decodeBase64('AQID'), new Uint8Array([1, 2, 3]));
  assert.deepEqual(decodeBase64('AQ=='), new Uint8Array([1]));
  for (const bad of ['', 'AQI', 'AQ=', 'A-ID', 'AQ ID', 'AQID\n', '====']) assert.equal(decodeBase64(bad), null, bad);
});
