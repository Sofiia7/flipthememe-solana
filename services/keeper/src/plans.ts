/**
 * What the admin scripts (init-house-limits, init-oracle, split-roles, set-pause) will do, as pure
 * functions of the chain state and the command line, so a dry run prints exactly the plan that
 * --execute would sign, and the logic is tested without a validator.
 */
import { PROGRAM_ID, type ConfigAccount, type HouseLimitsAccount, type OracleConfigAccount, type VaultAccount } from '@flipthememe/client';
import { isAddress, type Address } from '@solana/kit';
import { NO_ATTESTOR } from './attest.ts';
import { parseLamports } from './config.ts';

/** The value after `name` on the command line, or null when the flag is absent. */
export function argValue(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

export function lamportsArg(argv: readonly string[], name: string, fallback: bigint): bigint {
  return parseLamports(name, argValue(argv, name) ?? undefined, fallback);
}

export function boolArg(argv: readonly string[], name: string): boolean | null {
  const value = argValue(argv, name);
  if (value === null) return null;
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`);
  return value === 'true';
}

export function addressArg(argv: readonly string[], name: string): Address | null {
  const value = argValue(argv, name);
  if (value === null) return null;
  if (!isAddress(value)) throw new Error(`${name} must be a base58 address`);
  return value;
}

export type SetupAction = 'init' | 'update' | 'none';

/** Create the account when it is missing, update it when a value differs, otherwise nothing. */
export function planHouseLimits(current: HouseLimitsAccount | null, want: { roundCap: bigint; dailyCap: bigint }): SetupAction {
  if (!current) return 'init';
  return current.roundCap === want.roundCap && current.dailyCap === want.dailyCap ? 'none' : 'update';
}

/**
 * The oracle settings to write: a flag that is not given keeps the current value (no attestor and
 * not required on a fresh account). Refuses what the program refuses: a required attestor must be
 * a real key, not the default key or the program id.
 */
export function wantedOracle(current: OracleConfigAccount | null, args: { attestor: Address | null; required: boolean | null }): { attestor: Address; required: boolean } {
  const attestor = args.attestor ?? current?.attestor ?? NO_ATTESTOR;
  const required = args.required ?? current?.required ?? false;
  if (required && (attestor === NO_ATTESTOR || attestor === PROGRAM_ID)) {
    throw new Error('--required true needs --attestor <pubkey> of the attestor service');
  }
  return { attestor, required };
}

export function planOracle(current: OracleConfigAccount | null, want: { attestor: Address; required: boolean }): SetupAction {
  if (!current) return 'init';
  return current.attestor === want.attestor && current.required === want.required ? 'none' : 'update';
}

/** As the program sees it: a change that switches a required attestor off or replaces it. */
export function weakensOracle(current: OracleConfigAccount | null, want: { attestor: Address; required: boolean }): boolean {
  return current !== null && current.required && (!want.required || want.attestor !== current.attestor);
}

/**
 * Who must co-sign set_oracle besides the admin: nobody, unless the change weakens a required
 * oracle; then the attestor in office, whose key file (`keyAddress`, from --attestor-keypair)
 * must hold exactly that key. `error` is the refusal to print before anything is sent.
 */
export function oracleCosigner(
  current: OracleConfigAccount | null,
  want: { attestor: Address; required: boolean },
  keyAddress: Address | null,
): { cosigner: Address | null; error: string | null } {
  if (!current || !weakensOracle(current, want)) return { cosigner: null, error: null };
  const what = want.required ? 'replacing' : 'switching off';
  if (keyAddress === null) {
    return { cosigner: null, error: `${what} the required attestor ${current.attestor} needs its signature: pass --attestor-keypair <its key file>` };
  }
  if (keyAddress !== current.attestor) {
    return { cosigner: null, error: `--attestor-keypair holds ${keyAddress}, but the attestor in office is ${current.attestor}` };
  }
  return { cosigner: current.attestor, error: null };
}

export type SplitInput = {
  config: ConfigAccount;
  keeper: Address;
  keeperLamports: bigint;
  /** Target roles: the PRICE_KEYPAIR and HOUSE_KEYPAIR addresses (the keeper's when unset), TREASURY (the current one when unset). */
  price: Address;
  house: Address;
  treasury: Address;
  /** Vault of the current house authority, and of the new house key if it already has one. */
  oldVault: VaultAccount | null;
  newVault: VaultAccount | null;
  /** Lamports to move into the new house vault; null = everything free in the old one. */
  amount: bigint | null;
  /** Rent-exempt minimum of a Vault account, paid by the new house key at open_vault. */
  vaultRent: bigint;
  /** Lamports the keeper wallet keeps for fees. */
  feeReserve: bigint;
};

export type SplitStep =
  | { kind: 'withdraw'; vaultOwner: Address; lamports: bigint }
  | { kind: 'transfer'; from: Address; to: Address; lamports: bigint; deposit: bigint; vaultRent: bigint }
  | { kind: 'open-vault'; owner: Address; rent: bigint }
  | { kind: 'deposit'; owner: Address; lamports: bigint }
  | { kind: 'update-config'; priceAuthority: Address; houseAuthority: Address; treasury: Address };

export type SplitPlan = { steps: SplitStep[]; warnings: string[]; errors: string[] };

/**
 * Moving the house and price roles off the keeper key, in one transaction so it lands whole or
 * not at all: free house money leaves the keeper's vault (withdraw), goes to the new house wallet
 * with the new vault's rent (transfer), the new house opens its vault and deposits it, and
 * update_config names the new price authority, house authority and treasury. Every other Config
 * value stays. The keeper key stays admin and fee payer. The house wallet needs nothing more:
 * position rent comes out of the house vault and the keeper pays every fee.
 */
export function planRoleSplit(i: SplitInput): SplitPlan {
  const steps: SplitStep[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const c = i.config;
  if (c.admin !== i.keeper) errors.push(`Config admin is ${c.admin}, not the keeper key ${i.keeper}`);
  const houseMoves = i.house !== c.houseAuthority;
  if (houseMoves) {
    if (c.houseAuthority !== i.keeper) errors.push(`the current house authority ${c.houseAuthority} is not the keeper key: move its vault by hand`);
    const available = i.oldVault?.available ?? 0n;
    const locked = i.oldVault?.locked ?? 0n;
    const amount = i.amount ?? available;
    if (amount > available) errors.push(`amount ${amount} exceeds the ${available} lamports free in the old house vault`);
    if (locked > 0n) warnings.push(`${locked} lamports are still locked in rounds in flight; claims return them to the old vault, withdraw them later`);
    const vaultRent = i.newVault ? 0n : i.vaultRent;
    const transfer = amount + vaultRent;
    if (amount > 0n) steps.push({ kind: 'withdraw', vaultOwner: c.houseAuthority, lamports: amount });
    if (transfer > 0n) steps.push({ kind: 'transfer', from: i.keeper, to: i.house, lamports: transfer, deposit: amount, vaultRent });
    if (!i.newVault) steps.push({ kind: 'open-vault', owner: i.house, rent: i.vaultRent });
    if (amount > 0n) steps.push({ kind: 'deposit', owner: i.house, lamports: amount });
    // The withdrawn amount passes through; the keeper wallet pays the vault's rent.
    if (i.keeperLamports < vaultRent + i.feeReserve) {
      errors.push(`keeper wallet holds ${i.keeperLamports} lamports, needs ${vaultRent} for the new house vault plus a ${i.feeReserve} fee reserve`);
    }
  }
  if (i.price !== c.priceAuthority || houseMoves || i.treasury !== c.treasury) {
    steps.push({ kind: 'update-config', priceAuthority: i.price, houseAuthority: i.house, treasury: i.treasury });
  }
  if (steps.length === 0) warnings.push('Config already names these roles: nothing to do');
  return { steps, warnings, errors };
}
