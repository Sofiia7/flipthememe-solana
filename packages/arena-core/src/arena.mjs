/**
 * Deterministic, dependency-free model of the on-chain round.
 * Amounts are bigint lamports. It deliberately does not use JS numbers for money.
 */
export const Phase = Object.freeze({
  SCHEDULED: "SCHEDULED",
  OPEN: "OPEN",
  LOCKED: "LOCKED",
  ACTIVE: "ACTIVE",
  SETTLED_UP: "SETTLED_UP",
  SETTLED_DOWN: "SETTLED_DOWN",
  REFUNDABLE: "REFUNDABLE",
});

export const Side = Object.freeze({ UP: "UP", DOWN: "DOWN" });
export const BPS_DENOMINATOR = 10_000n;

export class ArenaError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ArenaError";
    this.code = code;
  }
}

const assert = (condition, code, message) => {
  if (!condition) throw new ArenaError(code, message);
};

const clone = (round) => ({
  ...round,
  pools: { ...round.pools },
  positions: new Map([...round.positions].map(([key, value]) => [key, { ...value }])),
});

export function createRound({
  id,
  token,
  poolAddress,
  source,
  opensAt,
  cutoffAt,
  startsAt,
  endsAt,
  settlementDeadlineAt,
  feeBps = 100n,
  tieToleranceBps = 0n,
  maxPool = 5_000_000_000n,
}) {
  assert(typeof id === "string" && id.length > 0, "INVALID_ID");
  assert(cutoffAt > opensAt && startsAt >= cutoffAt && endsAt > startsAt, "INVALID_TIMES");
  assert(settlementDeadlineAt >= endsAt, "INVALID_DEADLINE");
  assert(feeBps >= 0n && feeBps <= 100n, "INVALID_FEE");
  assert(maxPool > 0n, "INVALID_POOL_CAP");
  return {
    id, token, poolAddress, source, opensAt, cutoffAt, startsAt, endsAt, settlementDeadlineAt,
    feeBps, tieToleranceBps, maxPool,
    phase: Phase.SCHEDULED,
    pools: { [Side.UP]: 0n, [Side.DOWN]: 0n },
    positions: new Map(),
    startPrice: null,
    endPrice: null,
    fee: 0n,
    result: null,
    settledAt: null,
  };
}

export function advanceRound(round, now) {
  const next = clone(round);
  if (next.phase === Phase.SCHEDULED && now >= next.opensAt) next.phase = Phase.OPEN;
  if (next.phase === Phase.OPEN && now >= next.cutoffAt) next.phase = Phase.LOCKED;
  if (next.phase === Phase.LOCKED && now >= next.startsAt) next.phase = Phase.ACTIVE;
  if ([Phase.SCHEDULED, Phase.OPEN, Phase.LOCKED, Phase.ACTIVE].includes(next.phase) && now >= next.settlementDeadlineAt) {
    next.phase = Phase.REFUNDABLE;
    next.result = "TIMEOUT";
  }
  return next;
}

export function placeBet(round, { authority, side, amount, now }) {
  assert(round.phase === Phase.OPEN && now < round.cutoffAt, "ROUND_NOT_OPEN");
  assert(side === Side.UP || side === Side.DOWN, "INVALID_SIDE");
  assert(typeof amount === "bigint" && amount > 0n, "INVALID_AMOUNT");
  assert(!round.positions.has(authority), "POSITION_EXISTS");
  assert(round.pools[Side.UP] + round.pools[Side.DOWN] + amount <= round.maxPool, "POOL_CAP_REACHED");
  const next = clone(round);
  next.positions.set(authority, { authority, side, amount, claimed: false });
  next.pools[side] += amount;
  return next;
}

export function previewPayout(round, side, stake) {
  assert(side === Side.UP || side === Side.DOWN, "INVALID_SIDE");
  assert(typeof stake === "bigint" && stake > 0n, "INVALID_AMOUNT");
  const winnerPool = round.pools[side] + stake;
  const loserPool = round.pools[side === Side.UP ? Side.DOWN : Side.UP];
  if (loserPool === 0n) return { payout: stake, fee: 0n, prize: 0n, refundable: true };
  const fee = (loserPool * round.feeBps) / BPS_DENOMINATOR;
  const prize = loserPool - fee;
  return { payout: stake + (prize * stake) / winnerPool, fee, prize, refundable: false };
}

export function settle(round, { startPrice, endPrice, now }) {
  assert(round.phase === Phase.ACTIVE && now >= round.endsAt && now <= round.settlementDeadlineAt, "ROUND_NOT_SETTLEABLE");
  assert(typeof startPrice === "bigint" && startPrice > 0n && typeof endPrice === "bigint" && endPrice > 0n, "INVALID_PRICE");
  const next = clone(round);
  next.startPrice = startPrice;
  next.endPrice = endPrice;
  const changeBps = ((endPrice - startPrice) * BPS_DENOMINATOR) / startPrice;
  if (changeBps >= -next.tieToleranceBps && changeBps <= next.tieToleranceBps) {
    next.phase = Phase.REFUNDABLE;
    next.result = "TIE";
    return next;
  }
  const winningSide = changeBps > 0n ? Side.UP : Side.DOWN;
  if (next.pools[winningSide] === 0n || next.pools[winningSide === Side.UP ? Side.DOWN : Side.UP] === 0n) {
    next.phase = Phase.REFUNDABLE;
    next.result = "EMPTY_SIDE";
    return next;
  }
  const loserPool = next.pools[winningSide === Side.UP ? Side.DOWN : Side.UP];
  next.fee = (loserPool * next.feeBps) / BPS_DENOMINATOR;
  next.result = winningSide;
  next.phase = winningSide === Side.UP ? Phase.SETTLED_UP : Phase.SETTLED_DOWN;
  next.settledAt = now;
  return next;
}

export function claim(round, authority) {
  assert([Phase.SETTLED_UP, Phase.SETTLED_DOWN, Phase.REFUNDABLE].includes(round.phase), "ROUND_NOT_FINAL");
  const position = round.positions.get(authority);
  assert(position, "POSITION_NOT_FOUND");
  assert(!position.claimed, "ALREADY_CLAIMED");
  const next = clone(round);
  const nextPosition = next.positions.get(authority);
  nextPosition.claimed = true;
  if (next.phase === Phase.REFUNDABLE) return { round: next, payout: position.amount, kind: "REFUND" };
  const winner = next.result;
  if (position.side !== winner) return { round: next, payout: 0n, kind: "LOSS" };
  const winnerPool = next.pools[winner];
  const loserPool = next.pools[winner === Side.UP ? Side.DOWN : Side.UP];
  const prize = loserPool - next.fee;
  return { round: next, payout: position.amount + (prize * position.amount) / winnerPool, kind: "WIN" };
}

export function accounting(round) {
  const totalPool = round.pools[Side.UP] + round.pools[Side.DOWN];
  let totalPayout = 0n;
  for (const position of round.positions.values()) {
    if (round.phase === Phase.REFUNDABLE) totalPayout += position.amount;
    else if ((round.result === Side.UP || round.result === Side.DOWN) && position.side === round.result) {
      totalPayout += position.amount + ((round.pools[round.result === Side.UP ? Side.DOWN : Side.UP] - round.fee) * position.amount) / round.pools[round.result];
    }
  }
  return { totalPool, totalPayout, unallocated: totalPool - totalPayout, fee: round.fee };
}
