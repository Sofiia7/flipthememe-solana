import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Side } from '@flipthememe/client';
import {
  MAX_LEDGER_WALLETS,
  chainRoom,
  emptyLedger,
  houseFillAmount,
  matchedWallet,
  pacedCap,
  recordFill,
  recordWalletFill,
  remainingBudget,
  rollover,
  roundsLeftToday,
  utcDay,
  walletFills,
  type FillInput,
  type HouseLedger,
} from '../src/house.ts';

const SOL = 1_000_000_000n;
const milli = (n: number): bigint => (BigInt(n) * SOL) / 1000n; // n thousandths of a SOL

const base: FillInput = {
  rawUp: 0n,
  rawDown: 0n,
  minBank: milli(20),
  maxBank: SOL,
  roundCap: milli(50),
  remainingBudget: 2n * SOL,
  // On-chain HouseLimits room; roomy here, see the on-chain tests below.
  chainRoundRoom: SOL,
  chainDailyRoom: 10n * SOL,
  vaultAvailable: 2n * SOL,
};
const plan = (over: Partial<FillInput>) => houseFillAmount({ ...base, ...over });

describe('houseFillAmount', () => {
  test('fills the smaller side up to the gap', () => {
    assert.deepEqual(plan({ rawUp: milli(30) }), { kind: 'fill', amount: milli(30), side: Side.Down });
    assert.deepEqual(plan({ rawUp: milli(40), rawDown: milli(70) }), { kind: 'fill', amount: milli(30), side: Side.Up });
  });

  test('capped per round', () => {
    assert.deepEqual(plan({ rawUp: milli(100) }), { kind: 'fill', amount: milli(50), side: Side.Down });
  });

  test('capped by the pool depth: 2 * (smaller + amount) <= max_bank', () => {
    assert.deepEqual(plan({ rawUp: milli(100), rawDown: milli(10), maxBank: milli(60) }), { kind: 'fill', amount: milli(20), side: Side.Down });
    assert.deepEqual(plan({ rawUp: milli(100), rawDown: milli(30), maxBank: milli(60) }), { kind: 'skip', reason: 'depth' });
    // Odd max_bank: the room floors.
    assert.deepEqual(plan({ rawUp: milli(100), maxBank: 41_000_001n }), { kind: 'fill', amount: 20_500_000n, side: Side.Down });
  });

  test('capped by the daily budget left and by the house vault', () => {
    assert.deepEqual(plan({ rawUp: milli(50), remainingBudget: milli(15) }), { kind: 'fill', amount: milli(15), side: Side.Down });
    assert.deepEqual(plan({ rawUp: milli(50), vaultAvailable: milli(12) }), { kind: 'fill', amount: milli(12), side: Side.Down });
  });

  test('skipped when a limit is exhausted', () => {
    assert.deepEqual(plan({ rawUp: milli(50), remainingBudget: 0n }), { kind: 'skip', reason: 'budget' });
    assert.deepEqual(plan({ rawUp: milli(50), vaultAvailable: 0n }), { kind: 'skip', reason: 'vault' });
    assert.deepEqual(plan({ rawUp: milli(50), roundCap: 0n }), { kind: 'skip', reason: 'cap' });
    assert.deepEqual(plan({ rawUp: milli(50), rawDown: milli(50) }), { kind: 'skip', reason: 'balanced' });
    assert.deepEqual(plan({}), { kind: 'skip', reason: 'balanced' });
  });

  test('activation threshold: skip when 2 * min(up, down) would stay below min_bank', () => {
    // A 9 mSOL fill makes the matched bank 18 mSOL < 20 mSOL: the round would refund anyway.
    assert.deepEqual(plan({ rawUp: milli(50), vaultAvailable: milli(9) }), { kind: 'skip', reason: 'not-activating' });
    assert.deepEqual(plan({ rawUp: milli(9) }), { kind: 'skip', reason: 'not-activating' });
    // Exactly at the threshold it activates.
    assert.deepEqual(plan({ rawUp: milli(50), vaultAvailable: milli(10) }), { kind: 'fill', amount: milli(10), side: Side.Down });
    assert.deepEqual(plan({ rawUp: milli(10) }), { kind: 'fill', amount: milli(10), side: Side.Down });
    // A smaller side that already counts helps: 6 + 4 = 10 mSOL matched.
    assert.deepEqual(plan({ rawUp: milli(30), rawDown: milli(6), vaultAvailable: milli(4) }), { kind: 'fill', amount: milli(4), side: Side.Down });
  });
});

