// Node tests for the history kept on the phone (no React Native). Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddressDecoder } from '@solana/kit';
import { Outcome, RefundReason, RoundStatus, Side, type PositionAccount, type RoundAccount } from '@flipthememe/client';
import {
  HISTORY_CAP,
  accuracyOf,
  createHistoryStore,
  historyEntry,
  historyStats,
  mergeHistory,
  parseHistory,
  reconcileHistory,
  recordFace,
  recordOf,
  serializeHistory,
  streakAsOf,
  streakLabel,
  streakOf,
  streakWords,
  type ChainPosition,
  type HistoryEntry,
  type HistoryRecord,
} from '../state/history.ts';
import type { KeyValueStorage } from '../lib/boolStore.ts';

const SOL = 1_000_000_000n;
const addresses = getAddressDecoder();
/** A real-looking address from one repeated byte. */
const addr = (n: number) => addresses.decode(new Uint8Array(32).fill(n));
const OWNER = addr(1);
const MINT = addr(2);
const POOL = addr(3);
const T0 = 1_800_000_000n;

function roundAccount(id: bigint, over: Partial<RoundAccount> = {}): RoundAccount {
  const o = T0 + id * 60n;
  return {
    id,
    tokenMint: MINT,
    pool: POOL,
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
    feeRefundBps: 0,
    rawUp: SOL / 10n,
    rawDown: SOL / 10n,
    houseAmount: 0n,
    positionCount: 2,
    claimedCount: 0,
    totalPaid: 0n,
    feesSwept: false,
    status: RoundStatus.Final,
    outcome: Outcome.Up,
    refundReason: RefundReason.None,
    strikePrice: 1_000_000n,
    exitPrice: 1_010_000n,
    strikeSamples: 5,
    exitSamples: 5,
    bump: 255,
    ...over,
  };
}

/** My position in round `id` (Final, UP won, 0.1 SOL UP unless overridden). */
function mine(id: bigint, over: { position?: Partial<PositionAccount>; round?: Partial<RoundAccount> | null } = {}): ChainPosition {
  const round = over.round === null ? null : { id, address: addr(100 + Number(id)), account: roundAccount(id, over.round ?? {}) };
  return {
    address: addr(200 + Number(id)),
    account: {
      round: addr(100 + Number(id)),
      authority: OWNER,
      side: Side.Up,
      stake: SOL / 10n,
      face: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      isHouse: false,
      claimed: false,
      payout: 0n,
      bump: 254,
      ...over.position,
    },
    round,
  };
}

const kept = (id: bigint, over: Partial<HistoryRecord> = {}): HistoryRecord => ({ ...recordOf(mine(id), 1_000)!, ...over });

test('a final round becomes a kept row with the result History shows', () => {
  const won = recordOf(mine(5n), 1_234);
  assert.ok(won);
  assert.equal(won.position, addr(205));
  assert.equal(won.roundId, 5n);
  assert.equal(won.round, addr(105));
  assert.equal(won.side, Side.Up);
  assert.equal(won.stake, SOL / 10n);
  assert.equal(won.accepted, SOL / 10n);
  assert.equal(won.payout, 196_000_000n); // 0.1 matched, x1.96
  assert.equal(won.kind, 'won');
  assert.equal(won.label, 'UP');
  assert.equal(won.tokenMint, MINT);
  assert.equal(won.pool, POOL);
  assert.equal(won.strike, 1_000_000n);
  assert.equal(won.exit, 1_010_000n);
  assert.equal(won.opensAt, Number(T0 + 300n));
  assert.equal(won.exitEnd, Number(T0 + 460n));
  assert.equal(won.claimed, false);
  assert.equal(won.savedAt, 1_234);
  assert.deepEqual([...recordFace(won)], [1, 2, 3, 4, 5, 6, 7, 8]);

  const lost = recordOf(mine(6n, { position: { side: Side.Down } }), 0);
  assert.equal(lost?.kind, 'lost');
  assert.equal(lost?.payout, 0n);
  const tie = recordOf(mine(7n, { round: { outcome: Outcome.Refund, refundReason: RefundReason.Tie } }), 0);
  assert.equal(tie?.kind, 'refund');
  assert.equal(tie?.label, 'TIE');
  assert.equal(tie?.payout, SOL / 10n);
  const noMatch = recordOf(mine(8n, { round: { outcome: Outcome.NotActivated, rawDown: 0n, strikePrice: 0n, exitPrice: 0n } }), 0);
  assert.equal(noMatch?.kind, 'full-refund');
  assert.equal(noMatch?.label, 'NO MATCH');
  assert.equal(noMatch?.accepted, 0n);
  // A claimed position keeps the payout the program wrote.
  assert.equal(recordOf(mine(9n, { position: { claimed: true, payout: 123n } }), 0)?.payout, 123n);

  // Not final, or no round data: nothing to keep yet.
  assert.equal(recordOf(mine(10n, { round: { status: RoundStatus.Live, outcome: Outcome.Pending } }), 0), null);
  assert.equal(recordOf(mine(11n, { round: null }), 0), null);
});

