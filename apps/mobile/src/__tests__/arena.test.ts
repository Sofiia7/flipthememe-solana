// Node tests for the arena redesign helpers (no React Native). Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Outcome, RefundReason, RoundStatus, type RoundAccount } from '@flipthememe/client';
import { deltaView, formatAgoShort, poolAgeLabel } from '../lib/format.ts';
import { entryTick, inFlightStage, selectChartRound, selectPanel, strikeState, OVERDUE_SECS } from '../chain/phase.ts';
import { createBoolStore, type KeyValueStorage } from '../lib/boolStore.ts';
import { GLYPHS, GLYPH_H, GLYPH_W, cellsToPath, textCells } from '../lib/pixelFont.ts';
import { EXPRESSIONS, FACE_OPTIONS, GRID, SKINS, faceGrid, faceToBytes, type Face } from '../face/faceModel.ts';

const SOL = 1_000_000_000n;
const POOL_A = 'PooLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const POOL_B = 'PooLBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function round(over: Partial<RoundAccount> & { id: bigint; opensAt: bigint }): { id: bigint; account: RoundAccount } {
  const o = over.opensAt;
  const account: RoundAccount = {
    tokenMint: '11111111111111111111111111111111' as RoundAccount['tokenMint'],
    pool: POOL_A as RoundAccount['pool'],
    cutoffAt: o + 60n,
    strikeStart: o + 90n,
    strikeEnd: o + 100n,
    exitStart: o + 150n,
    exitEnd: o + 160n,
    settleDeadline: o + 760n,
    minStake: SOL / 100n,
    maxStake: SOL / 10n,
    minBank: SOL / 50n,
    maxBank: SOL,
    feeWinBps: 200,
    feeRefundBps: 100,
    rawUp: 0n,
    rawDown: 0n,
    houseAmount: 0n,
    positionCount: 0,
    claimedCount: 0,
    totalPaid: 0n,
    feesSwept: false,
    status: RoundStatus.Open,
    outcome: Outcome.Pending,
    refundReason: RefundReason.None,
    strikePrice: 0n,
    exitPrice: 0n,
    strikeSamples: 0,
    exitSamples: 0,
    bump: 255,
    ...over,
  };
  return { id: account.id, account };
}

test('delta vs strike: sign from integers, arrow and tone', () => {
  const up = deltaView(1_000_000n, 1_004_200n);
  assert.deepEqual(up, { micro: 420_000n, text: '+0.42%', arrow: '▲', tone: 'up' });
  const down = deltaView(1_000_000n, 996_900n);
  assert.equal(down?.text, '-0.31%');
  assert.equal(down?.arrow, '▼');
  assert.equal(down?.tone, 'down');
  const flat = deltaView(5n, 5n);
  assert.equal(flat?.text, '0.00%');
  assert.equal(flat?.tone, 'flat');
  assert.equal(flat?.arrow, '=');
  // A tiny but real move keeps its sign and never prints as zero.
  assert.equal(deltaView(1_000_000_000n, 1_000_000_500n)?.text, '+0.000050%');
  assert.equal(deltaView(null, 5n), null);
  assert.equal(deltaView(5n, undefined), null);
  assert.equal(deltaView(0n, 5n), null);
});

test('pool age label from the pool creation time', () => {
  const now = 1_800_000_000_000;
  assert.equal(poolAgeLabel(now - 12 * 60_000, now), 'pool 12m old');
  assert.equal(poolAgeLabel(now - 45_000, now), 'pool 45s old');
  assert.equal(poolAgeLabel(now - 3 * 3_600_000 - 5, now), 'pool 3h old');
  assert.equal(poolAgeLabel(now - 3 * 86_400_000, now), 'pool 3d old');
  assert.equal(poolAgeLabel(now - 2_000, now), 'pool just opened');
  assert.equal(poolAgeLabel(now + 60_000, now), 'pool just opened'); // clock skew
  assert.equal(poolAgeLabel(null, now), null);
  assert.equal(poolAgeLabel(0, now), null);
  assert.equal(formatAgoShort(119_999), '1m');
  assert.equal(formatAgoShort(-5), '0s');
});

