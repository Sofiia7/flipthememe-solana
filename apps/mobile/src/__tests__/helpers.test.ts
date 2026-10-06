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
  formatDuration,
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
  assert.equal(parseRoundLink('flipthememe://round/123')?.round, 123n);
  assert.equal(parseRoundLink('flipthememe:///round/7?x=1')?.round, 7n);
  assert.equal(parseRoundLink('https://example.com/round/1'), null);
  assert.equal(parseRoundLink('https://sol.flipthememe.com/r/496?side=up&t=Tesla')?.round, 496n);
  assert.equal(parseRoundLink('https://sol.flipthememe.com/r/'), null);
  assert.equal(parseRoundLink('https://evil.example/r/5?u=https://sol.flipthememe.com/r/5'), null);
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
  if (watching.kind === 'entry') assert.equal(watching.secondsLeft, 40);

  const result = selectTimer({ nowSec: now, open: g.open, upcoming: g.upcoming, myUnresolved: [measuring, open] });
  assert.equal(result.kind, 'result');
  if (result.kind === 'result') {
    assert.equal(result.stage, 'measuring');
    assert.equal(result.secondsLeft, 40);
  }
  const confirmingTimer = selectTimer({ nowSec: now, open: g.open, upcoming: null, myUnresolved: [confirming, measuring] });
  assert.equal(confirmingTimer.kind, 'confirming');

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

test('chart line splits exactly at the strike level, so its colour always follows the strike line', async () => {
  const { splitAtLevel } = await import('../ui/chartPath.ts');
  // Screen y: smaller is higher. Level 50: the line starts below, crosses up, stays above.
  const parts = splitAtLevel(
    [
      { x: 0, y: 80 },
      { x: 10, y: 60 },
      { x: 20, y: 40 },
      { x: 30, y: 10 },
    ],
    50,
  );
  assert.equal(parts.below, 'M0.0 80.0L10.0 60.0L15.0 50.0');
  assert.equal(parts.above, 'M15.0 50.0L20.0 40.0L30.0 10.0');
  // All above: nothing red at all, however far the strike sits below.
  assert.deepEqual(splitAtLevel([{ x: 0, y: 5 }, { x: 1, y: 9 }], 100), { above: 'M0.0 5.0L1.0 9.0', below: '' });
});

test('top up plan lists every lamport leaving the wallet; win profit is 0.96x of a matched stake', async () => {
  const { topUpPlan, maxWinProfit, NETWORK_FEE } = await import('../wallet/topUpPlan.ts');
  const SOL = 1_000_000_000n;
  const rules = { gasMin: SOL / 100n, gasTopUp: (SOL * 3n) / 100n };
  // First top up: deposit, key fees, both accounts' rent and the network fee.
  const first = topUpPlan({ deposit: SOL / 10n, vaultExists: false, sessionExists: false, keyLamports: 0n, rent: { vault: 1_287_600n, session: 1_851_360n }, ...rules });
  assert.equal(first.keyFees, (SOL * 3n) / 100n);
  assert.equal(first.setup, 1_287_600n + 1_851_360n);
  assert.equal(first.total, SOL / 10n + (SOL * 3n) / 100n + 1_287_600n + 1_851_360n + NETWORK_FEE);
  // Renewal with a funded key and existing accounts: only the network fee.
  const renew = topUpPlan({ deposit: 0n, vaultExists: true, sessionExists: true, keyLamports: SOL / 10n, rent: null, ...rules });
  assert.deepEqual([renew.keyFees, renew.setup, renew.total], [0n, 0n, NETWORK_FEE]);
  assert.equal(maxWinProfit(SOL / 50n, 200), 19_200_000n); // 0.02 SOL wins +0.0192
  assert.equal(maxWinProfit(SOL / 100n, 200), 9_600_000n);
});

test('away summary counts results once and reports the net in SOL', async () => {
  const { awaySummary, awayText } = await import('../state/away.ts');
  const { formatSol } = await import('../lib/format.ts');
  const SOL = 1_000_000_000n;
  assert.equal(awaySummary([]), null);
  const s = awaySummary([
    { id: 7n, kind: 'won', stake: SOL / 50n, payout: (SOL * 392n) / 10_000n },
    { id: 9n, kind: 'lost', stake: SOL / 100n, payout: 0n },
    { id: 8n, kind: 'full-refund', stake: SOL / 100n, payout: SOL / 100n },
  ])!;
  assert.deepEqual([s.won, s.lost, s.refunded, s.lastId], [1, 1, 1, 9n]);
  assert.equal(s.net, (SOL * 192n) / 10_000n - SOL / 100n);
  assert.equal(awayText(s, formatSol), 'While you were away: 1 won, 1 lost, 1 refunded · net +0.0092 SOL');
});

test('Seeker ID: the name after the 200-byte record header, one plain label, deterministic pick', async () => {
  const { nameFromRecord, pickName } = await import('../chain/skrName.ts');
  const record = (label: string) => {
    const bytes = new Uint8Array(200 + 32);
    bytes.set(new TextEncoder().encode(label), 200);
    return bytes;
  };
  assert.equal(nameFromRecord(record('oxbla')), 'oxbla.skr');
  assert.equal(nameFromRecord(record('a.b')), null);
  assert.equal(nameFromRecord(record('')), null);
  assert.equal(pickName(['zed.skr', 'Alpha.skr', 'alpha.skr']), 'Alpha.skr');
  assert.equal(pickName([]), null);
});

test('session time left reads in days once it is a day or more', () => {
  assert.equal(formatDuration(7 * 86400 - 600), '6d 23h');
  assert.equal(formatDuration(86400), '1d 00h');
  assert.equal(formatDuration(86399), '23h 59m');
  assert.equal(formatDuration(125), '2m 05s');
  assert.equal(formatDuration(-5), '0s');
});
