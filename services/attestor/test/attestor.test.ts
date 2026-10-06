// Run: node --test "services/attestor/test/*.test.ts" (from the repo root). No network.
// The Durable Object logic end to end: node:sqlite for storage.sql, a fake alarm, scripted devnet
// and mainnet RPCs, transactions built with the client's builders and kit.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { PROGRAM_ID, RoundStatus, setStrike, settle, type PriceSample, type RoundAccount } from '@flipthememe/client';
import { getBase58Encoder, partiallySignTransaction, getTransactionDecoder, type KeyPairSigner } from '@solana/kit';
import { AttestorCore, PRUNE_EVERY_MS, REFRESH_MS, RETAIN_MS, type AttestorEnv, type LogFields } from '../src/attestor.ts';
import { Failover } from '../src/rpc.ts';
import { SAMPLE_MARGIN_MS, windowOf } from '../src/samples.ts';
import {
  ATTESTOR,
  ATTESTOR_PUBLIC,
  ATTESTOR_SECRET,
  Clock,
  Devnet,
  FIXTURE_BASE,
  FIXTURE_PRICE,
  FIXTURE_QUOTE,
  FIXTURE_SLOT,
  HIGGS_POOL,
  Mainnet,
  MemoryAlarms,
  MemorySql,
  SLOT0,
  SOL,
  encodeRound,
  keeperSigner,
  makeRound,
  priceOfState,
  slotAt,
  testAddress,
  toBytes,
  wire,
  type PoolState,
} from './helpers.ts';

const T0 = Date.parse('2026-10-06T12:00:00Z');
/** Round 10 opens at 12:01:00: strike window 12:02:30-12:02:40, exit window 12:03:30-12:03:40. */
const OPENS = BigInt(T0 / 1000 + 60);

/** The pool drifts up 1 bp per slot (0.4 s from T0): the price is a function of the slot alone. */
const stateAtSlot = (slot: bigint): PoolState => ({ slot, base: FIXTURE_BASE, quote: FIXTURE_QUOTE + (FIXTURE_QUOTE * (slot - SLOT0)) / 10_000n });
const drifting = (ms: number): PoolState => stateAtSlot(slotAt(T0, ms));

type Setup = {
  core: AttestorCore;
  sql: MemorySql;
  alarms: MemoryAlarms;
  clock: Clock;
  devnet: Devnet;
  mainnet: Mainnet;
  keeper: KeyPairSigner;
  logs: LogFields[];
  /** Called before each alarm fires, at the alarm's time (to move the chain along). */
  beforeTick?: (ms: number) => void;
};

async function setup(startMs: number, env: AttestorEnv = { ATTESTOR_SECRET }): Promise<Setup> {
  const clock = new Clock(startMs);
  const sql = new MemorySql();
  const alarms = new MemoryAlarms();
  const keeper = await keeperSigner();
  const devnet = new Devnet(keeper.address, { attestor: ATTESTOR, required: true, bump: 254 });
  const mainnet = new Mainnet(clock.now, drifting);
  const logs: LogFields[] = [];
  const core = new AttestorCore({
    sql,
    alarms,
    env,
    now: clock.now,
    devnet: new Failover([{ name: 'devnet.test', rpc: devnet.rpc() }], clock.now),
    mainnet: new Failover([{ name: 'mainnet.test', rpc: mainnet.rpc() }], clock.now),
    log: (fields) => void logs.push(fields),
  });
  return { core, sql, alarms, clock, devnet, mainnet, keeper, logs };
}

/** Fires the alarms due up to `untilMs` in order, as the runtime does; returns how many fired. */
async function runUntil(s: Setup, untilMs: number): Promise<number> {
  let fired = 0;
  while (s.alarms.at !== null && s.alarms.at <= untilMs) {
    s.clock.ms = Math.max(s.clock.ms, s.alarms.at);
    s.alarms.at = null; // the runtime clears it while the handler runs
    s.beforeTick?.(s.clock.ms);
    await s.core.tick();
    fired++;
  }
  s.clock.ms = Math.max(s.clock.ms, untilMs);
  return fired;
}

