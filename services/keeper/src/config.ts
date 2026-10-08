import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAddress, type Address } from '@solana/kit';
import { CLOSE_AFTER_SECS, effectiveCloseAfter } from './closer.ts';
import { DEFAULT_GATE, MINUTE_MS, type PoolGate } from './poolgate.ts';
import { DEFAULT_HOLDER_MAX_PCT, TOKEN_CACHE_TTL_MS } from './tokencheck.ts';

export type KeeperConfig = {
  devnetRpc: string;
  mainnetRpcs: string[];
  /** The keeper key: fee payer and admin (create_round), and every role that has no key of its own. */
  keypairPath: string;
  /** PRICE_KEYPAIR: signs set_strike and settle; null = the keeper key. */
  priceKeypairPath: string | null;
  /** HOUSE_KEYPAIR: signs house_fill and owns the house vault; null = the keeper key. */
  houseKeypairPath: string | null;
  /** ATTEST_URL: base URL of the price attestor service; null = no attestation unless the chain requires it. */
  attestUrl: string | null;
  /** ATTEST_TOKEN: shared secret sent as a bearer token to the attestor. Never logged. */
  attestToken: string | null;
  /** Temporary compatibility for the previous program, before its upgrade. */
  legacyPrices: boolean;
  /** TREASURY: an address only (the program pays it at sweep_fees; nothing here signs for it). */
  treasury: Address | null;
  /** CLOSE_AFTER_SECS: paid positions are closed this long after their round's exit_end (closer.ts). */
  closeAfterSecs: bigint;
  stateFile: string;
  /** status.json, next to the state file. */
  statusFile: string;
  /** observations.json, next to the state file: the last 15 minutes of price observations, kept across restarts. */
  observationsFile: string;
  houseRoundCap: bigint;
  houseDailyBudget: bigint;
  /** HOUSE_SWITCH_PAUSE_SECS: no house fill in a round of a pool selected less than this long ago (0 = off). */
  houseSwitchPauseSecs: number;
  /** HOUSE_WALLET_DAILY_FILLS: house fills that match one wallet per UTC day at most (0 = no limit). */
  houseWalletDailyFills: number;
  /** HOUSE_PACE_DIVISOR: the day's budget is spread over (rounds left today / this) fills (0 = no spreading). */
  housePaceDivisor: number;
  /** The token check at pool selection (tokencheck.ts). */
  tokenCheck: { enabled: boolean; holderMaxPct: number; ttlMs: number };
  /** shadow.jsonl and rounds.jsonl, next to the state file, and how many lines each keeps. */
  shadowFile: string;
  roundsFile: string;
  shadowMaxLines: number;
  roundsMaxLines: number;
  poolOverride: Address | null;
  /** Token choice: entry gate, hold and keep gate (poolgate.ts). */
  poolGate: PoolGate;
};

export const DEFAULT_DEVNET_RPC = 'https://api.devnet.solana.com';
export const DEFAULT_MAINNET_RPCS = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'];
export const DEFAULT_HOUSE_ROUND_CAP = 50_000_000n;
export const DEFAULT_HOUSE_DAILY_BUDGET = 2_000_000_000n;
export const DEFAULT_HOUSE_DEPOSIT = 2_000_000_000n;
export const DEFAULT_HOUSE_SWITCH_PAUSE_SECS = 60;
export const DEFAULT_HOUSE_WALLET_DAILY_FILLS = 30;
export const DEFAULT_HOUSE_PACE_DIVISOR = 4;
export const DEFAULT_JSONL_MAX_LINES = 20_000;

/** Locally the key lives in the user profile; the Docker image sets KEEPER_KEYPAIR=/secrets/keeper.json. */
export function defaultKeypairPath(): string {
  return join(homedir(), '.flipthememe', 'keeper.json');
}

/**
 * services/keeper, whether this runs from src/config.ts or from the dist/keeper.mjs bundle (both
 * sit one folder below it). The default state file lives there, so a keeper started from the
 * repository root does not drop files into it; the Docker image sets STATE_FILE=/data/state.json.
 */
export const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_STATE_FILE = join(PACKAGE_DIR, 'keeper-state.json');

type Env = Record<string, string | undefined>;