test('reconcile keeps finals, follows the claim and returns the same list when nothing changed', () => {
  const live = mine(12n, { round: { status: RoundStatus.Live, outcome: Outcome.Pending } });
  const chain = [mine(11n), live];
  const first = reconcileHistory([], chain, { nowMs: 5_000 });
  assert.deepEqual(
    first.map((r) => [r.roundId, r.claimed, r.savedAt]),
    [[11n, false, 5_000]],
  );
  assert.equal(reconcileHistory(first, chain, { nowMs: 9_000 }), first, 'unchanged: same reference, nothing to save');

  const claimed = reconcileHistory(first, [mine(11n, { position: { claimed: true, payout: 196_000_000n } }), live], { nowMs: 9_000 });
  assert.notEqual(claimed, first);
  assert.equal(claimed[0].claimed, true);
  assert.equal(claimed[0].savedAt, 5_000, 'first save time stays');

  // The round of the live position turns final: a second row, newest first.
  const both = reconcileHistory(claimed, [mine(11n, { position: { claimed: true, payout: 196_000_000n } }), mine(12n)], { nowMs: 9_500 });
  assert.deepEqual(
    both.map((r) => r.roundId),
    [12n, 11n],
  );
});

test('a kept row whose account is gone counts as claimed (the program closes only claimed positions)', () => {
  const records = [kept(20n), kept(19n, { claimed: true })];
  const after = reconcileHistory(records, [mine(21n, { round: { status: RoundStatus.Open, outcome: Outcome.Pending } })], { nowMs: 0 });
  assert.deepEqual(
    after.map((r) => [r.roundId, r.claimed]),
    [
      [20n, true],
      [19n, true],
    ],
  );
  // Still on chain and unclaimed: left as it is.
  assert.equal(reconcileHistory([kept(22n)], [mine(22n)], { nowMs: 0 })[0].claimed, false);
});

test('the store keeps the newest rounds up to the cap', () => {
  const records = [1n, 2n, 3n, 4n, 5n, 6n, 7n].map((id) => kept(id));
  const capped = reconcileHistory(records, [], { cap: 5, nowMs: 0 });
  assert.deepEqual(
    capped.map((r) => r.roundId),
    [7n, 6n, 5n, 4n, 3n],
  );
  assert.equal(HISTORY_CAP, 500);
});

test('merge: the chain row wins, kept rows fill in closed positions, newest round first', () => {
  const chain = [mine(10n, { position: { claimed: true, payout: 196_000_000n } }), mine(8n, { round: { status: RoundStatus.Live, outcome: Outcome.Pending } })];
  const records = [kept(10n), kept(9n, { claimed: true }), kept(7n, { claimed: true })];
  const merged = mergeHistory(chain, records);
  assert.deepEqual(
    merged.map((e) => [e.kind, e.roundId]),
    [
      ['chain', 10n],
      ['stored', 9n],
      ['chain', 8n],
      ['stored', 7n],
    ],
  );
  assert.equal(merged[0].kind === 'chain' && merged[0].position.account.claimed, true, 'chain data, not the older kept copy');
  assert.deepEqual(
    merged.map((e) => e.key),
    [addr(210), addr(209), addr(208), addr(207)],
  );

  // A chain row without round data gives way to the kept row of the same position.
  const blind = mergeHistory([mine(10n, { round: null })], [kept(10n)]);
  assert.deepEqual(
    blind.map((e) => e.kind),
    ['stored'],
  );
  // Without kept data it stays, last.
  assert.deepEqual(
    mergeHistory([mine(4n, { round: null }), mine(5n)], []).map((e) => e.roundId),
    [5n, null],
  );
  // Nothing on chain (not read yet, or all closed): the kept rows alone.
  assert.equal(mergeHistory([], records).length, 3);
});

