import test from "node:test";
import assert from "node:assert/strict";
import { ArenaError, Phase, Side, accounting, advanceRound, claim, createRound, placeBet, previewPayout, settle } from "../src/arena.mjs";

const base = () => createRound({
  id: "round-7", token: "TIKTOK", poolAddress: "pool", source: "mock",
  opensAt: 10, cutoffAt: 40, startsAt: 45, endsAt: 105, settlementDeadlineAt: 150,
});
const open = () => advanceRound(base(), 10);
const sol = (value) => BigInt(value) * 1_000_000_000n;

test("blocks duplicate position and cutoff entries", () => {
  let round = placeBet(open(), { authority: "alice", side: Side.UP, amount: sol(1), now: 20 });
  assert.throws(() => placeBet(round, { authority: "alice", side: Side.DOWN, amount: sol(1), now: 20 }), (error) => error instanceof ArenaError && error.code === "POSITION_EXISTS");
  round = advanceRound(round, 40);
  assert.equal(round.phase, Phase.LOCKED);
  assert.throws(() => placeBet(round, { authority: "bob", side: Side.DOWN, amount: sol(1), now: 40 }), /ROUND_NOT_OPEN/);
});

test("uses 1% of losing pool and returns winning stake", () => {
  let round = open();
  round = placeBet(round, { authority: "alice", side: Side.UP, amount: sol(0) + 10_000_000n, now: 20 });
  round = placeBet(round, { authority: "bob", side: Side.UP, amount: 590_000_000n, now: 20 });
  round = placeBet(round, { authority: "carol", side: Side.DOWN, amount: 200_000_000n, now: 20 });
  round = advanceRound(round, 45);
  round = settle(round, { startPrice: 100_000n, endPrice: 101_000n, now: 105 });
  const payment = claim(round, "alice");
  assert.equal(round.fee, 2_000_000n);
  assert.equal(payment.kind, "WIN");
  assert.equal(payment.payout, 13_300_000n);
});

test("pays a DOWN winner under uneven pools and preserves accounting", () => {
  let round = open();
  round = placeBet(round, { authority: "alice", side: Side.UP, amount: 600_000_000n, now: 20 });
  round = placeBet(round, { authority: "bob", side: Side.DOWN, amount: 10_000_000n, now: 20 });
  round = placeBet(round, { authority: "carol", side: Side.DOWN, amount: 190_000_000n, now: 20 });
  round = settle(advanceRound(round, 45), { startPrice: 100_000n, endPrice: 90_000n, now: 105 });
  assert.equal(claim(round, "bob").payout, 39_700_000n);
  const ledger = accounting(round);
  assert.equal(ledger.totalPool, 800_000_000n);
  assert.equal(ledger.fee, 6_000_000n);
  assert.equal(ledger.unallocated, ledger.fee);
});

test("refunds both sides for a tie, empty side, or timeout", () => {
  let tied = placeBet(open(), { authority: "alice", side: Side.UP, amount: sol(1), now: 20 });
  tied = placeBet(tied, { authority: "bob", side: Side.DOWN, amount: sol(1), now: 20 });
  tied = settle(advanceRound(tied, 45), { startPrice: 100n, endPrice: 100n, now: 105 });
  assert.equal(tied.phase, Phase.REFUNDABLE);
  assert.equal(claim(tied, "alice").payout, sol(1));
  let timeout = placeBet(open(), { authority: "alice", side: Side.UP, amount: sol(1), now: 20 });
  timeout = advanceRound(timeout, 150);
  assert.equal(timeout.result, "TIMEOUT");
  assert.equal(claim(timeout, "alice").payout, sol(1));
});

test("preview includes own unsubmitted stake", () => {
  let round = placeBet(open(), { authority: "alice", side: Side.UP, amount: 100n, now: 20 });
  round = placeBet(round, { authority: "bob", side: Side.DOWN, amount: 100n, now: 20 });
  assert.deepEqual(previewPayout(round, Side.UP, 100n), { payout: 149n, fee: 1n, prize: 99n, refundable: false });
});

test("rounding never pays more than pool and leaves only fee plus dust", () => {
  let round = open();
  round = placeBet(round, { authority: "a", side: Side.UP, amount: 1n, now: 20 });
  round = placeBet(round, { authority: "b", side: Side.UP, amount: 1n, now: 20 });
  round = placeBet(round, { authority: "c", side: Side.UP, amount: 1n, now: 20 });
  round = placeBet(round, { authority: "d", side: Side.DOWN, amount: 100n, now: 20 });
  round = settle(advanceRound(round, 45), { startPrice: 10n, endPrice: 11n, now: 105 });
  const ledger = accounting(round);
  assert.ok(ledger.totalPayout <= ledger.totalPool);
  assert.ok(ledger.unallocated >= ledger.fee);
  assert.ok(ledger.unallocated < ledger.fee + 3n);
});

test("an empty side becomes refundable without charging a fee", () => {
  let round = placeBet(open(), { authority: "alice", side: Side.UP, amount: 100n, now: 20 });
  round = settle(advanceRound(round, 45), { startPrice: 100n, endPrice: 110n, now: 105 });
  assert.equal(round.phase, Phase.REFUNDABLE);
  assert.equal(round.fee, 0n);
  assert.equal(claim(round, "alice").kind, "REFUND");
});

test("a terminal result remains terminal when time advances", () => {
  let round = open();
  round = placeBet(round, { authority: "alice", side: Side.UP, amount: 100n, now: 20 });
  round = placeBet(round, { authority: "bob", side: Side.DOWN, amount: 100n, now: 20 });
  round = settle(advanceRound(round, 45), { startPrice: 100n, endPrice: 110n, now: 105 });
  const finalRound = advanceRound(round, 1_000);
  assert.equal(finalRound.phase, Phase.SETTLED_UP);
  assert.equal(finalRound.result, Side.UP);
});
