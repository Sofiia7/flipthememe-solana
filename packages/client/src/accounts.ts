import {
  fixDecoderSize,
  getAddressDecoder,
  getBooleanDecoder,
  getBytesDecoder,
  getI64Decoder,
  getStructDecoder,
  getU16Decoder,
  getU32Decoder,
  getU64Decoder,
  getU8Decoder,
  type Address,
} from '@solana/kit';
import { ACCOUNT, type Outcome, type RefundReason, type RoundStatus, type Side } from './constants.ts';

const pubkey = getAddressDecoder();
const u8 = getU8Decoder();
const u16 = getU16Decoder();
const u32 = getU32Decoder();
const u64 = getU64Decoder();
const i64 = getI64Decoder();
const bool = getBooleanDecoder();

export type ConfigAccount = {
  admin: Address;
  priceAuthority: Address;
  houseAuthority: Address;
  treasury: Address;
  paused: boolean;
  nextRoundId: bigint;
  minStake: bigint;
  maxStake: bigint;
  minBank: bigint;
  feeWinBps: number;
  feeRefundBps: number;
  totalAvailable: bigint;
  totalLocked: bigint;
  bump: number;
};

export type VaultAccount = { authority: Address; available: bigint; locked: bigint; bump: number };

export type SessionAccount = {
  authority: Address;
  vault: Address;
  signer: Address;
  expiry: bigint;
  maxPerBet: bigint;
  sessionCap: bigint;
  spent: bigint;
  revoked: boolean;
  bump: number;
};

export type RoundAccount = {
  id: bigint;
  tokenMint: Address;
  pool: Address;
  opensAt: bigint;
  cutoffAt: bigint;
  strikeStart: bigint;
  strikeEnd: bigint;
  exitStart: bigint;
  exitEnd: bigint;
  settleDeadline: bigint;
  minStake: bigint;
  maxStake: bigint;
  minBank: bigint;
  maxBank: bigint;
  feeWinBps: number;
  feeRefundBps: number;
  rawUp: bigint;
  rawDown: bigint;
  houseAmount: bigint;
  positionCount: number;
  claimedCount: number;
  totalPaid: bigint;
  feesSwept: boolean;
  status: RoundStatus;
  outcome: Outcome;
  refundReason: RefundReason;
  strikePrice: bigint;
  exitPrice: bigint;
  strikeSamples: number;
  exitSamples: number;
  bump: number;
};

export type PositionAccount = {
  round: Address;
  authority: Address;
  side: Side;
  stake: bigint;
  face: Uint8Array;
  isHouse: boolean;
  claimed: boolean;
  payout: bigint;
  bump: number;
};

/** On-chain house ceiling; `spent` belongs to UTC day `day` (unix seconds / 86400). */
export type HouseLimitsAccount = { roundCap: bigint; dailyCap: bigint; day: bigint; spent: bigint; bump: number };

/** The independent price attestor: while `required`, set_strike and settle need its signature. */
export type OracleConfigAccount = { attestor: Address; required: boolean; bump: number };

const configDecoder = getStructDecoder([
  ['admin', pubkey],
  ['priceAuthority', pubkey],
  ['houseAuthority', pubkey],
  ['treasury', pubkey],
  ['paused', bool],
  ['nextRoundId', u64],
  ['minStake', u64],
  ['maxStake', u64],
  ['minBank', u64],
  ['feeWinBps', u16],
  ['feeRefundBps', u16],
  ['totalAvailable', u64],
  ['totalLocked', u64],
  ['bump', u8],
]);

const vaultDecoder = getStructDecoder([
  ['authority', pubkey],
  ['available', u64],
  ['locked', u64],
  ['bump', u8],
]);

const sessionDecoder = getStructDecoder([
  ['authority', pubkey],
  ['vault', pubkey],
  ['signer', pubkey],
  ['expiry', i64],
  ['maxPerBet', u64],
  ['sessionCap', u64],
  ['spent', u64],
  ['revoked', bool],
  ['bump', u8],
]);

