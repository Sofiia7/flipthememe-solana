/**
 * A fake devnet RPC for scheduler tests: serves Config, Vault, Round and Position accounts encoded
 * exactly like the program stores them, confirms every transaction at once and records the
 * instructions the keeper actually signed (decoded from the wire bytes).
 */
import {
  ACCOUNT,
  IX,
  OFFSETS,
  PROGRAM_ID,
  RoundStatus,
  Outcome,
  RefundReason,
  configAddress,
  houseLimitsAddress,
  oracleAddress,
  positionAddress,
  roundAddress,
  roundTimes,
  vaultAddress,
  type ConfigAccount,
  type HouseLimitsAccount,
  type OracleConfigAccount,
  type PositionAccount,
  type RoundAccount,
  type VaultAccount,
} from '@flipthememe/client';
import {
  fixEncoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Decoder,
  getBase64Encoder,
  getBooleanEncoder,
  getBytesEncoder,
  getCompiledTransactionMessageDecoder,
  getI64Encoder,
  getStructEncoder,
  getTransactionDecoder,
  getU16Encoder,
  getU32Encoder,
  getU64Encoder,
  getU8Encoder,
  type Address,
} from '@solana/kit';
import type { SolanaRpc } from '../src/rpc.ts';

const pubkey = getAddressEncoder();
const u8 = getU8Encoder();
const u16 = getU16Encoder();
const u32 = getU32Encoder();
const u64 = getU64Encoder();
const i64 = getI64Encoder();
const bool = getBooleanEncoder();