type Row = { pool: string; at_ms: number; slot: number; price: string; strike_round: number | null; exit_round: number | null };
const rows = (s: Setup) => s.sql.rows<Row>('SELECT * FROM samples ORDER BY at_ms');

/**
 * The keeper's own reads: ten, 0.3 s after each second of the window, on the same pool. About half
 * fall on a slot the attestor read too (its reads are 0.5 s after each second). `avoid` moves
 * those one slot on, so no slot is shared; `scale` changes the prices the keeper reports.
 */
function keeperSamples(round: RoundAccount, kind: 'strike' | 'exit', opts: { avoid?: Set<bigint>; scale?: (price: bigint) => bigint } = {}): PriceSample[] {
  const { startMs } = windowOf(round, kind);
  return Array.from({ length: 10 }, (_, i) => {
    let slot = slotAt(T0, startMs + 300 + i * 1000);
    if (opts.avoid?.has(slot)) slot += 1n;
    const price = priceOfState(stateAtSlot(slot));
    return { slot, price: opts.scale ? opts.scale(price) : price };
  });
}

/** Slots of the attestor's stored reads. */
const readSlots = (s: Setup) => new Set(rows(s).map((r) => BigInt(r.slot)));
const sharedWith = (s: Setup, samples: PriceSample[]) => samples.filter((x) => readSlots(s).has(x.slot)).length;

async function strikeTx(s: Setup, roundId: bigint, samples: PriceSample[], feePayer = s.keeper.address) {
  return wire([await setStrike({ priceAuthority: s.keeper, roundId, samples, attestor: ATTESTOR })], feePayer);
}

const body = (r: { body: Record<string, unknown> }) => r.body as { signature?: string; attestor?: string; reason?: string; error?: string };

