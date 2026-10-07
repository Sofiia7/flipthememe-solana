// The second-keeper detector: each boundary counts once, three in a row pause create for 5 minutes.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AnotherKeeperGuard, CREATE_PAUSE_MS, SUSPECTS_BEFORE_PAUSE } from '../src/guard.ts';
import type { LogFields } from '../src/log.ts';
import { roundAhead } from '../src/steps.ts';

const T0 = 1_800_000_000n; // a minute boundary
const at = (secs: number): number => (Number(T0) + secs) * 1000;

function guard(over: { limit?: number; pauseMs?: number } = {}) {
  const logs: LogFields[] = [];
  return { guard: new AnotherKeeperGuard({ logger: (f) => logs.push(f), ...over }), logs };
}

describe('AnotherKeeperGuard', () => {
  test('defaults: three boundaries in a row, a 5 minute pause', () => {
    assert.equal(SUSPECTS_BEFORE_PAUSE, 3);
    assert.equal(CREATE_PAUSE_MS, 300_000);
  });

  test('a boundary counts once, however many ticks see the foreign round; the line says which sign', () => {
    const { guard: g, logs } = guard();
    g.foreignRound(T0 + 60n, 11n, at(50));
    g.foreignRound(T0 + 60n, 11n, at(51));
    g.invalidRoundId(T0 + 60n, at(52));
    assert.equal(g.suspected, 1);
    assert.deepEqual(logs.map((l) => [l.event, l.consecutive, l.sign, l.round]), [['another_keeper_suspected', 1, 'round_exists', 11n]]);
    assert.equal(g.paused(at(53)), false);
  });

  test('three boundaries in a row pause create for 5 minutes, then the count starts again', () => {
    const { guard: g, logs } = guard();
    g.foreignRound(T0 + 60n, 11n, at(50));
    g.invalidRoundId(T0 + 120n, at(110));
    assert.equal(g.paused(at(111)), false);
    g.foreignRound(T0 + 180n, 13n, at(170));
    assert.equal(g.paused(at(171)), true);
    assert.equal(g.paused(at(170 + 299)), true);
    assert.equal(g.paused(at(170 + 300)), false);
    assert.equal(g.pausedUntil(), at(170 + 300));
    const paused = logs.find((l) => l.event === 'another_keeper_create_paused');
    assert.equal(paused?.minutes, 5);
    assert.equal(paused?.until, new Date(at(470)).toISOString());
    // After the pause two more boundaries are not yet a pause.
    g.foreignRound(T0 + 540n, 20n, at(530));
    g.foreignRound(T0 + 600n, 21n, at(590));
    assert.equal(g.paused(at(591)), false);
  });

  test('a create of its own resets the count: restarts and an occasional lost race never add up to a pause', () => {
    const { guard: g } = guard();
    g.foreignRound(T0 + 60n, 11n, at(50));
    g.foreignRound(T0 + 120n, 12n, at(110));
    g.created();
    g.foreignRound(T0 + 180n, 13n, at(170));
    g.foreignRound(T0 + 240n, 14n, at(230));
    assert.equal(g.paused(at(231)), false);
    assert.equal(g.suspected, 4);
  });

  test('the suspicion line is throttled to one per 30 s, the counting is not', () => {
    const { guard: g, logs } = guard({ limit: 10 });
    g.foreignRound(T0 + 60n, 1n, at(50));
    g.foreignRound(T0 + 70n, 2n, at(55)); // another boundary 5 s later: counted, not logged again
    g.foreignRound(T0 + 120n, 3n, at(110));
    assert.equal(g.suspected, 3);
    assert.deepEqual(logs.map((l) => l.consecutive), [1, 3]);
  });
});

describe('roundAhead (steps.ts)', () => {
  test('the round standing at or past the upcoming boundary, only once creating it is due (the last 15 s of the minute)', () => {
    const rounds = [{ id: 9n, opensAt: T0 }, { id: 10n, opensAt: T0 + 60n }];
    assert.equal(roundAhead(at(30), rounds), null, 'too early to say');
    assert.deepEqual(roundAhead(at(45), rounds), { id: 10n, opensAt: T0 + 60n });
    assert.equal(roundAhead(at(50), [{ id: 9n, opensAt: T0 }]), null, 'no round at the boundary: createDue handles that');
    assert.deepEqual(roundAhead(at(59.9), [{ id: 11n, opensAt: T0 + 3600n }]), { id: 11n, opensAt: T0 + 3600n }, 'a round far ahead counts too');
    assert.equal(roundAhead(at(60), [{ id: 10n, opensAt: T0 + 60n }]), null, 'on the boundary the next one is a minute away');
  });
});
