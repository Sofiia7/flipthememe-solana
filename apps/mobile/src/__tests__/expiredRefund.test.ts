// Node tests for what an expired round pays: the program gives its house position nothing and shares the
// house stake among the other positions pro rata, so a player can get MORE than the stake back. Run from
// the repo root: node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Outcome, RefundReason, RoundStatus, Side, type RoundAccount } from '@flipthememe/client';
import { positionResult, refundTitle } from '../chain/phase.ts';

const SOL = 1_000_000_000n;

function round(over: Partial<RoundAccount> = {}): RoundAccount {
  const o = 1_000_000n;
  return {
    id: 7n,
    tokenMint: '11111111111111111111111111111111' as RoundAccount['tokenMint'],
    pool: '11111111111111111111111111111111' as RoundAccount['pool'],
    opensAt: o,
    cutoffAt: o + 60n,
    strikeStart: o + 90n,
    strikeEnd: o + 100n,
    exitStart: o + 150n,
    exitEnd: o + 160n,
    settleDeadline: o + 760n,
    minStake: SOL / 100n,
    maxStake: SOL / 10n,
    minBank: SOL / 50n,
    maxBank: SOL,
    feeWinBps: 200,
    feeRefundBps: 0,
    rawUp: 0n,
    rawDown: 0n,
    houseAmount: 0n,
    positionCount: 0,
    claimedCount: 0,
    totalPaid: 0n,
    feesSwept: false,
    status: RoundStatus.Final,
    outcome: Outcome.Refund,
    refundReason: RefundReason.Expired,
    strikePrice: 0n,
    exitPrice: 0n,
    strikeSamples: 0,
    exitSamples: 0,
    bump: 255,
    ...over,
  };
}

// UP: a player with 0.06. DOWN: a player with 0.02 and the house with 0.04. Matched 0.06 a side.
const expired = round({ rawUp: (SOL * 6n) / 100n, rawDown: (SOL * 6n) / 100n, houseAmount: (SOL * 4n) / 100n });
const NOW = 2_000_000;

test('an expired round with a house stake: the house gets 0, the players share its stake on top of their own', () => {
  const up = positionResult({ side: Side.Up, stake: (SOL * 6n) / 100n, claimed: false, payout: 0n, isHouse: false }, expired, NOW);
  assert.equal(up.kind, 'refund');
  // 0.06 back plus 0.04 x 0.06 / 0.08 = 0.03.
  assert.equal(up.payout, (SOL * 9n) / 100n);
  const down = positionResult({ side: Side.Down, stake: (SOL * 2n) / 100n, claimed: false, payout: 0n, isHouse: false }, expired, NOW);
  assert.equal(down.payout, (SOL * 3n) / 100n);
  const house = positionResult({ side: Side.Down, stake: (SOL * 4n) / 100n, claimed: false, payout: 0n, isHouse: true }, expired, NOW);
  assert.equal(house.payout, 0n);
  // Everything in the bank goes out: 0.09 + 0.03 + 0.00 = 0.12.
  assert.equal((up.payout ?? 0n) + (down.payout ?? 0n) + (house.payout ?? 0n), (SOL * 12n) / 100n);
});

test('a position without the isHouse flag counts as a player', () => {
  const plain = positionResult({ side: Side.Up, stake: (SOL * 6n) / 100n, claimed: false, payout: 0n }, expired, NOW);
  assert.equal(plain.payout, (SOL * 9n) / 100n);
});

test('a claimed position shows what the chain paid, not a recomputation', () => {
  const claimed = positionResult({ side: Side.Up, stake: (SOL * 6n) / 100n, claimed: true, payout: 123n, isHouse: false }, expired, NOW);
  assert.equal(claimed.payout, 123n);
});

test('other refund reasons and a round without a house stake pay the stake back as before', () => {
  const tie = round({ ...expired, refundReason: RefundReason.Tie });
  assert.equal(positionResult({ side: Side.Up, stake: (SOL * 6n) / 100n, claimed: false, payout: 0n, isHouse: false }, tie, NOW).payout, (SOL * 6n) / 100n);
  const noHouse = round({ rawUp: SOL / 10n, rawDown: SOL / 10n });
  assert.equal(positionResult({ side: Side.Up, stake: SOL / 10n, claimed: false, payout: 0n, isHouse: false }, noHouse, NOW).payout, SOL / 10n);
});

test('the refund headline says "plus a house share" only when the payout is above the stake', () => {
  const stake = (SOL * 6n) / 100n;
  assert.equal(refundTitle({ kind: 'refund', label: 'EXPIRED', payout: (SOL * 9n) / 100n, stake }), 'Expired - stake back plus a house share');
  assert.equal(refundTitle({ kind: 'refund', label: 'EXPIRED', payout: stake, stake }), 'Expired - stake back');
  assert.equal(refundTitle({ kind: 'refund', label: 'TIE', payout: stake, stake }), 'Tie - stake back');
  assert.equal(refundTitle({ kind: 'refund', label: 'NO PRICE', payout: stake, stake }), 'No price - stake back');
  assert.equal(refundTitle({ kind: 'full-refund', label: 'NO MATCH', payout: stake, stake }), 'No match - stake back');
  assert.equal(refundTitle({ kind: 'refund', label: 'REFUND', payout: stake, stake }), 'Refund - stake back');
});
