// Node tests for the "SAME CALL" / "FLIP IT" offer on the result overlay (no React Native). Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Outcome, RefundReason, RoundStatus, Side, type RoundAccount, type SessionAccount } from '@flipthememe/client';
import {
  REPEAT_MAX_ARENA_AGE_MS,
  REPEAT_MIN_SECS_LEFT,
  canRepeatBet,
  holdsPosition,
  multiplierText,
  type RepeatBetInput,
} from '../chain/repeatBet.ts';

const SOL = 1_000_000_000n;
const NOW = 1_800_000_000;
const RENT = 1_158_240n;
const ADDRESS = '11111111111111111111111111111111';

function round(id: bigint, over: Partial<RoundAccount> = {}): RoundAccount {
  return {
    id,
    tokenMint: ADDRESS,
    pool: ADDRESS,
    opensAt: BigInt(NOW - 20),
    cutoffAt: BigInt(NOW + 40),
    strikeStart: BigInt(NOW + 70),
    strikeEnd: BigInt(NOW + 80),
    exitStart: BigInt(NOW + 130),
    exitEnd: BigInt(NOW + 140),
    settleDeadline: BigInt(NOW + 740),
    minStake: SOL / 100n,
    maxStake: SOL / 10n,
    minBank: SOL / 50n,
    maxBank: SOL,
    feeWinBps: 200,
    feeRefundBps: 0,
    rawUp: SOL / 10n,
    rawDown: SOL / 10n,
    houseAmount: 0n,
    positionCount: 2,
    claimedCount: 0,
    totalPaid: 0n,
    feesSwept: false,
    status: RoundStatus.Open,
    outcome: Outcome.Pending,
    refundReason: RefundReason.None,
    strikePrice: 0n,
    exitPrice: 0n,
    strikeSamples: 0,
    exitSamples: 0,
    bump: 255,
    ...over,
  } as RoundAccount;
}

function session(over: Partial<SessionAccount> = {}): SessionAccount {
  return {
    authority: ADDRESS,
    vault: ADDRESS,
    signer: ADDRESS,
    expiry: BigInt(NOW + 86_400),
    maxPerBet: SOL / 10n,
    sessionCap: SOL,
    spent: SOL / 10n,
    revoked: false,
    bump: 255,
    ...over,
  } as SessionAccount;
}

/** Everything in order: an open round with 40 s left, an active session, enough balance, nothing in flight. */
function input(over: Partial<RepeatBetInput> = {}): RepeatBetInput {
  return {
    rounds: [{ id: 50n, account: round(50n) }],
    nowSec: NOW,
    nowMs: 5_000_000,
    arenaUpdatedAt: 4_999_000,
    paused: false,
    owner: ADDRESS,
    myReady: true,
    session: session(),
    available: SOL / 2n,
    positionRent: RENT,
    keyLamports: 5_000_000n,
    gasPerBet: 1_000_000n,
    holds: () => false,
    working: false,
    pendingRoundId: null,
    side: Side.Up,
    stake: SOL / 50n,
    ...over,
  };
}

const withRound = (over: Partial<RoundAccount>) => ({ rounds: [{ id: 50n, account: round(50n, over) }] });
const blockedBy = (over: Partial<RepeatBetInput>) => {
  const r = canRepeatBet(input(over));
  return r.ok ? 'ok' : r.reason;
};

test('everything in order: the same call and the flip, for the stake of the round just finished', () => {
  const r = canRepeatBet(input());
  assert.deepEqual(r, { ok: true, roundId: 50n, amount: SOL / 50n, same: Side.Up, flip: Side.Down, sameFits: true, flipFits: true });
  const down = canRepeatBet(input({ side: Side.Down }));
  assert.ok(down.ok);
  assert.equal(down.same, Side.Down);
  assert.equal(down.flip, Side.Up);
  assert.equal(REPEAT_MIN_SECS_LEFT, 6);
  assert.equal(REPEAT_MAX_ARENA_AGE_MS, 10_000);
});