describe('daily budget ledger (UTC day)', () => {
  const day1 = Date.parse('2026-10-05T12:00:00Z');
  const lateDay1 = Date.parse('2026-10-05T23:59:59Z');
  const day2 = Date.parse('2026-10-06T00:00:01Z');

  test('utcDay', () => {
    assert.equal(utcDay(day1), '2026-10-05');
    assert.equal(utcDay(day2), '2026-10-06');
  });

  test('records each round once and subtracts it from the budget', () => {
    let ledger: HouseLedger = emptyLedger(day1);
    ledger = recordFill(ledger, 10n, milli(50), day1);
    ledger = recordFill(ledger, 10n, milli(50), day1 + 5_000); // seen again on chain after a restart
    ledger = recordFill(ledger, 11n, milli(30), day1 + 60_000);
    assert.equal(ledger.spent, milli(80));
    assert.deepEqual(ledger.rounds, ['10', '11']);
    assert.equal(remainingBudget(ledger, 2n * SOL, day1), 2n * SOL - milli(80));
  });

  test('never negative', () => {
    const ledger: HouseLedger = { day: '2026-10-05', spent: 3n * SOL, rounds: [] };
    assert.equal(remainingBudget(ledger, 2n * SOL, day1), 0n);
  });

  test('rolls over at UTC midnight', () => {
    const spentOut: HouseLedger = { day: '2026-10-05', spent: 2n * SOL, rounds: ['1', '2'] };
    assert.equal(remainingBudget(spentOut, 2n * SOL, lateDay1), 0n);
    assert.equal(rollover(spentOut, lateDay1), spentOut);
    assert.deepEqual(rollover(spentOut, day2), { day: '2026-10-06', spent: 0n, rounds: [] });
    assert.equal(remainingBudget(spentOut, 2n * SOL, day2), 2n * SOL);
    const next = recordFill(spentOut, 3n, milli(50), day2);
    assert.deepEqual(next, { day: '2026-10-06', spent: milli(50), rounds: ['3'] });
  });

  test('budget exhausted blocks the fill until the next UTC day', () => {
    const spentOut: HouseLedger = { day: '2026-10-05', spent: 2n * SOL, rounds: [] };
    assert.deepEqual(plan({ rawUp: milli(50), remainingBudget: remainingBudget(spentOut, 2n * SOL, lateDay1) }), { kind: 'skip', reason: 'budget' });
    assert.deepEqual(plan({ rawUp: milli(50), remainingBudget: remainingBudget(spentOut, 2n * SOL, day2) }), {
      kind: 'fill',
      amount: milli(50),
      side: Side.Down,
    });
  });
});