function text(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function httpUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an http(s) URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${name} must be an http(s) URL`);
  return value;
}

/** Whole lamports; underscores are allowed as digit separators ("50_000_000"). */
export function parseLamports(name: string, value: string | undefined, fallback: bigint): bigint {
  if (value === undefined || value.trim() === '') return fallback;
  const cleaned = value.trim();
  if (!/^\d[\d_]*$/.test(cleaned)) throw new Error(`${name} must be a whole number of lamports`);
  return BigInt(cleaned.replaceAll('_', ''));
}

/** A non-negative number from the environment: digits with an optional decimal part ("1.5"). */
export function parseNumber(name: string, value: string | undefined, fallback: number, opts: { integer?: boolean } = {}): number {
  if (value === undefined || value.trim() === '') return fallback;
  const cleaned = value.trim();
  if (!(opts.integer ? /^\d+$/ : /^\d+(\.\d+)?$/).test(cleaned)) {
    throw new Error(`${name} must be a ${opts.integer ? 'whole' : 'non-negative'} number`);
  }
  return Number(cleaned);
}

/**
 * POOL_MIN_AGE_MIN, POOL_MAX_AGE_MIN, POOL_MIN_TX_M5 (entry gate), POOL_HOLD_MIN,
 * POOL_SWITCH_RATIO, POOL_KEEP_MIN_TX_M5, POOL_KEEP_MAX_AGE_MIN; ages and the hold in minutes;
 * POOL_MAX_IMBALANCE (0 to 1, the one-sided flow gate) and POOL_YOUTH_WEIGHT (the youth bonus).
 */
export function loadPoolGate(env: Env): PoolGate {
  const minutes = (name: string, fallbackMs: number) => parseNumber(name, text(env, name), fallbackMs / MINUTE_MS) * MINUTE_MS;
  const count = (name: string, fallback: number) => parseNumber(name, text(env, name), fallback, { integer: true });
  const gate: PoolGate = {
    neutral: flag(env, 'POOL_NEUTRAL', false),
    balanced: flag(env, 'POOL_BALANCED', true),
    minAgeMs: minutes('POOL_MIN_AGE_MIN', DEFAULT_GATE.minAgeMs),
    maxAgeMs: minutes('POOL_MAX_AGE_MIN', DEFAULT_GATE.maxAgeMs),
    minTxM5: count('POOL_MIN_TX_M5', DEFAULT_GATE.minTxM5),
    holdMs: minutes('POOL_HOLD_MIN', DEFAULT_GATE.holdMs),
    switchRatio: parseNumber('POOL_SWITCH_RATIO', text(env, 'POOL_SWITCH_RATIO'), DEFAULT_GATE.switchRatio),
    keepMinTxM5: count('POOL_KEEP_MIN_TX_M5', DEFAULT_GATE.keepMinTxM5),
    keepMaxAgeMs: minutes('POOL_KEEP_MAX_AGE_MIN', DEFAULT_GATE.keepMaxAgeMs),
    pumpOnly: text(env, 'POOL_PUMP_ONLY') === undefined ? DEFAULT_GATE.pumpOnly : text(env, 'POOL_PUMP_ONLY') === 'true',
    maxImbalance: parseNumber('POOL_MAX_IMBALANCE', text(env, 'POOL_MAX_IMBALANCE'), 0.3),
    youthWeight: parseNumber('POOL_YOUTH_WEIGHT', text(env, 'POOL_YOUTH_WEIGHT'), 0),
  };
  if (gate.neutral) {
    gate.maxPriceMoveM5 = parseNumber('POOL_MAX_PRICE_MOVE_M5', text(env, 'POOL_MAX_PRICE_MOVE_M5'), 1);
    gate.youthWeight = 0;
    if (text(env, 'POOL_MAX_IMBALANCE') === undefined) gate.maxImbalance = 0.3;
  }
  if (gate.maxAgeMs <= gate.minAgeMs) throw new Error('POOL_MAX_AGE_MIN must be greater than POOL_MIN_AGE_MIN');
  if (gate.keepMaxAgeMs < gate.maxAgeMs) throw new Error('POOL_KEEP_MAX_AGE_MIN must not be below POOL_MAX_AGE_MIN');
  if (gate.keepMinTxM5 > gate.minTxM5) throw new Error('POOL_KEEP_MIN_TX_M5 must not exceed POOL_MIN_TX_M5');
  if (gate.switchRatio < 1) throw new Error('POOL_SWITCH_RATIO must be at least 1');
  if (gate.maxImbalance > 1) throw new Error('POOL_MAX_IMBALANCE must be between 0 and 1');
  return gate;
}

/** TOKEN_CHECK: "true" (default) or "false"; "on"/"off" and "1"/"0" are accepted too. */
function flag(env: Env, name: string, fallback: boolean): boolean {
  const value = text(env, name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (value === 'true' || value === 'on' || value === '1') return true;
  if (value === 'false' || value === 'off' || value === '0') return false;
  throw new Error(`${name} must be true or false`);
}

/** TOKEN_CHECK, HOLDER_MAX_PCT (a share of the supply, above 0 and up to 100), TOKEN_CHECK_TTL_MIN. */
export function loadTokenCheck(env: Env): KeeperConfig['tokenCheck'] {
  const holderMaxPct = parseNumber('HOLDER_MAX_PCT', text(env, 'HOLDER_MAX_PCT'), DEFAULT_HOLDER_MAX_PCT);
  if (!(holderMaxPct > 0 && holderMaxPct <= 100)) throw new Error('HOLDER_MAX_PCT must be above 0 and at most 100');
  const ttlMin = parseNumber('TOKEN_CHECK_TTL_MIN', text(env, 'TOKEN_CHECK_TTL_MIN'), TOKEN_CACHE_TTL_MS / MINUTE_MS);
  return { enabled: flag(env, 'TOKEN_CHECK', true), holderMaxPct, ttlMs: ttlMin * MINUTE_MS };
}

export function loadConfig(env: Env = process.env, cwd: string = process.cwd()): KeeperConfig {
  const devnetRpc = httpUrl('DEVNET_RPC', text(env, 'DEVNET_RPC') ?? DEFAULT_DEVNET_RPC);
  const mainnetList = text(env, 'MAINNET_RPCS');
  const mainnetRpcs = (mainnetList ? mainnetList.split(',') : DEFAULT_MAINNET_RPCS)
    .map((u) => u.trim())
    .filter((u) => u !== '')
    .map((u) => httpUrl('MAINNET_RPCS', u));
  if (mainnetRpcs.length === 0) throw new Error('MAINNET_RPCS must list at least one URL');
  const stateFile = resolve(cwd, text(env, 'STATE_FILE') ?? DEFAULT_STATE_FILE);
  const override = text(env, 'POOL_OVERRIDE');
  if (override !== undefined && !isAddress(override)) throw new Error('POOL_OVERRIDE must be a base58 address');
  const treasury = text(env, 'TREASURY');
  if (treasury !== undefined && !isAddress(treasury)) throw new Error('TREASURY must be a base58 address');
  const attestUrl = text(env, 'ATTEST_URL');
  const attestToken = text(env, 'ATTEST_TOKEN');
  // It goes into an HTTP header; the message never quotes the value.
  if (attestToken !== undefined && !/^[\x21-\x7e]+$/.test(attestToken)) throw new Error('ATTEST_TOKEN must be printable ASCII without spaces');
  const keyPath = (name: string): string | null => {
    const value = text(env, name);
    return value === undefined ? null : resolve(cwd, value);
  };
  return {
    devnetRpc,
    mainnetRpcs,
    keypairPath: resolve(cwd, text(env, 'KEEPER_KEYPAIR') ?? defaultKeypairPath()),
    priceKeypairPath: keyPath('PRICE_KEYPAIR'),
    houseKeypairPath: keyPath('HOUSE_KEYPAIR'),
    attestUrl: attestUrl === undefined ? null : httpUrl('ATTEST_URL', attestUrl).replace(/\/+$/, ''),
    attestToken: attestToken ?? null,
    legacyPrices: text(env, 'LEGACY_PRICES') === 'true',
    treasury: treasury === undefined ? null : (treasury as Address),
    // A demo may shorten it, but never below the program's one-hour minimum.
    closeAfterSecs: effectiveCloseAfter(BigInt(parseNumber('CLOSE_AFTER_SECS', text(env, 'CLOSE_AFTER_SECS'), Number(CLOSE_AFTER_SECS), { integer: true }))),
    stateFile,
    statusFile: join(dirname(stateFile), 'status.json'),
    observationsFile: join(dirname(stateFile), 'observations.json'),
    houseRoundCap: parseLamports('HOUSE_ROUND_CAP_LAMPORTS', env.HOUSE_ROUND_CAP_LAMPORTS, DEFAULT_HOUSE_ROUND_CAP),
    houseDailyBudget: parseLamports('HOUSE_DAILY_BUDGET_LAMPORTS', env.HOUSE_DAILY_BUDGET_LAMPORTS, DEFAULT_HOUSE_DAILY_BUDGET),
    houseSwitchPauseSecs: parseNumber('HOUSE_SWITCH_PAUSE_SECS', text(env, 'HOUSE_SWITCH_PAUSE_SECS'), DEFAULT_HOUSE_SWITCH_PAUSE_SECS, { integer: true }),
    houseWalletDailyFills: parseNumber('HOUSE_WALLET_DAILY_FILLS', text(env, 'HOUSE_WALLET_DAILY_FILLS'), DEFAULT_HOUSE_WALLET_DAILY_FILLS, { integer: true }),
    housePaceDivisor: parseNumber('HOUSE_PACE_DIVISOR', text(env, 'HOUSE_PACE_DIVISOR'), DEFAULT_HOUSE_PACE_DIVISOR, { integer: true }),
    tokenCheck: loadTokenCheck(env),
    shadowFile: join(dirname(stateFile), 'shadow.jsonl'),
    roundsFile: join(dirname(stateFile), 'rounds.jsonl'),
    shadowMaxLines: Math.max(100, parseNumber('SHADOW_MAX_LINES', text(env, 'SHADOW_MAX_LINES'), DEFAULT_JSONL_MAX_LINES, { integer: true })),
    roundsMaxLines: Math.max(100, parseNumber('ROUNDS_MAX_LINES', text(env, 'ROUNDS_MAX_LINES'), DEFAULT_JSONL_MAX_LINES, { integer: true })),
    poolOverride: override === undefined ? null : (override as Address),
    poolGate: loadPoolGate(env),
  };
}