test('profile stats count kept rows like chain rows', () => {
  const now = Number(T0) + 10_000;
  const chain = [
    mine(10n), // won 0.1 -> 0.196
    mine(9n, { position: { side: Side.Down } }), // lost 0.1
    mine(8n, { round: { status: RoundStatus.Live, outcome: Outcome.Pending } }), // open
    mine(7n, { round: null }), // no round data
  ];
  const chainOnly = historyStats(mergeHistory(chain, []), now);
  assert.deepEqual(chainOnly, { rounds: 4, wins: 1, losses: 1, refunds: 0, open: 1, net: 96_000_000n - 100_000_000n });

  const records = [kept(6n, { kind: 'refund', label: 'TIE', payout: SOL / 10n, claimed: true }), kept(5n, { claimed: true })];
  const withKept = historyStats(mergeHistory(chain, records), now);
  assert.deepEqual(withKept, { rounds: 6, wins: 2, losses: 1, refunds: 1, open: 1, net: 96_000_000n - 100_000_000n + 96_000_000n });
});

test('storage: versioned entry per wallet, round trip, unreadable rows dropped', async () => {
  const records = [kept(3n, { claimed: true, accepted: null, payout: null }), kept(2n)];
  assert.deepEqual(parseHistory(serializeHistory(records)), records);
  assert.deepEqual(parseHistory(null), []);
  assert.deepEqual(parseHistory('not json'), []);
  assert.deepEqual(parseHistory(JSON.stringify({ v: 2, rows: JSON.parse(serializeHistory(records)).rows })), [], 'another version is not read');

  const rows = JSON.parse(serializeHistory(records)).rows as Record<string, unknown>[];
  rows.push({ ...rows[0], position: 'not an address' }, { ...rows[0], stake: '-5' }, { ...rows[0], kind: 'pending' }, null as never);
  assert.deepEqual(parseHistory(JSON.stringify({ v: 1, rows })), records);

  const data = new Map<string, string>();
  const storage: KeyValueStorage = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
  };
  const store = createHistoryStore(storage);
  await store.save(OWNER, records);
  assert.equal(historyEntry(OWNER), `ftm.history.v1.${OWNER}`);
  assert.deepEqual([...data.keys()], [`ftm.history.v1.${OWNER}`]);
  assert.deepEqual(await store.load(OWNER), records);
  assert.deepEqual(await store.load(addr(9)), [], 'other wallets have their own entry');
});

/** One row per letter, oldest letter first: W won, L lost, T tie (refund), N no match (full refund), P still in play, X no round data. */
function rows(letters: string, firstId = 1n): HistoryEntry[] {
  const chain = [...letters].map((ch, i): ChainPosition => {
    const id = firstId + BigInt(i);
    switch (ch) {
      case 'W':
        return mine(id);
      case 'L':
        return mine(id, { position: { side: Side.Down } });
      case 'T':
        return mine(id, { round: { outcome: Outcome.Refund, refundReason: RefundReason.Tie } });
      case 'N':
        return mine(id, { round: { outcome: Outcome.NotActivated, rawDown: 0n, strikePrice: 0n, exitPrice: 0n } });
      case 'P':
        return mine(id, { round: { status: RoundStatus.Live, outcome: Outcome.Pending } });
      case 'X':
        return mine(id, { round: null });
      default:
        throw new Error(`unknown row ${ch}`);
    }
  });
  return mergeHistory(chain, []);
}

test('streak: nothing played yet', () => {
  assert.deepEqual(streakOf([]), { current: 0, kind: null, best: 0 });
});

test('streak: refunds neither extend nor break a streak, and alone they make none', () => {
  assert.deepEqual(streakOf(rows('TNT')), { current: 0, kind: null, best: 0 });
  assert.deepEqual(streakOf(rows('WTNW')), { current: 2, kind: 'win', best: 2 });
  assert.deepEqual(streakOf(rows('LTL')), { current: 2, kind: 'loss', best: 0 });
  assert.deepEqual(streakOf(rows('WWTL')), { current: 1, kind: 'loss', best: 2 });
});

