import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RoundStatus, roundTimes } from '@flipthememe/client';
import { createDue, nextBoundarySecs, nextStep, type RoundView, type StepContext } from '../src/steps.ts';

// A minute boundary: opens_at T0, cutoff +60, strike +90..+100, exit +150..+160, deadline +760.
const T0 = 1_800_000_000n;
const at = (secs: number): number => (Number(T0) + secs) * 1000;
const sync: StepContext = { chainOffsetMs: 0 };
const lag = (ms: number): StepContext => ({ chainOffsetMs: -ms });

function round(over: Partial<RoundView> = {}): RoundView {
  return {
    id: 7n,
    status: RoundStatus.Open,
    ...roundTimes(T0),
    rawUp: 0n,
    rawDown: 0n,
    houseAmount: 0n,
    positionCount: 0,
    claimedCount: 0,
    feesSwept: false,
    ...over,
  };
}

const kind = (r: RoundView, nowMs: number, ctx: StepContext = sync): string => nextStep(r, nowMs, ctx).kind;
// One bet of 0.05 SOL on UP, nothing on DOWN: the house has something to fill.
const lonely = { rawUp: 50_000_000n, positionCount: 1 } as const;

describe('nextStep: open round before the strike', () => {
  test('entry still open: wait', () => {
    assert.equal(kind(round(lonely), at(30)), 'wait');
    assert.equal(kind(round(lonely), at(60)), 'wait');
  });

  test('house fill window is [cutoff + 2 s, strike_start - 3 s)', () => {
    assert.equal(kind(round(lonely), at(61.999)), 'wait');
    assert.equal(kind(round(lonely), at(62)), 'fill');
    assert.equal(kind(round(lonely), at(86.999)), 'fill');
    assert.equal(kind(round(lonely), at(87)), 'wait');
    assert.equal(kind(round(lonely), at(95)), 'wait');
  });

  test('no fill when the sides are equal, there are no positions, or the house already filled', () => {
    assert.equal(kind(round({ rawUp: 30_000_000n, rawDown: 30_000_000n, positionCount: 2 }), at(70)), 'wait');
    assert.equal(kind(round({ positionCount: 0 }), at(70)), 'wait');
    // Restart inside the window after the house fill landed: never a second fill.
    assert.equal(kind(round({ rawUp: 80_000_000n, rawDown: 50_000_000n, houseAmount: 50_000_000n, positionCount: 2 }), at(70)), 'wait');
  });

  test('fill waits until the devnet clock has passed cutoff too', () => {
    assert.equal(kind(round(lonely), at(62), lag(2_000)), 'fill');
    assert.equal(kind(round(lonely), at(62), lag(3_000)), 'wait');
    assert.equal(kind(round(lonely), at(63), lag(3_000)), 'fill');
  });
});

describe('nextStep: strike', () => {
  test('due 1 s after strike_end on the local clock', () => {
    assert.equal(kind(round(), at(100.999)), 'wait');
    assert.equal(kind(round(), at(101)), 'strike');
    assert.equal(kind(round(lonely), at(101)), 'strike');
  });

  test('also waits for the devnet clock to pass strike_end', () => {
    assert.equal(kind(round(), at(101), lag(2_000)), 'wait');
    assert.equal(kind(round(), at(102), lag(2_000)), 'strike');
  });

  test('restart long after the strike window (keeper was down): strike with what there is', () => {
    assert.equal(kind(round(lonely), at(300)), 'strike');
    assert.equal(kind(round(), at(759)), 'strike');
  });
});

describe('nextStep: settle', () => {
  const live = round({ status: RoundStatus.Live, rawUp: 50_000_000n, rawDown: 50_000_000n, positionCount: 2 });

  test('due 1 s after exit_end, and only once the devnet clock passed it', () => {
    assert.equal(kind(live, at(120)), 'wait');
    assert.equal(kind(live, at(160.999)), 'wait');
    assert.equal(kind(live, at(161)), 'settle');
    assert.equal(kind(live, at(161), lag(2_000)), 'wait');
    assert.equal(kind(live, at(162), lag(2_000)), 'settle');
  });

  test('restart after the exit window: settle', () => {
    assert.equal(kind(live, at(500)), 'settle');
  });
});