test('main panel: my in-flight round first, then the open round, then the upcoming one', () => {
  const now = 1_000_000;
  const open = round({ id: 12n, opensAt: BigInt(now - 20) });
  const upcoming = round({ id: 13n, opensAt: BigInt(now + 40) });
  // Entry closed 10 s ago: the strike window has not started.
  const fixing = round({ id: 11n, opensAt: BigInt(now - 70) });
  // Strike fixed, measuring.
  const live = round({ id: 10n, opensAt: BigInt(now - 130), status: RoundStatus.Live, strikePrice: 100n });
  // Exit window over, not final yet.
  const settling = round({ id: 9n, opensAt: BigInt(now - 170), status: RoundStatus.Live, strikePrice: 100n });
  // Unsettled long after its exit window: no longer holds the panel.
  const late = round({ id: 8n, opensAt: BigInt(now - 160 - OVERDUE_SECS - 5), status: RoundStatus.Live, strikePrice: 100n });
  const final = round({ id: 7n, opensAt: BigInt(now - 400), status: RoundStatus.Final, outcome: Outcome.Up });

  const p = selectPanel({ nowSec: now, open, upcoming, myUnresolved: [live, fixing, late, final, open] });
  assert.equal(p.kind, 'mine');
  if (p.kind === 'mine') {
    assert.equal(p.round.id, 10n);
    assert.equal(p.stage, 'live');
    assert.deepEqual(p.others.map((r) => r.id), [11n]);
  }
  const s = selectPanel({ nowSec: now, open, upcoming, myUnresolved: [settling, live] });
  assert.equal(s.kind === 'mine' && s.stage, 'settling');
  const f = selectPanel({ nowSec: now, open, upcoming, myUnresolved: [fixing] });
  assert.equal(f.kind === 'mine' && f.stage, 'fixing');

  // A bet in the open round only (entry still open) keeps the open round on the panel.
  assert.equal(selectPanel({ nowSec: now, open, upcoming, myUnresolved: [open] }).kind, 'open');
  assert.equal(selectPanel({ nowSec: now, open, upcoming, myUnresolved: [late] }).kind, 'open');
  assert.equal(selectPanel({ nowSec: now, open: null, upcoming, myUnresolved: [] }).kind, 'upcoming');
  assert.equal(selectPanel({ nowSec: now, open: null, upcoming: null, myUnresolved: [] }).kind, 'empty');

  assert.equal(inFlightStage(live.account, now), 'live');
  assert.equal(inFlightStage(live.account, Number(live.account.exitEnd)), 'settling');
});

test('strike state and the round the chart follows', () => {
  const now = 2_000_000;
  const pause = round({ id: 21n, opensAt: BigInt(now - 70) }); // entry closed 10 s ago: the strike window opens in 20 s
  assert.deepEqual(strikeState(pause.account, now), { kind: 'pending', secondsLeft: 20 });
  assert.deepEqual(strikeState(pause.account, now + 20), { kind: 'fixing' });
  assert.deepEqual(strikeState(pause.account, now + 35), { kind: 'fixing' }); // window over, keeper not posted yet
  const live = round({ id: 20n, opensAt: BigInt(now - 130), status: RoundStatus.Live, strikePrice: 777n });
  assert.deepEqual(strikeState(live.account, now), { kind: 'fixed', strike: 777n });
  const unplayed = round({ id: 19n, opensAt: BigInt(now - 400), status: RoundStatus.Final, outcome: Outcome.NotActivated });
  assert.deepEqual(strikeState(unplayed.account, now), { kind: 'none' });

  const otherPool = round({ id: 22n, opensAt: BigInt(now - 65), pool: POOL_B as RoundAccount['pool'] });
  // My focus round on the charted pool wins, even while its strike is still pending.
  assert.equal(selectChartRound({ pool: POOL_A, focus: pause, inFlight: [live, pause] })?.id, 21n);
  // Spectators: the latest live round, else the latest one fixing its strike.
  assert.equal(selectChartRound({ pool: POOL_A, focus: null, inFlight: [live, pause] })?.id, 20n);
  assert.equal(selectChartRound({ pool: POOL_A, focus: null, inFlight: [pause] })?.id, 21n);
  // My round on another pool is not drawn on this chart.
  assert.equal(selectChartRound({ pool: POOL_A, focus: otherPool, inFlight: [live, otherPool] })?.id, 20n);
  assert.equal(selectChartRound({ pool: null, focus: pause, inFlight: [pause] }), null);
});

test('countdown tick covers the last 5 seconds of entry', () => {
  assert.equal(entryTick(5), 5);
  assert.equal(entryTick(4.2), 5);
  assert.equal(entryTick(5.01), null);
  assert.equal(entryTick(0.4), 1);
  assert.equal(entryTick(0), null);
  assert.equal(entryTick(-1), null);
  assert.equal(entryTick(Number.NaN), null);
});

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string>; gate: () => void } {
  const data = { ...initial };
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return {
    data,
    gate: () => release(),
    getItem: async (key) => {
      await opened;
      return data[key] ?? null;
    },
    setItem: async (key, value) => {
      data[key] = value;
    },
  };
}

