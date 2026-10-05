// What one "Top up & play" or "renew" approval moves, line by line, so the button can show the
// full amount leaving the wallet and not only the deposit. Pure TypeScript for node:test.

/** Account sizes in bytes (8-byte discriminator included), from programs/flip-the-meme/src/lib.rs. */
export const ACCOUNT_SPACE = { vault: 57, session: 138, position: 100 } as const;

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