describe('on-chain HouseLimits (program house_fill)', () => {
  // 2026-10-06 12:00 UTC is UTC day 20732.
  const noon = BigInt(Date.parse('2026-10-06T12:00:00Z') / 1000);
  const day = noon / 86_400n;
  const limits = { roundCap: milli(50), dailyCap: 2n * SOL, day, spent: SOL + milli(990), bump: 255 };

  test('room in the round and today, as the program counts it', () => {
    assert.equal(day, 20_732n);
    assert.deepEqual(chainRoom(limits, 0n, noon), { round: milli(50), daily: milli(10), day, spentToday: SOL + milli(990) });
    // A rotated house key already put 30 mSOL into this round: the cap is on the round total.
    assert.equal(chainRoom(limits, milli(30), noon).round, milli(20));
    assert.equal(chainRoom(limits, milli(80), noon).round, 0n);
    assert.equal(chainRoom({ ...limits, spent: 3n * SOL }, 0n, noon).daily, 0n);
  });

  test('a new UTC day starts from zero, even before any fill writes it', () => {
    const tomorrow = (day + 1n) * 86_400n;
    assert.deepEqual(chainRoom(limits, 0n, tomorrow - 1n).daily, milli(10));
    assert.deepEqual(chainRoom(limits, 0n, tomorrow), { round: milli(50), daily: 2n * SOL, day: day + 1n, spentToday: 0n });
  });

  test('the fill never asks for more than the chain allows', () => {
    assert.deepEqual(plan({ rawUp: milli(50), chainRoundRoom: milli(30) }), { kind: 'fill', amount: milli(30), side: Side.Down });
    assert.deepEqual(plan({ rawUp: milli(50), chainDailyRoom: milli(25) }), { kind: 'fill', amount: milli(25), side: Side.Down });
  });

  test('spent on-chain caps skip with their own reasons, ahead of the keeper soft limits', () => {
    assert.deepEqual(plan({ rawUp: milli(50), chainRoundRoom: 0n }), { kind: 'skip', reason: 'chain-round-cap' });
    assert.deepEqual(plan({ rawUp: milli(50), chainDailyRoom: 0n, remainingBudget: 0n }), { kind: 'skip', reason: 'chain-daily-cap' });
    // A little room left that cannot activate the round: the house stays out.
    assert.deepEqual(plan({ rawUp: milli(50), chainDailyRoom: milli(5) }), { kind: 'skip', reason: 'not-activating' });
  });
});

describe('config.paused', () => {
  test('no house fill while the arena is paused (the program answers Paused), whatever else would allow it', () => {
    assert.deepEqual(plan({ rawUp: milli(50), paused: true }), { kind: 'skip', reason: 'paused' });
    assert.deepEqual(plan({ rawUp: milli(50), paused: false }), { kind: 'fill', amount: milli(50), side: Side.Down });
    assert.deepEqual(plan({ paused: true }), { kind: 'skip', reason: 'paused' }, 'also before the balanced check');
  });
});

