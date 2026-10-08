// Shadow rounds: the outcome of the round that would open at every minute boundary, computed from the
// observations with the same window function the real rounds use, written to the log and shadow.jsonl.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { roundTimes, windowMean, type PriceObservation } from '@flipthememe/client';
import { JsonlFile } from '../src/jsonl.ts';
import type { LogFields } from '../src/log.ts';
import { ObservationStore, windowSamples } from '../src/observations.ts';
import { ShadowBook, directionalBias, marketReadiness, parseShadowRow, summarize, upShare, type ShadowPool, type ShadowRow } from '../src/shadow.ts';
import { testAddress } from './pool-fixtures.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const POOL = testAddress(1);
const OTHER = testAddress(2);
const current = (pool = POOL, name = 'TEST / SOL'): ShadowPool => ({ pool, baseMint: testAddress(1001), name, rung: 'fresh' });
/** A minute boundary, unix seconds. */
const B = 1_800_000_000;
const ms = (secs: number): number => secs * 1000;
test('observed momentum veto is symmetric, needs ten priced minutes, excludes old, future and other-pool rows', () => {
  const now = ms(B);
  const rows = (up: number, down: number) => Array.from({ length: up + down }, (_, i) => ({ pool: POOL, opensAt: B - (i + 1) * 60, dir: i < up ? 'up' as const : 'down' as const }));
  assert.match(directionalBias(rows(8, 2), POOL, now)!, /8 UP \/ 2 DOWN/);
  assert.match(directionalBias(rows(2, 8), POOL, now)!, /2 UP \/ 8 DOWN/);
  assert.equal(directionalBias(rows(6, 4), POOL, now), null);
  assert.equal(directionalBias(rows(4, 6), POOL, now), null);
  assert.equal(directionalBias(rows(5, 5), POOL, now), null);
  assert.match(marketReadiness(rows(4, 5), POOL, now)!, /9\/10/);
  assert.equal(marketReadiness(rows(5, 5), POOL, now), null);
  assert.match(marketReadiness(rows(8, 2), POOL, now)!, /observed momentum/);
  assert.match(marketReadiness(rows(5, 5), OTHER, now)!, /0\/10/);
  assert.equal(directionalBias(rows(9, 0), POOL, now), null);
  assert.equal(directionalBias(rows(10, 0), OTHER, now), null);
  assert.equal(directionalBias(rows(10, 0), POOL, now + 40 * 60_000), null);
  assert.equal(directionalBias(rows(10, 0), POOL, now - 40 * 60_000), null);
});
let slotCounter = 1_000n;

function obs(atSecs: number, price: bigint, slot: bigint = ++slotCounter): PriceObservation {
  return { atMs: ms(atSecs), slot, baseAmount: 1_000_000_000_000n, quoteAmount: 400_000_000_000n, price };
}

/** `count` observations, one every `step` seconds from `from`, at the given prices (cycled). */
function series(store: ObservationStore, pool: string, from: number, count: number, prices: bigint[], step = 1): void {
  for (let k = 0; k < count; k++) store.add(pool, obs(from + k * step, prices[k % prices.length] ?? 1n));
}

/**
 * One price level per window slot, the way the market is read: the strike window of the round that opens at B + 60 m and the
 * exit window of the round that opened a minute earlier are the same seconds (30 to 40 of a minute), so level j is the price in
 * [B + 30 + 60 j, B + 40 + 60 j). Round m strikes at level m + 1 and exits at level m + 2.
 */
function levels(store: ObservationStore, pool: string, values: bigint[]): void {
  values.forEach((value, j) => {
    for (let k = 0; k < 10; k++) store.add(pool, obs(B + 30 + 60 * j + k, value));
  });
}

function setup(file: JsonlFile | null = null) {
  const store = new ObservationStore();
  const logs: LogFields[] = [];
  const book = new ShadowBook({ store, logger: (f) => logs.push(f), file });
  const rows = () => logs.filter((l) => l.event === 'shadow_round');
  return { store, logs, book, rows };
}

/** Runs the book second by second over [fromSecs, toSecs] with `pool` as the selector's current pool. */
function run(book: ShadowBook, fromSecs: number, toSecs: number, pool: ShadowPool | null = current()): void {
  for (let t = fromSecs; t <= toSecs; t++) book.tick(ms(t), pool);
}

