// The operator watchdog (scripts/watchdog.ts): which problems it finds in status.json and in the
// attestor's public health, and when it tells Telegram. Pure functions only; nothing here touches the network.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  ACTION_MAX_AGE_MS,
  CLOCK_OFFSET_MAX_MS,
  HOUSE_VAULT_MIN_LAMPORTS,
  KEEPER_MIN_LAMPORTS,
  SIGNED_MIN_RATIO,
  STATUS_MAX_AGE_MS,
  decideNotice,
  evaluate,
  formatNotice,
  notify,
} from '../scripts/watchdog.ts';

const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const SEC = 1000;
const MIN = 60_000;
const SOL = 1_000_000_000n;

/** status.json as the keeper writes it (bigints as strings), healthy. */
const status = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  updatedAt: ago(1 * SEC),
  startedAt: ago(3 * 60 * MIN),
  nextRoundId: '120',
  lastRoundId: '119',
  paused: false,
  lastSuccessfulActionAt: ago(20 * SEC),
  keeperLamports: (3n * SOL).toString(),
  houseVaultAvailable: SOL.toString(),
  chainClockOffsetMs: -1_500,
  ...over,
});
/** GET /v1/attestor, healthy. */
const health = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  attestor: 'AttestorKey',
  oracle: { attestor: 'AttestorKey', required: true, matchesKey: true },
  attests: { attests: 50, signed: 48, compared: 48 },
  ...over,
});
const codes = (problems: { code: string }[]): string[] => problems.map((p) => p.code);

describe('evaluate: status.json', () => {
  test('thresholds: 3 min, 5 min, 0.2 SOL, 0.1 SOL, 3 s', () => {
    assert.equal(STATUS_MAX_AGE_MS, 3 * MIN);
    assert.equal(ACTION_MAX_AGE_MS, 5 * MIN);
    assert.equal(KEEPER_MIN_LAMPORTS, 200_000_000n);
    assert.equal(HOUSE_VAULT_MIN_LAMPORTS, 100_000_000n);
    assert.equal(CLOCK_OFFSET_MAX_MS, 3_000);
    assert.equal(SIGNED_MIN_RATIO, 0.8);
  });

  test('a healthy keeper and a healthy attestor: no problems', () => {
    assert.deepEqual(evaluate(status(), health(), NOW), []);
    assert.deepEqual(evaluate(status(), null, NOW), []);
  });

  test('status.json missing, or without a usable updatedAt', () => {
    assert.deepEqual(codes(evaluate(null, null, NOW)), ['status_missing']);
    assert.deepEqual(codes(evaluate(status({ updatedAt: 'yesterday' }), null, NOW)), ['status_stale']);
    assert.deepEqual(codes(evaluate(status({ updatedAt: undefined }), null, NOW)), ['status_stale']);
    assert.deepEqual(codes(evaluate('not an object', null, NOW)), ['status_missing']);
  });

  test('status.json older than 3 minutes: stale, and nothing else is judged from its old numbers', () => {
    assert.deepEqual(evaluate(status({ updatedAt: ago(STATUS_MAX_AGE_MS - 1) }), null, NOW), []);
    const stale = evaluate(status({ updatedAt: ago(STATUS_MAX_AGE_MS), keeperLamports: '1' }), null, NOW);
    assert.deepEqual(codes(stale), ['status_stale']);
    assert.match(stale[0]?.message ?? '', /3m 0s/);
  });

  test('no successful action for 5 minutes while rounds exist', () => {
    assert.deepEqual(evaluate(status({ lastSuccessfulActionAt: ago(ACTION_MAX_AGE_MS - 1) }), null, NOW), []);
    const late = evaluate(status({ lastSuccessfulActionAt: ago(ACTION_MAX_AGE_MS) }), null, NOW);
    assert.deepEqual(codes(late), ['no_recent_action']);
    assert.match(late[0]?.message ?? '', /5m 0s/);
  });

  test('no action at all since the start counts from startedAt; a keeper that has just started is given its 5 minutes', () => {
    assert.deepEqual(evaluate(status({ lastSuccessfulActionAt: null, startedAt: ago(2 * MIN) }), null, NOW), []);
    assert.deepEqual(codes(evaluate(status({ lastSuccessfulActionAt: null, startedAt: ago(6 * MIN) }), null, NOW)), ['no_recent_action']);
  });

  test('the action check is for a keeper that has rounds to serve: none yet, or paused, is fine', () => {
    const quiet = { lastSuccessfulActionAt: ago(60 * MIN) };
    assert.deepEqual(evaluate(status({ ...quiet, nextRoundId: '0', lastRoundId: null }), null, NOW), []);
    assert.deepEqual(evaluate(status({ ...quiet, nextRoundId: null, lastRoundId: null }), null, NOW), []);
    assert.deepEqual(evaluate(status({ ...quiet, paused: true }), null, NOW), []);
    assert.deepEqual(codes(evaluate(status(quiet), null, NOW)), ['no_recent_action']);
  });

  test('keeper wallet below 0.2 SOL', () => {
    assert.deepEqual(evaluate(status({ keeperLamports: '200000000' }), null, NOW), []);
    const low = evaluate(status({ keeperLamports: '199999999' }), null, NOW);
    assert.deepEqual(codes(low), ['keeper_low_balance']);
    assert.match(low[0]?.message ?? '', /0\.199999999 SOL/);
    // The keeper writes lamports as strings; a plain number is read too.
    assert.deepEqual(codes(evaluate(status({ keeperLamports: 5_000 }), null, NOW)), ['keeper_low_balance']);
    assert.deepEqual(evaluate(status({ keeperLamports: null }), null, NOW), []);
  });

  test('house vault available below 0.1 SOL', () => {
    assert.deepEqual(evaluate(status({ houseVaultAvailable: '100000000' }), null, NOW), []);
    assert.deepEqual(codes(evaluate(status({ houseVaultAvailable: '99999999' }), null, NOW)), ['house_vault_low']);
    assert.deepEqual(evaluate(status({ houseVaultAvailable: null }), null, NOW), []);
  });

  test('devnet clock offset beyond 3 s, either way', () => {
    assert.deepEqual(evaluate(status({ chainClockOffsetMs: -3_000 }), null, NOW), []);
    assert.deepEqual(evaluate(status({ chainClockOffsetMs: 3_000 }), null, NOW), []);
    assert.deepEqual(codes(evaluate(status({ chainClockOffsetMs: -3_001 }), null, NOW)), ['clock_offset']);
    assert.deepEqual(codes(evaluate(status({ chainClockOffsetMs: 4_500 }), null, NOW)), ['clock_offset']);
  });

  test('several problems at once come back together, in a fixed order', () => {
    const found = evaluate(status({ keeperLamports: '1', houseVaultAvailable: '1', chainClockOffsetMs: 9_000, lastSuccessfulActionAt: ago(10 * MIN) }), null, NOW);
    assert.deepEqual(codes(found), ['no_recent_action', 'keeper_low_balance', 'house_vault_low', 'clock_offset']);
  });
});

