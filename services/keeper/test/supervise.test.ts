// Loop supervision: the throttled loop_error log with its recovery line, and the self-watchdog's
// stall check (main.ts wires both; they live in supervise.ts so they can be tested without a process).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LogFields } from '../src/log.ts';
import { LOOP_ERROR_EVERY_MS, LoopErrorLog, STALL_AFTER_MS, isStalled, watchStall } from '../src/supervise.ts';

function make(everyMs?: number): { guard: LoopErrorLog; lines: LogFields[] } {
  const lines: LogFields[] = [];
  return { guard: new LoopErrorLog((f) => lines.push(f), everyMs), lines };
}

describe('LoopErrorLog', () => {
  test('the first failure is logged at once, the rest of a burst is counted, not logged', () => {
    const { guard, lines } = make();
    guard.failure('scheduler', 'fetch failed', 0);
    assert.deepEqual(lines, [{ event: 'loop_error', loop: 'scheduler', error: 'fetch failed' }]);
    for (let s = 1; s < 30; s++) guard.failure('scheduler', 'fetch failed', s * 1000);
    assert.equal(lines.length, 1);
  });

  test('then at most one line per 30 s, with the suppressed count and the last error', () => {
    assert.equal(LOOP_ERROR_EVERY_MS, 30_000);
    const { guard, lines } = make();
    guard.failure('scheduler', 'first', 0);
    for (let s = 1; s <= 29; s++) guard.failure('scheduler', `error ${s}`, s * 1000);
    guard.failure('scheduler', 'at thirty', 30_000);
    assert.equal(lines.length, 2);
    // 29 failures were held back (seconds 1 to 29); the one at second 30 is the line itself.
    assert.deepEqual(lines[1], { event: 'loop_error', loop: 'scheduler', error: 'at thirty', suppressed: 29, failures: 31 });
    // The next window starts from that line.
    for (let s = 31; s <= 59; s++) guard.failure('scheduler', 'again', s * 1000);
    assert.equal(lines.length, 2);
    guard.failure('scheduler', 'again', 60_000);
    assert.deepEqual(lines[2], { event: 'loop_error', loop: 'scheduler', error: 'again', suppressed: 29, failures: 61 });
  });

  test('the line carries the latest error, not the first', () => {
    const { guard, lines } = make(10_000);
    guard.failure('sampler', 'timeout', 0);
    guard.failure('sampler', 'HTTP 429', 4_000);
    guard.failure('sampler', 'HTTP 503', 10_000);
    assert.equal(lines[1]?.error, 'HTTP 503');
    assert.equal(lines[1]?.suppressed, 1);
  });

  test('a success after failures logs one recovery line; a success while healthy logs nothing', () => {
    const { guard, lines } = make();
    guard.success('scheduler', 0);
    assert.deepEqual(lines, []);
    guard.failure('scheduler', 'down', 1_000);
    guard.failure('scheduler', 'down', 2_000);
    guard.failure('scheduler', 'down', 3_000);
    guard.success('scheduler', 61_000);
    assert.deepEqual(lines.at(-1), { event: 'loop_recovered', loop: 'scheduler', failures: 3, suppressed: 2, downMs: 60_000 });
    guard.success('scheduler', 62_000);
    assert.equal(lines.length, 2);
    // A new outage starts from a fresh first line.
    guard.failure('scheduler', 'down again', 70_000);
    assert.deepEqual(lines.at(-1), { event: 'loop_error', loop: 'scheduler', error: 'down again' });
  });

  test('loops are tracked separately', () => {
    const { guard, lines } = make();
    guard.failure('selector', 'gecko', 0);
    guard.failure('sampler', 'rpc', 100);
    guard.failure('selector', 'gecko', 200);
    assert.deepEqual(lines.map((l) => l.loop), ['selector', 'sampler']);
    guard.success('selector', 300);
    assert.deepEqual(lines.at(-1)?.event, 'loop_recovered');
    guard.failure('sampler', 'rpc', 400);
    assert.equal(lines.length, 3);
  });
});

describe('self-watchdog', () => {
  test('stalled once the last completed tick is STALL_AFTER_MS (120 s) old', () => {
    assert.equal(STALL_AFTER_MS, 120_000);
    assert.equal(isStalled(1_000, 1_000), false);
    assert.equal(isStalled(1_000, 1_000 + 119_999), false);
    assert.equal(isStalled(1_000, 1_000 + 120_000), true);
    assert.equal(isStalled(1_000, 1_000 + 600_000), true);
    assert.equal(isStalled(1_000, 5_000, 3_000), true);
    // A clock that went backwards is not a stall.
    assert.equal(isStalled(10_000, 5_000), false);
  });

  test('watchStall reports a stall once, with the idle time, and stops', async () => {
    let now = 0;
    let beat = 0;
    const reports: number[] = [];
    const stop = watchStall({ lastBeatMs: () => beat, now: () => now, checkEveryMs: 5, limitMs: 100, onStall: (idleMs) => reports.push(idleMs) });
    try {
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(reports, []);
      beat = 50;
      now = 120; // 70 ms since the last beat: fine
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(reports, []);
      now = 200; // 150 ms since the last beat: stalled
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(reports, [150]);
      now = 900;
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(reports, [150]);
    } finally {
      stop();
    }
  });
});
