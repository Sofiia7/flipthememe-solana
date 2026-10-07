/**
 * House policy: after entry closes, the house Vault tops up the smaller side so a lone player
 * still gets a matched round. The hard limits are on chain (HouseLimits: per round and per UTC
 * day); the keeper's own limits are an extra, softer layer on top:
 *
 * - the round cap and the daily budget;
 * - the budget is spread over the day: a fill is capped at `remaining / max(1, roundsLeftToday / 4)`, so
 *   2 SOL do not burn in 40 minutes of lone bets and leave every later player of the day without a match.
 *   The cap never goes below what the round needs to activate (2 x its smaller side reaching min_bank),
 *   as long as the budget, the vault and the chain's caps allow that;
 * - per wallet and UTC day, at most HOUSE_WALLET_DAILY_FILLS fills that match that wallet's stake.
 */
import { SECS_PER_DAY, isActivated, Side, type HouseLimitsAccount, type PositionAccount } from '@flipthememe/client';

/**
 * Lamports the house put into rounds on one UTC day; `rounds` makes recording idempotent. `fills` counts,
 * per wallet, the fills that matched its stake today (absent until the first one; files written before it
 * existed have none).
 */
export type HouseLedger = { day: string; spent: bigint; rounds: string[]; fills?: Record<string, number> };

/** The per-wallet counters are kept for this many wallets at most (the busiest ones). */
export const MAX_LEDGER_WALLETS = 2_000;

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
  const next: HouseLedger = { day: today.day, spent: today.spent + amount, rounds: [...today.rounds, id] };
  if (today.fills) next.fills = today.fills;
  return next;
}

/**
 * One more fill that matched `wallet` today. Not idempotent (the caller counts a round once): a fill found
 * on the chain after a restart has no wallet to name, so only the keeper's own confirmed fills are counted.
 * Past MAX_LEDGER_WALLETS the least busy wallets are forgotten.
 */
export function recordWalletFill(ledger: HouseLedger, wallet: string, nowMs: number): HouseLedger {
  const today = rollover(ledger, nowMs);
  const fills = { ...today.fills, [wallet]: (today.fills?.[wallet] ?? 0) + 1 };
  const entries = Object.entries(fills);
  const kept = entries.length <= MAX_LEDGER_WALLETS ? fills : Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_LEDGER_WALLETS));
  return { ...today, fills: kept };
}

/** House fills that matched `wallet` on the UTC day of `nowMs`. */
export function walletFills(ledger: HouseLedger, wallet: string, nowMs: number): number {
  return rollover(ledger, nowMs).fills?.[wallet] ?? 0;
}

export type FillPosition = Pick<PositionAccount, 'authority' | 'side' | 'stake' | 'isHouse'>;

/**
 * The human wallet a house fill on `fillSide` matches: the owner of the largest stake on the other side
 * (the first one on a tie), or null when nobody but the house is there. Several wallets on the matched side
 * are all helped by the fill; the biggest stake is the one the fill is for, so it is the one that is counted.
 */
export function matchedWallet(positions: readonly FillPosition[], fillSide: Side): string | null {
  let best: FillPosition | null = null;
  for (const p of positions) {
    if (p.isHouse || p.side === fillSide) continue;
    if (best === null || p.stake > best.stake) best = p;
  }
  return best ? best.authority : null;
}

/** Whole minutes (rounds, one opens a minute) left in the UTC day of `nowMs`, at least 1. */
export function roundsLeftToday(nowMs: number): number {
  const dayMs = Number(SECS_PER_DAY) * 1000;
  const endOfDay = (Math.floor(nowMs / dayMs) + 1) * dayMs;
  return Math.max(1, Math.ceil((endOfDay - nowMs) / 60_000));
}

/**
 * The most one fill may take so that the day's budget lasts: `remaining / max(1, roundsLeft / divisor)`
 * (divisor 4: one round in four is expected to need a fill). Null when spreading is off (divisor 0).
 */
export function pacedCap(remaining: bigint, roundsLeft: number, divisor: number): bigint | null {
  if (!(divisor > 0)) return null;
  if (roundsLeft <= divisor) return remaining;
  return (remaining * BigInt(Math.round(divisor))) / BigInt(Math.ceil(roundsLeft));
}

export type ChainRoom = { round: bigint; daily: bigint; day: bigint; spentToday: bigint };

