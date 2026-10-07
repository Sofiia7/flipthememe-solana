// Money rules of one round, mirrored from programs/flip-the-meme/src/payout.rs.
// vectors.test.ts checks the same functions against numbers written by the Rust side.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Outcome, RefundReason, Side } from '../src/constants.ts';
import { acceptedStake, houseContext, isActivated, positionPayout, previewBet, type HouseContext } from '../src/payout.ts';

const SOL = 1_000_000_000n;
const withReason = (refundReason: RefundReason) => (houseAmount: bigint, isHouse: boolean): HouseContext => ({ refundReason, houseAmount, isHouse });
const expired = withReason(RefundReason.Expired);
const unpriceable = withReason(RefundReason.Unpriceable);

test('without house information the payout is the plain payout of the book', () => {
  const s = SOL / 10n;
  assert.equal(positionPayout(s, s, Outcome.Up, 200, 100, Side.Up, s), (s * 196n) / 100n);
  assert.equal(positionPayout(s, s, Outcome.Up, 200, 100, Side.Down, s), 0n);
  assert.equal(positionPayout(s, s, Outcome.Refund, 200, 100, Side.Up, s), (s * 99n) / 100n);
  assert.equal(positionPayout(s, 0n, Outcome.NotActivated, 200, 100, Side.Up, s), s);
  assert.equal(positionPayout(s, s, Outcome.Pending, 200, 100, Side.Up, s), null);
  assert.equal(positionPayout(s, s, Outcome.Pending, 200, 100, Side.Up, s, expired(s, true)), null);
});

test('an expired round takes the house stake and the other positions share it', () => {
  // 0.08 UP from two players (0.06 and 0.02), 0.02 DOWN from one; the house filled DOWN with 0.06.
  const [up, down, house] = [(8n * SOL) / 100n, (8n * SOL) / 100n, (6n * SOL) / 100n];
  const pay = (side: Side, stake: bigint, isHouse: boolean) => positionPayout(up, down, Outcome.Refund, 200, 0, side, stake, expired(house, isHouse));
  // Other stakes total 0.10: each gets its stake back plus 0.06 * stake / 0.10.
  assert.equal(pay(Side.Up, (6n * SOL) / 100n, false), (6n * SOL) / 100n + (36n * SOL) / 1000n);
  assert.equal(pay(Side.Up, (2n * SOL) / 100n, false), (2n * SOL) / 100n + (12n * SOL) / 1000n);
  assert.equal(pay(Side.Down, (2n * SOL) / 100n, false), (2n * SOL) / 100n + (12n * SOL) / 1000n);
  assert.equal(pay(Side.Down, (6n * SOL) / 100n, true), 0n);
});

test('an unpriceable round treats the house exactly like an expired one', () => {
  // Same book as above: 0.08 UP from two players, 0.02 DOWN from one, the house filled DOWN with 0.06.
  const [up, down, house] = [(8n * SOL) / 100n, (8n * SOL) / 100n, (6n * SOL) / 100n];
  const book = [
    [Side.Up, (6n * SOL) / 100n, false],
    [Side.Up, (2n * SOL) / 100n, false],
    [Side.Down, (2n * SOL) / 100n, false],
    [Side.Down, (6n * SOL) / 100n, true],
  ] as const;
  for (const fee of [0, 100]) {
    for (const [side, stake, isHouse] of book) {
      const got = positionPayout(up, down, Outcome.Refund, 200, fee, side, stake, unpriceable(house, isHouse));
      assert.equal(got, positionPayout(up, down, Outcome.Refund, 200, fee, side, stake, expired(house, isHouse)));
    }
  }
  const pay = (side: Side, stake: bigint, isHouse: boolean) => positionPayout(up, down, Outcome.Refund, 200, 0, side, stake, unpriceable(house, isHouse));
  assert.equal(pay(Side.Up, (6n * SOL) / 100n, false), (6n * SOL) / 100n + (36n * SOL) / 1000n);
  assert.equal(pay(Side.Down, (2n * SOL) / 100n, false), (2n * SOL) / 100n + (12n * SOL) / 1000n);
  assert.equal(pay(Side.Down, (6n * SOL) / 100n, true), 0n);
});