test('bool store (sound mute, chatter): default, load, persist, listeners', async () => {
  const empty = memoryStorage();
  const muted = createBoolStore(empty, 'mute', false);
  assert.equal(muted.get(), false);
  assert.equal(muted.isLoaded(), false);
  empty.gate();
  assert.equal(await muted.load(), false);
  assert.equal(muted.isLoaded(), true);
  let calls = 0;
  const off = muted.subscribe(() => calls++);
  muted.toggle();
  assert.equal(muted.get(), true);
  assert.equal(empty.data.mute, '1');
  assert.equal(muted.snapshot(), 3);
  muted.set(true); // no change, no event
  off();
  muted.set(false);
  assert.equal(calls, 1);
  assert.equal(empty.data.mute, '0');

  // A stored value replaces the default once loaded, and the load itself notifies.
  const stored = memoryStorage({ chatter: '0' });
  const chatter = createBoolStore(stored, 'chatter', true);
  let seen = 0;
  chatter.subscribe(() => seen++);
  assert.equal(chatter.snapshot(), 1);
  stored.gate();
  assert.equal(await chatter.load(), false);
  assert.equal(chatter.snapshot(), 2);
  assert.equal(seen, 1);

  // A tap before the stored value arrives wins over it.
  const racing = memoryStorage({ mute: '1' });
  const early = createBoolStore(racing, 'mute', false);
  const loading = early.load();
  early.set(false);
  racing.gate();
  assert.equal(await loading, false);
  assert.equal(racing.data.mute, '0');

  // Broken storage: the default stays and the store still loads.
  const broken = createBoolStore(
    { getItem: () => Promise.reject(new Error('io')), setItem: () => Promise.reject(new Error('io')) },
    'x',
    true,
  );
  assert.equal(await broken.load(), true);
  broken.set(false);
  assert.equal(broken.get(), false);
});

test('pixel font: every glyph is 5 x 7 and paths cover exactly the lit cells', () => {
  for (const [ch, rows] of Object.entries(GLYPHS)) {
    assert.equal(rows.length, GLYPH_H, `${ch} rows`);
    rows.forEach((row) => assert.match(row, /^[.#]{5}$/, `${ch} row`));
  }
  for (const ch of 'YOU WONREKT$FLIPTHEME#0123456789') assert.ok(GLYPHS[ch], ch);
  const { width, height, cells } = textCells('you won');
  assert.equal(width, 7 * (GLYPH_W + 1) - 1);
  assert.equal(height, GLYPH_H);
  let covered = 0;
  for (const m of cellsToPath(cells).matchAll(/h(\d+)/g)) covered += Number(m[1]);
  assert.equal(covered, cells.length);
  assert.equal(textCells('').width, 0);
  assert.deepEqual(textCells('~').cells, []); // unknown characters render as spaces
});

test('expressions change only the mouth area and never the face bytes', () => {
  for (let skin = 0; skin < FACE_OPTIONS.skin; skin++)
    for (let hairStyle = 0; hairStyle < FACE_OPTIONS.hairStyle; hairStyle++)
      for (let accessory = 0; accessory < FACE_OPTIONS.accessory; accessory++)
        for (let mouth = 0; mouth < FACE_OPTIONS.mouth; mouth++) {
          const face: Face = { skin, hairStyle, hairColor: (skin + hairStyle) % FACE_OPTIONS.hairColor, eyes: mouth % FACE_OPTIONS.eyes, accessory, mouth };
          const bytes = Array.from(faceToBytes(face));
          const plain = faceGrid(face);
          const skins = new Set(SKINS[skin]);
          for (const expression of EXPRESSIONS) {
            const grid = faceGrid(face, expression);
            assert.equal(grid.length, GRID * GRID);
            for (let i = 0; i < grid.length; i++) {
              const y = Math.floor(i / GRID);
              if (y < 9 || y > 13) assert.equal(grid[i], plain[i], `${expression} changed row ${y}`);
              if (y >= 14) assert.equal(skins.has(grid[i] ?? ''), false, 'no skin below the chin');
            }
          }
          assert.deepEqual(Array.from(faceToBytes(face)), bytes);
        }
  const face: Face = { skin: 1, hairStyle: 7, hairColor: 0, eyes: 0, accessory: 0, mouth: 1 };
  assert.notDeepEqual(faceGrid(face, 'happy'), faceGrid(face));
  assert.notDeepEqual(faceGrid(face, 'sad'), faceGrid(face, 'happy'));
});