describe('sampler', () => {
  test('sleeps until a window, reads about once a second through it, then sleeps again', async () => {
    const s = await setup(T0 + 70_000);
    const round = s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL));
    const strike = windowOf(round, 'strike');
    const exit = windowOf(round, 'exit');

    await s.core.ping();
    assert.equal(s.alarms.at, T0 + 70_000);
    // Idle: a devnet refresh every 15 s, no mainnet reads.
    const idle = await runUntil(s, strike.startMs - SAMPLE_MARGIN_MS - 1);
    assert.equal(s.mainnet.reads, 0);
    assert.ok(idle >= 5 && idle <= 6, `idle alarms ${idle}`);
    assert.equal(s.alarms.at, strike.startMs - SAMPLE_MARGIN_MS);

    // The window: one read per second from 1.5 s before until 1.5 s after.
    const busy = await runUntil(s, strike.endMs + SAMPLE_MARGIN_MS - 1);
    assert.equal(busy, 13);
    const read = rows(s);
    assert.equal(read.length, 13);
    assert.deepEqual(
      read.map((r) => r.at_ms - strike.startMs),
      Array.from({ length: 13 }, (_, i) => -1500 + i * 1000),
    );
    assert.ok(read.every((r) => r.pool === HIGGS_POOL && r.strike_round === 10 && r.exit_round === null));
    assert.deepEqual(
      read.map((r) => BigInt(r.price)),
      read.map((r) => priceOfState(drifting(r.at_ms))),
    );
    // Then the devnet refresh that waited for the window, a refresh every 15 s, and the exit window.
    assert.equal(s.alarms.at, strike.endMs + SAMPLE_MARGIN_MS);
    const reads = s.devnet.reads;
    assert.equal(await runUntil(s, exit.startMs - SAMPLE_MARGIN_MS - 1), 4);
    assert.equal(s.devnet.reads - reads, 4);
    assert.equal(s.mainnet.reads, 13);
    await runUntil(s, exit.endMs + SAMPLE_MARGIN_MS);
    assert.equal(rows(s).filter((r) => r.exit_round === 10).length, 13);
  });

  test('price math against the fixture: quote * 10^12 / base of the captured vaults, with their slot', async () => {
    const s = await setup(T0 + 70_000);
    const round = s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL));
    s.mainnet.raw = true;
    await s.core.ping();
    await runUntil(s, windowOf(round, 'strike').startMs);
    const [first] = rows(s);
    assert.ok(first);
    assert.equal(BigInt(first.price), FIXTURE_PRICE);
    assert.equal(FIXTURE_PRICE, (FIXTURE_QUOTE * 10n ** 12n) / FIXTURE_BASE);
    assert.equal(BigInt(first.slot), FIXTURE_SLOT);
  });

  test('one read serves round N exit and round N+1 strike; both round ids are stored on it', async () => {
    const s = await setup(T0 + 70_000);
    const round = s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL));
    s.devnet.add(makeRound(11n, OPENS + 60n, HIGGS_POOL));
    await s.core.ping();
    const exit = windowOf(round, 'exit');
    await runUntil(s, exit.endMs + SAMPLE_MARGIN_MS);
    const shared = rows(s).filter((r) => r.at_ms >= exit.startMs - SAMPLE_MARGIN_MS);
    assert.equal(shared.length, 13);
    assert.ok(shared.every((r) => r.exit_round === 10 && r.strike_round === 11));
  });

  test('reads older than an hour are deleted', async () => {
    const s = await setup(T0 + 70_000);
    const round = s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL));
    await s.core.ping();
    await runUntil(s, windowOf(round, 'exit').endMs + SAMPLE_MARGIN_MS);
    assert.equal(rows(s).length, 26);
    await runUntil(s, windowOf(round, 'exit').endMs + RETAIN_MS + PRUNE_EVERY_MS);
    assert.equal(rows(s).length, 0);
  });

  test('a mainnet outage loses reads, not the loop; health names the error', async () => {
    const s = await setup(T0 + 70_000);
    const round = s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL));
    s.mainnet.down = true;
    await s.core.ping();
    await runUntil(s, windowOf(round, 'strike').endMs + SAMPLE_MARGIN_MS);
    assert.equal(rows(s).length, 0);
    assert.ok(s.alarms.at !== null);
    const health = body(await s.core.health()) as { sampler?: { errors: Record<string, { error: string }> } };
    assert.match(health.sampler!.errors.mainnet!.error, /fetch failed/);
    assert.ok(s.logs.some((l) => l.event === 'mainnet_error'));
  });

  test('the cron ping arms the loop only when no alarm is pending or one is long overdue', async () => {
    const s = await setup(T0);
    await s.core.ping();
    assert.equal(s.alarms.sets, 1);
    await s.core.ping();
    assert.equal(s.alarms.sets, 1);
    s.clock.ms += 120_000; // an alarm that never fired
    await s.core.ping();
    assert.equal(s.alarms.sets, 2);
    assert.equal(s.alarms.at, s.clock.ms);
  });

  test('budget: one round a minute for 10 minutes', async (t) => {
    const s = await setup(T0 + 45_000);
    // The keeper creates the round opening at minute m 15 s before m, on one pool.
    s.beforeTick = (ms) => {
      for (let id = 0n; id < 12n; id++) {
        const opensAt = OPENS + 60n * id;
        if (!s.devnet.rounds.has(id) && ms >= Number(opensAt) * 1000 - 15_000) s.devnet.add(makeRound(id, opensAt, HIGGS_POOL));
      }
    };
    await s.core.ping();
    await runUntil(s, T0 + 3 * 60_000); // steady state from here
    const [alarms0, sets0, written0, mainnet0, devnet0] = [s.alarms.sets, s.alarms.sets, s.sql.rowsWritten, s.mainnet.reads, s.devnet.reads];
    const fired = await runUntil(s, T0 + 13 * 60_000);
    const perMinute = (n: number) => n / 10;
    const alarmsPerMin = perMinute(fired);
    const rowsPerMin = perMinute(s.sql.rowsWritten - written0);
    const setsPerMin = perMinute(s.alarms.sets - sets0);
    t.diagnostic(
      `per minute: ${alarmsPerMin} alarms, ${setsPerMin} setAlarm, ${rowsPerMin} sample rows, ` +
        `${perMinute(s.mainnet.reads - mainnet0)} mainnet reads, ${perMinute(s.devnet.reads - devnet0)} devnet reads (alarms before: ${alarms0})`,
    );
    // Free plan: 100k Durable Object requests and 100k rows written a day. Requests: alarms, the
    // cron ping, about 2 attests a round. Rows: one per setAlarm, one per read, one per deleted read.
    const requestsPerDay = (alarmsPerMin + 1 + 2) * 1440;
    const rowsPerDay = (setsPerMin + 2 * rowsPerMin) * 1440;
    t.diagnostic(`per day: ${requestsPerDay} Durable Object requests, ${rowsPerDay} rows written`);
    assert.ok(alarmsPerMin <= 17, `alarms per minute ${alarmsPerMin}`);
    assert.ok(rowsPerMin <= 13.5, `rows per minute ${rowsPerMin}`);
    assert.ok(requestsPerDay < 30_000);
    assert.ok(rowsPerDay < 65_000);
  });
});