describe('ShadowBook: one hypothetical round per minute boundary', () => {
  test('up: the exit mean above the strike mean; the line carries both means, the sample counts, the pool and the rung', () => {
    const { store, book, rows } = setup();
    const t = roundTimes(BigInt(B));
    series(store, POOL, Number(t.strikeStart), 10, [1000n, 1002n]); // mean 1001
    series(store, POOL, Number(t.exitStart), 10, [1100n, 1102n]); // mean 1101
    run(book, B - 20, B + 162);
    const [row] = rows();
    assert.equal(rows().length, 1);
    assert.equal(row?.opensAt, B);
    assert.equal(row?.dir, 'up');
    assert.equal(row?.strikeMean, '1001');
    assert.equal(row?.exitMean, '1101');
    assert.deepEqual([row?.strikeSamples, row?.exitSamples], [10, 10]);
    assert.deepEqual([row?.pool, row?.mint, row?.name, row?.rung], [POOL, testAddress(1001), 'TEST / SOL', 'fresh']);
    assert.equal(typeof row?.ts, 'string');
  });

  test('down, tie (equal whole-number means) and unpriced (fewer than 5 observations in a window)', () => {
    const down = setup();
    series(down.store, POOL, B + 90, 8, [1000n]);
    series(down.store, POOL, B + 150, 8, [999n]);
    run(down.book, B - 20, B + 165);
    assert.equal(down.rows()[0]?.dir, 'down');

    const tie = setup();
    series(tie.store, POOL, B + 90, 6, [1000n, 1001n]); // 1000.5 -> 1000
    series(tie.store, POOL, B + 150, 6, [1000n]);
    run(tie.book, B - 20, B + 165);
    assert.equal(tie.rows()[0]?.strikeMean, '1000');
    assert.equal(tie.rows()[0]?.dir, 'tie');

    const fewExit = setup();
    series(fewExit.store, POOL, B + 90, 8, [1000n]);
    series(fewExit.store, POOL, B + 150, 4, [1200n]); // the program would refund this round as unpriceable
    run(fewExit.book, B - 20, B + 165);
    const row = fewExit.rows()[0];
    assert.equal(row?.dir, 'unpriced');
    assert.deepEqual([row?.strikeMean, row?.exitMean, row?.strikeSamples, row?.exitSamples], ['1000', null, 8, 0]);

    const none = setup();
    run(none.book, B - 20, B + 165);
    assert.deepEqual([none.rows()[0]?.dir, none.rows()[0]?.strikeMean, none.rows()[0]?.exitMean], ['unpriced', null, null]);
  });

  test('the same window function as the real rounds: one sample per slot, at most 16, zero prices dropped, the window is [start, end)', () => {
    const { store, book, rows } = setup();
    // 24 observations in the strike window, two of them with a repeated slot and two with a zero price: windowMean keeps
    // the first per slot, drops the zero prices and takes the 16 lowest slots.
    for (let k = 0; k < 24; k++) store.add(POOL, obs(B + 90 + k * 0.4, BigInt(1000 + k), BigInt(5_000 + (k === 7 ? 6 : k))));
    store.add(POOL, obs(B + 91, 0n));
    store.add(POOL, obs(B + 92, 0n));
    store.add(POOL, obs(B + 100, 9_999_999n)); // exactly at strike_end: outside the window
    series(store, POOL, B + 150, 6, [1500n]);
    run(book, B - 20, B + 165);
    const row = rows()[0];
    const t = roundTimes(BigInt(B));
    const reference = windowMean(store.get(POOL), Number(t.strikeStart) * 1000, Number(t.strikeEnd) * 1000);
    assert.ok(reference);
    assert.equal(row?.strikeMean, reference.price.toString());
    assert.equal(row?.strikeSamples, reference.samples.length);
    assert.equal(row?.strikeSamples, 16);
    // The count the scheduler would send to set_strike is the same.
    assert.equal(windowSamples(store.get(POOL), t.strikeStart, t.strikeEnd).length, 16);
  });

  test('every minute boundary gets its round, once, even when nobody bets: 6 minutes, 6 rows, in order', () => {
    const { store, book, rows } = setup();
    levels(store, POOL, [1n, 1000n, 1010n, 1005n, 1020n, 1000n, 1000n, 1030n]);
    run(book, B - 20, B + 60 * 5 + 165);
    run(book, B + 60 * 5 + 165, B + 60 * 5 + 165); // a tick that repeats changes nothing
    const lines = rows();
    assert.deepEqual(lines.map((l) => l.opensAt), [B, B + 60, B + 120, B + 180, B + 240, B + 300]);
    assert.deepEqual(lines.map((l) => l.dir), ['up', 'down', 'up', 'down', 'tie', 'up']);
    assert.equal(new Set(lines.map((l) => l.opensAt)).size, lines.length, 'no boundary twice');
  });

  test('a round is evaluated only after its exit window closed (opens_at + 160 s, plus the 1 s the keeper waits)', () => {
    const { store, book, rows } = setup();
    series(store, POOL, B + 90, 8, [1000n]);
    series(store, POOL, B + 150, 8, [1100n]);
    run(book, B - 20, B + 160);
    assert.equal(rows().length, 0, 'at exit_end: not yet');
    book.tick(ms(B + 161) - 1, current());
    assert.equal(rows().length, 0);
    book.tick(ms(B + 161), current());
    assert.equal(rows().length, 1);
  });

  test('no pool selected at the boundary: no round; a dropped pool stays read until its round is evaluated', () => {
    const none = setup();
    run(none.book, B - 20, B + 165, null);
    assert.equal(none.rows().length, 0);
    assert.deepEqual(none.book.pendingPools(), []);

    const { store, book, rows } = setup();
    series(store, POOL, B + 90, 8, [1000n]);
    series(store, POOL, B + 150, 8, [1100n]);
    run(book, B - 20, B - 1, current(POOL)); // noted at B - 15 s
    run(book, B, B + 30, current(OTHER)); // the selector moved on; the noted pool is not forgotten
    assert.deepEqual(book.pendingPools(), [POOL]);
    run(book, B + 31, B + 165, current(OTHER));
    assert.equal(rows().filter((l) => l.opensAt === B)[0]?.pool, POOL);
    assert.equal(rows().filter((l) => l.opensAt === B)[0]?.dir, 'up');
    assert.deepEqual(book.pendingPools().filter((p) => p === POOL), []);
  });
});