test('the refund fee still applies to the stake of a player in an expired round', () => {
  // Equal sides, 100 bps: 0.05 * 0.99 back, plus the whole 0.05 house stake.
  const half = SOL / 20n;
  assert.equal(positionPayout(half, half, Outcome.Refund, 200, 100, Side.Up, half, expired(half, false)), (half * 99n) / 100n + half);
  assert.equal(positionPayout(half, half, Outcome.Refund, 200, 100, Side.Down, half, expired(half, true)), 0n);
});

test('an expired round without a house stake pays like any refund', () => {
  const [up, down] = [(3n * SOL) / 10n, SOL / 10n];
  for (const fee of [0, 100]) {
    for (const [side, stake] of [[Side.Up, up], [Side.Down, down]] as const) {
      const plain = positionPayout(up, down, Outcome.Refund, 200, fee, side, stake);
      assert.equal(positionPayout(up, down, Outcome.Refund, 200, fee, side, stake, expired(0n, false)), plain);
    }
  }
});

test('only a refund without a price takes the house stake', () => {
  const [up, down, house] = [SOL / 10n, SOL / 10n, SOL / 20n];
  // A tie is a real price that came out equal: the house is refunded like everyone.
  for (const refundReason of [RefundReason.None, RefundReason.Tie]) {
    for (const isHouse of [true, false]) {
      const plain = positionPayout(up, down, Outcome.Refund, 200, 100, Side.Down, SOL / 20n);
      assert.equal(positionPayout(up, down, Outcome.Refund, 200, 100, Side.Down, SOL / 20n, { refundReason, houseAmount: house, isHouse }), plain);
    }
  }
  // A priced round and an unmatched one never look at the house either, whatever the reason says.
  for (const reason of [expired, unpriceable]) {
    for (const outcome of [Outcome.Up, Outcome.Down, Outcome.NotActivated]) {
      const plain = positionPayout(up, down, outcome, 200, 100, Side.Down, SOL / 20n);
      assert.equal(positionPayout(up, down, outcome, 200, 100, Side.Down, SOL / 20n, reason(house, true)), plain);
    }
  }
});

test('an unmatched round returns a small house fill whole, and a tie refunds the house like everyone', () => {
  // 0.05 UP against a 0.005 house fill: 2 x 0.005 is under a 0.02 minimum bank, so nothing plays.
  const [up, down, house] = [SOL / 20n, SOL / 200n, SOL / 200n];
  const notActivated = { refundReason: RefundReason.None, houseAmount: house };
  assert.equal(positionPayout(up, down, Outcome.NotActivated, 200, 100, Side.Down, house, { ...notActivated, isHouse: true }), house);
  assert.equal(positionPayout(up, down, Outcome.NotActivated, 200, 100, Side.Up, up, { ...notActivated, isHouse: false }), up);
  // Tie: the house stake is refunded at the refund rate (99% at 100 bps), not forfeited.
  const [tieUp, tieDown, tieHouse] = [(8n * SOL) / 100n, (8n * SOL) / 100n, (6n * SOL) / 100n];
  const tie = { refundReason: RefundReason.Tie, houseAmount: tieHouse, isHouse: true };
  assert.equal(positionPayout(tieUp, tieDown, Outcome.Refund, 200, 100, Side.Down, tieHouse, tie), (tieHouse * 99n) / 100n);
  assert.equal(positionPayout(tieUp, tieDown, Outcome.Refund, 200, 0, Side.Down, tieHouse, tie), tieHouse);
});

test('with nobody to compensate the house gets its refund', () => {
  // Not reachable with a real book (the house never takes the larger side), but the rule must hold.
  const [up, down] = [SOL / 10n, SOL / 10n];
  const plain = positionPayout(up, down, Outcome.Refund, 200, 100, Side.Up, up);
  assert.equal(positionPayout(up, down, Outcome.Refund, 200, 100, Side.Up, up, expired(up + down, true)), plain);
  // A house stake above the bank cannot be real: no payout.
  assert.equal(positionPayout(up, down, Outcome.Refund, 200, 100, Side.Up, up, expired(up + down + 1n, false)), null);
});

