/**
 * House policy: after entry closes, the keeper's own Vault tops up the smaller side so a lone
 * player still gets a matched round, within a per-round cap and a daily (UTC) budget.
 */
import { isActivated, Side } from '@flipthememe/client';

/** Lamports the house put into rounds on one UTC day; `rounds` makes recording idempotent. */
export type HouseLedger = { day: string; spent: bigint; rounds: string[] };

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function emptyLedger(nowMs: number): HouseLedger {
  return { day: utcDay(nowMs), spent: 0n, rounds: [] };
}

/** A new, empty ledger once the UTC day has changed; otherwise the same ledger. */
export function rollover(ledger: HouseLedger, nowMs: number): HouseLedger {
  return ledger.day === utcDay(nowMs) ? ledger : emptyLedger(nowMs);
}

export function remainingBudget(ledger: HouseLedger, dailyBudget: bigint, nowMs: number): bigint {
  const left = dailyBudget - rollover(ledger, nowMs).spent;
  return left > 0n ? left : 0n;
}

/**
 * Counts a fill against today's budget once per round, whether the keeper saw its own
 * confirmation or found the fill on chain after a restart.
 */
export function recordFill(ledger: HouseLedger, roundId: bigint, amount: bigint, nowMs: number): HouseLedger {
  const today = rollover(ledger, nowMs);
  const id = roundId.toString();
  if (today.rounds.includes(id)) return today;
  return { day: today.day, spent: today.spent + amount, rounds: [...today.rounds, id] };
}

export type FillInput = {
  rawUp: bigint;
  rawDown: bigint;
  minBank: bigint;
  maxBank: bigint;
  roundCap: bigint;
  remainingBudget: bigint;
  vaultAvailable: bigint;
};

export type FillSkipReason = 'balanced' | 'depth' | 'cap' | 'budget' | 'vault' | 'not-activating';

export type FillPlan = { kind: 'fill'; amount: bigint; side: Side } | { kind: 'skip'; reason: FillSkipReason };

const min = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b < a ? b : a));

/**
 * amount = min(gap, round cap, max_bank / 2 - smaller, budget left, vault available).
 * Skipped when the round would still not activate (2 * min(up, down) < min_bank) after the fill,
 * because then the house money would only sit in a round that refunds anyway.
 */
export function houseFillAmount(i: FillInput): FillPlan {
  if (i.rawUp === i.rawDown) return { kind: 'skip', reason: 'balanced' };
  const side = i.rawUp < i.rawDown ? Side.Up : Side.Down;
  const smaller = side === Side.Up ? i.rawUp : i.rawDown;
  const larger = side === Side.Up ? i.rawDown : i.rawUp;
  const gap = larger - smaller;
  // Program depth rule: 2 * (smaller + amount) <= max_bank.
  const depthRoom = i.maxBank / 2n - smaller;
  const limits: [FillSkipReason, bigint][] = [
    ['depth', depthRoom],
    ['cap', i.roundCap],
    ['budget', i.remainingBudget],
    ['vault', i.vaultAvailable],
  ];
  for (const [reason, limit] of limits) if (limit <= 0n) return { kind: 'skip', reason };
  const amount = min(gap, depthRoom, i.roundCap, i.remainingBudget, i.vaultAvailable);
  const up = side === Side.Up ? i.rawUp + amount : i.rawUp;
  const down = side === Side.Down ? i.rawDown + amount : i.rawDown;
  if (!isActivated(up, down, i.minBank)) return { kind: 'skip', reason: 'not-activating' };
  return { kind: 'fill', amount, side };
}
