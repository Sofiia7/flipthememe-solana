// Round accounts the arena poll has just read, shared with my account's poll: while the arena is on
// screen it already reads every round in play every 2 s, so my rounds need no second read.
import type { Address } from '@solana/kit';
import { setBounded } from '../lib/limits';
import type { RoundView } from './fetch';

/** The arena window is 6 rounds; this keeps a few windows. */
const MAX_ROUNDS = 24;

const recent = new Map<Address, { view: RoundView; atMs: number }>();

export function shareRounds(views: readonly RoundView[], atMs: number = Date.now()): void {
  for (const view of views) setBounded(recent, view.address, { view, atMs }, MAX_ROUNDS);
}

/** The round as read by the arena within the last `maxAgeMs`, else null. */
export function recentRound(address: Address, maxAgeMs: number, nowMs: number = Date.now()): RoundView | null {
  const entry = recent.get(address);
  return entry && nowMs - entry.atMs <= maxAgeMs ? entry.view : null;
}
