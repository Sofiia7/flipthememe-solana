/**
 * A fake devnet RPC for scheduler tests: serves Config, Vault, Round and Position accounts encoded
 * exactly like the program stores them, confirms every transaction at once and records the
 * instructions the keeper actually signed (decoded from the wire bytes).
 */
import {
  ACCOUNT,
  IX,
  PROGRAM_ID,
  RoundStatus,
  Outcome,
  RefundReason,
  configAddress,
  roundAddress,
  roundTimes,
  vaultAddress,
  type ConfigAccount,
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

const b64 = getBase64Encoder(); // base64 text -> bytes
const toB64 = getBase64Decoder(); // bytes -> base64 text
const addressAt = getAddressDecoder();
const IX_NAMES = Object.entries(IX) as [string, Uint8Array][];

export class FakeChain {
  readonly keeper: Address;
  config: ConfigAccount | null = null;
  vault: VaultAccount | null = null;
  keeperLamports = 5n * SOL;
  readonly rounds = new Map<bigint, RoundAccount>();
  /** Positions per round id. */
  readonly positions = new Map<bigint, PositionAccount[]>();
  /** Instructions of every transaction sent, in order. */
  readonly sent: SentInstruction[][] = [];

  constructor(keeper: Address) {
    this.keeper = keeper;
  }

  private async byAddress(): Promise<Map<string, Uint8Array | 'system'>> {
    const map = new Map<string, Uint8Array | 'system'>();
    if (this.config) map.set(await configAddress(), encodeConfig(this.config));
    if (this.vault) map.set(await vaultAddress(this.keeper), encodeVault(this.vault));
    map.set(this.keeper, 'system');
    for (const [id, round] of this.rounds) map.set(await roundAddress(id), encodeRound(round));
    return map;
  }

  private info(data: Uint8Array | 'system') {
    const bytes = data === 'system' ? new Uint8Array() : data;
    return {
      data: [toB64.decode(bytes), 'base64'] as const,
      executable: false,
      lamports: data === 'system' ? this.keeperLamports : 2_000_000n,
      owner: data === 'system' ? ('11111111111111111111111111111111' as Address) : PROGRAM_ID,
      rentEpoch: 0n,
      space: BigInt(bytes.length),
    };
  }

  private record(wire: string): void {
    const tx = getTransactionDecoder().decode(b64.encode(wire));
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    // The keeper signs legacy-layout v0 messages; kit's union also has a v1 shape without `instructions`.
    if (!('instructions' in message)) throw new Error(`unexpected transaction message version ${String(message.version)}`);
    const keys = message.staticAccounts;
    this.sent.push(
      message.instructions.map((ix) => {
        const data = new Uint8Array(ix.data ?? new Uint8Array());
        const name = IX_NAMES.find(([, d]) => d.every((b, i) => data[i] === b))?.[0] ?? 'unknown';
        const key = (i: number): Address => {
          const k = keys[i];
          if (!k) throw new Error(`no account key ${i}`);
          return k;
        };
        return { name, program: key(ix.programAddressIndex), accounts: (ix.accountIndices ?? []).map(key), data };
      }),
    );
  }

  rpc(): SolanaRpc {
    const send = <T>(value: () => Promise<T> | T) => ({ send: async () => value() });
    const fake = {
      getMultipleAccounts: (keys: Address[]) =>
        send(async () => {
          const map = await this.byAddress();
          return { context: { slot: 1n }, value: keys.map((k) => (map.has(k) ? this.info(map.get(k) as Uint8Array | 'system') : null)) };
        }),
      getProgramAccounts: (_program: Address, opts: { filters?: { memcmp?: { offset: bigint; bytes: string } }[] }) =>
        send(async () => {
          const byRound = opts.filters?.find((f) => f.memcmp && f.memcmp.offset === 8n)?.memcmp?.bytes;
          if (!byRound) return [];
          for (const [id, list] of this.positions) {
            if ((await roundAddress(id)) !== byRound) continue;
            return list.map((p) => ({ pubkey: p.authority, account: this.info(encodePosition(p)) }));
          }
          return [];
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