describe('attest', () => {
  /** Round 10 (activated, Open) sampled through its strike window; the clock 1 s after it. */
  async function strikeReady() {
    const s = await setup(T0 + 70_000);
    const round = s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL));
    await s.core.ping();
    await runUntil(s, Number(round.strikeEnd) * 1000 + 1000);
    return { s, round };
  }

  test('agreeing samples are co-signed; the signature verifies against the message', async () => {
    const { s, round } = await strikeReady();
    const samples = keeperSamples(round, 'strike');
    const { tx, messageBytes } = await strikeTx(s, 10n, samples);
    const result = await s.core.attest(tx);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const { signature, attestor } = body(result);
    assert.equal(attestor, ATTESTOR);
    const signatureBytes = new Uint8Array(getBase58Encoder().encode(signature!));
    assert.equal(signatureBytes.length, 64);
    assert.ok(ed25519.verify(signatureBytes, messageBytes, ATTESTOR_PUBLIC));
    const verifier = await crypto.subtle.importKey('raw', ATTESTOR_PUBLIC, 'Ed25519', false, ['verify']);
    assert.ok(await crypto.subtle.verify('Ed25519', verifier, signatureBytes, messageBytes));

    // With the keeper's own signature added, every required signature is there and valid.
    const keeperSigned = await partiallySignTransaction([s.keeper.keyPair], getTransactionDecoder().decode(toBytes(tx)));
    const full = { ...keeperSigned, signatures: { ...keeperSigned.signatures, [ATTESTOR]: signatureBytes } };
    assert.deepEqual(Object.keys(full.signatures).sort(), [ATTESTOR, s.keeper.address].sort());
    assert.ok(Object.values(full.signatures).every((sig) => sig !== null));
    const log = s.logs.find((l) => l.event === 'attest');
    assert.equal(log?.signed, true);
    assert.equal(log?.verdict, 'agree');
    assert.equal(log?.ownSamples, 10);
    // Some keeper samples sat at slots the attestor read too, checked to the unit.
    const shared = sharedWith(s, samples);
    assert.ok(shared > 0 && shared < 10, `shared ${shared}`);
    assert.equal(log?.sharedSlots, shared);
    assert.equal(log?.keeperSamples, 10);
  });

  test('settle: a Live round, samples of the exit window', async () => {
    const s = await setup(T0 + 70_000);
    const round = s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL, { status: RoundStatus.Live, strikePrice: 1n }));
    await s.core.ping();
    await runUntil(s, Number(round.exitEnd) * 1000 + 1000);
    const ix = await settle({ priceAuthority: s.keeper, roundId: 10n, samples: keeperSamples(round, 'exit'), attestor: ATTESTOR });
    const result = await s.core.attest(wire([ix], s.keeper.address).tx);
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });

  test('a shared slot with a price off by one unit: refused; the slot and both prices go to the log, not the answer', async () => {
    const { s, round } = await strikeReady();
    const samples = keeperSamples(round, 'strike');
    const at = samples.findIndex((x) => readSlots(s).has(x.slot));
    const target = samples[at]!;
    const off = samples.map((x, i) => (i === at ? { ...x, price: x.price + 1n } : x));
    const result = await s.core.attest((await strikeTx(s, 10n, off)).tx);
    assert.equal(result.status, 422);
    assert.equal(body(result).reason, 'slot_price_mismatch');
    const answer = JSON.stringify(result.body);
    assert.ok(!answer.includes(String(target.slot)) && !answer.includes(String(target.price)), answer);
    const log = s.logs.at(-1)!;
    assert.equal(log.result, 'slot_price_mismatch');
    assert.equal(log.slot, target.slot);
    assert.equal(log.keeperPrice, target.price + 1n);
    assert.equal(log.ownPrice, target.price);
    assert.equal(log.sharedSlots, sharedWith(s, samples));
  });

  test('no shared slots: the mean check decides; keeper prices 2% high are refused', async () => {
    const { s, round } = await strikeReady();
    const high = keeperSamples(round, 'strike', { avoid: readSlots(s), scale: (p) => (p * 102n) / 100n });
    assert.equal(sharedWith(s, high), 0);
    const result = await s.core.attest((await strikeTx(s, 10n, high)).tx);
    assert.equal(result.status, 422);
    assert.equal(body(result).reason, 'price_mismatch');
    assert.match(body(result).error!, /bps apart; the tolerance is 150/);
    assert.equal(s.logs.at(-1)?.sharedSlots, 0);
    // The same samples at their true prices pass.
    const fair = keeperSamples(round, 'strike', { avoid: readSlots(s) });
    assert.equal((await s.core.attest((await strikeTx(s, 10n, fair)).tx)).status, 200);
    assert.equal(s.logs.at(-1)?.sharedSlots, 0);
  });

  test('ATTEST_TOLERANCE_BPS widens or narrows the mean check', async () => {
    const s = await setup(T0 + 70_000, { ATTESTOR_SECRET, ATTEST_TOLERANCE_BPS: '300' });
    const round = s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL));
    await s.core.ping();
    await runUntil(s, Number(round.strikeEnd) * 1000 + 1000);
    const high = keeperSamples(round, 'strike', { avoid: readSlots(s), scale: (p) => (p * 102n) / 100n });
    assert.equal((await s.core.attest((await strikeTx(s, 10n, high)).tx)).status, 200);
    // Shared slots are exact whatever the tolerance.
    const shifted = keeperSamples(round, 'strike', { scale: (p) => p + 1n });
    assert.equal(body(await s.core.attest((await strikeTx(s, 10n, shifted)).tx)).reason, 'slot_price_mismatch');
  });

  test('slot outside the window: samples from slots the attestor never saw', async () => {
    const { s, round } = await strikeReady();
    const later = keeperSamples(round, 'strike').map((x) => ({ ...x, slot: x.slot + 500n }));
    const result = await s.core.attest((await strikeTx(s, 10n, later)).tx);
    assert.equal(body(result).reason, 'slot_out_of_range');
  });

  test('too few samples: a window the attestor did not watch', async () => {
    const { s, round } = await strikeReady();
    // Round 11 is on devnet, but its strike window passed while the sampler did not know it.
    const missed = s.devnet.add(makeRound(11n, OPENS - 600n, HIGGS_POOL));
    const result = await s.core.attest((await strikeTx(s, 11n, keeperSamples(missed, 'strike'))).tx);
    assert.equal(result.status, 422);
    assert.equal(body(result).reason, 'too_few_samples');
    assert.equal((await s.core.attest((await strikeTx(s, 10n, keeperSamples(round, 'strike'))).tx)).status, 200);
  });

  test('round state: the window still open, settle on an Open round, a Final round, no such round', async () => {
    const { s, round } = await strikeReady();
    const samples = keeperSamples(round, 'strike');
    s.clock.ms = Number(round.strikeEnd) * 1000 - 1;
    assert.equal(body(await s.core.attest((await strikeTx(s, 10n, samples)).tx)).reason, 'window_open');
    s.clock.ms = Number(round.exitEnd) * 1000 + 1000;
    const ix = await settle({ priceAuthority: s.keeper, roundId: 10n, samples, attestor: ATTESTOR });
    assert.equal(body(await s.core.attest(wire([ix], s.keeper.address).tx)).reason, 'round_state');
    s.devnet.add({ ...round, status: RoundStatus.Final });
    assert.equal(body(await s.core.attest((await strikeTx(s, 10n, samples)).tx)).reason, 'round_state');
    assert.equal(body(await s.core.attest((await strikeTx(s, 99n, samples)).tx)).reason, 'round_not_found');
  });

  test('a copy of the round away from its PDA: refused in the config slot before devnet, and in the round slot', async () => {
    const { s, round } = await strikeReady();
    const ix = await setStrike({ priceAuthority: s.keeper, roundId: 10n, samples: keeperSamples(round, 'strike'), attestor: ATTESTOR });
    // Another program account holding a copy of round 10.
    const impostor = testAddress(66);
    s.devnet.extra.set(impostor, { data: encodeRound(round), owner: PROGRAM_ID });
    const reads = s.devnet.reads;
    const inConfig = { ...ix, accounts: ix.accounts!.map((a, i) => (i === 0 ? { ...a, address: impostor } : a)) };
    assert.equal(body(await s.core.attest(wire([inConfig as typeof ix], s.keeper.address).tx)).reason, 'wrong_accounts');
    assert.equal(s.devnet.reads, reads);
    const inRound = { ...ix, accounts: ix.accounts!.map((a, i) => (i === 1 ? { ...a, address: impostor } : a)) };
    assert.equal(body(await s.core.attest(wire([inRound as typeof ix], s.keeper.address).tx)).reason, 'round_not_found');
  });

  test('no matched bank: an empty set_strike is co-signed (NotActivated reads no price); an activated round needs a price', async () => {
    const { s } = await strikeReady();
    s.devnet.add(makeRound(12n, OPENS, HIGGS_POOL, { rawUp: SOL / 100n, rawDown: 0n, positionCount: 1 }));
    const empty = await s.core.attest((await strikeTx(s, 12n, [])).tx);
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(s.logs.at(-1)?.verdict, 'not_activated');
    assert.equal(body(await s.core.attest((await strikeTx(s, 10n, [])).tx)).reason, 'unpriced');
  });

  test('fewer than five samples fix no price: refused as unpriced', async () => {
    const { s, round } = await strikeReady();
    const result = await s.core.attest((await strikeTx(s, 10n, keeperSamples(round, 'strike').slice(0, 4))).tx);
    assert.equal(body(result).reason, 'unpriced');
  });

  test('static checks run before any devnet read: attestor as fee payer', async () => {
    const { s, round } = await strikeReady();
    const reads = s.devnet.reads;
    const result = await s.core.attest((await strikeTx(s, 10n, keeperSamples(round, 'strike'), ATTESTOR)).tx);
    assert.equal(result.status, 422);
    assert.equal(body(result).reason, 'attestor_is_fee_payer');
    assert.equal(s.devnet.reads, reads);
  });

  test('devnet down: 503, nothing signed', async () => {
    const { s, round } = await strikeReady();
    s.devnet.down = true;
    const result = await s.core.attest((await strikeTx(s, 10n, keeperSamples(round, 'strike'))).tx);
    assert.equal(result.status, 503);
    assert.equal(body(result).reason, 'devnet_unavailable');
  });

  test('not configured: no key, or a tolerance that is not basis points', async () => {
    for (const env of [{}, { ATTESTOR_SECRET: 'not-a-key' }, { ATTESTOR_SECRET, ATTEST_TOLERANCE_BPS: '1.5%' }]) {
      const s = await setup(T0, env);
      const result = await s.core.attest('AQID');
      assert.equal(result.status, 503);
      assert.equal(body(result).reason, 'not_configured');
      assert.equal((await s.core.health()).status, 503);
    }
  });

  test('a tx that is not base64: 400', async () => {
    const s = await setup(T0);
    assert.equal(body(await s.core.attest('***')).reason, 'bad_request');
  });
});

