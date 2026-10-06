// What one "Top up & play" or "renew" approval moves, line by line, so the button can show the
// full amount leaving the wallet and not only the deposit. Pure TypeScript for node:test.

/** Account sizes in bytes (8-byte discriminator included), from programs/flip-the-meme/src/lib.rs. */
export const ACCOUNT_SPACE = { vault: 57, session: 138, position: 100 } as const;

/** Bytes every account carries besides its data (the cluster's ACCOUNT_STORAGE_OVERHEAD). */
const ACCOUNT_STORAGE_OVERHEAD = 128n;
/**
 * Rent-exempt lamports per byte, used until the cluster's own figure is read (chain/rent.ts, within a
 * second of launch). 5080 is the rate devnet charges now (a 100-byte position: (100 + 128) x 5080 =
 * 1_158_240); 5_100 keeps the fallback a hair above it and never below. The old rate was 6960.
 */
const RENT_PER_BYTE_FALLBACK = 5_100n;

/** Rent-exempt minimum of an account of `space` bytes at `perByte` lamports per byte. */
export function rentExempt(space: number, perByte: bigint = RENT_PER_BYTE_FALLBACK): bigint {
  return (ACCOUNT_STORAGE_OVERHEAD + BigInt(space)) * perByte;
}

/** The rents derived from the account sizes: what the app assumes before the cluster has answered. */
export const RENT_FALLBACK = {
  vault: rentExempt(ACCOUNT_SPACE.vault),
  session: rentExempt(ACCOUNT_SPACE.session),
  position: rentExempt(ACCOUNT_SPACE.position),
} as const;

export const U64_MAX = 18_446_744_073_709_551_615n;

/**
 * The turnover allowance passed to start_session as `session_cap`.
 *
 * The program adds every stake to the session's `spent` and never subtracts: a win or a refund does not
 * give it back, and only the owner re-issuing the session resets it. So the cap can never mean "how much
 * I may lose": stakes come out of the vault's available balance, which a stolen device key can spend only
 * up to the max per bet per round, and never withdraw. A cap equal to the deposit (the old rule) ended
 * the one-tap play after 5 bets of 0.02 on a 0.10 top up, long before the money did. The allowance is
 * therefore generous turnover: `max(base, maxPerBet) x capTurnoverFactor`, where `base` is what is on the
 * account after the approval (deposit plus what is already available), clamped to a u64. The program
 * only requires session_cap > 0 and adds stakes with checked_add, so any u64 is accepted.
 */
export function sessionCapFor(base: bigint, rules: { maxPerBet: bigint; capTurnoverFactor: bigint }): bigint {
  const floor = rules.maxPerBet;
  const cap = (base > floor ? base : floor) * rules.capTurnoverFactor;
  return cap > U64_MAX ? U64_MAX : cap;
}

/** Base fee of a transaction with one signature (the wallet). */
export const NETWORK_FEE = 5_000n;

export type TopUpPlan = {
  /** To the game balance (vault); 0 when only the session is renewed. */
  deposit: bigint;
  /** To the device key: pays bet fees and position rent, and stays on the key until used. */
  keyFees: bigint;
  /** Rent of the accounts this approval creates (vault, session). */
  setup: bigint;
  networkFee: bigint;
  total: bigint;
};

export function topUpPlan(input: {
  deposit: bigint;
  vaultExists: boolean;
  sessionExists: boolean;
  /** Device key balance, or null while unknown (counted as empty). */
  keyLamports: bigint | null;
  /** Rent-exempt minimums for the vault and session sizes, or null while unknown. */
  rent: { vault: bigint; session: bigint } | null;
  gasMin: bigint;
  gasTopUp: bigint;
}): TopUpPlan {
  const keyFees = (input.keyLamports ?? 0n) < input.gasMin ? input.gasTopUp : 0n;
  const setup = input.rent ? (input.vaultExists ? 0n : input.rent.vault) + (input.sessionExists ? 0n : input.rent.session) : 0n;
  const networkFee = NETWORK_FEE;
  return { deposit: input.deposit, keyFees, setup, networkFee, total: input.deposit + keyFees + setup + networkFee };
}

/** Profit of a win on a fully matched stake: 1.96x back means +0.96x, with the fee taken from the bank. */
export function maxWinProfit(stake: bigint, feeWinBps: number): bigint {
  return (stake * 2n * BigInt(10_000 - feeWinBps)) / 10_000n - stake;
}
