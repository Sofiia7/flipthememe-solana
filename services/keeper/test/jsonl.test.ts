// The bounded JSON-lines files (shadow.jsonl, rounds.jsonl) and the rounds.jsonl rows.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { Outcome, RefundReason } from '@flipthememe/client';
import { JsonlFile } from '../src/jsonl.ts';
import type { LogFields } from '../src/log.ts';
import { RoundLog, countHumans, roundRow, type RoundRow } from '../src/roundlog.ts';
import { makeRound } from './fake-chain.ts';
import { testAddress } from './pool-fixtures.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempFile = (name = 'log.jsonl'): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ftm-jsonl-'));
  dirs.push(dir);
  return join(dir, name);
};
const lines = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');

describe('JsonlFile', () => {
  test('appends one object per line, creating the folder, and reads them back oldest first (bigint as a string)', () => {
    const path = join(tempFile(), 'nested', 'x.jsonl');
    const file = new JsonlFile(path, 100);
    assert.deepEqual(file.read(), [], 'no file yet');
    file.append({ n: 1, big: 18_446_744_073_709_551_000n });
    file.append({ n: 2 });
    file.append({ n: 3 });
    assert.deepEqual(lines(path), ['{"n":1,"big":"18446744073709551000"}', '{"n":2}', '{"n":3}']);
    assert.deepEqual(file.read().map((r) => r.n), [1, 2, 3]);
    assert.deepEqual(file.read(2).map((r) => r.n), [2, 3]);
  });

  test('past maxLines plus the slack the file is cut to its last maxLines lines, by a rename', () => {
    const path = tempFile();
    const file = new JsonlFile(path, 10, 4);
    for (let n = 1; n <= 14; n++) file.append({ n });
    assert.equal(lines(path).length, 14, 'inside the slack nothing is cut');
    file.append({ n: 15 });
    assert.deepEqual(file.read().map((r) => r.n), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    for (let n = 16; n <= 30; n++) file.append({ n });
    const kept = file.read().map((r) => r.n as number);
    assert.ok(kept.length >= 10 && kept.length <= 14, String(kept.length));
    assert.equal(kept.at(-1), 30);
    assert.deepEqual(readdirNames(path), ['log.jsonl'], 'no temp file is left');
  });

  test('a process that starts on an existing file counts its lines, so the bound holds across restarts', () => {
    const path = tempFile();
    const first = new JsonlFile(path, 10, 0);
    for (let n = 1; n <= 10; n++) first.append({ n });
    const second = new JsonlFile(path, 10, 0);
    second.append({ n: 11 });
    assert.deepEqual(second.read().map((r) => r.n), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test('half a line from a crash is skipped on reading, and the next append starts on a line of its own', () => {
    const path = tempFile();
    writeFileSync(path, '{"n":1}\n{"n":2}\n{"n":3');
    const file = new JsonlFile(path, 100);
    assert.deepEqual(file.read().map((r) => r.n), [1, 2]);
    file.append({ n: 4 });
    assert.deepEqual(file.read().map((r) => r.n), [1, 2, 4]);
    appendFileSync(path, 'not json\n[1,2]\n"text"\n');
    assert.deepEqual(file.read().map((r) => r.n), [1, 2, 4], 'lines that are not objects are skipped');
  });
});

const readdirNames = (path: string): string[] => readdirSync(dirname(path)).sort();

describe('rounds.jsonl rows', () => {
  const POOL = testAddress(1);
  const MINT = testAddress(2);
  const A = testAddress(10);
  const B = testAddress(11);
  const HOUSE = testAddress(12);
  const played = makeRound(42n, 1_800_000_000n, POOL, MINT, {
    status: 2,
    outcome: Outcome.Down,
    refundReason: RefundReason.None,
    strikePrice: 5_000n,
    exitPrice: 4_900n,
    rawUp: 70_000_000n,
    rawDown: 70_000_000n,
    houseAmount: 20_000_000n,
    positionCount: 3,
  });

  test('countHumans: positions that are not the house, and the distinct wallets among them', () => {
    assert.deepEqual(countHumans([{ authority: A, isHouse: false }, { authority: B, isHouse: false }, { authority: HOUSE, isHouse: true }]), { humans: 2, wallets: 2, players: [A, B] });
    assert.deepEqual(countHumans([{ authority: A, isHouse: false }, { authority: A, isHouse: false }]), { humans: 2, wallets: 1, players: [A] });
    assert.deepEqual(countHumans([{ authority: HOUSE, isHouse: true }]), { humans: 0, wallets: 0, players: [] });
    const crowd = Array.from({ length: 60 }, (_, i) => ({ authority: testAddress(200 + i), isHouse: false }));
    const counted = countHumans(crowd);
    assert.deepEqual([counted.humans, counted.wallets, counted.players.length], [60, 60, 50], 'the list is capped, the counts are not');
  });

  test('roundRow: every field as the deck needs it, numbers as strings where they are u64', () => {
    const row = roundRow(played, 'PEPE / SOL', [{ authority: A, isHouse: false }, { authority: B, isHouse: false }, { authority: HOUSE, isHouse: true }], Date.parse('2026-10-07T12:00:00Z'));
    assert.deepEqual(row, {
      id: '42',
      ts: '2026-10-07T12:00:00.000Z',
      opensAt: 1_800_000_000,
      pool: POOL,
      name: 'PEPE / SOL',
      outcome: 'down',
      refundReason: 'none',
      strike: '5000',
      exit: '4900',
      rawUp: '70000000',
      rawDown: '70000000',
      houseAmount: '20000000',
      humans: 2,
      wallets: 2,
      players: [A, B],
      positions: 3,
    });
    const refunded = roundRow({ ...played, outcome: Outcome.Refund, refundReason: RefundReason.Expired }, null, null, 0);
    assert.deepEqual([refunded.outcome, refunded.refundReason, refunded.name, refunded.humans, refunded.wallets, refunded.players], ['refund', 'expired', null, null, null, null]);
    assert.equal(roundRow({ ...played, outcome: Outcome.NotActivated }, null, [], 0).outcome, 'not_activated');
    assert.equal(roundRow({ ...played, refundReason: RefundReason.Unpriceable }, null, [], 0).refundReason, 'unpriceable');
  });

  test('RoundLog writes a round once, also across a restart, and a failing disk is reported once and never thrown', () => {
    const path = tempFile('rounds.jsonl');
    const logs: LogFields[] = [];
    const row = (id: string): RoundRow => ({ ...roundRow(played, null, null, 0), id });
    const first = new RoundLog({ file: new JsonlFile(path, 100), logger: (f) => logs.push(f) });
    assert.equal(first.has(1n), false);
    first.add(row('1'));
    first.add(row('1'));
    first.add(row('2'));
    assert.equal(lines(path).length, 2);
    assert.equal(first.has(1n), true);
    const second = new RoundLog({ file: new JsonlFile(path, 100), logger: (f) => logs.push(f) });
    assert.equal(second.has(2n), true, 'remembered from the file');
    second.add(row('2'));
    assert.equal(lines(path).length, 2);

    const blocker = tempFile('blocker');
    writeFileSync(blocker, 'a file where a folder should be');
    const broken = new RoundLog({ file: new JsonlFile(join(blocker, 'rounds.jsonl'), 100), logger: (f) => logs.push(f) });
    broken.add(row('3'));
    broken.add(row('4'));
    assert.equal(logs.filter((l) => l.event === 'rounds_log_write_failed').length, 1);
    assert.equal(broken.has(3n), false, 'not remembered as written: it is tried again');
  });
});