/**
 * What HouseLimits still allows for a round that holds `houseAmount` from the house, at chain time
 * `nowSecs`. Mirrors house_fill: `spent` counts for its own UTC day only, so a later day starts at 0.
 */
export function chainRoom(limits: HouseLimitsAccount, houseAmount: bigint, nowSecs: bigint): ChainRoom {
  const today = nowSecs / SECS_PER_DAY;
  const newDay = today > limits.day;
  const spentToday = newDay ? 0n : limits.spent;
  return {
    round: limits.roundCap > houseAmount ? limits.roundCap - houseAmount : 0n,
    daily: limits.dailyCap > spentToday ? limits.dailyCap - spentToday : 0n,
    day: newDay ? today : limits.day,
    spentToday,
  };
}

export type FillInput = {
  rawUp: bigint;
  rawDown: bigint;
  minBank: bigint;
  maxBank: bigint;
  /** Keeper policy: HOUSE_ROUND_CAP_LAMPORTS and what the local ledger leaves of the daily budget. */
  roundCap: bigint;
  remainingBudget: bigint;
  /** On chain (chainRoom): what HouseLimits still allows in this round and today. */
  chainRoundRoom: bigint;
  chainDailyRoom: bigint;
  vaultAvailable: bigint;
  /** Spreads the daily budget over the rest of the day (see pacedCap); absent = no spreading. */
  pace?: { roundsLeft: number; divisor: number };
  /** Config.paused: the program refuses house_fill (Paused), so there is nothing to plan. */
  paused?: boolean;
};

export type FillSkipReason = 'paused' | 'balanced' | 'depth' | 'chain-round-cap' | 'chain-daily-cap' | 'cap' | 'budget' | 'vault' | 'not-activating';

/** `paced` is the spreading cap, present only when it made the fill smaller than the limits alone would. */
export type FillPlan = { kind: 'fill'; amount: bigint; side: Side; paced?: bigint } | { kind: 'skip'; reason: FillSkipReason };

const min = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b < a ? b : a));

/**
 * amount = min(gap, max_bank / 2 - smaller, on-chain room in the round and today, keeper round
 * cap, keeper budget left, vault available), so the program never refuses it for a cap.
 * Skipped when the round would still not activate (2 * min(up, down) < min_bank) after the fill,
 * because then the house money would only sit in a round that refunds anyway.
 */
export function houseFillAmount(i: FillInput): FillPlan {
  if (i.paused) return { kind: 'skip', reason: 'paused' };
  if (i.rawUp === i.rawDown) return { kind: 'skip', reason: 'balanced' };
  const side = i.rawUp < i.rawDown ? Side.Up : Side.Down;
  const smaller = side === Side.Up ? i.rawUp : i.rawDown;
  const larger = side === Side.Up ? i.rawDown : i.rawUp;
  const gap = larger - smaller;
  // Program depth rule: 2 * (smaller + amount) <= max_bank.
  const depthRoom = i.maxBank / 2n - smaller;
  // The chain's caps first: when they are spent, that is the reason worth logging.
  const limits: [FillSkipReason, bigint][] = [
    ['depth', depthRoom],
    ['chain-round-cap', i.chainRoundRoom],
    ['chain-daily-cap', i.chainDailyRoom],
    ['cap', i.roundCap],
    ['budget', i.remainingBudget],
    ['vault', i.vaultAvailable],
  ];
  for (const [reason, limit] of limits) if (limit <= 0n) return { kind: 'skip', reason };
  const hardMax = min(gap, ...limits.map(([, limit]) => limit));
  let amount = hardMax;
  let paced: bigint | undefined;
  const cap = i.pace ? pacedCap(i.remainingBudget, i.pace.roundsLeft, i.pace.divisor) : null;
  if (cap !== null && cap < hardMax) {
    // Never below what the round needs to activate: 2 * (smaller + amount) >= min_bank.
    const need = (i.minBank + 1n) / 2n - smaller;
    const floor = need > 0n ? min(need, hardMax) : 0n;
    amount = cap > floor ? cap : floor;
    if (amount < hardMax) paced = cap;
  }
  const up = side === Side.Up ? i.rawUp + amount : i.rawUp;
  const down = side === Side.Down ? i.rawDown + amount : i.rawDown;
  if (!isActivated(up, down, i.minBank)) return { kind: 'skip', reason: 'not-activating' };
  return paced === undefined ? { kind: 'fill', amount, side } : { kind: 'fill', amount, side, paced };
}
