import {
  AccountRole,
  fixEncoderSize,
  getAddressEncoder,
  getArrayEncoder,
  getBooleanEncoder,
  getBytesEncoder,
  getI64Encoder,
  getStructEncoder,
  getU16Encoder,
  getU64Encoder,
  getU8Encoder,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
import { IX, PROGRAM_ID, SYSTEM_PROGRAM_ID, type Side } from './constants.ts';
import { configAddress, positionAddress, roundAddress, sessionAddress, vaultAddress } from './pda.ts';

/** A plain address, or a signer object that kit's signing helpers can pick up from the instruction. */
export type SignerLike = Address | TransactionSigner;

export type ConfigParams = {
  priceAuthority: Address;
  houseAuthority: Address;
  treasury: Address;
  minStake: bigint;
  maxStake: bigint;
  minBank: bigint;
  feeWinBps: number;
  feeRefundBps: number;
};

export type CreateRoundArgs = {
  tokenMint: Address;
  pool: Address;
  opensAt: bigint;
  cutoffAt: bigint;
  strikeStart: bigint;
  strikeEnd: bigint;
  exitStart: bigint;
  exitEnd: bigint;
  settleDeadline: bigint;
  maxBank: bigint;
};

export type PriceSample = { slot: bigint; price: bigint };

const pubkey = getAddressEncoder();
const u64 = getU64Encoder();
const i64 = getI64Encoder();
const u16 = getU16Encoder();

const configParamsEncoder = getStructEncoder([
  ['priceAuthority', pubkey],
  ['houseAuthority', pubkey],
  ['treasury', pubkey],
  ['minStake', u64],
  ['maxStake', u64],
  ['minBank', u64],
  ['feeWinBps', u16],
  ['feeRefundBps', u16],
]);

const createRoundEncoder = getStructEncoder([
  ['roundId', u64],
  [
    'args',
    getStructEncoder([
      ['tokenMint', pubkey],
      ['pool', pubkey],
      ['opensAt', i64],
      ['cutoffAt', i64],
      ['strikeStart', i64],
      ['strikeEnd', i64],
      ['exitStart', i64],
      ['exitEnd', i64],
      ['settleDeadline', i64],
      ['maxBank', u64],
    ]),
  ],
]);

const placeBetEncoder = getStructEncoder([
  ['side', getU8Encoder()],
  ['amount', u64],
  ['face', fixEncoderSize(getBytesEncoder(), 8)],
]);

const samplesEncoder = getArrayEncoder(getStructEncoder([['slot', u64], ['price', u64]]));

const startSessionEncoder = getStructEncoder([
  ['expiry', i64],
  ['maxPerBet', u64],
  ['sessionCap', u64],
]);

function data(discriminator: Uint8Array, args?: ReadonlyUint8Array): Uint8Array {
  const out = new Uint8Array(8 + (args?.length ?? 0));
  out.set(discriminator, 0);
  if (args) out.set(args, 8);
  return out;
}
type ReadonlyUint8Array = Omit<Uint8Array, 'set' | 'fill' | 'copyWithin' | 'reverse' | 'sort'> & ArrayLike<number>;

const ro = (address: Address) => ({ address, role: AccountRole.READONLY });
const rw = (address: Address) => ({ address, role: AccountRole.WRITABLE });
function sign(s: SignerLike, writable: boolean) {
  const role = writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER;
  return typeof s === 'string' ? { address: s, role } : { address: s.address, role, signer: s };
}
const addressOf = (s: SignerLike): Address => (typeof s === 'string' ? s : s.address);

function build(programAddress: Address, accounts: Instruction['accounts'], bytes: Uint8Array): Instruction {
  return { programAddress, accounts, data: bytes } as Instruction;
}

type WithProgram = { programId?: Address };

export async function initializeConfig(i: { admin: SignerLike; params: ConfigParams } & WithProgram): Promise<Instruction> {
  const p = i.programId ?? PROGRAM_ID;
  return build(p, [rw(await configAddress(p)), sign(i.admin, true), ro(SYSTEM_PROGRAM_ID)], data(IX.initializeConfig, configParamsEncoder.encode(i.params)));
}

export async function updateConfig(i: { admin: SignerLike; params: ConfigParams } & WithProgram): Promise<Instruction> {
  const p = i.programId ?? PROGRAM_ID;
  return build(p, [rw(await configAddress(p)), sign(i.admin, false)], data(IX.updateConfig, configParamsEncoder.encode(i.params)));
}

export async function setPause(i: { admin: SignerLike; paused: boolean } & WithProgram): Promise<Instruction> {
  const p = i.programId ?? PROGRAM_ID;
  return build(p, [rw(await configAddress(p)), sign(i.admin, false)], data(IX.setPause, getBooleanEncoder().encode(i.paused)));
}

export async function openVault(i: { owner: SignerLike } & WithProgram): Promise<Instruction> {
  const p = i.programId ?? PROGRAM_ID;
  const owner = addressOf(i.owner);
  return build(p, [ro(await configAddress(p)), rw(await vaultAddress(owner, p)), sign(i.owner, true), ro(SYSTEM_PROGRAM_ID)], data(IX.openVault));
}

export async function deposit(i: { owner: SignerLike; amount: bigint } & WithProgram): Promise<Instruction> {
  const p = i.programId ?? PROGRAM_ID;
  const owner = addressOf(i.owner);
  return build(
    p,
    [rw(await configAddress(p)), rw(await vaultAddress(owner, p)), sign(i.owner, true), ro(SYSTEM_PROGRAM_ID)],
    data(IX.deposit, u64.encode(i.amount)),
  );
}

export async function withdraw(i: { owner: SignerLike; amount: bigint } & WithProgram): Promise<Instruction> {
  const p = i.programId ?? PROGRAM_ID;
  const owner = addressOf(i.owner);
  return build(p, [rw(await configAddress(p)), rw(await vaultAddress(owner, p)), sign(i.owner, true)], data(IX.withdraw, u64.encode(i.amount)));
}

export async function startSession(
  i: { owner: SignerLike; sessionSigner: Address; expiry: bigint; maxPerBet: bigint; sessionCap: bigint } & WithProgram,
): Promise<Instruction> {
  const p = i.programId ?? PROGRAM_ID;
  const owner = addressOf(i.owner);
  const vault = await vaultAddress(owner, p);
  return build(
    p,
    [
      ro(await configAddress(p)),
      ro(vault),
      rw(await sessionAddress(vault, i.sessionSigner, p)),
      sign(i.owner, true),
      ro(i.sessionSigner),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data(IX.startSession, startSessionEncoder.encode(i)),
  );
}

export async function revokeSession(i: { owner: SignerLike; sessionSigner: Address } & WithProgram): Promise<Instruction> {
  const p = i.programId ?? PROGRAM_ID;
  const owner = addressOf(i.owner);
  const vault = await vaultAddress(owner, p);
  return build(p, [ro(vault), rw(await sessionAddress(vault, i.sessionSigner, p)), sign(i.owner, false)], data(IX.revokeSession));
}

export async function createRound(i: { admin: SignerLike; roundId: bigint; args: CreateRoundArgs } & WithProgram): Promise<Instruction> {
  const p = i.programId ?? PROGRAM_ID;
  return build(
    p,
    [rw(await configAddress(p)), rw(await roundAddress(i.roundId, p)), sign(i.admin, true), ro(SYSTEM_PROGRAM_ID)],
    data(IX.createRound, createRoundEncoder.encode({ roundId: i.roundId, args: i.args })),
  );
}

/** Signed and paid by the session key; `owner` is the wallet that owns the vault. */
export async function placeBet(
  i: { owner: Address; sessionSigner: SignerLike; roundId: bigint; side: Side; amount: bigint; face: Uint8Array } & WithProgram,
): Promise<Instruction> {
  const p = i.programId ?? PROGRAM_ID;
  const round = await roundAddress(i.roundId, p);
  const vault = await vaultAddress(i.owner, p);
  const key = addressOf(i.sessionSigner);
  return build(
    p,
    [
      rw(await configAddress(p)),
      rw(round),
      rw(vault),
      rw(await sessionAddress(vault, key, p)),
      rw(await positionAddress(round, i.owner, p)),
      sign(i.sessionSigner, true),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data(IX.placeBet, placeBetEncoder.encode({ side: i.side, amount: i.amount, face: i.face.slice(0, 8) })),
  );
}

export async function houseFill(i: { house: SignerLike; roundId: bigint; amount: bigint } & WithProgram): Promise<Instruction> {
  const p = i.programId ?? PROGRAM_ID;
  const house = addressOf(i.house);
  const round = await roundAddress(i.roundId, p);
  return build(
    p,
    [
      rw(await configAddress(p)),
      rw(round),
      rw(await vaultAddress(house, p)),
      rw(await positionAddress(round, house, p)),
      sign(i.house, true),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data(IX.houseFill, u64.encode(i.amount)),
  );
}

export async function setStrike(i: { priceAuthority: SignerLike; roundId: bigint; samples: PriceSample[] } & WithProgram): Promise<Instruction> {
  const p = i.programId ?? PROGRAM_ID;
  return build(
    p,
    [ro(await configAddress(p)), rw(await roundAddress(i.roundId, p)), sign(i.priceAuthority, false)],
    data(IX.setStrike, samplesEncoder.encode(i.samples)),
  );
}

export async function settle(i: { priceAuthority: SignerLike; roundId: bigint; samples: PriceSample[] } & WithProgram): Promise<Instruction> {
  const p = i.programId ?? PROGRAM_ID;
  return build(
    p,
    [ro(await configAddress(p)), rw(await roundAddress(i.roundId, p)), sign(i.priceAuthority, false)],
    data(IX.settle, samplesEncoder.encode(i.samples)),
  );
}

export async function refundExpired(i: { roundId: bigint } & WithProgram): Promise<Instruction> {
  const p = i.programId ?? PROGRAM_ID;
  return build(p, [rw(await roundAddress(i.roundId, p))], data(IX.refundExpired));
}

/** Permissionless: whoever pays the fee, the payout lands in the owner's vault. */
export async function claim(i: { roundId: bigint; owner: Address } & WithProgram): Promise<Instruction> {
  const p = i.programId ?? PROGRAM_ID;
  const round = await roundAddress(i.roundId, p);
  return build(
    p,
    [rw(await configAddress(p)), rw(round), rw(await positionAddress(round, i.owner, p)), rw(await vaultAddress(i.owner, p))],
    data(IX.claim),
  );
}

export async function sweepFees(i: { roundId: bigint; treasury: Address } & WithProgram): Promise<Instruction> {
  const p = i.programId ?? PROGRAM_ID;
  return build(p, [rw(await configAddress(p)), rw(await roundAddress(i.roundId, p)), rw(i.treasury)], data(IX.sweepFees));
}

export async function closeEmptyRound(i: { roundId: bigint; admin: Address } & WithProgram): Promise<Instruction> {
  const p = i.programId ?? PROGRAM_ID;
  return build(p, [ro(await configAddress(p)), rw(await roundAddress(i.roundId, p)), rw(i.admin)], data(IX.closeEmptyRound));
}