describe('the daily budget spread over the day', () => {
  test('roundsLeftToday: whole minutes to the end of the UTC day, at least 1', () => {
    assert.equal(roundsLeftToday(Date.parse('2026-10-07T00:00:00Z')), 1440);
    assert.equal(roundsLeftToday(Date.parse('2026-10-07T00:00:01Z')), 1440, 'a started minute counts');
    assert.equal(roundsLeftToday(Date.parse('2026-10-07T12:00:00Z')), 720);
    assert.equal(roundsLeftToday(Date.parse('2026-10-07T23:59:30Z')), 1);
    assert.equal(roundsLeftToday(Date.parse('2026-10-07T23:59:59.999Z')), 1);
  });

  test('pacedCap = remaining / max(1, roundsLeft / divisor); the rest of the day all in one when few rounds are left', () => {
    assert.equal(pacedCap(2n * SOL, 1440, 4), (2n * SOL * 4n) / 1440n); // 5.5 mSOL
    assert.equal(pacedCap(2n * SOL, 800, 4), 10_000_000n); // 10 mSOL
    assert.equal(pacedCap(SOL, 4, 4), SOL, 'roundsLeft / divisor is 1');
    assert.equal(pacedCap(SOL, 3, 4), SOL, 'below 1 it is still the whole remainder');
    assert.equal(pacedCap(SOL, 1, 4), SOL);
    assert.equal(pacedCap(SOL, 100, 0), null, 'divisor 0: no spreading');
  });

  const pace = (roundsLeft: number, divisor = 4) => ({ roundsLeft, divisor });

  test('a lone big stake is matched only up to the paced cap, and the plan says so', () => {
    // 2 SOL left, 400 rounds to go: cap 2 SOL / (400 / 4) = 20 mSOL against a 50 mSOL gap.
    assert.deepEqual(plan({ rawUp: milli(50), pace: pace(400) }), { kind: 'fill', amount: milli(20), side: Side.Down, paced: milli(20) });
    // Late in the day the cap is above the round cap: nothing is cut, no mark.
    assert.deepEqual(plan({ rawUp: milli(50), pace: pace(40) }), { kind: 'fill', amount: milli(50), side: Side.Down });
    // Without pace the old behaviour: the full gap up to the round cap.
    assert.deepEqual(plan({ rawUp: milli(50) }), { kind: 'fill', amount: milli(50), side: Side.Down });
  });

  test('never below what the round needs to activate (2 x smaller side >= min_bank), while the budget allows it', () => {
    // At the start of the day the cap is 5.5 mSOL, but a 50 mSOL lone stake needs 10 mSOL on the other side.
    assert.deepEqual(plan({ rawUp: milli(50), pace: pace(1440) }), { kind: 'fill', amount: milli(10), side: Side.Down, paced: (2n * SOL * 4n) / 1440n });
    // A smaller side that already counts lowers the floor: 3 mSOL there, 7 more are needed (above the 5.5 mSOL cap) ...
    assert.deepEqual(plan({ rawUp: milli(50), rawDown: milli(3), pace: pace(1440) }), { kind: 'fill', amount: milli(7), side: Side.Down, paced: (2n * SOL * 4n) / 1440n });
    // ... and 6 mSOL there need only 4 more: the cap is the larger, so it stays.
    assert.deepEqual(plan({ rawUp: milli(50), rawDown: milli(6), pace: pace(1440) }), { kind: 'fill', amount: (2n * SOL * 4n) / 1440n, side: Side.Down, paced: (2n * SOL * 4n) / 1440n });
    // Already activated (smaller side 12 mSOL): the cap applies as it is.
    assert.deepEqual(plan({ rawUp: milli(50), rawDown: milli(12), pace: pace(1440) }), { kind: 'fill', amount: (2n * SOL * 4n) / 1440n, side: Side.Down, paced: (2n * SOL * 4n) / 1440n });
  });

  test('the floor still obeys the hard limits: a nearly spent budget or vault gives what is there, or skips', () => {
    // 12 mSOL of budget left: the floor 10 mSOL fits.
    assert.deepEqual(plan({ rawUp: milli(50), remainingBudget: milli(12), pace: pace(1440) }), { kind: 'fill', amount: milli(10), side: Side.Down, paced: (milli(12) * 4n) / 1440n });
    // 8 mSOL left cannot activate the round: skipped as before.
    assert.deepEqual(plan({ rawUp: milli(50), remainingBudget: milli(8), pace: pace(1440) }), { kind: 'skip', reason: 'not-activating' });
    assert.deepEqual(plan({ rawUp: milli(50), vaultAvailable: milli(9), pace: pace(1440) }), { kind: 'skip', reason: 'not-activating' });
  });

  test('2 SOL last the day: with lone 50 mSOL stakes every minute the spread budget pays out about 200 fills, not 40', () => {
    let remaining = 2n * SOL;
    let fills = 0;
    for (let roundsLeft = 1440; roundsLeft > 0; roundsLeft--) {
      const result = plan({ rawUp: milli(50), remainingBudget: remaining, pace: pace(roundsLeft) });
      if (result.kind !== 'fill') continue;
      remaining -= result.amount;
      fills++;
    }
    assert.ok(fills > 150, `${fills} fills`);
    // Without the spread the same day ends after 40 fills.
    let flat = 2n * SOL;
    let flatFills = 0;
    for (let k = 0; k < 1440; k++) {
      const result = plan({ rawUp: milli(50), remainingBudget: flat });
      if (result.kind !== 'fill') continue;
      flat -= result.amount;
      flatFills++;
    }
    assert.equal(flatFills, 40);
  });
});