describe('evaluate: attestor health', () => {
  test('the key the Worker holds is not the one in OracleConfig', () => {
    assert.deepEqual(codes(evaluate(status(), health({ oracle: { attestor: 'Other', required: true, matchesKey: false } }), NOW)), ['attestor_key_mismatch']);
    // null = unknown (no key or no OracleConfig read yet): not a verdict.
    assert.deepEqual(evaluate(status(), health({ oracle: { attestor: 'X', required: true, matchesKey: null } }), NOW), []);
    assert.deepEqual(evaluate(status(), health({ oracle: null }), NOW), []);
  });

  test('from 10 attests on, fewer than 80 percent signed is a problem', () => {
    assert.deepEqual(evaluate(status(), health({ attests: { attests: 9, signed: 0 } }), NOW), []);
    assert.deepEqual(evaluate(status(), health({ attests: { attests: 10, signed: 8 } }), NOW), []);
    const low = evaluate(status(), health({ attests: { attests: 10, signed: 7 } }), NOW);
    assert.deepEqual(codes(low), ['attestor_signing_low']);
    assert.match(low[0]?.message ?? '', /7 of 10/);
    assert.deepEqual(codes(evaluate(status(), health({ attests: { attests: 1000, signed: 100 } }), NOW)), ['attestor_signing_low']);
  });

  test('a health answer of another shape is ignored, not a crash', () => {
    for (const odd of [{}, { oracle: 'x', attests: 'y' }, { attests: { attests: 'ten', signed: 3 } }, [], 'text', 7]) {
      assert.deepEqual(evaluate(status(), odd, NOW), [], JSON.stringify(odd));
    }
  });

  test('attestor problems are found even when status.json is missing or stale', () => {
    const bad = health({ oracle: { attestor: 'Other', required: true, matchesKey: false } });
    assert.deepEqual(codes(evaluate(null, bad, NOW)), ['status_missing', 'attestor_key_mismatch']);
    assert.deepEqual(codes(evaluate(status({ updatedAt: ago(10 * MIN) }), bad, NOW)), ['status_stale', 'attestor_key_mismatch']);
  });
});