const configEncoder = getStructEncoder([
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
const vaultEncoder = getStructEncoder([
  ['authority', pubkey],
  ['available', u64],
  ['locked', u64],
  ['bump', u8],
]);
const roundEncoder = getStructEncoder([
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
const positionEncoder = getStructEncoder([
  ['round', pubkey],
  ['authority', pubkey],
  ['side', u8],
  ['stake', u64],
  ['face', fixEncoderSize(getBytesEncoder(), 8)],
  ['isHouse', bool],
  ['claimed', bool],
  ['payout', u64],
  ['bump', u8],
]);
const houseLimitsEncoder = getStructEncoder([
  ['roundCap', u64],
  ['dailyCap', u64],
  ['day', i64],
  ['spent', u64],
  ['bump', u8],
]);
const oracleEncoder = getStructEncoder([
  ['attestor', pubkey],
  ['required', bool],
  ['bump', u8],
]);

function account(discriminator: Uint8Array, body: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  out.set(discriminator, 0);
  out.set(body, 8);
  return out;
}

export const encodeConfig = (c: ConfigAccount) => account(ACCOUNT.Config, configEncoder.encode(c));
export const encodeVault = (v: VaultAccount) => account(ACCOUNT.Vault, vaultEncoder.encode(v));
export const encodeRound = (r: RoundAccount) => account(ACCOUNT.Round, roundEncoder.encode(r));
export const encodePosition = (p: PositionAccount) => account(ACCOUNT.Position, positionEncoder.encode(p));
export const encodeHouseLimits = (l: HouseLimitsAccount) => account(ACCOUNT.HouseLimits, houseLimitsEncoder.encode(l));
export const encodeOracle = (o: OracleConfigAccount) => account(ACCOUNT.OracleConfig, oracleEncoder.encode(o));

export const SOL = 1_000_000_000n;

export function makeConfig(keeper: Address, over: Partial<ConfigAccount> = {}): ConfigAccount {
  return {
    admin: keeper,
    priceAuthority: keeper,
    houseAuthority: keeper,
    treasury: keeper,
    paused: false,
    nextRoundId: 0n,
    minStake: SOL / 100n,
    maxStake: SOL / 10n,
    minBank: (2n * SOL) / 100n,
    feeWinBps: 200,
    feeRefundBps: 100,
    totalAvailable: 0n,
    totalLocked: 0n,
    bump: 255,
    ...over,
  };
}

export function makeRound(id: bigint, opensAt: bigint, pool: Address, mint: Address, over: Partial<RoundAccount> = {}): RoundAccount {
  return {
    id,
    tokenMint: mint,
    pool,
    ...roundTimes(opensAt),
    minStake: SOL / 100n,
    maxStake: SOL / 10n,
    minBank: (2n * SOL) / 100n,
    maxBank: SOL,
    feeWinBps: 200,
    feeRefundBps: 100,
    rawUp: 0n,
    rawDown: 0n,
    houseAmount: 0n,
    positionCount: 0,
    claimedCount: 0,
    totalPaid: 0n,
    feesSwept: false,
    status: RoundStatus.Open,
    outcome: Outcome.Pending,
    refundReason: RefundReason.None,
    strikePrice: 0n,
    exitPrice: 0n,
    strikeSamples: 0,
    exitSamples: 0,
    bump: 254,
    ...over,
  };
}

export type SentInstruction = { name: string; program: Address; accounts: Address[]; data: Uint8Array };
/** Signatures of a sent transaction by signer; an all-zero signature means the slot was left empty. */
export type SentSignatures = { messageBytes: Uint8Array; signatures: Record<string, Uint8Array> };

const b64 = getBase64Encoder(); // base64 text -> bytes
const toB64 = getBase64Decoder(); // bytes -> base64 text
const addressAt = getAddressDecoder();
const IX_NAMES = Object.entries(IX) as [string, Uint8Array][];
/** Rent the fake reports for every program account (positions included). */
export const FAKE_ACCOUNT_LAMPORTS = 2_000_000n;

export class FakeChain {
  readonly keeper: Address;
  /** Owner of `vault`; the keeper unless a test splits the house role off. */
  house: Address;
  config: ConfigAccount | null = null;
  vault: VaultAccount | null = null;
  houseLimits: HouseLimitsAccount | null = null;
  oracle: OracleConfigAccount | null = null;
  keeperLamports = 5n * SOL;
  /** Other wallets (a separate house key) and their balances. */
  readonly wallets = new Map<Address, bigint>();
  readonly rounds = new Map<bigint, RoundAccount>();
  /** Positions per round id. */
  readonly positions = new Map<bigint, PositionAccount[]>();
  /** Instructions of every transaction sent, in order. */
  readonly sent: SentInstruction[][] = [];
  /** Signatures of every transaction sent, in the same order as `sent`. */
  readonly signed: SentSignatures[] = [];
  /** Set to make sendTransaction fail (like a simulation error) for the transactions it returns an Error for. */
  failWhen: ((instructions: SentInstruction[]) => Error | null) | null = null;

  constructor(keeper: Address) {
    this.keeper = keeper;
    this.house = keeper;
  }

  private async byAddress(): Promise<Map<string, { data: Uint8Array; lamports: bigint; system: boolean }>> {
    const map = new Map<string, { data: Uint8Array; lamports: bigint; system: boolean }>();
    const program = (data: Uint8Array) => ({ data, lamports: FAKE_ACCOUNT_LAMPORTS, system: false });
    const wallet = (lamports: bigint) => ({ data: new Uint8Array(), lamports, system: true });
    if (this.config) map.set(await configAddress(), program(encodeConfig(this.config)));
    if (this.vault) map.set(await vaultAddress(this.house), program(encodeVault(this.vault)));
    if (this.houseLimits) map.set(await houseLimitsAddress(), program(encodeHouseLimits(this.houseLimits)));
    if (this.oracle) map.set(await oracleAddress(), program(encodeOracle(this.oracle)));
    for (const [address, lamports] of this.wallets) map.set(address, wallet(lamports));
    map.set(this.keeper, wallet(this.keeperLamports));
    for (const [id, round] of this.rounds) map.set(await roundAddress(id), program(encodeRound(round)));
    return map;
  }

  private info(entry: { data: Uint8Array; lamports: bigint; system: boolean }) {
    return {
      data: [toB64.decode(entry.data), 'base64'] as const,
      executable: false,
      lamports: entry.lamports,
      owner: entry.system ? ('11111111111111111111111111111111' as Address) : PROGRAM_ID,
      rentEpoch: 0n,
      space: BigInt(entry.data.length),
    };
  }

  /** Decodes a sent transaction; a failure set by `failWhen` throws before it is recorded as sent. */
  private record(wire: string): void {
    const tx = getTransactionDecoder().decode(b64.encode(wire));
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    // The keeper signs legacy-layout v0 messages; kit's union also has a v1 shape without `instructions`.
    if (!('instructions' in message)) throw new Error(`unexpected transaction message version ${String(message.version)}`);
    const keys = message.staticAccounts;
    const instructions = message.instructions.map((ix) => {
      const data = new Uint8Array(ix.data ?? new Uint8Array());
      const name = IX_NAMES.find(([, d]) => d.every((b, i) => data[i] === b))?.[0] ?? 'unknown';
      const key = (i: number): Address => {
        const k = keys[i];
        if (!k) throw new Error(`no account key ${i}`);
        return k;
      };
      return { name, program: key(ix.programAddressIndex), accounts: (ix.accountIndices ?? []).map(key), data };
    });
    const failure = this.failWhen?.(instructions) ?? null;
    if (failure) throw failure;
    const signatures: Record<string, Uint8Array> = {};
    for (const [signer, signature] of Object.entries(tx.signatures)) signatures[signer] = new Uint8Array(signature ?? new Uint8Array(64));
    this.signed.push({ messageBytes: new Uint8Array(tx.messageBytes), signatures });
    this.sent.push(instructions);
  }

  rpc(): SolanaRpc {
    const send = <T>(value: () => Promise<T> | T) => ({ send: async () => value() });
    const fake = {
      getMultipleAccounts: (keys: Address[]) =>
        send(async () => {
          const map = await this.byAddress();
          return { context: { slot: 1n }, value: keys.map((k) => { const entry = map.get(k); return entry ? this.info(entry) : null; }) };
        }),
      // Positions by round (memcmp at 8), or every claimed position (memcmp at OFFSETS.positionClaimed).
      getProgramAccounts: (_program: Address, opts: { filters?: { memcmp?: { offset: bigint; bytes: string } }[] }) =>
        send(async () => {
          const memcmps = (opts.filters ?? []).flatMap((f) => (f.memcmp ? [f.memcmp] : []));
          const byRound = memcmps.find((m) => m.offset === 8n)?.bytes;
          const claimedOnly = memcmps.some((m) => m.offset === BigInt(OFFSETS.positionClaimed));
          if (!byRound && !claimedOnly) return [];
          const rows = [];
          for (const [id, list] of this.positions) {
            const round = await roundAddress(id);
            if (byRound && round !== byRound) continue;
            for (const p of list) {
              if (claimedOnly && !p.claimed) continue;
              const data = encodePosition(p);
              rows.push({ pubkey: await positionAddress(p.round, p.authority), account: this.info({ data, lamports: FAKE_ACCOUNT_LAMPORTS, system: false }) });
            }
          }
          return rows;
        }),
      getLatestBlockhash: () =>
        send(() => ({ context: { slot: 1n }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1_000n } })),
      sendTransaction: (wire: string) =>
        send(() => {
          this.record(wire);
          return 'fake-signature';
        }),
      getSignatureStatuses: () =>
        send(() => ({ context: { slot: 1n }, value: [{ confirmationStatus: 'confirmed', err: null, confirmations: 1n, slot: 1n, status: { Ok: null } }] })),
      getBlockHeight: () => send(() => 1n),
    };
    return fake as unknown as SolanaRpc;
  }
}

/** Little-endian readers for instruction data. */
export const readU64 = (data: Uint8Array, at: number): bigint => new DataView(data.buffer, data.byteOffset).getBigUint64(at, true);
export const readI64 = (data: Uint8Array, at: number): bigint => new DataView(data.buffer, data.byteOffset).getBigInt64(at, true);
export const readU32 = (data: Uint8Array, at: number): number => new DataView(data.buffer, data.byteOffset).getUint32(at, true);
export const readAddress = (data: Uint8Array, at: number): Address => addressAt.decode(data, at);
