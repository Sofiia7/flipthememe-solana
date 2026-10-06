// Which bet amounts the game balance can pay. A bet takes its stake AND the rent of its position account
// from the vault's available balance (the keeper returns the rent a day later), so a chip fits only when
// amount + rent <= available. Pure TypeScript for node:test.
import { formatSol } from './format.ts';

export type ChipState = { amount: bigint; fits: boolean };

/**
 * The most one bet can be right now: the available balance less the position rent, and, for a session
 * made before the allowance was widened, what that session still allows. Never negative.
 */
export function maxBet(input: { available: bigint; positionRent: bigint; sessionLeft?: bigint | null }): bigint {
  const afterRent = input.available - input.positionRent;
  const byBalance = afterRent > 0n ? afterRent : 0n;
  const left = input.sessionLeft;
  if (left === null || left === undefined) return byBalance;
  const byLimit = left > 0n ? left : 0n;
  return byLimit < byBalance ? byLimit : byBalance;
}

export function chipStates(amounts: readonly bigint[], max: bigint): ChipState[] {
  return amounts.map((amount) => ({ amount, fits: amount <= max }));
}

/** The largest chip that fits, or null when none does. */
export function largestFitting(amounts: readonly bigint[], max: bigint): bigint | null {
  let best: bigint | null = null;
  for (const amount of amounts) if (amount <= max && (best === null || amount > best)) best = amount;
  return best;
}

/**
 * The amount a bet really uses: the player's choice while it fits, else the largest chip that does.
 * With no chip fitting the choice stays, so the screen can say the balance is too low.
 */
export function effectiveAmount(selected: bigint, amounts: readonly bigint[], max: bigint): bigint {
  if (selected <= max) return selected;
  return largestFitting(amounts, max) ?? selected;
}

/** "max 0.098": 3 decimals, truncated, so it never promises more than the balance allows. */
export function maxBetCaption(max: bigint): string {
  return `max ${formatSol(max, { maxDecimals: 3 })}`;
}