test('houseContext reads the round and the position', () => {
  const round = { refundReason: RefundReason.Expired, houseAmount: 5n };
  assert.deepEqual(houseContext(round, { isHouse: true }), { refundReason: RefundReason.Expired, houseAmount: 5n, isHouse: true });
  assert.deepEqual(houseContext(round, { isHouse: false }), { refundReason: RefundReason.Expired, houseAmount: 5n, isHouse: false });
});

test('previews, the accepted stake and activation are untouched by the house rule', () => {
  const p = previewBet({ rawUp: SOL / 10n, rawDown: SOL / 10n, feeWinBps: 200 }, Side.Up, SOL / 20n);
  assert.equal(p.payoutIfMatched, ((SOL / 20n) * 19_600n) / 10_000n);
  // 0.10 UP against 0.20 DOWN: the DOWN stake of 0.10 plays half, 0.05 comes back.
  assert.equal(acceptedStake(SOL / 10n, SOL / 5n, Side.Down, SOL / 10n), SOL / 20n);
  assert.equal(acceptedStake(SOL / 10n, SOL / 5n, Side.Up, SOL / 10n), SOL / 10n);
  assert.equal(isActivated(SOL / 10n, SOL / 10n, (2n * SOL) / 100n), true);
  assert.equal(isActivated(SOL / 10n, 0n, (2n * SOL) / 100n), false);
});

/** xorshift64*, as in the Rust tests: many book shapes without a dependency. */
function rng(seed: bigint) {
  let state = seed;
  const mask = (1n << 64n) - 1n;
  return () => {
    state ^= state >> 12n;
    state ^= (state << 25n) & mask;
    state ^= state >> 27n;
    return (state * 0x2545f4914f6cdd1dn) & mask;
  };
}

test('payouts of a round without a price and with a house never exceed the bank and the house keeps nothing', () => {
  const next = rng(0x1234_5678_9abc_def1n);
  const stake = () => SOL / 100n + (next() % (SOL / 10n));
  for (let i = 0; i < 2_000; i++) {
    const ups = Array.from({ length: Number(1n + (next() % 6n)) }, stake);
    const downs = Array.from({ length: Number(1n + (next() % 6n)) }, stake);
    const upPlayers = ups.reduce((a, b) => a + b, 0n);
    const downPlayers = downs.reduce((a, b) => a + b, 0n);
    // The house tops the smaller side up by part of the gap, in one or two fills.
    const houseSide = upPlayers < downPlayers ? Side.Up : Side.Down;
    const gap = upPlayers < downPlayers ? downPlayers - upPlayers : upPlayers - downPlayers;
    const first = gap === 0n ? 0n : 1n + (next() % gap);
    const second = gap > first ? next() % (gap - first + 1n) : 0n;
    const houseStakes = [first, second].filter((h) => h > 0n);
    const house = houseStakes.reduce((a, b) => a + b, 0n);
    const up = upPlayers + (houseSide === Side.Up ? house : 0n);
    const down = downPlayers + (houseSide === Side.Down ? house : 0n);
    for (const reason of [expired, unpriceable]) {
      for (const fee of [0, 100]) {
        const pay = (side: Side, s: bigint, isHouse: boolean) => positionPayout(up, down, Outcome.Refund, 200, fee, side, s, reason(house, isHouse))!;
        let paid = 0n;
        for (const s of ups) paid += pay(Side.Up, s, false);
        for (const s of downs) paid += pay(Side.Down, s, false);
        for (const s of houseStakes) {
          const got = pay(houseSide, s, true);
          assert.equal(got, 0n);
          paid += got;
        }
        assert.ok(paid <= up + down, `paid ${paid} > bank ${up + down} (house ${house}, fee ${fee})`);
        if (fee === 0 && house > 0n) assert.ok(up + down - paid <= BigInt(ups.length + downs.length), 'floors lose under one lamport per position');
      }
    }
  }
});
