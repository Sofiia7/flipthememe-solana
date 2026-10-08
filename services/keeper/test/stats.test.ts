// scripts/stats.ts: the deck figures from rounds.jsonl and shadow.jsonl.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeRoundStats, computeShadowStats, formatStats, readJsonl } from '../scripts/stats.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const T = 1_800_000_000;
type Over = Record<string, unknown>;
const round = (id: number, over: Over = {}): Over => ({
  id: String(id), ts: '', opensAt: T + id * 60, pool: 'p', name: 'X / SOL', outcome: 'up', refundReason: 'none', strike: '1', exit: '2', rawUp: '1', rawDown: '1', houseAmount: '0',
  humans: 1, wallets: 1, players: ['A'], positions: 2, ...over,
});

describe('computeRoundStats', () => {
  const rows = [
    round(1, { humans: 1, players: ['A'] }), // up, one person
    round(2, { outcome: 'down', humans: 2, wallets: 2, players: ['A', 'B'] }), // down, two people
    round(3, { outcome: 'refund', refundReason: 'tie', humans: 2, wallets: 2, players: ['B', 'C'] }), // tie, two people
    round(4, { outcome: 'refund', refundReason: 'expired', humans: 1, players: ['C'] }), // not priced
    round(5, { outcome: 'not_activated', humans: 1, players: ['D'] }),
    round(6, { outcome: 'up', humans: null, wallets: null, players: null }), // positions gone before the sweep
    round(7, { outcome: 'up', humans: 0, wallets: 0, players: [] }),
  ];

  test('played, people, unique wallets across rounds and the share of UP', () => {
    const s = computeRoundStats(rows);
    assert.deepEqual(
      { ...s, first: undefined, last: undefined },
      {
        recorded: 7,
        played: 5, // up x3, down, tie
        up: 3,
        down: 1,
        tie: 1,
        notPlayed: 2,
        withPeople: 5,
        withTwoPlus: 2,
        playedWithTwoPlus: 2,
        unknownPeople: 1,
        uniqueWallets: 4, // A, B, C, D: the same wallet in several rounds counts once
        upShare: 0.75,
        first: undefined,
        last: undefined,
      },
    );
    assert.equal(s.first, new Date((T + 60) * 1000).toISOString());
    assert.equal(s.last, new Date((T + 7 * 60) * 1000).toISOString());
  });

  test('--days: only rounds that opened since then', () => {
    const s = computeRoundStats(rows, T + 5 * 60);
    assert.deepEqual([s.recorded, s.up, s.notPlayed, s.uniqueWallets], [3, 2, 1, 1]);
  });

  test('an empty or foreign file gives zeros and no share', () => {
    const s = computeRoundStats([{ nothing: true }, round(1, { outcome: 'pending' })]);
    assert.deepEqual([s.recorded, s.played, s.upShare], [2, 0, null]);
    assert.equal(computeRoundStats([]).first, null);
  });
});

describe('computeShadowStats', () => {
  const rows = [
    { opensAt: T, dir: 'up', rung: 'fresh' },
    { opensAt: T + 60, dir: 'up', rung: 'fresh' },
    { opensAt: T + 120, dir: 'down', rung: 'fresh' },
    { opensAt: T + 180, dir: 'tie', rung: 'within-6h' },
    { opensAt: T + 240, dir: 'unpriced', rung: 'within-6h' },
    { opensAt: T + 300, dir: 'down', rung: 'within-6h' },
    { opensAt: T + 360, dir: 'sideways', rung: 'fresh' }, // not a shadow row
    { opensAt: T + 420, dir: 'up' }, // no rung
  ];

  test('counts, the share of UP (ties and unpriced left out) and the split by rung', () => {
    const s = computeShadowStats(rows);
    assert.deepEqual([s.rounds, s.up, s.down, s.tie, s.unpriced, s.upShare], [7, 3, 2, 1, 1, 0.6]);
    assert.deepEqual(s.byRung.fresh, { rounds: 3, up: 2, down: 1, upShare: 0.667 });
    assert.deepEqual(s.byRung['within-6h'], { rounds: 3, up: 0, down: 1, upShare: 0 });
    assert.deepEqual(s.byRung.unknown, { rounds: 1, up: 1, down: 0, upShare: 1 });
    assert.equal(computeShadowStats(rows, T + 300).rounds, 2);
  });
});

describe('the script', () => {
  test('readJsonl skips a half line and what is not an object; a missing file is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ftm-stats-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'x.jsonl'), '{"a":1}\n[1]\nnot json\n{"b":2}\n{"c"');
    assert.deepEqual(readJsonl(join(dir, 'x.jsonl')), [{ a: 1 }, { b: 2 }]);
    assert.deepEqual(readJsonl(join(dir, 'missing.jsonl')), []);
  });

  test('prints the figures for a folder, as text and as JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ftm-stats-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'rounds.jsonl'), `${[round(1), round(2, { outcome: 'down', humans: 2, wallets: 2, players: ['A', 'B'] })].map((r) => JSON.stringify(r)).join('\n')}\n`);
    writeFileSync(join(dir, 'shadow.jsonl'), `${JSON.stringify({ opensAt: T, dir: 'up', rung: 'fresh' })}\n`);
    const script = fileURLToPath(new URL('../scripts/stats.ts', import.meta.url));
    const text = execFileSync(process.execPath, [script, '--dir', dir], { encoding: 'utf8' });
    assert.match(text, /rounds\.jsonl: 2 swept rounds/);
    assert.match(text, /played \(priced, up\/down\/tie\):\s+2/);
    assert.match(text, /with 2\+ people:\s+1/);
    assert.match(text, /unique wallets:\s+2/);
    assert.match(text, /share of UP among played:\s+50\.0%/);
    assert.match(text, /shadow\.jsonl: 1 rounds/);
    const json = JSON.parse(execFileSync(process.execPath, [script, '--dir', dir, '--json'], { encoding: 'utf8' })) as { rounds: { uniqueWallets: number }; shadow: { upShare: number } };
    assert.equal(json.rounds.uniqueWallets, 2);
    assert.equal(json.shadow.upShare, 1);
    assert.match(formatStats(computeRoundStats([]), computeShadowStats([]), dir), /No data yet/);
  });

  test('a bad argument is an error with exit code 2', () => {
    const script = fileURLToPath(new URL('../scripts/stats.ts', import.meta.url));
    assert.throws(() => execFileSync(process.execPath, [script, '--days', 'soon'], { encoding: 'utf8', stdio: 'pipe' }), (e: { status?: number }) => e.status === 2);
  });
});


test('candidate observation does not inflate selected-market statistics', () => {
  const stats = computeShadowStats([{ opensAt: 100, dir: 'up', rung: 'fresh' }, { opensAt: 100, dir: 'down', rung: 'fresh', observedOnly: true }]);
  assert.equal(stats.rounds, 1);
  assert.equal(stats.down, 0);
  assert.equal(stats.upShare, 1);
});
