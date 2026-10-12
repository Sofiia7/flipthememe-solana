// Run: node --test "services/attestor/test/*.test.ts" (from the repo root). No network.
// A round nobody entered is never priced: the sampler leaves it alone once that is provable, readiness
// neither waits for it nor reads the whole table, and the keeper's 5 second poll stays cheap.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AttestorCore, TOTALS_CACHE_MS } from '../src/attestor.ts';
import { Failover } from '../src/rpc.ts';
import { EMPTY_PROOF_MARGIN_MS, SAMPLE_MARGIN_MS, isProvablyEmpty, roundsToPrice, windowOf } from '../src/samples.ts';
import {
  ATTESTOR,
  ATTESTOR_SECRET,
  Clock,
  Devnet,
  FIXTURE_BASE,
  FIXTURE_QUOTE,
  HIGGS_POOL,
  Mainnet,
  MemoryAlarms,
  MemorySql,
  SLOT0,
  keeperSigner,
  makeRound,
  slotAt,
  type PoolState,
} from './helpers.ts';

const T0 = Date.parse('2026-10-06T12:00:00Z');
/** Round 10 opens at 12:01:00: entry closes 12:02:00, strike window 12:02:30-12:02:40, exit window 12:03:30-12:03:40. */
const OPENS = BigInt(T0 / 1000 + 60);
const EMPTY = { positionCount: 0, rawUp: 0n, rawDown: 0n };

const stateAtSlot = (slot: bigint): PoolState => ({ slot, base: FIXTURE_BASE, quote: FIXTURE_QUOTE + (FIXTURE_QUOTE * (slot - SLOT0)) / 10_000n });
const drifting = (ms: number): PoolState => stateAtSlot(slotAt(T0, ms));

/** MemorySql that remembers every SELECT, so a test can see which scans a call made. */
class RecordingSql extends MemorySql {
  readonly selects: string[] = [];
  override exec(query: string, ...bindings: Parameters<MemorySql['exec']> extends [string, ...infer B] ? B : never) {
    if (/^\s*select\b/i.test(query)) this.selects.push(query);
    return super.exec(query, ...bindings);
  }
}