const roundDecoder = getStructDecoder([
  ['id', u64],
  ['tokenMint', pubkey],
  ['pool', pubkey],
  ['opensAt', i64],
  ['cutoffAt', i64],
  ['strikeStart', i64],
  ['strikeEnd', i64],
  ['exitStart', i64],
  ['exitEnd', i64],
  ['settleDeadline', i64],
  ['minStake', u64],
  ['maxStake', u64],
  ['minBank', u64],
  ['maxBank', u64],
  ['feeWinBps', u16],
  ['feeRefundBps', u16],
  ['rawUp', u64],
  ['rawDown', u64],
  ['houseAmount', u64],
  ['positionCount', u32],
  ['claimedCount', u32],
  ['totalPaid', u64],
  ['feesSwept', bool],
  ['status', u8],
  ['outcome', u8],
  ['refundReason', u8],
  ['strikePrice', u64],
  ['exitPrice', u64],
  ['strikeSamples', u8],
  ['exitSamples', u8],
  ['bump', u8],
]);

const positionDecoder = getStructDecoder([
  ['round', pubkey],
  ['authority', pubkey],
  ['side', u8],
  ['stake', u64],
  ['face', fixDecoderSize(getBytesDecoder(), 8)],
  ['isHouse', bool],
  ['claimed', bool],
  ['payout', u64],
  ['bump', u8],
]);

const houseLimitsDecoder = getStructDecoder([
  ['roundCap', u64],
  ['dailyCap', u64],
  ['day', i64],
  ['spent', u64],
  ['bump', u8],
]);

const oracleConfigDecoder = getStructDecoder([
  ['attestor', pubkey],
  ['required', bool],
  ['bump', u8],
]);

function hasDiscriminator(data: Uint8Array, expected: Uint8Array): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) if (data[i] !== expected[i]) return false;
  return true;
}

function decodeWith<T>(name: keyof typeof ACCOUNT, decoder: { decode(bytes: Uint8Array, offset?: number): unknown }, data: Uint8Array): T {
  if (!hasDiscriminator(data, ACCOUNT[name])) throw new Error(`not a ${name} account`);
  return decoder.decode(data, 8) as T;
}

export const decodeConfig = (data: Uint8Array) => decodeWith<ConfigAccount>('Config', configDecoder, data);
export const decodeVault = (data: Uint8Array) => decodeWith<VaultAccount>('Vault', vaultDecoder, data);
export const decodeSession = (data: Uint8Array) => decodeWith<SessionAccount>('Session', sessionDecoder, data);
export const decodeRound = (data: Uint8Array) => decodeWith<RoundAccount>('Round', roundDecoder, data);
export const decodePosition = (data: Uint8Array) => {
  const p = decodeWith<PositionAccount>('Position', positionDecoder, data);
  return { ...p, face: new Uint8Array(p.face) };
};
export const decodeHouseLimits = (data: Uint8Array) => decodeWith<HouseLimitsAccount>('HouseLimits', houseLimitsDecoder, data);
export const decodeOracleConfig = (data: Uint8Array) => decodeWith<OracleConfigAccount>('OracleConfig', oracleConfigDecoder, data);

/** True when the bytes carry the discriminator of `name`; used to filter program accounts. */
export function isAccount(name: keyof typeof ACCOUNT, data: Uint8Array): boolean {
  return hasDiscriminator(data, ACCOUNT[name]);
}

/** Byte offsets for getProgramAccounts memcmp filters (after the 8-byte discriminator). */
export const OFFSETS = {
  positionRound: 8,
  positionAuthority: 8 + 32,
  /** round, authority, side, stake and face come first: `is_house` is the byte after them (89). */
  positionIsHouse: 8 + 32 + 32 + 1 + 8 + 8,
  /** round, authority, side, stake, face, is_house come first. */
  positionClaimed: 8 + 32 + 32 + 1 + 8 + 8 + 1,
  sessionAuthority: 8,
} as const;