test('needs an open round: not one that is upcoming, in flight or final', () => {
  assert.equal(blockedBy({ rounds: [] }), 'no-round');
  const upcoming = round(51n, { opensAt: BigInt(NOW + 10), cutoffAt: BigInt(NOW + 70) });
  const inFlight = round(49n, { opensAt: BigInt(NOW - 70), cutoffAt: BigInt(NOW - 10) });
  const final = round(48n, { status: RoundStatus.Final, outcome: Outcome.Up });
  assert.equal(blockedBy({ rounds: [upcoming, inFlight, final].map((a) => ({ id: a.id, account: a })) }), 'no-round');
  // Past its start but not Open on chain (already Live): not open.
  assert.equal(blockedBy(withRound({ status: RoundStatus.Live })), 'no-round');
  // The newest open round is the one offered.
  const older = round(49n, { cutoffAt: BigInt(NOW + 30) });
  const r = canRepeatBet(input({ rounds: [older, round(50n)].map((a) => ({ id: a.id, account: a })) }));
  assert.ok(r.ok);
  assert.equal(r.roundId, 50n);
});

test('at least 6 s before the cutoff', () => {
  assert.equal(blockedBy({ nowSec: NOW + 40 - 5.9 }), 'closing');
  assert.equal(blockedBy({ nowSec: NOW + 40 - 6 }), 'ok');
  assert.equal(blockedBy({ nowSec: NOW + 40 - 1 }), 'closing');
  assert.equal(blockedBy({ nowSec: NOW + 40 }), 'no-round', 'at the cutoff the round is no longer open');
});

test('the wallet owner must be connected and my account read', () => {
  assert.equal(blockedBy({ owner: null }), 'no-wallet');
  assert.equal(blockedBy({ myReady: false }), 'loading');
});

test('the play session must be active: not missing, expired, revoked or used up', () => {
  assert.equal(blockedBy({ session: null }), 'no-session');
  assert.equal(blockedBy({ session: session({ expiry: BigInt(NOW - 1) }) }), 'no-session');
  assert.equal(blockedBy({ session: session({ revoked: true }) }), 'no-session');
  // Used up: not even the minimum stake of the round is left in the session budget.
  assert.equal(blockedBy({ session: session({ sessionCap: SOL, spent: SOL - SOL / 100n + 1n }) }), 'no-session');
  assert.equal(blockedBy({ session: session({ sessionCap: SOL, spent: SOL - SOL / 100n }) }), 'ok');
});

test('the device key needs SOL for one more fee', () => {
  assert.equal(blockedBy({ keyLamports: null }), 'no-gas');
  assert.equal(blockedBy({ keyLamports: 999_999n }), 'no-gas');
  assert.equal(blockedBy({ keyLamports: 1_000_000n }), 'ok');
});

test('no bet in flight, and none waiting for its signature in this round', () => {
  assert.equal(blockedBy({ working: true }), 'busy');
  assert.equal(blockedBy({ pendingRoundId: 50n }), 'busy');
  // A pending bet of another round does not stop a call here (the arena lets it through too).
  assert.equal(blockedBy({ pendingRoundId: 49n }), 'ok');
});

test('arena data must be fresh (not older than 10 s)', () => {
  assert.equal(blockedBy({ arenaUpdatedAt: null }), 'stale');
  assert.equal(blockedBy({ nowMs: 5_000_000, arenaUpdatedAt: 4_990_000 }), 'ok');
  assert.equal(blockedBy({ nowMs: 5_000_000, arenaUpdatedAt: 4_989_999 }), 'stale');
});

test('not while betting is paused', () => {
  assert.equal(blockedBy({ paused: true }), 'paused');
});

test('not when I already hold a position in that round', () => {
  assert.equal(blockedBy({ holds: (id) => id === 50n }), 'already-in');
  assert.equal(blockedBy({ holds: (id) => id === 49n }), 'ok');
});

