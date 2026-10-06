// The observation store survives a restart: the last 15 minutes are written next to the state file
// (bigints as strings, atomically, at most every 5 s) and read back at start, minus anything stale
// or malformed. A restart inside a strike or exit window then no longer loses the window's samples.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { PriceObservation } from '@flipthememe/client';
import { loadConfig } from '../src/config.ts';
import type { LogFields } from '../src/log.ts';
import { ObservationPersister, ObservationStore, PERSIST_EVERY_MS, RETAIN_MS, parseObservations, windowSamples } from '../src/observations.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ftm-observations-'));
  dirs.push(dir);
  return dir;
};

const NOW = 1_800_000_000_000;
const BIG = 18_446_744_073_709_551_000n; // above Number.MAX_SAFE_INTEGER: must not pass through a JS number
const obs = (ageMs: number, slot: bigint, price: bigint = 1_000n): PriceObservation => ({
  atMs: NOW - ageMs,
  slot,
  baseAmount: 1_000_000_000_000n,
  quoteAmount: 400_000_000_000n,
  price,
});

function setup(everyMs?: number): { dir: string; path: string; store: ObservationStore; persister: ObservationPersister; logs: LogFields[] } {
  const dir = tempDir();
  const path = join(dir, 'observations.json');
  const store = new ObservationStore();
  const logs: LogFields[] = [];
  return { dir, path, store, persister: new ObservationPersister({ store, path, logger: (f) => logs.push(f), everyMs }), logs };
}

describe('observation persistence', () => {
  test('round trip: pools, order and bigint slots and prices come back exactly; the file holds strings', () => {
    const a = setup();
    a.store.add('poolA', obs(5_000, 300_000_001n, BIG));
    a.store.add('poolA', obs(4_000, 300_000_002n, BIG + 1n));
    a.store.add('poolB', obs(3_000, BIG, 7n));
    a.persister.saveNow(NOW);

    const raw = JSON.parse(readFileSync(a.path, 'utf8')) as { version: number; pools: Record<string, unknown[][]> };
    assert.equal(raw.version, 1);
    // [atMs, slot, baseAmount, quoteAmount, price]: only atMs is a number.
    assert.deepEqual(raw.pools.poolA?.[0], [NOW - 5_000, '300000001', '1000000000000', '400000000000', BIG.toString()]);
    assert.deepEqual(raw.pools.poolB?.[0]?.map((v) => typeof v), ['number', 'string', 'string', 'string', 'string']);

    const b = new ObservationStore();
    const restored = new ObservationPersister({ store: b, path: a.path, logger: () => {} });
    restored.restore(NOW);
    assert.deepEqual(b.pools().sort(), ['poolA', 'poolB']);
    assert.deepEqual(b.get('poolA'), a.store.get('poolA'));
    assert.deepEqual(b.get('poolB'), a.store.get('poolB'));
    assert.equal(b.latest('poolA')?.price, BIG + 1n);
  });

  test('a restored window gives the same samples as before the restart', () => {
    const T = Math.floor(NOW / 1000) - 60; // a window that ended a minute ago
    const a = setup();
    for (let k = 0; k < 8; k++) a.store.add('pool', { atMs: T * 1000 + k * 800, slot: 1_000n + BigInt(k), baseAmount: 1n, quoteAmount: 1n, price: 2_000n + BigInt(k) });
    const before = windowSamples(a.store.get('pool'), BigInt(T), BigInt(T + 10));
    assert.equal(before.length, 8);
    a.persister.saveNow(NOW);
    const b = new ObservationStore();
    new ObservationPersister({ store: b, path: a.path, logger: () => {} }).restore(NOW);
    assert.deepEqual(windowSamples(b.get('pool'), BigInt(T), BigInt(T + 10)), before);
  });

  test('observations older than 15 minutes are dropped at load (and a pool left empty with them)', () => {
    const a = setup();
    // The store itself keeps whatever it was given until pruned; the file must not carry it on.
    a.store.add('fresh', obs(60_000, 1n));
    a.store.add('fresh', obs(RETAIN_MS - 1, 2n));
    a.store.add('old', obs(RETAIN_MS + 1, 3n));
    a.persister.saveNow(NOW);
    const onDisk = JSON.parse(readFileSync(a.path, 'utf8')) as { pools: Record<string, unknown[]> };
    assert.deepEqual(Object.keys(onDisk.pools), ['fresh']);

    // Restart 10 minutes later: the older of the two is stale by then.
    const later = NOW + 10 * 60_000;
    const b = new ObservationStore();
    const logs: LogFields[] = [];
    new ObservationPersister({ store: b, path: a.path, logger: (f) => logs.push(f) }).restore(later);
    assert.deepEqual(b.get('fresh').map((o) => o.slot), [1n]);
    assert.deepEqual(b.pools(), ['fresh']);
    assert.deepEqual(logs, [{ event: 'observations_restored', pools: 1, observations: 1, dropped: 1 }]);
  });

  test('a file written by a keeper with a clock far ahead is not trusted: future observations are dropped', () => {
    const parsed = parseObservations({ version: 1, pools: { p: [[NOW + 60_000, '1', '1', '1', '5'], [NOW - 1_000, '2', '1', '1', '5']] } }, NOW);
    assert.deepEqual(parsed.pools.get('p')?.map((o) => o.slot), [2n]);
    assert.equal(parsed.dropped, 1);
  });

  test('a corrupt file is ignored: the store starts empty, one line says why, nothing throws', () => {
    for (const body of ['', '{not json', 'null', '[]', '{"version":2,"pools":{}}', '{"version":1}', '{"version":1,"pools":[]}', '\u0000\u0000']) {
      const a = setup();
      writeFileSync(a.path, body);
      a.persister.restore(NOW);
      assert.deepEqual(a.store.pools(), [], body);
      assert.deepEqual(a.logs.map((l) => l.event), ['observations_restore_failed'], body);
    }
  });

  test('a missing file is the normal first start: no line, empty store', () => {
    const a = setup();
    a.persister.restore(NOW);
    assert.deepEqual(a.store.pools(), []);
    assert.deepEqual(a.logs, []);
  });

  test('malformed entries are dropped one by one, the good ones stay', () => {
    const good = [NOW - 5_000, '10', '1', '1', '99'];
    const parsed = parseObservations(
      {
        version: 1,
        pools: {
          p: [
            good,
            [NOW - 5_000, 11, '1', '1', '99'], // slot as a number: precision is lost on the way in, so no
            [NOW - 5_000, '12', '1', '1', 99], // price as a number
            [NOW - 5_000, '13', '1', '1'], // too short
            [NOW - 5_000, '14', '1', '1', '99', 'extra'],
            ['x', '15', '1', '1', '99'], // atMs not a number
            [Number.NaN, '16', '1', '1', '99'],
            [NOW - 5_000, '-17', '1', '1', '99'],
            [NOW - 5_000, '1e3', '1', '1', '99'],
            [NOW - 5_000, '18', '1', '1', '9'.repeat(40)], // bigger than any u64
            { atMs: NOW, slot: '19' },
            null,
            'text',
          ],
          q: 'not a list',
          r: [[NOW - 4_000, '20', '1', '1', '98']],
        },
      },
      NOW,
    );
    assert.deepEqual(parsed.pools.get('p')?.map((o) => o.slot), [10n]);
    assert.deepEqual(parsed.pools.get('r')?.map((o) => o.slot), [20n]);
    assert.equal(parsed.pools.has('q'), false);
    assert.equal(parsed.kept, 2);
    assert.equal(parsed.dropped, 12);
  });

  test('entries come back in time order even if the file lists them differently', () => {
    const parsed = parseObservations({ version: 1, pools: { p: [[NOW - 1_000, '3', '1', '1', '5'], [NOW - 3_000, '1', '1', '1', '5'], [NOW - 2_000, '2', '1', '1', '5']] } }, NOW);
    assert.deepEqual(parsed.pools.get('p')?.map((o) => o.slot), [1n, 2n, 3n]);
  });

  test('a file far beyond what 15 minutes of sampling can produce is not read', () => {
    const a = setup();
    writeFileSync(a.path, `{"version":1,"pools":{"p":[${'[1,"1","1","1","1"],'.repeat(400_000)}[1,"1","1","1","1"]]}}`);
    a.persister.restore(NOW);
    assert.deepEqual(a.store.pools(), []);
    assert.deepEqual(a.logs.map((l) => l.event), ['observations_restore_failed']);
  });
});