describe('house fills per wallet and UTC day', () => {
  const day1 = Date.parse('2026-10-07T12:00:00Z');
  const day2 = Date.parse('2026-10-08T00:00:05Z');
  const A = '11111111111111111111111111111112';
  const B = '11111111111111111111111111111113';

  test('counts per wallet, resets at UTC midnight, leaves the spend and the round list alone', () => {
    let ledger: HouseLedger = emptyLedger(day1);
    assert.equal(walletFills(ledger, A, day1), 0);
    ledger = recordWalletFill(ledger, A, day1);
    ledger = recordWalletFill(ledger, A, day1 + 1_000);
    ledger = recordWalletFill(ledger, B, day1 + 2_000);
    assert.equal(walletFills(ledger, A, day1), 2);
    assert.equal(walletFills(ledger, B, day1), 1);
    assert.equal(ledger.spent, 0n);
    // A fill recorded later for a round keeps the counters.
    ledger = recordFill(ledger, 5n, milli(10), day1 + 3_000);
    assert.deepEqual(ledger.fills, { [A]: 2, [B]: 1 });
    assert.equal(ledger.spent, milli(10));
    // The next UTC day starts empty.
    assert.equal(walletFills(ledger, A, day2), 0);
    const next = recordWalletFill(ledger, A, day2);
    assert.deepEqual(next, { day: '2026-10-08', spent: 0n, rounds: [], fills: { [A]: 1 } });
  });

  test('a ledger that never had the field reads as zero, and a day without fills has no field', () => {
    const old: HouseLedger = { day: '2026-10-07', spent: 5n, rounds: ['1'] };
    assert.equal(walletFills(old, A, day1), 0);
    assert.deepEqual(rollover(old, day2), { day: '2026-10-08', spent: 0n, rounds: [] });
    assert.deepEqual(recordFill(old, 2n, 7n, day1), { day: '2026-10-07', spent: 12n, rounds: ['1', '2'] });
  });

  test('the table is bounded: past MAX_LEDGER_WALLETS the least busy wallets are forgotten', () => {
    let ledger: HouseLedger = emptyLedger(day1);
    const wallet = (i: number) => `w${i.toString().padStart(6, '0')}`;
    ledger = recordWalletFill(recordWalletFill(ledger, wallet(0), day1), wallet(0), day1); // busiest: 2
    for (let i = 1; i <= MAX_LEDGER_WALLETS + 50; i++) ledger = recordWalletFill(ledger, wallet(i), day1);
    assert.equal(Object.keys(ledger.fills ?? {}).length, MAX_LEDGER_WALLETS);
    assert.equal(walletFills(ledger, wallet(0), day1), 2, 'the busy wallet is kept');
  });

  test('matchedWallet: the owner of the largest human stake on the side the fill matches', () => {
    const p = (authority: string, side: Side, stake: bigint, isHouse = false) => ({ authority: authority as never, side, stake, isHouse });
    assert.equal(matchedWallet([p(A, Side.Up, milli(50))], Side.Down), A);
    assert.equal(matchedWallet([p(A, Side.Up, milli(30)), p(B, Side.Up, milli(50))], Side.Down), B, 'the biggest stake');
    assert.equal(matchedWallet([p(A, Side.Up, milli(50)), p(B, Side.Up, milli(50))], Side.Down), A, 'the first on a tie');
    assert.equal(matchedWallet([p(A, Side.Up, milli(50)), p(B, Side.Down, milli(20))], Side.Down), A, 'the other side is the one being matched');
    assert.equal(matchedWallet([p(A, Side.Down, milli(50))], Side.Down), null, 'nobody on the matched side');
    assert.equal(matchedWallet([p(A, Side.Up, milli(50), true)], Side.Down), null, 'the house is no wallet to limit');
    assert.equal(matchedWallet([], Side.Up), null);
  });
});
