// Node tests for the pure helpers (no React Native). Run from the repo root:
//   node --test apps/mobile/src/__tests__/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Outcome, RefundReason, RoundStatus, Side, TransactionFailed, type RoundAccount } from '@flipthememe/client';
import {
  changeMicroPct,
  formatCountdown,
  formatMicroPct,
  formatSol,
  parseRoundLink,
  shortAddress,
} from '../lib/format.ts';
import {
  ART_LAYERS,
  FACE_OPTIONS,
  GRID,
  SKINS,
  faceFromBytes,
  faceGrid,
  faceToBytes,
  gridToPaths,
  houseGrid,
  type Face,
} from '../face/faceModel.ts';
import { classifyRounds, fitsDepth, positionResult, roundResultLabel, selectTimer, standingNow } from '../chain/phase.ts';
import { customErrorCode, humanError, programError } from '../lib/errors.ts';

const SOL = 1_000_000_000n;

test('formatSol is exact and truncates', () => {
  assert.equal(formatSol(SOL / 100n), '0.01');
  assert.equal(formatSol((SOL * 98n) / 1000n), '0.098');
  assert.equal(formatSol((SOL * 495n) / 10_000n), '0.0495');
  assert.equal(formatSol(SOL + SOL / 2n), '1.50');
  assert.equal(formatSol(0n), '0.00');
  assert.equal(formatSol(1n), '0.00'); // dust truncates, never rounds up
  assert.equal(formatSol(1n, { maxDecimals: 9 }), '0.000000001');
  assert.equal(formatSol(-(SOL / 20n), { sign: true }), '-0.05');
  assert.equal(formatSol(SOL / 20n, { sign: true }), '+0.05');
  assert.equal(formatSol(123_456_789_000n), '123.4567');
});

test('percent change compares integers', () => {
  assert.equal(changeMicroPct(1_000_000n, 1_001_200n), 120_000n); // +0.12%
  assert.equal(formatMicroPct(changeMicroPct(1_000_000n, 1_001_200n)), '+0.12%');
  assert.equal(formatMicroPct(changeMicroPct(1_000_000n, 985_000n)), '-1.50%');
  assert.equal(formatMicroPct(changeMicroPct(1_000_000_000n, 1_000_030_000n)), '+0.003%');
  assert.equal(formatMicroPct(changeMicroPct(1_000_000_000n, 1_000_000_500n)), '+0.000050%');
  assert.equal(formatMicroPct(changeMicroPct(5n, 5n)), '0.00%');
  assert.equal(changeMicroPct(0n, 5n), null);
});

test('countdown, short address and deep links', () => {
  assert.equal(formatCountdown(42.2), '0:43');
  assert.equal(formatCountdown(65), '1:05');
  assert.equal(formatCountdown(-3), '0:00');
  assert.equal(shortAddress('5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz'), '5kUC...WuCz');
  assert.equal(parseRoundLink('flipthememe://round/123'), 123n);
  assert.equal(parseRoundLink('flipthememe:///round/7?x=1'), 7n);
  assert.equal(parseRoundLink('https://example.com/round/1'), null);
  assert.equal(parseRoundLink(null), null);
});

test('face bytes round-trip for every combination, and every combination renders a head', () => {
  let count = 0;
  for (let skin = 0; skin < FACE_OPTIONS.skin; skin++)
    for (let hairStyle = 0; hairStyle < FACE_OPTIONS.hairStyle; hairStyle++)
      for (let hairColor = 0; hairColor < FACE_OPTIONS.hairColor; hairColor++)
        for (let eyes = 0; eyes < FACE_OPTIONS.eyes; eyes++)
          for (let accessory = 0; accessory < FACE_OPTIONS.accessory; accessory++)
            for (let mouth = 0; mouth < FACE_OPTIONS.mouth; mouth++) {
              const face: Face = { skin, hairStyle, hairColor, eyes, accessory, mouth };
              const bytes = faceToBytes(face);
              assert.equal(bytes.length, 8);
              assert.equal(bytes[6], 0);
              assert.equal(bytes[7], 0);
              assert.deepEqual(faceFromBytes(bytes), face);
              const grid = faceGrid(face);
              assert.equal(grid.length, GRID * GRID);
              // Head only: no skin below the chin row (no neck, no shoulders). Long hair may hang lower.
              const skins = new Set(SKINS[skin]);
              for (let y = 14; y < GRID; y++)
                for (let x = 0; x < GRID; x++) assert.equal(skins.has(grid[y * GRID + x] ?? ''), false, `skin at ${x},${y}`);
              count++;
            }
  assert.equal(count, 6 * 8 * 6 * 4 * 6 * 4);
});