test('the game balance must cover the amount and the position rent; a shorter balance cuts the amount down', () => {
  // 0.015 SOL left after the rent: the offer is 0.015, not the 0.02 staked.
  const cut = canRepeatBet(input({ available: RENT + 15_000_000n }));
  assert.ok(cut.ok);
  assert.equal(cut.amount, 15_000_000n);
  const odd = canRepeatBet(input({ available: RENT + 15_654_321n }));
  assert.ok(odd.ok);
  assert.equal(odd.amount, 15_600_000n, 'rounded down so the label shows exactly what is bet');
  // Exactly enough for the stake: not cut.
  const exact = canRepeatBet(input({ available: RENT + SOL / 50n }));
  assert.ok(exact.ok);
  assert.equal(exact.amount, SOL / 50n);
  // Less than the minimum stake of the round left, or less than the rent: no offer.
  assert.equal(blockedBy({ available: RENT + 9_999_999n }), 'balance');
  assert.equal(blockedBy({ available: RENT - 1n }), 'balance');
  assert.equal(blockedBy({ available: 0n }), 'balance');
});

test('the amount stays within the per-bet limit of the session and what is left of its budget', () => {
  const perBet = canRepeatBet(input({ stake: SOL / 20n, session: session({ maxPerBet: 30_000_000n }) }));
  assert.ok(perBet.ok);
  assert.equal(perBet.amount, 30_000_000n);
  // 0.03 left of the budget (active: the minimum stake still fits).
  const left = canRepeatBet(input({ stake: SOL / 20n, session: session({ sessionCap: SOL, spent: SOL - 30_000_000n }) }));
  assert.ok(left.ok);
  assert.equal(left.amount, 30_000_000n);
  // A per-bet limit under the minimum stake of the round can never place a bet.
  assert.equal(blockedBy({ session: session({ maxPerBet: 9_000_000n }) }), 'session-limit');
});

test('the amount stays within the stake limits of the round; a stake below the minimum is not raised', () => {
  const capped = canRepeatBet(input({ stake: SOL / 2n, ...withRound({ maxStake: SOL / 20n }) }));
  assert.ok(capped.ok);
  assert.equal(capped.amount, SOL / 20n);
  assert.equal(blockedBy({ stake: 5_000_000n }), 'stake-limits', 'under the 0.01 minimum');
  assert.equal(blockedBy({ stake: SOL / 100n }), 'ok');
  assert.equal(blockedBy(withRound({ maxStake: 5_000_000n })), 'stake-limits');
});

test('the pool depth decides which side is still offered', () => {
  // Up would push the matched part past maxBank / 2; Down still fits.
  const upFull = canRepeatBet(input(withRound({ maxBank: 200_000_000n, rawUp: 90_000_000n, rawDown: 150_000_000n })));
  assert.ok(upFull.ok);
  assert.equal(upFull.sameFits, false);
  assert.equal(upFull.flipFits, true);
  const downCall = canRepeatBet(input({ side: Side.Down, ...withRound({ maxBank: 200_000_000n, rawUp: 90_000_000n, rawDown: 150_000_000n }) }));
  assert.ok(downCall.ok);
  assert.equal(downCall.sameFits, true, 'the same call is Down, which fits');
  assert.equal(downCall.flipFits, false);
  // Neither side fits.
  assert.equal(blockedBy(withRound({ maxBank: 200_000_000n, rawUp: 150_000_000n, rawDown: 150_000_000n })), 'depth');
});

test('holdsPosition reads my account and the arena players, and leaves out the house', () => {
  const me = 'ME';
  const mine = [{ round: { id: 7n } }, { round: null }];
  const players = [
    { account: { authority: 'OTHER', isHouse: false } },
    { account: { authority: me, isHouse: true } },
  ];
  assert.equal(holdsPosition(7n, me, mine, []), true, 'from my positions');
  assert.equal(holdsPosition(8n, me, mine, []), false);
  assert.equal(holdsPosition(8n, me, mine, players), false, 'another player and the house do not count');
  assert.equal(holdsPosition(8n, me, mine, [...players, { account: { authority: me, isHouse: false } }]), true, 'from the arena players');
});

test('the multiplier text follows the fee of the round', () => {
  assert.equal(multiplierText(200), 'x1.96');
  assert.equal(multiplierText(0), 'x2.00');
  assert.equal(multiplierText(100), 'x1.98');
  assert.equal(multiplierText(500), 'x1.90');
});