describe('ObservationPersister writes', () => {
  test('at most one write per PERSIST_EVERY_MS (5 s), and only when something new arrived', () => {
    assert.equal(PERSIST_EVERY_MS, 5_000);
    const a = setup();
    assert.equal(a.persister.maybeSave(NOW), false); // nothing yet: no file
    assert.equal(existsSync(a.path), false);

    a.store.add('p', obs(1_000, 1n));
    assert.equal(a.persister.maybeSave(NOW), true);
    a.store.add('p', obs(500, 2n));
    assert.equal(a.persister.maybeSave(NOW + 4_999), false); // too soon
    assert.equal(JSON.parse(readFileSync(a.path, 'utf8')).pools.p.length, 1);
    assert.equal(a.persister.maybeSave(NOW + 5_000), true);
    assert.equal(JSON.parse(readFileSync(a.path, 'utf8')).pools.p.length, 2);
    assert.equal(a.persister.maybeSave(NOW + 20_000), false); // nothing new since the last write
  });

  test('a restored store is not rewritten until a new observation arrives', () => {
    const a = setup();
    a.store.add('p', obs(1_000, 1n));
    a.persister.saveNow(NOW);
    const b = new ObservationStore();
    const persister = new ObservationPersister({ store: b, path: a.path, logger: () => {} });
    persister.restore(NOW);
    assert.equal(persister.maybeSave(NOW + 60_000), false);
    b.add('p', obs(-60_000, 2n));
    assert.equal(persister.maybeSave(NOW + 60_000), true);
  });

  test('the write is atomic: a temp file, then a rename; no temp file is left and the folder is created', () => {
    const dir = tempDir();
    const path = join(dir, 'nested', 'observations.json');
    const store = new ObservationStore();
    store.add('p', obs(1_000, 1n));
    new ObservationPersister({ store, path, logger: () => {} }).saveNow(NOW);
    assert.deepEqual(readdirSync(join(dir, 'nested')), ['observations.json']);
    assert.ok(JSON.parse(readFileSync(path, 'utf8')).pools.p);
  });

  test('saveNow (graceful shutdown) writes even inside the 5 s window, and skips an unchanged store', () => {
    const a = setup();
    a.store.add('p', obs(1_000, 1n));
    assert.equal(a.persister.maybeSave(NOW), true);
    a.store.add('p', obs(0, 2n));
    assert.equal(a.persister.saveNow(NOW + 100), true);
    assert.equal(JSON.parse(readFileSync(a.path, 'utf8')).pools.p.length, 2);
    assert.equal(a.persister.saveNow(NOW + 200), false);
  });

  test('the file lives next to STATE_FILE (so in the Docker data volume): observations.json', () => {
    const dir = tempDir();
    const cfg = loadConfig({ STATE_FILE: join(dir, 'state.json') }, dir);
    assert.equal(cfg.observationsFile, join(dir, 'observations.json'));
  });
});
