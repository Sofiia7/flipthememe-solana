import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Side } from '@flipthememe/client';
import {
  emptyLedger,
  houseFillAmount,
  recordFill,
  remainingBudget,
  rollover,
  utcDay,
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
