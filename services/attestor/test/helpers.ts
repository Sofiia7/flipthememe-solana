// Shared test helpers (not a test file): node:sqlite in place of the Durable Object's storage.sql,
// an alarm store, scripted devnet and mainnet RPCs serving accounts encoded the way the program and
// the token programs store them, deterministic keys and transaction builders. No network.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  ACCOUNT,
  PROGRAM_ID,
  Outcome,
  RefundReason,
  RoundStatus,
  WSOL_MINT,
  configAddress,
  decodePumpSwapPool,
  oracleAddress,
  roundAddress,
  roundTimes,
  type ConfigAccount,
  type OracleConfigAccount,
  type RoundAccount,
} from '@flipthememe/client';
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBooleanEncoder,
  getI64Encoder,
  getStructEncoder,
  getU16Encoder,
  getU32Encoder,
  getU64Encoder,
  getU8Encoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type RpcTransport,
} from '@solana/kit';
import type { Alarms, Sql, SqlValue } from '../src/attestor.ts';
import type { SolanaRpc } from '../src/rpc.ts';

// ---- Durable Object storage stand-ins ------------------------------------------------------------

/** storage.sql on node:sqlite; counts rows written the way Durable Objects bill them (deletes too). */
export class MemorySql implements Sql {
  readonly db = new DatabaseSync(':memory:');
  rowsWritten = 0;

  exec(query: string, ...bindings: SqlValue[]) {
    const statement = this.db.prepare(query);
    if (/^\s*(select|with)\b/i.test(query)) {
      const rows = statement.all(...bindings);
      return { toArray: () => rows as unknown[] };
    }
    this.rowsWritten += Number(statement.run(...bindings).changes);
    return { toArray: () => [] as unknown[] };
  }

  rows<T>(query: string, ...bindings: SqlValue[]): T[] {
    return this.db.prepare(query).all(...bindings) as T[];
  }
}

/** One alarm, like ctx.storage; `fire()` clears it first, as the runtime does while the handler runs. */
export class MemoryAlarms implements Alarms {
  at: number | null = null;
  sets = 0;

  async getAlarm(): Promise<number | null> {
    return this.at;
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.at = scheduledTime;
    this.sets++;
  }
}

export class Clock {
  ms: number;
  constructor(ms: number) {
    this.ms = ms;
  }
  readonly now = (): number => this.ms;
}

// ---- RPC -------------------------------------------------------------------------------------

type Respond = (method: string, params: any[]) => unknown;

/** A real kit RPC (response transformers included) over a scripted transport. */
export function scriptedRpc(respond: Respond): SolanaRpc {
  const transport = (async ({ payload }: { payload: unknown }) => {
    const { method, params } = payload as { method: string; params: any[] };
    return structuredClone({ jsonrpc: '2.0', id: 1, result: await respond(method, params) });
  }) as RpcTransport;
  return createSolanaRpcFromTransport(transport);
}

const toBase64 = getBase64Decoder(); // bytes -> base64 text

export const accountInfo = (data: Uint8Array, owner: string, lamports = 2_000_000) => ({
  data: [toBase64.decode(data), 'base64'],
  executable: false,
  lamports,
  owner,
  rentEpoch: 0,
  space: data.length,
});

// ---- program accounts ------------------------------------------------------------------------

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
const oracleEncoder = getStructEncoder([
  ['attestor', pubkey],
  ['required', bool],
  ['bump', u8],
]);

function withDiscriminator(discriminator: Uint8Array, body: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  out.set(discriminator, 0);
  out.set(body, 8);
  return out;
}

export const encodeConfig = (c: ConfigAccount) => withDiscriminator(ACCOUNT.Config, configEncoder.encode(c));
export const encodeRound = (r: RoundAccount) => withDiscriminator(ACCOUNT.Round, roundEncoder.encode(r));
export const encodeOracle = (o: OracleConfigAccount) => withDiscriminator(ACCOUNT.OracleConfig, oracleEncoder.encode(o));

export const SOL = 1_000_000_000n;

/** A distinct valid address per number. */
export function testAddress(i: number): Address {
  const bytes = new Uint8Array(32);
  bytes[0] = 3;
  bytes[30] = Math.floor(i / 256);
  bytes[31] = i % 256;
  return getAddressDecoder().decode(bytes);
}