describe('Telegram notice: only when the set of problems changed', () => {
  const p = (...cs: string[]) => cs.map((code) => ({ code, message: `${code} happened` }));

  test('first run: speaks only if there is something wrong', () => {
    assert.deepEqual(decideNotice(p('keeper_low_balance'), null), { notify: true, kind: 'problems', key: 'keeper_low_balance' });
    assert.deepEqual(decideNotice([], null), { notify: false, kind: null, key: '' });
  });

  test('the same problems again: silent, whatever the order and whatever the numbers in the text', () => {
    assert.equal(decideNotice(p('a', 'b'), 'a,b').notify, false);
    assert.equal(decideNotice(p('b', 'a'), 'a,b').notify, false);
    assert.equal(decideNotice([{ code: 'a', message: 'now 7m old' }, { code: 'b', message: 'x' }], 'a,b').notify, false);
  });

  test('a changed set (one more, one less, a different one) speaks', () => {
    assert.deepEqual(decideNotice(p('a', 'b'), 'a'), { notify: true, kind: 'problems', key: 'a,b' });
    assert.deepEqual(decideNotice(p('a'), 'a,b'), { notify: true, kind: 'problems', key: 'a' });
    assert.deepEqual(decideNotice(p('c'), 'a'), { notify: true, kind: 'problems', key: 'c' });
  });

  test('everything fine again after problems: one recovery notice, then silence', () => {
    assert.deepEqual(decideNotice([], 'a,b'), { notify: true, kind: 'recovered', key: '' });
    assert.equal(decideNotice([], '').notify, false);
  });

  test('notify remembers the set between runs, in a file, and posts only on a change', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ftm-watchdog-'));
    try {
      const memoryFile = join(dir, 'nested', 'watchdog-state.json');
      const posted: string[] = [];
      const post = async (text: string): Promise<boolean> => {
        posted.push(text);
        return true;
      };
      assert.equal(await notify({ problems: [], memoryFile, post }), 'silent');
      assert.equal(await notify({ problems: p('a'), memoryFile, post }), 'sent');
      assert.equal(await notify({ problems: p('a'), memoryFile, post }), 'silent');
      assert.equal(await notify({ problems: p('a', 'b'), memoryFile, post }), 'sent');
      assert.equal(await notify({ problems: [], memoryFile, post }), 'sent');
      assert.equal(await notify({ problems: [], memoryFile, post }), 'silent');
      assert.equal(posted.length, 3);
      assert.match(posted[0] ?? '', /1 problem\b/);
      assert.match(posted[1] ?? '', /2 problems/);
      assert.match(posted[2] ?? '', /all clear/i);
      assert.equal(JSON.parse(readFileSync(memoryFile, 'utf8')).problems, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a post Telegram did not accept is not remembered: the next run tries again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ftm-watchdog-'));
    try {
      const memoryFile = join(dir, 'watchdog-state.json');
      let accept = false;
      const post = async (): Promise<boolean> => accept;
      assert.equal(await notify({ problems: p('a'), memoryFile, post }), 'failed');
      assert.equal(existsSync(memoryFile), false);
      accept = true;
      assert.equal(await notify({ problems: p('a'), memoryFile, post }), 'sent');
      assert.equal(await notify({ problems: p('a'), memoryFile, post }), 'silent');
      // A memory file that is garbage counts as no earlier run.
      writeFileSync(memoryFile, 'garbage');
      assert.equal(await notify({ problems: p('a'), memoryFile, post }), 'sent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the text lists every problem and never anything but the problems', () => {
    const text = formatNotice(p('keeper_low_balance', 'clock_offset'), 'problems');
    assert.match(text, /2 problems/);
    assert.match(text, /keeper_low_balance: keeper_low_balance happened/);
    assert.match(text, /clock_offset: clock_offset happened/);
    assert.match(formatNotice([], 'recovered'), /all clear/i);
    assert.match(formatNotice(p('a'), 'problems'), /1 problem\b/);
  });
});