describe('nextStep: past settle_deadline', () => {
  test('open or live rounds past the deadline are refunded', () => {
    assert.equal(kind(round(lonely), at(760.999)), 'strike');
    assert.equal(kind(round(lonely), at(761)), 'expire');
    assert.equal(kind(round({ status: RoundStatus.Live, positionCount: 2 }), at(761)), 'expire');
    assert.equal(kind(round(), at(5_000)), 'expire');
  });

  test('uses the devnet clock: while devnet is still before the deadline, the normal step runs', () => {
    assert.equal(kind(round({ status: RoundStatus.Live, positionCount: 2 }), at(761), lag(2_000)), 'settle');
    assert.equal(kind(round({ status: RoundStatus.Live, positionCount: 2 }), at(763), lag(2_000)), 'expire');
  });

  test('final rounds past the deadline still go through claim / sweep / close', () => {
    const final = round({ status: RoundStatus.Final, positionCount: 2, claimedCount: 0 });
    assert.equal(kind(final, at(5_000)), 'claim');
    assert.equal(kind(round({ status: RoundStatus.Final }), at(5_000)), 'close');
  });
});

describe('nextStep: final rounds', () => {
  test('empty round: close', () => {
    assert.equal(kind(round({ status: RoundStatus.Final, positionCount: 0 }), at(102)), 'close');
  });

  test('claim every position, then sweep, then done', () => {
    assert.equal(kind(round({ status: RoundStatus.Final, positionCount: 3, claimedCount: 0 }), at(170)), 'claim');
    assert.equal(kind(round({ status: RoundStatus.Final, positionCount: 3, claimedCount: 2 }), at(170)), 'claim');
    assert.equal(kind(round({ status: RoundStatus.Final, positionCount: 3, claimedCount: 3 }), at(170)), 'sweep');
    assert.equal(kind(round({ status: RoundStatus.Final, positionCount: 3, claimedCount: 3, feesSwept: true }), at(170)), 'done');
  });

  test('a one-sided round that ended NotActivated at the strike still has its stake claimed back', () => {
    assert.equal(kind(round({ status: RoundStatus.Final, rawUp: 50_000_000n, positionCount: 1 }), at(102)), 'claim');
  });
});

describe('createDue', () => {
  const next = T0 + 60n;

  test('nothing before the last 15 s of the minute', () => {
    assert.equal(createDue(at(44.999), []), null);
  });

  test('creates the round of the next minute boundary in the last 15 s', () => {
    assert.deepEqual(createDue(at(45), []), { opensAt: next });
    assert.deepEqual(createDue(at(59.999), [{ opensAt: T0 }]), { opensAt: next });
  });

  test('skips when that round already exists', () => {
    assert.equal(createDue(at(50), [{ opensAt: T0 }, { opensAt: next }]), null);
  });

  test('after downtime it creates only the next upcoming round, never one in the past', () => {
    const stale = [{ opensAt: T0 - 600n }, { opensAt: T0 - 540n }];
    assert.equal(createDue(at(10), stale), null);
    assert.deepEqual(createDue(at(50), stale), { opensAt: next });
    // Exactly on a boundary the current minute is not backfilled; the next one comes 15 s before its start.
    assert.equal(createDue(at(60), stale), null);
    assert.deepEqual(createDue(at(105), stale), { opensAt: T0 + 120n });
  });

  test('nextBoundarySecs is the start of the next UTC minute', () => {
    assert.equal(nextBoundarySecs(at(0)), T0 + 60n);
    assert.equal(nextBoundarySecs(at(59.999)), T0 + 60n);
    assert.equal(nextBoundarySecs(at(60)), T0 + 120n);
  });
});