describe('ShadowBook: the aggregate and the file', () => {
  const row = (opensAt: number, dir: ShadowRow['dir']): ShadowRow => ({
    ts: '', opensAt, pool: 'p', mint: 'm', name: 'n', rung: 'fresh', strikeMean: null, exitMean: null, strikeSamples: 0, exitSamples: 0, dir,
  });

  test('summarize: up, down, tie, unpriced and the share of UP among the rounds that had a direction, over the last 200 minutes', () => {
    const now = ms(B + 100 * 60);
    const rows = [
      row(B + 100 * 60 - 60, 'up'),
      row(B + 100 * 60 - 120, 'up'),
      row(B + 100 * 60 - 180, 'up'),
      row(B + 100 * 60 - 240, 'down'),
      row(B + 100 * 60 - 300, 'tie'),
      row(B + 100 * 60 - 360, 'unpriced'),
      row(B + 100 * 60 - 201 * 60, 'down'), // older than 200 minutes: out
    ];
    assert.deepEqual(summarize(rows, now), { windowMinutes: 200, rounds: 6, up: 3, down: 1, tie: 1, unpriced: 1, upShare: 0.75 });
    assert.deepEqual(summarize([], now), { windowMinutes: 200, rounds: 0, up: 0, down: 0, tie: 0, unpriced: 0, upShare: null });
    assert.equal(upShare(1, 2), 0.333);
    assert.equal(upShare(0, 0), null);
    assert.equal(upShare(5, 0), 1);
  });

  test('rows go to shadow.jsonl, one JSON object per line, and the book reads the last 200 minutes back after a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ftm-shadow-'));
    dirs.push(dir);
    const path = join(dir, 'shadow.jsonl');
    const first = setup(new JsonlFile(path, 1000));
    levels(first.store, POOL, [1n, 1000n, 1100n, 900n, 1200n]);
    run(first.book, B - 20, B + 60 * 2 + 165);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    const parsed = lines.map((l) => JSON.parse(l) as ShadowRow);
    assert.deepEqual(parsed.map((r) => r.dir), ['up', 'down', 'up']);
    assert.equal(parsed[0]?.strikeMean, '1000');
    assert.equal(parseShadowRow(parsed[0] as unknown as Record<string, unknown>)?.exitMean, '1100');
    assert.equal(parsed[1]?.strikeMean, '1100');

    const now = ms(B + 60 * 2 + 170);
    const second = setup(new JsonlFile(path, 1000));
    second.book.restore(now);
    assert.deepEqual(second.book.summary(now), { windowMinutes: 200, rounds: 3, up: 2, down: 1, tie: 0, unpriced: 0, upShare: 0.667 });
    assert.deepEqual(second.logs.map((l) => [l.event, l.rounds]), [['shadow_restored', 3]]);
    // A day later nothing of it counts.
    const third = setup(new JsonlFile(path, 1000));
    third.book.restore(ms(B + 86_400));
    assert.equal(third.book.summary(ms(B + 86_400)).rounds, 0);
  });

  test('the file is bounded: past maxLines (plus its slack) it is cut to the last maxLines rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ftm-shadow-'));
    dirs.push(dir);
    const path = join(dir, 'shadow.jsonl');
    const { store, book } = setup(new JsonlFile(path, 20, 5));
    for (let m = 0; m < 40; m++) {
      series(store, POOL, B + 60 * m + 90, 6, [1000n]);
      series(store, POOL, B + 60 * m + 150, 6, [1001n]);
    }
    run(book, B - 20, B + 60 * 39 + 165);
    const rows = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ShadowRow);
    assert.ok(rows.length >= 20 && rows.length <= 25, String(rows.length));
    assert.equal(rows.at(-1)?.opensAt, B + 60 * 39, 'the newest rows are the ones kept');
    assert.ok((rows[0]?.opensAt ?? 0) > B + 60 * 10);
  });

  test('a file that cannot be written is reported once and the book carries on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ftm-shadow-'));
    dirs.push(dir);
    const failing = new JsonlFile(join(dir, 'file-not-dir', 'x', 'shadow.jsonl'), 100);
    // Make the parent a file, so mkdir fails.
    new JsonlFile(join(dir, 'file-not-dir'), 100).append({ a: 1 });
    const { store, book, logs } = setup(failing);
    for (let m = 0; m < 3; m++) {
      series(store, POOL, B + 60 * m + 90, 6, [1000n]);
      series(store, POOL, B + 60 * m + 150, 6, [1001n]);
    }
    run(book, B - 20, B + 60 * 2 + 165);
    assert.equal(logs.filter((l) => l.event === 'shadow_round').length, 3);
    assert.equal(logs.filter((l) => l.event === 'shadow_write_failed').length, 1);
    assert.equal(book.summary(ms(B + 60 * 2 + 170)).rounds, 3, 'the aggregate does not depend on the file');
  });

  test('parseShadowRow refuses what is not a row', () => {
    assert.equal(parseShadowRow({}), null);
    assert.equal(parseShadowRow({ opensAt: 1, dir: 'sideways', strikeSamples: 0, exitSamples: 0, strikeMean: null, exitMean: null }), null);
    assert.equal(parseShadowRow({ opensAt: -1, dir: 'up', strikeSamples: 0, exitSamples: 0, strikeMean: null, exitMean: null }), null);
    assert.equal(parseShadowRow({ opensAt: 1, dir: 'up', strikeSamples: 0, exitSamples: 0, strikeMean: 12, exitMean: null }), null, 'a mean is a decimal string');
    assert.ok(parseShadowRow({ opensAt: 1, dir: 'unpriced', strikeSamples: 0, exitSamples: 0, strikeMean: null, exitMean: null }));
  });
});


test('parallel candidates are measured without double-counting the current pool or inflating arena statistics', () => {
  const { store, book, rows } = setup();
  levels(store, POOL, [1n, 1000n, 1100n]);
  levels(store, OTHER, [1n, 1000n, 900n]);
  for (let t = B - 20; t <= B + 165; t++) book.tick(ms(t), current(), [current(), current(OTHER)]);
  const first = rows().filter(r => r.opensAt === B);
  assert.equal(first.length, 2);
  assert.equal(first.find(r => r.pool === OTHER)?.observedOnly, true);
  assert.equal(first.find(r => r.pool === POOL)?.observedOnly, undefined);
  assert.equal(book.summary(ms(B + 165)).rounds, 1);
  assert.match(book.readiness(OTHER, ms(B + 165))!, /1\/10/);
  const candidate = first.find(r => r.pool === OTHER)!;
  assert.equal(parseShadowRow(candidate)?.observedOnly, true);
});
