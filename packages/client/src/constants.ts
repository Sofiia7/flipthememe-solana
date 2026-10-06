import { address, type Address } from '@solana/kit';

/** Devnet deployment of programs/flip-the-meme. */
export const PROGRAM_ID: Address = address('5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz');
export const SYSTEM_PROGRAM_ID: Address = address('11111111111111111111111111111111');

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Anchor discriminators: sha256("global:<ix>"), sha256("account:<Name>"), sha256("event:<Name>"), first 8 bytes. */
export const IX = {
  initializeConfig: new Uint8Array([208, 127, 21, 1, 194, 190, 196, 70]),
  updateConfig: new Uint8Array([29, 158, 252, 191, 10, 83, 219, 99]),
  setPause: new Uint8Array([63, 32, 154, 2, 56, 103, 79, 45]),
  openVault: new Uint8Array([181, 248, 228, 67, 6, 175, 37, 167]),
  deposit: new Uint8Array([242, 35, 198, 137, 82, 225, 242, 182]),
  withdraw: new Uint8Array([183, 18, 70, 156, 148, 109, 161, 34]),
  startSession: new Uint8Array([23, 227, 111, 142, 212, 230, 3, 175]),
  revokeSession: new Uint8Array([86, 92, 198, 120, 144, 2, 7, 194]),
  createRound: new Uint8Array([229, 218, 236, 169, 231, 80, 134, 112]),
  placeBet: new Uint8Array([222, 62, 67, 220, 63, 166, 126, 33]),
  houseFill: new Uint8Array([154, 201, 96, 156, 58, 221, 102, 235]),
  setStrike: new Uint8Array([141, 116, 9, 160, 105, 130, 61, 88]),
  settle: new Uint8Array([175, 42, 185, 87, 144, 131, 102, 212]),
  refundExpired: new Uint8Array([118, 153, 164, 244, 40, 128, 242, 250]),
  claim: new Uint8Array([62, 198, 214, 193, 213, 159, 108, 210]),
  sweepFees: new Uint8Array([175, 225, 98, 71, 118, 66, 34, 148]),
  closeEmptyRound: new Uint8Array([13, 204, 252, 231, 59, 21, 152, 146]),
  closePosition: new Uint8Array([123, 134, 81, 0, 49, 68, 98, 98]),
  initHouseLimits: new Uint8Array([170, 212, 23, 98, 213, 220, 127, 249]),
  updateHouseLimits: new Uint8Array([238, 112, 193, 244, 25, 131, 67, 81]),
  initOracle: new Uint8Array([78, 100, 33, 183, 96, 207, 60, 91]),
  setOracle: new Uint8Array([186, 128, 81, 104, 74, 79, 18, 224]),
} as const;

export const ACCOUNT = {
  Config: new Uint8Array([155, 12, 170, 224, 30, 250, 204, 130]),
  Vault: new Uint8Array([211, 8, 232, 43, 2, 152, 117, 119]),
  Session: new Uint8Array([243, 81, 72, 115, 214, 188, 72, 144]),
  Round: new Uint8Array([87, 127, 165, 51, 73, 78, 116, 174]),
  Position: new Uint8Array([170, 188, 143, 228, 122, 64, 247, 208]),
  HouseLimits: new Uint8Array([120, 141, 151, 233, 161, 195, 23, 121]),
  OracleConfig: new Uint8Array([133, 196, 152, 50, 27, 21, 145, 254]),
} as const;

export const EVENT = {
  BetPlaced: new Uint8Array([88, 88, 145, 226, 126, 206, 32, 0]),
  StrikeSet: new Uint8Array([206, 31, 210, 238, 79, 123, 152, 18]),
  RoundSettled: new Uint8Array([249, 225, 66, 54, 157, 200, 234, 222]),
  Claimed: new Uint8Array([217, 192, 123, 72, 108, 150, 248, 33]),
  PositionClosed: new Uint8Array([157, 163, 227, 228, 13, 97, 138, 121]),
} as const;

/** Program: a claimed position of a Final round may be closed once its exit_end is this far behind. */
export const POSITION_CLOSE_DELAY_SECS = 3_600n;
/**
 * Bytes of a Position account (8-byte discriminator + Position::INIT_SPACE). Its rent-exempt
 * minimum (getMinimumBalanceForRentExemption) comes out of the vault at every bet, on top of the stake.
 */
export const POSITION_ACCOUNT_SIZE = 100;
/** Program: the house daily cap counts per UTC day, `unix_timestamp / SECS_PER_DAY`. */
export const SECS_PER_DAY = 86_400n;

/** Borsh enum tags, in declaration order of the Rust enums. */
export const Side = { Up: 0, Down: 1 } as const;
export type Side = (typeof Side)[keyof typeof Side];
export const RoundStatus = { Open: 0, Live: 1, Final: 2 } as const;
export type RoundStatus = (typeof RoundStatus)[keyof typeof RoundStatus];
export const Outcome = { Pending: 0, Up: 1, Down: 2, Refund: 3, NotActivated: 4 } as const;
export type Outcome = (typeof Outcome)[keyof typeof Outcome];
export const RefundReason = { None: 0, Tie: 1, Unpriceable: 2, Expired: 3 } as const;
export type RefundReason = (typeof RefundReason)[keyof typeof RefundReason];

/**
 * Devnet economics (also snapshotted into every Round). Refunds are free since 5 October 2026
 * (update_config set fee_refund_bps to 0); rounds created before keep the 1% they were created with.
 */
export const DEVNET_PARAMS = {
  minStake: LAMPORTS_PER_SOL / 100n,
  maxStake: LAMPORTS_PER_SOL / 10n,
  minBank: (2n * LAMPORTS_PER_SOL) / 100n,
  feeWinBps: 200,
  feeRefundBps: 0,
} as const;

/** Pool-depth rule from the Robinhood Chain rounds: accepted bank <= quote reserve / K. */
export const DEPTH_K = 2500n;
export const MAX_BANK_CEILING = LAMPORTS_PER_SOL;

/** Round cadence in seconds. A new round opens every ENTRY_SECS. */
export const TIMING = {
  entrySecs: 60,
  pauseSecs: 30,
  strikeSecs: 10,
  /** Exit window starts this long after the strike window starts. */
  moveSecs: 60,
  exitSecs: 10,
  /** After exit_end, anyone may turn an unsettled round into a refund. */
  deadlineSecs: 600,
} as const;

export type RoundTimes = {
  opensAt: bigint;
  cutoffAt: bigint;
  strikeStart: bigint;
  strikeEnd: bigint;
  exitStart: bigint;
  exitEnd: bigint;
  settleDeadline: bigint;
};

export function roundTimes(opensAt: bigint): RoundTimes {
  const cutoffAt = opensAt + BigInt(TIMING.entrySecs);
  const strikeStart = cutoffAt + BigInt(TIMING.pauseSecs);
  const strikeEnd = strikeStart + BigInt(TIMING.strikeSecs);
  const exitStart = strikeStart + BigInt(TIMING.moveSecs);
  const exitEnd = exitStart + BigInt(TIMING.exitSecs);
  return {
    opensAt,
    cutoffAt,
    strikeStart,
    strikeEnd,
    exitStart,
    exitEnd,
    settleDeadline: exitEnd + BigInt(TIMING.deadlineSecs),
  };
}