/** A round opening at `opensAt` (unix seconds) on `pool`, Open and activated unless `over` says otherwise. */
export function makeRound(id: bigint, opensAt: bigint, pool: Address, over: Partial<RoundAccount> = {}): RoundAccount {
  return {
    id,
    tokenMint: testAddress(900),
    pool,
    ...roundTimes(opensAt),
    minStake: SOL / 100n,
    maxStake: SOL / 10n,
    minBank: (2n * SOL) / 100n,
    maxBank: SOL,
    feeWinBps: 200,
    feeRefundBps: 0,
    rawUp: SOL / 100n,
    rawDown: SOL / 100n,
    houseAmount: 0n,
    positionCount: 2,
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

export function makeConfig(keeper: Address, nextRoundId: bigint): ConfigAccount {
  return {
    admin: keeper,
    priceAuthority: keeper,
    houseAuthority: keeper,
    treasury: keeper,
    paused: false,
    nextRoundId,
    minStake: SOL / 100n,
    maxStake: SOL / 10n,
    minBank: (2n * SOL) / 100n,
    feeWinBps: 200,
    feeRefundBps: 0,
    totalAvailable: 0n,
    totalLocked: 0n,
    bump: 255,
  };
}

/** Devnet as the attestor reads it: Config, OracleConfig and Round accounts at their PDAs. */
export class Devnet {
  config: ConfigAccount;
  oracle: OracleConfigAccount | null;
  readonly rounds = new Map<bigint, RoundAccount>();
  /** Extra accounts by address (e.g. a Round account away from its PDA). */
  readonly extra = new Map<string, { data: Uint8Array; owner: string }>();
  down = false;
  reads = 0;

  constructor(keeper: Address, oracle: OracleConfigAccount | null) {
    this.config = makeConfig(keeper, 0n);
    this.oracle = oracle;
  }

  add(round: RoundAccount): RoundAccount {
    this.rounds.set(round.id, round);
    if (this.config.nextRoundId <= round.id) this.config = { ...this.config, nextRoundId: round.id + 1n };
    return round;
  }

  private async byAddress(): Promise<Map<string, { data: Uint8Array; owner: string }>> {
    const map = new Map<string, { data: Uint8Array; owner: string }>();
    map.set(await configAddress(), { data: encodeConfig(this.config), owner: PROGRAM_ID });
    if (this.oracle) map.set(await oracleAddress(), { data: encodeOracle(this.oracle), owner: PROGRAM_ID });
    for (const [id, round] of this.rounds) map.set(await roundAddress(id), { data: encodeRound(round), owner: PROGRAM_ID });
    for (const [key, account] of this.extra) map.set(key, account);
    return map;
  }

  /** The JSON-RPC result for a request, as the chain would answer it. */
  async respond(method: string, params: any[]): Promise<unknown> {
    if (this.down) throw new TypeError('fetch failed');
    if (method !== 'getMultipleAccounts') throw new TypeError(`devnet fake: no ${method}`);
    this.reads++;
    const map = await this.byAddress();
    return {
      context: { slot: 1 },
      value: (params[0] as string[]).map((key) => {
        const found = map.get(key);
        return found ? accountInfo(found.data, found.owner) : null;
      }),
    };
  }

  rpc(): SolanaRpc {
    return scriptedRpc((method, params) => this.respond(method, params));
  }
}

/** What an endpoint does with a request: answer from the fake chain, fail at once, or never answer. */
export type EndpointMode = 'ok' | 'fail' | 'hang';

/**
 * Devnet over a transport that follows `mode()` on every request and honours the abort signal, to
 * test time budgets with real timers. A hanging request ends only when its signal aborts.
 */
export function modalRpc(devnet: Devnet, mode: () => EndpointMode, calls: { n: number } = { n: 0 }): SolanaRpc {
  const transport = (async ({ payload, signal }: { payload: unknown; signal?: AbortSignal }) => {
    calls.n++;
    const m = mode();
    if (m === 'fail') throw new TypeError('fetch failed');
    if (m === 'hang') {
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    const { method, params } = payload as { method: string; params: any[] };
    return structuredClone({ jsonrpc: '2.0', id: 1, result: await devnet.respond(method, params) });
  }) as RpcTransport;
  return createSolanaRpcFromTransport(transport);
}

// ---- mainnet: the HIGGS/SOL PumpSwap pool of the client fixtures ---------------------------------

// Captured from mainnet on 2026-10-05 (copies of packages/client/test/fixtures):
// pumpswap-pool-higgs.json: getAccountInfo(pool, base64, confirmed) at slot 453526007
// pumpswap-vaults-higgs.json: getMultipleAccounts([base vault, quote vault], base64) at slot 453526171
type AccountJson = { data: [string, string]; owner: string; lamports: number; space: number };
const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
export const POOL_JSON = fixture<{ result: { context: { slot: number }; value: AccountJson } }>('pumpswap-pool-higgs.json');
export const VAULTS_JSON = fixture<{ result: { context: { slot: number }; value: AccountJson[] } }>('pumpswap-vaults-higgs.json');
export const HIGGS_POOL = 'BFrSZakeqNzVtM3EFhroo4eRhagmmWN8BRntiQKFH6Ru' as Address;
const POOL_KEYS = decodePumpSwapPool(Uint8Array.from(Buffer.from(POOL_JSON.result.value.data[0], 'base64')));
export const FIXTURE_SLOT = 453_526_171n;
export const FIXTURE_BASE = 47_668_820_617_664n;
export const FIXTURE_QUOTE = 640_136_793_430n;
/** quote * 10^12 / base of the fixture vaults. */
export const FIXTURE_PRICE = 13_428_836_399n;

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function tokenAccount(mint: Address, amount: bigint): Uint8Array {
  const data = new Uint8Array(165);
  data.set(pubkey.encode(mint), 0);
  data.set(u64.encode(amount), 64);
  return data;
}

/** The pool's state at a moment: mainnet slot, and the vault amounts that give its price. */
export type PoolState = { slot: bigint; base: bigint; quote: bigint };

/** A mainnet whose HIGGS pool follows `state(nowMs)`; `raw` serves the captured vaults unchanged. */
export class Mainnet {
  state: (nowMs: number) => PoolState;
  raw = false;
  down = false;
  reads = 0;
  private readonly now: () => number;

  constructor(now: () => number, state: (nowMs: number) => PoolState) {
    this.now = now;
    this.state = state;
  }

  rpc(): SolanaRpc {
    return scriptedRpc(async (method, params) => {
      if (this.down) throw new TypeError('fetch failed');
      if (method === 'getAccountInfo') {
        if (params[0] !== HIGGS_POOL) return { context: { slot: 1 }, value: null };
        return structuredClone(POOL_JSON.result);
      }
      if (method !== 'getMultipleAccounts') throw new TypeError(`mainnet fake: no ${method}`);
      this.reads++;
      if (this.raw) return structuredClone(VAULTS_JSON.result);
      const s = this.state(this.now());
      const keys = params[0] as string[];
      return {
        context: { slot: Number(s.slot) },
        value: keys.map((key) => {
          if (key === POOL_KEYS.baseVault) return accountInfo(tokenAccount(POOL_KEYS.baseMint, s.base), TOKEN_PROGRAM);
          if (key === POOL_KEYS.quoteVault) return accountInfo(tokenAccount(WSOL_MINT, s.quote), TOKEN_PROGRAM);
          return null;
        }),
      };
    });
  }
}

/** Mainnet slot at a time: one slot every 400 ms from SLOT0 at T0_MS. */
export const SLOT0 = 400_000_000n;
export const slotAt = (t0Ms: number, ms: number): bigint => SLOT0 + BigInt(Math.floor((ms - t0Ms) / 400));

/** quote * 10^12 / base for a state, as the client computes it. */
export const priceOfState = (s: PoolState): bigint => (s.quote * 10n ** 12n) / s.base;

// ---- keys and transactions -------------------------------------------------------------------

const base58 = getBase58Decoder(); // bytes -> base58 text

/** The attestor's test key: seed 7,7,... (never used anywhere real). */
export const ATTESTOR_SEED = new Uint8Array(32).fill(7);
export const ATTESTOR_PUBLIC = ed25519.getPublicKey(ATTESTOR_SEED);
export const ATTESTOR = getAddressDecoder().decode(ATTESTOR_PUBLIC);
const secretKey = new Uint8Array(64);
secretKey.set(ATTESTOR_SEED, 0);
secretKey.set(ATTESTOR_PUBLIC, 32);
/** ATTESTOR_SECRET forms: the 64-byte secret key and the 32-byte seed, base58. */
export const ATTESTOR_SECRET = base58.decode(secretKey);
export const ATTESTOR_SEED_SECRET = base58.decode(ATTESTOR_SEED);

export const keeperSigner = () => createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(9));

export const BLOCKHASH = getAddressDecoder().decode(new Uint8Array(32).fill(5)) as string as Blockhash;

/** Compiles `instructions` into an unsigned wire transaction paid by `feePayer`. */
export function wire(instructions: Instruction[], feePayer: Address, version: 0 | 'legacy' = 0): { tx: string; messageBytes: Uint8Array<ArrayBuffer> } {
  const message = pipe(
    createTransactionMessage({ version }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000n }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = compileTransaction(message);
  return { tx: getBase64EncodedWireTransaction(transaction), messageBytes: new Uint8Array(transaction.messageBytes) };
}

export const toBytes = (b64: string): Uint8Array => Uint8Array.from(Buffer.from(b64, 'base64'));
export const toB64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
