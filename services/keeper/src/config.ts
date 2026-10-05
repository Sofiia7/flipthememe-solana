import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAddress, type Address } from '@solana/kit';

export type KeeperConfig = {
  devnetRpc: string;
  mainnetRpcs: string[];
  keypairPath: string;
  stateFile: string;
  /** status.json, next to the state file. */
  statusFile: string;
  houseRoundCap: bigint;
  houseDailyBudget: bigint;
  poolOverride: Address | null;
};

export const DEFAULT_DEVNET_RPC = 'https://api.devnet.solana.com';
export const DEFAULT_MAINNET_RPCS = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'];
export const DEFAULT_HOUSE_ROUND_CAP = 50_000_000n;
export const DEFAULT_HOUSE_DAILY_BUDGET = 2_000_000_000n;
export const DEFAULT_HOUSE_DEPOSIT = 2_000_000_000n;

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
  return {
    devnetRpc,
    mainnetRpcs,
    keypairPath: resolve(cwd, text(env, 'KEEPER_KEYPAIR') ?? defaultKeypairPath()),
    stateFile,
    statusFile: join(dirname(stateFile), 'status.json'),
    houseRoundCap: parseLamports('HOUSE_ROUND_CAP_LAMPORTS', env.HOUSE_ROUND_CAP_LAMPORTS, DEFAULT_HOUSE_ROUND_CAP),
    houseDailyBudget: parseLamports('HOUSE_DAILY_BUDGET_LAMPORTS', env.HOUSE_DAILY_BUDGET_LAMPORTS, DEFAULT_HOUSE_DAILY_BUDGET),
    poolOverride: override === undefined ? null : (override as Address),
  };
}