test('health: key, sampler, rounds with their reads, recent attests with shared slots, the on-chain oracle', async () => {
  const s = await setup(T0 + 70_000);
  const round = s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL));
  s.devnet.add(makeRound(11n, OPENS + 60n, HIGGS_POOL));
  await s.core.ping();
  await runUntil(s, Number(round.strikeEnd) * 1000 + 2000);
  const samples = keeperSamples(round, 'strike');
  const shared = sharedWith(s, samples);
  await s.core.attest((await strikeTx(s, 10n, samples)).tx); // signed
  await s.core.attest((await strikeTx(s, 10n, samples.slice(0, 4))).tx); // unpriced: no comparison
  await s.core.attest((await strikeTx(s, 10n, samples.map((x) => ({ ...x, price: x.price + 1n })))).tx); // slot_price_mismatch
  const result = await s.core.health();
  assert.equal(result.status, 200);
  const h = result.body as any;
  assert.equal(h.attestor, ATTESTOR);
  assert.equal(h.toleranceBps, 150);
  assert.deepEqual(h.oracle, { attestor: ATTESTOR, required: true, matchesKey: true });
  assert.equal(h.sampler.nextRoundId, '12');
  assert.equal(h.sampler.windowsObserved, 1);
  assert.equal(h.sampler.samplesStored, 13);
  assert.equal(h.sampler.lastRefreshAt !== null, true);
  assert.deepEqual(
    h.sampler.rounds.map((r: any) => [r.id, r.status, r.strike.samples, r.exit.samples]),
    [
      ['10', 'open', 10, 0],
      ['11', 'open', 0, 0],
    ],
  );
  assert.deepEqual(h.sampler.devnet, ['devnet.test']);
  // Coverage: shared slots over the keeper samples of the attests that were compared.
  const { recent, since, coverage, ...totals } = h.attests;
  assert.equal(since !== null, true);
  assert.deepEqual(totals, { attests: 3, signed: 1, compared: 2, keeperSamples: 20, sharedSlots: 2 * shared });
  assert.equal(coverage, Math.round((shared / 10) * 100) / 100);
  assert.deepEqual(
    recent.map((r: any) => [r.round, r.instruction, r.result, r.keeperSamples, r.sharedSlots]),
    [
      ['10', 'set_strike', 'signed', 10, shared],
      ['10', 'set_strike', 'unpriced', 4, null],
      ['10', 'set_strike', 'slot_price_mismatch', 10, shared],
    ],
  );
  assert.ok(!JSON.stringify(h).includes(ATTESTOR_SECRET));
});

test('refresh interval: a devnet read at most every 15 s between windows', async () => {
  const s = await setup(T0 + 70_000);
  s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL));
  await s.core.ping();
  await runUntil(s, T0 + 70_000 + 4 * REFRESH_MS);
  // One read without a hint, one around next_round_id, then one per refresh.
  assert.equal(s.devnet.reads, 2 + 4);
});
