// Decisions shared by the arena dock, the top up sheet and the Wallet tab, so the three cannot drift
// apart. Pure TypeScript for node:test.
import { DEFAULT_MIN_STAKE, SESSION_RULES } from '../config.ts';
import type { SessionStatus } from './sessionList.ts';

/** The minimum stake: the first source that has one (the open round's, then the config's), else the program's usual one. */
export function minStakeOf(...sources: (bigint | null | undefined)[]): bigint {
  for (const source of sources) if (source !== null && source !== undefined) return source;
  return DEFAULT_MIN_STAKE;
}

/**
 * Money is already in the game balance, but this phone cannot play with it (no session, an expired,
 * revoked or used-up one, or a device key out of fee money): one approval brings one-tap play back, no deposit.
 */
export function canRenewSession(input: {
  /** My account data belongs to the connected wallet. */
  myReady: boolean;
  available: bigint;
  minStake: bigint;
  status: SessionStatus;
  /** SOL on the device key; null while unread (counted as empty). */
  keyLamports: bigint | null;
}): boolean {
  if (!input.myReady || input.available < input.minStake) return false;
  return input.status !== 'active' || (input.keyLamports ?? 0n) < SESSION_RULES.gasPerBet;
}