async function setup(startMs: number) {
  const clock = new Clock(startMs);
  const sql = new RecordingSql();
  const alarms = new MemoryAlarms();
  const keeper = await keeperSigner();
  const devnet = new Devnet(keeper.address, { attestor: ATTESTOR, required: true, bump: 254 });
  const mainnet = new Mainnet(clock.now, drifting);
  const core = new AttestorCore({
    sql,
    alarms,
    env: { ATTESTOR_SECRET },
    now: clock.now,
    devnet: new Failover([{ name: 'devnet.test', rpc: devnet.rpc() }], clock.now),
    mainnet: new Failover([{ name: 'mainnet.test', rpc: mainnet.rpc() }], clock.now),
    log: () => undefined,
  });
  return { core, sql, alarms, clock, devnet, mainnet };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** Fires the alarms due up to untilMs in order, as the runtime does; returns how many fired. */
async function runUntil(s: Setup, untilMs: number, beforeTick?: (ms: number) => void): Promise<number> {
  let fired = 0;
  while (s.alarms.at !== null && s.alarms.at <= untilMs) {
    s.clock.ms = Math.max(s.clock.ms, s.alarms.at);
    s.alarms.at = null;
    beforeTick?.(s.clock.ms);
    await s.core.tick();
    fired++;
  }
  s.clock.ms = Math.max(s.clock.ms, untilMs);
  return fired;
}

const samples = (s: Setup) => s.sql.rows<{ at_ms: number }>('SELECT at_ms FROM samples ORDER BY at_ms');

describe('isProvablyEmpty', () => {
  const round = makeRound(7n, 1_800_000_000n, HIGGS_POOL, EMPTY);
  const cutoffMs = Number(round.cutoffAt) * 1000;

  test('needs a read taken at least the margin after the entry closed', () => {
    assert.equal(isProvablyEmpty(round, cutoffMs + EMPTY_PROOF_MARGIN_MS), true);
    assert.equal(isProvablyEmpty(round, cutoffMs + EMPTY_PROOF_MARGIN_MS - 1), false);
    assert.equal(isProvablyEmpty(round, cutoffMs - 5_000), false, 'a read from before the cutoff proves nothing');
    assert.equal(isProvablyEmpty(round, 0), false, 'no read yet');
  });

  test('one position, or any stake, makes it an entered round', () => {
    const late = cutoffMs + 60_000;
    assert.equal(isProvablyEmpty({ ...round, positionCount: 1 }, late), false);
    assert.equal(isProvablyEmpty({ ...round, rawUp: 1n }, late), false);
    assert.equal(isProvablyEmpty({ ...round, rawDown: 1n }, late), false);
  });

  test('roundsToPrice drops only the proven-empty rounds', () => {
    const entered = makeRound(8n, 1_800_000_000n, HIGGS_POOL);
    const late = cutoffMs + 60_000;
    assert.deepEqual(roundsToPrice([round, entered], late).map((r) => r.id), [8n]);
    assert.deepEqual(roundsToPrice([round, entered], cutoffMs - 1).map((r) => r.id), [7n, 8n]);
  });
});

describe('the sampler leaves a round nobody entered alone', () => {
  test('no mainnet read, no stored sample and no window alarm for it, and the arena stays ready', async () => {
    const s = await setup(T0 + 70_000);
    const round = s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL, EMPTY));
    const strike = windowOf(round, 'strike');
    const exit = windowOf(round, 'exit');

    await s.core.ping();
    await runUntil(s, exit.endMs + SAMPLE_MARGIN_MS + 1_000);

    assert.equal(s.mainnet.reads, 0, 'nobody entered, so nothing was priced');
    assert.deepEqual(samples(s), []);
    // Idle readiness: the empty round is not a window that must be fresh.
    s.clock.ms = strike.startMs + 5_000;
    const verdict = await s.core.ready();
    assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
    assert.deepEqual((verdict.body.readiness as { reasons: string[] }).reasons.filter((r) => r === 'window_samples_stale'), []);
  });

  test('a bet placed before the entry closed is sampled, even when an earlier read saw the round empty', async () => {
    const s = await setup(T0 + 70_000);
    const round = s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL, EMPTY));
    const strike = windowOf(round, 'strike');
    // Someone bets at 12:01:55, five seconds before the entry closes: the next read shows it.
    const placed = Number(round.cutoffAt) * 1000 - 5_000;
    let bet = false;
    await s.core.ping();
    await runUntil(s, strike.endMs + SAMPLE_MARGIN_MS, (ms) => {
      if (!bet && ms >= placed) {
        bet = true;
        s.devnet.rounds.set(10n, { ...round, positionCount: 1, rawUp: 20_000_000n, rawDown: 0n });
      }
    });
    assert.equal(samples(s).length, 13, 'the strike window was read once a second from 1.5 s before to 1.5 s after');
    assert.ok(s.mainnet.reads >= 13);
  });

  test('without a read taken after the entry closed the round is still sampled', async () => {
    const s = await setup(T0 + 70_000);
    const round = s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL, EMPTY));
    const strike = windowOf(round, 'strike');
    // The devnet read fails after the first snapshot, so nothing proves the round empty.
    await s.core.ping();
    await runUntil(s, T0 + 75_000);
    s.devnet.down = true;
    await runUntil(s, strike.endMs + SAMPLE_MARGIN_MS);
    assert.equal(samples(s).length, 13, 'safe default: an unproven round keeps its windows');
  });
});

describe('the keeper poll and the health page stay cheap', () => {
  test('ready() reads no whole table and lists no rounds', async () => {
    const s = await setup(T0 + 70_000);
    s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL));
    await s.core.ping();
    await runUntil(s, T0 + 100_000);
    s.sql.selects.length = 0;
    const verdict = await s.core.ready();
    assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
    assert.ok('readiness' in verdict.body);
    assert.ok(!('sampler' in verdict.body), 'the poll gets the verdict only');
    assert.ok(s.sql.selects.every((q) => !/COUNT\(/i.test(q)), 'no COUNT scan: ' + s.sql.selects.join(' | '));
  });

  test('ready() agrees with the readiness block of health()', async () => {
    const s = await setup(T0 + 70_000);
    s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL));
    await s.core.ping();
    await runUntil(s, T0 + 100_000);
    const ready = await s.core.ready();
    const health = await s.core.health();
    assert.deepEqual((ready.body.readiness as { ready: boolean; reasons: string[] }).reasons, (health.body.readiness as { reasons: string[] }).reasons);
    assert.equal((ready.body.readiness as { ready: boolean }).ready, (health.body.readiness as { ready: boolean }).ready);
  });

  test('health() scans the samples table at most once per cache period', async () => {
    const s = await setup(T0 + 70_000);
    s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL));
    await s.core.ping();
    await runUntil(s, T0 + 100_000);
    const scans = () => s.sql.selects.filter((q) => /COUNT\(DISTINCT/i.test(q)).length;
    s.sql.selects.length = 0;
    await s.core.health();
    await s.core.health();
    await s.core.health();
    assert.equal(scans(), 1);
    s.clock.ms += TOTALS_CACHE_MS + 1;
    await s.core.health();
    assert.equal(scans(), 2);
  });
});