test('any 8 bytes decode to a valid face; the house zeros too', () => {
  assert.deepEqual(faceFromBytes(new Uint8Array(8)), { skin: 0, hairStyle: 0, hairColor: 0, eyes: 0, accessory: 0, mouth: 0 });
  const f = faceFromBytes([255, 255, 255, 255, 255, 255, 9, 9]);
  assert.equal(f.skin, 255 % 6);
  assert.equal(f.hairStyle, 255 % 8);
  assert.deepEqual(faceFromBytes([1, 2]), { skin: 1, hairStyle: 2, hairColor: 0, eyes: 0, accessory: 0, mouth: 0 });
});

test('pixel art layers are 16 x 16 and paths cover exactly the filled pixels', () => {
  for (const [name, layer] of Object.entries(ART_LAYERS)) {
    assert.equal(layer.length, GRID, `${name} rows`);
    layer.forEach((row, y) => assert.equal(row.length, GRID, `${name} row ${y}`));
  }
  const grid = houseGrid();
  const filled = grid.filter((c) => c !== null).length;
  let covered = 0;
  for (const { d } of gridToPaths(grid)) for (const m of d.matchAll(/h(\d+)/g)) covered += Number(m[1]);
  assert.equal(covered, filled);
});

function round(over: Partial<RoundAccount> & { opensAt: bigint }): { id: bigint; account: RoundAccount } {
  const o = over.opensAt;
  const account: RoundAccount = {
    id: 0n,
    tokenMint: '11111111111111111111111111111111' as RoundAccount['tokenMint'],
    pool: '11111111111111111111111111111111' as RoundAccount['pool'],
    opensAt: o,
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

test('rounds are classified and the one timer follows my earliest unresolved round', () => {
  const now = 1_000_000;
  const upcoming = round({ id: 5n, opensAt: BigInt(now + 8) });
  const open = round({ id: 4n, opensAt: BigInt(now - 20) });
  const measuring = round({ id: 3n, opensAt: BigInt(now - 120), status: RoundStatus.Live, strikePrice: 100n });
  const confirming = round({ id: 2n, opensAt: BigInt(now - 170), status: RoundStatus.Live, strikePrice: 100n });
  const final = round({ id: 1n, opensAt: BigInt(now - 300), status: RoundStatus.Final, outcome: Outcome.Up });
  const g = classifyRounds([upcoming, open, measuring, confirming, final], now);
  assert.equal(g.open?.id, 4n);
  assert.equal(g.upcoming?.id, 5n);
  assert.deepEqual(g.inFlight.map((r) => r.id), [2n, 3n]);
  assert.deepEqual(g.finals.map((r) => r.id), [1n]);

  const watching = selectTimer({ nowSec: now, open: g.open, upcoming: g.upcoming, myUnresolved: [] });
  assert.equal(watching.kind, 'entry');
  assert.equal(watching.label, 'ENTRY CLOSES IN');
  if (watching.kind === 'entry') assert.equal(watching.secondsLeft, 40);

  const result = selectTimer({ nowSec: now, open: g.open, upcoming: g.upcoming, myUnresolved: [measuring, open] });
  assert.equal(result.kind, 'result');
  if (result.kind === 'result') {
    assert.equal(result.label, 'RESULT IN');
    assert.equal(result.stage, 'measuring');
    assert.equal(result.secondsLeft, 40);
  }
  const confirmingTimer = selectTimer({ nowSec: now, open: g.open, upcoming: null, myUnresolved: [confirming, measuring] });
  assert.equal(confirmingTimer.label, 'CONFIRMING RESULT');

  const pause = round({ id: 9n, opensAt: BigInt(now - 70) });
  const t = selectTimer({ nowSec: now, open: null, upcoming: null, myUnresolved: [pause] });
  assert.equal(t.kind === 'result' && t.stage, 'pause');
  assert.equal(selectTimer({ nowSec: now, open: null, upcoming: upcoming, myUnresolved: [] }).kind, 'next');
  assert.equal(selectTimer({ nowSec: now, open: null, upcoming: null, myUnresolved: [] }).kind, 'waiting');
});

test('position results follow the 1:1 matched bank', () => {
  const now = 2_000_000;
  const won = round({ id: 1n, opensAt: BigInt(now - 400), status: RoundStatus.Final, outcome: Outcome.Up, rawUp: SOL / 10n, rawDown: SOL / 20n });
  // UP 0.1 vs DOWN 0.05: 0.05 matched, 0.05 returned; a win pays 0.05 + 0.05 * 1.96.
  const r = positionResult({ side: Side.Up, stake: SOL / 10n, claimed: false, payout: 0n }, won.account, now);
  assert.equal(r.kind, 'won');
  assert.equal(r.accepted, SOL / 20n);
  assert.equal(r.payout, SOL / 20n + (SOL / 20n) * 196n / 100n);
  const lost = positionResult({ side: Side.Down, stake: SOL / 20n, claimed: false, payout: 0n }, won.account, now);
  assert.equal(lost.kind, 'lost');
  assert.equal(lost.payout, 0n);
  const claimed = positionResult({ side: Side.Up, stake: SOL / 10n, claimed: true, payout: 123n }, won.account, now);
  assert.equal(claimed.payout, 123n);

  const tie = round({ id: 2n, opensAt: BigInt(now - 400), status: RoundStatus.Final, outcome: Outcome.Refund, refundReason: RefundReason.Tie });
  assert.equal(roundResultLabel(tie.account), 'TIE');
  const none = round({ id: 3n, opensAt: BigInt(now - 400), status: RoundStatus.Final, outcome: Outcome.NotActivated, rawUp: SOL / 100n });
  assert.equal(roundResultLabel(none.account), 'NO MATCH');
  assert.equal(positionResult({ side: Side.Up, stake: SOL / 100n, claimed: false, payout: 0n }, none.account, now).payout, SOL / 100n);

  assert.equal(standingNow(Side.Up, 100n, 101n), 'winning');
  assert.equal(standingNow(Side.Down, 100n, 101n), 'losing');
  assert.equal(standingNow(Side.Down, 100n, 100n), 'tie');

  const shallow = round({ id: 4n, opensAt: BigInt(now), rawUp: SOL / 20n, maxBank: SOL / 20n });
  assert.equal(fitsDepth(shallow.account, Side.Up, SOL / 10n), true); // larger side: matched bank unchanged
  assert.equal(fitsDepth(shallow.account, Side.Down, SOL / 20n), false); // 2 * 0.05 > 0.05
});

test('program error codes are read from bigint transaction details (kit getSignatureStatuses)', () => {
  const failed = new TransactionFailed('sig' as never, { InstructionError: [0n, { Custom: 6006n }] });
  assert.equal(customErrorCode(failed), 6006);
  assert.equal(programError(failed), 'RoundNotOpen');
  assert.equal(humanError(failed, 'bet'), 'Entry just closed - try the next round.');
  const logs = new Error('simulation failed: Program x failed: custom program error: 0x1774');
  assert.equal(programError(logs), 'SessionCapExceeded');
  assert.equal(
    humanError(new TransactionFailed('sig' as never, 'blockhash expired'), 'bet'),
    'The network was too slow and the transaction expired - nothing was taken. Try again.',
  );
});

test('no em or en dash characters in the app sources', () => {
  const root = join(import.meta.dirname, '..', '..');
  const files = [join(root, 'App.tsx'), join(root, '..', '..', 'packages', 'client', 'src', 'system.ts')];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) files.push(path);
    }
  };
  walk(join(root, 'src'));
  const banned = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
  for (const file of files) assert.equal(banned.test(readFileSync(file, 'utf8')), false, file);
});