test('streak: the newest finished rounds count, whatever order the rows come in', () => {
  const ordered = rows('WWLWWWTW');
  // 8 W, 7 refund, then 6 5 4 W: four wins in a row, stopped by the loss in round 3; the best run is the same four.
  assert.deepEqual(streakOf(ordered), { current: 4, kind: 'win', best: 4 });
  const shuffled = [ordered[3], ordered[0], ordered[7], ordered[5], ordered[1], ordered[6], ordered[2], ordered[4]];
  assert.deepEqual(streakOf(shuffled), { current: 4, kind: 'win', best: 4 });
  assert.deepEqual(streakOf(rows('WWWWWLW')), { current: 1, kind: 'win', best: 5 }, 'the best run may be an old one');
  assert.deepEqual(streakOf(rows('WLLL')), { current: 3, kind: 'loss', best: 1 });
  assert.deepEqual(streakOf(rows('LLLWL')), { current: 1, kind: 'loss', best: 1 });
});

test('streak: a round still in play, or without round data, is ignored', () => {
  assert.deepEqual(streakOf(rows('WWP')), { current: 2, kind: 'win', best: 2 });
  assert.deepEqual(streakOf(rows('LLWPP')), { current: 1, kind: 'win', best: 1 });
  assert.deepEqual(streakOf(rows('WXW')), { current: 2, kind: 'win', best: 2 });
  assert.deepEqual(streakOf(rows('PX')), { current: 0, kind: null, best: 0 });
});

test('streak: rows kept on the phone count like chain rows', () => {
  const chain = [mine(10n), mine(9n)];
  const records = [kept(8n, { claimed: true }), kept(7n, { kind: 'lost', payout: 0n, claimed: true }), kept(6n, { claimed: true }), kept(5n, { claimed: true })];
  const entries = mergeHistory(chain, records);
  assert.deepEqual(entries.map((e) => e.kind), ['chain', 'chain', 'stored', 'stored', 'stored', 'stored']);
  assert.deepEqual(streakOf(entries), { current: 3, kind: 'win', best: 3 });
});

test('streak as of a round leaves out the rounds after it (the overlay of an older result)', () => {
  const entries = rows('WWLW');
  assert.deepEqual(streakOf(entries), { current: 1, kind: 'win', best: 2 });
  assert.deepEqual(streakAsOf(entries, 2n), { current: 2, kind: 'win', best: 2 });
  assert.deepEqual(streakAsOf(entries, 3n), { current: 1, kind: 'loss', best: 2 });
  assert.deepEqual(streakAsOf(entries, 0n), { current: 0, kind: null, best: 0 });
});

test('streak words and the chip label', () => {
  assert.equal(streakWords({ current: 0, kind: null, best: 3 }), '-');
  assert.equal(streakWords({ current: 1, kind: 'win', best: 1 }), '1 win');
  assert.equal(streakWords({ current: 3, kind: 'win', best: 3 }), '3 wins');
  assert.equal(streakWords({ current: 1, kind: 'loss', best: 0 }), '1 loss');
  assert.equal(streakWords({ current: 2, kind: 'loss', best: 0 }), '2 losses');

  assert.equal(streakLabel({ current: 3, kind: 'win', best: 3 }), '3 IN A ROW');
  assert.equal(streakLabel({ current: 2, kind: 'win', best: 2 }), '2 IN A ROW');
  assert.equal(streakLabel({ current: 1, kind: 'win', best: 5 }), null, 'one win is not a streak');
  assert.equal(streakLabel({ current: 2, kind: 'loss', best: 0 }), 'LOST 2 IN A ROW');
  assert.equal(streakLabel({ current: 1, kind: 'loss', best: 0 }), null);
  assert.equal(streakLabel({ current: 0, kind: null, best: 0 }), null);
});

test('accuracy is wins over decided rounds, none without a decided round', () => {
  assert.equal(accuracyOf({ wins: 0, losses: 0 }), null);
  assert.equal(accuracyOf({ wins: 3, losses: 1 }), 0.75);
  assert.equal(accuracyOf({ wins: 0, losses: 4 }), 0);
  assert.equal(accuracyOf({ wins: 2, losses: 0 }), 1);
  // Refunds are not in it: it reads the same fields historyStats returns.
  const stats = historyStats(rows('WLWT'), Number(T0) + 10_000);
  assert.equal(accuracyOf(stats), 2 / 3);
});
