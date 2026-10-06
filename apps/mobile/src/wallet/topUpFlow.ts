// The pure parts of "Top up & play": what a top up reads, what it costs, which instructions it sends,
// and whether the wallet holds enough. The wallet session itself (useWalletActions.ts) only fetches the
// accounts and signs; everything it decides lives here, so node:test covers it. Two entrances share it:
// a connected wallet (a new wallet session that signs) and a visitor (one session that authorizes, reads
// the accounts of the wallet it just learned, and signs the same transaction).
import { decodeVault, deposit, openVault, startSession, transferSol, type VaultAccount } from '@flipthememe/client';
import type { Address, Instruction } from '@solana/kit';
import { sol } from '../lib/format.ts';
import { sessionCapFor, topUpPlan, type TopUpPlan } from './topUpPlan.ts';

/**
 * Lamports a top up needs in the wallet beyond the deposit and the device key's fees: rent of the
 * vault and session accounts (about 0.0023), the network fee, and a margin so the wallet is never left
 * under its own rent-exempt minimum.
 */
export const TOP_UP_OVERHEAD = 10_000_000n;

/** The parts of SESSION_RULES (config.ts) a top up uses. */
export type TopUpRules = {
  durationSecs: number;
  maxPerBet: bigint;
  gasTopUp: bigint;
  gasMin: bigint;
  capTurnoverFactor: bigint;
};

/** Who is asking: the connected wallet tops up; a visitor connects and plays in one wallet session. */
export type PlayRoute = { kind: 'top-up'; owner: Address } | { kind: 'connect-and-play' };

export function playRoute(owner: Address | null): PlayRoute {
  return owner ? { kind: 'top-up', owner } : { kind: 'connect-and-play' };
}

/**
 * The bill the sheet shows. Before a wallet is connected (or while its accounts are being read) nothing
 * is known: the worst case is assumed (no vault, no session, an empty device key) and the total is
 * "up to". With the accounts read it is exact.
 */
export function topUpBill(input: {
  /** The wallet is connected and its accounts have been read. */
  known: boolean;
  deposit: bigint;
  vaultExists: boolean;
  sessionExists: boolean;
  keyLamports: bigint | null;
  rent: { vault: bigint; session: bigint } | null;
  rules: Pick<TopUpRules, 'gasMin' | 'gasTopUp'>;
}): { plan: TopUpPlan; upTo: boolean } {
  const { rules } = input;
  const plan = topUpPlan(
    input.known
      ? {
          deposit: input.deposit,
          vaultExists: input.vaultExists,
          sessionExists: input.sessionExists,
          keyLamports: input.keyLamports,
          rent: input.rent,
          gasMin: rules.gasMin,
          gasTopUp: rules.gasTopUp,
        }
      : { deposit: input.deposit, vaultExists: false, sessionExists: false, keyLamports: null, rent: input.rent, gasMin: rules.gasMin, gasTopUp: rules.gasTopUp },
  );
  return { plan, upTo: !input.known };
}

/** Lamports the wallet must hold for this plan: the deposit, the key's fees and the margin above. */
export function walletNeed(plan: TopUpPlan): bigint {
  return plan.deposit + plan.keyFees + TOP_UP_OVERHEAD;
}

export function walletTooPoor(walletLamports: bigint, need: bigint): Error {
  return new Error(`The wallet has ${sol(walletLamports)} on devnet; this top up needs about ${sol(need)}. Use Airdrop 1 devnet SOL first.`);
}

/** The vault from its account bytes, or null when there is none or it cannot be read. */
export function readVault(data: Uint8Array | null): VaultAccount | null {
  if (!data) return null;
  try {
    return decodeVault(data);
  } catch {
    return null;
  }
}

/** What a top up reads over RPC once the wallet's address is known. */
export type TopUpReads = {
  /** The vault account's bytes, or null when the account does not exist. */
  vaultData: Uint8Array | null;
  walletLamports: bigint;
  /** SOL on this phone's device key. */
  keyLamports: bigint;
};

export type PreparedTopUp = {
  plan: TopUpPlan;
  vaultExists: boolean;
  /** The session allowance the transaction grants (start_session's session_cap). */
  sessionCap: bigint;
  /** Open the vault when it is missing, deposit, start the session, fund the device key when it runs low. */
  instructions: Instruction[];
};

/**
 * Decides one top up from what was read. Throws the friendly "not enough devnet SOL" sentence before the
 * wallet is asked to sign anything, so a wallet with too little never sees a request that would fail.
 */
export async function prepareTopUp(input: {
  owner: Address;
  deviceKey: Address;
  deposit: bigint;
  nowSec: number;
  rules: TopUpRules;
  reads: TopUpReads;
}): Promise<PreparedTopUp> {
  const { owner, deviceKey, rules, reads } = input;
  const vault = readVault(reads.vaultData);
  const vaultExists = vault !== null;
  const plan = topUpPlan({
    deposit: input.deposit,
    vaultExists,
    sessionExists: false,
    keyLamports: reads.keyLamports,
    rent: null,
    gasMin: rules.gasMin,
    gasTopUp: rules.gasTopUp,
  });
  const need = walletNeed(plan);
  if (reads.walletLamports < need) throw walletTooPoor(reads.walletLamports, need);

  const sessionCap = sessionCapFor(input.deposit + (vault?.available ?? 0n), rules);
  const instructions: Instruction[] = [];
  if (!vaultExists) instructions.push(await openVault({ owner }));
  instructions.push(await deposit({ owner, amount: input.deposit }));
  instructions.push(
    await startSession({
      owner,
      sessionSigner: deviceKey,
      expiry: BigInt(Math.floor(input.nowSec) + rules.durationSecs),
      maxPerBet: rules.maxPerBet,
      sessionCap,
    }),
  );
  if (plan.keyFees > 0n) instructions.push(transferSol({ from: owner, to: deviceKey, lamports: plan.keyFees }));
  return { plan, vaultExists, sessionCap, instructions };
}
