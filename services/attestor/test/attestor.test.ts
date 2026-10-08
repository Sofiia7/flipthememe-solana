// Run: node --test "services/attestor/test/*.test.ts" (from the repo root). No network.
// The Durable Object logic end to end: node:sqlite for storage.sql, a fake alarm, scripted devnet
// and mainnet RPCs, transactions built with the client's builders and kit.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { PROGRAM_ID, RoundStatus, setStrike, settle, type PriceSample, type RoundAccount } from '@flipthememe/client';
import { getBase58Encoder, partiallySignTransaction, getTransactionDecoder, type KeyPairSigner } from '@solana/kit';
import {
  ATTEST_DEVNET_BUDGET_MS,
  ATTEST_RETAIN_MS,
  AttestorCore,
  DEFAULT_MAX_TRIES,
  PRUNE_EVERY_MS,
  REFRESH_MS,
  RETAIN_MS,
  type AttestorEnv,
  type CoreOptions,
  type LogFields,
} from '../src/attestor.ts';
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
  modalRpc,
  priceOfState,
  slotAt,
  testAddress,
  toBytes,
  wire,
  type EndpointMode,
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

async function setup(startMs: number, env: AttestorEnv = { ATTESTOR_SECRET }, over?: (devnet: Devnet) => Partial<CoreOptions>): Promise<Setup> {
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
    ...over?.(devnet),
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
  test('public certificates use our own full window and survive eviction without changing the message', async () => {
    const s = await setup(T0 + 70_000);
    const round = makeRound(10n, OPENS, HIGGS_POOL);
    s.devnet.add(round);
    await s.core.tick();
    await runUntil(s, Number(round.strikeEnd) * 1000 + 2_000);
      const boundary = Number(round.strikeStart) * 1000;
      s.sql.exec('INSERT INTO samples (pool, at_ms, slot, price, strike_round) VALUES (?, ?, ?, ?, ?)', round.pool, boundary - 1, 999999, '123', 10);
      s.sql.exec('INSERT INTO samples (pool, at_ms, slot, price, strike_round) VALUES (?, ?, ?, ?, ?)', round.pool, boundary + 1, 999999, '123', 10);
    const first = await s.core.certificate('10', 'strike');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(Array.isArray(first.body.samples) && first.body.samples.length >= 5);
      assert.ok((first.body.samples as { slot: string }[]).some((s) => s.slot === '999999'), 'inside-window read survives a preceding margin read of its slot');
    const again = await s.core.certificate('10', 'strike');
    assert.deepEqual(again.body, first.body);
    const core = new AttestorCore({ sql: s.sql, alarms: s.alarms, env: { ATTESTOR_SECRET }, now: s.clock.now, devnet: new Failover([{ name: 'test', rpc: s.devnet.rpc() }], s.clock.now), mainnet: new Failover([{ name: 'test', rpc: s.mainnet.rpc() }], s.clock.now) });
    assert.deepEqual((await core.certificate('10', 'strike')).body, first.body);
  });
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

/** Round 10 (activated, Open) sampled through its strike window; the clock 1 s after it. */
async function strikeReady(env?: AttestorEnv, over?: (devnet: Devnet) => Partial<CoreOptions>) {
  const s = await setup(T0 + 70_000, env, over);
  const round = s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL));
  await s.core.ping();
  await runUntil(s, Number(round.strikeEnd) * 1000 + 1000);
  return { s, round };
}

describe('attest', () => {
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
    // Shared slots are exact whatever the tolerance.
    const shifted = keeperSamples(round, 'strike', { scale: (p) => p + 1n });
    assert.equal(body(await s.core.attest((await strikeTx(s, 10n, shifted)).tx)).reason, 'slot_price_mismatch');
    const high = keeperSamples(round, 'strike', { avoid: readSlots(s), scale: (p) => (p * 102n) / 100n });
    assert.equal((await s.core.attest((await strikeTx(s, 10n, high)).tx)).status, 200);
  });

  test('slot outside the window: samples from slots the attestor never saw', async () => {
    const { s, round } = await strikeReady();
    const later = keeperSamples(round, 'strike').map((x) => ({ ...x, slot: x.slot + 500n }));
    const result = await s.core.attest((await strikeTx(s, 10n, later)).tx);
    assert.equal(body(result).reason, 'slot_out_of_range');
  });

  test('too few samples: a window the attestor did not watch', async () => {
    const { s, round } = await strikeReady();
    // Round 11 is on devnet with the same windows, but on a pool the sampler never read.
    const missed = s.devnet.add(makeRound(11n, OPENS, testAddress(2)));
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

  test('fewer than five samples while the attestor read ten: refused as unpriced (the keeper is withholding or faulty)', async () => {
    const { s, round } = await strikeReady();
    const result = await s.core.attest((await strikeTx(s, 10n, keeperSamples(round, 'strike').slice(0, 4))).tx);
    assert.equal(body(result).reason, 'unpriced');
    assert.equal(s.logs.at(-1)?.ownSamples, 10);
  });

  test('a keeper that sends only the five highest of its ten reads is refused as samples_withheld', async () => {
    const { s, round } = await strikeReady();
    const samples = keeperSamples(round, 'strike');
    // The price drifts up, so the last five are the highest. The mean of those stays inside 150 bps.
    const result = await s.core.attest((await strikeTx(s, 10n, samples.slice(5))).tx);
    assert.equal(result.status, 422);
    assert.equal(body(result).reason, 'samples_withheld');
    assert.equal(s.logs.at(-1)?.result, 'samples_withheld');
    assert.equal(s.logs.at(-1)?.ownSamples, 10);
    assert.equal(s.logs.at(-1)?.required, 6);
    // Six of ten (four reads lost, 60 percent) are fine.
    assert.equal((await s.core.attest((await strikeTx(s, 10n, samples.slice(4))).tx)).status, 200);
  });

  describe('set_strike only before the exit window opens (the program rejects a later one)', () => {
    test('co-signed up to exit_start, refused as strike_too_late from then on', async () => {
      const { s, round } = await strikeReady();
      const { tx } = await strikeTx(s, 10n, keeperSamples(round, 'strike'));
      const exitStartMs = Number(round.exitStart) * 1000;
      s.clock.ms = exitStartMs - 1;
      assert.equal((await s.core.attest(tx)).status, 200);
      s.clock.ms = exitStartMs;
      const late = await s.core.attest(tx);
      assert.equal(late.status, 422);
      assert.equal(body(late).reason, 'strike_too_late');
      assert.equal(s.logs.at(-1)?.result, 'strike_too_late');
      s.clock.ms = exitStartMs + 5_000;
      assert.equal(body(await s.core.attest(tx)).reason, 'strike_too_late');
    });

    test('a round without a matched bank is held to the same window (the program checks it first)', async () => {
      const { s } = await strikeReady();
      const lonely = s.devnet.add(makeRound(12n, OPENS, HIGGS_POOL, { rawUp: SOL / 100n, rawDown: 0n, positionCount: 1 }));
      const { tx } = await strikeTx(s, 12n, []);
      const exitStartMs = Number(lonely.exitStart) * 1000;
      s.clock.ms = exitStartMs - 1;
      assert.equal((await s.core.attest(tx)).status, 200);
      assert.equal(s.logs.at(-1)?.verdict, 'not_activated');
      s.clock.ms = exitStartMs;
      assert.equal(body(await s.core.attest(tx)).reason, 'strike_too_late');
    });
  });

  describe('a corroborated outage: fewer than five samples on both sides', () => {
    /** Mainnet goes dark `afterMs` into the window: the attestor keeps only the reads before that. */
    async function outageAfter(afterMs: number, status: RoundStatus = RoundStatus.Open) {
      const s = await setup(T0 + 70_000);
      const round = s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL, status === RoundStatus.Live ? { status, strikePrice: 1n } : {}));
      const kind = status === RoundStatus.Live ? 'exit' : 'strike';
      const window = windowOf(round, kind);
      s.beforeTick = (ms) => {
        s.mainnet.down = ms >= window.startMs + afterMs;
      };
      await s.core.ping();
      await runUntil(s, window.endMs + 1000);
      const inside = rows(s).filter((r) => r.at_ms >= window.startMs && r.at_ms < window.endMs).length;
      return { s, round, kind, inside };
    }

    test('set_strike: the attestor read 4, the keeper sends 4 or none: co-signed, the program refunds it as Unpriceable', async () => {
      const { s, round, inside } = await outageAfter(4_000);
      assert.equal(inside, 4);
      // Round 11 has the same pool and windows: a second set for round 10 would be refused as already_signed.
      s.devnet.add(makeRound(11n, OPENS, HIGGS_POOL));
      for (const [roundId, samples] of [[10n, [] as PriceSample[]], [11n, keeperSamples(round, 'strike').slice(0, 4)]] as const) {
        const { tx, messageBytes } = await strikeTx(s, roundId, samples);
        const result = await s.core.attest(tx);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.ok(ed25519.verify(new Uint8Array(getBase58Encoder().encode(body(result).signature!)), messageBytes, ATTESTOR_PUBLIC));
        const log = s.logs.at(-1)!;
        assert.equal(log.signed, true);
        assert.equal(log.verdict, 'unpriceable');
        assert.equal(log.keeperSamples, samples.length);
        assert.equal(log.ownSamples, 4);
        assert.equal(log.sharedSlots, null); // no comparison ran
      }
      // The health report keeps the verdict, and counts them as signed without a comparison.
      const h = (await s.core.health()).body as any;
      assert.deepEqual(
        h.attests.recent.map((r: any) => [r.result, r.verdict, r.sharedSlots]),
        [
          ['signed', 'unpriceable', null],
          ['signed', 'unpriceable', null],
        ],
      );
      assert.equal(h.attests.compared, 0);
    });

    test('five or more keeper samples are compared, never waved through: the attestor cannot check a window it did not see', async () => {
      const { s, round } = await outageAfter(4_000);
      const result = await s.core.attest((await strikeTx(s, 10n, keeperSamples(round, 'strike'))).tx);
      assert.equal(result.status, 422);
      assert.equal(body(result).reason, 'slot_out_of_range');
    });

    test('the attestor read exactly 5: a keeper with fewer is refused as unpriced, not signed', async () => {
      const { s, round, inside } = await outageAfter(5_000);
      assert.equal(inside, 5);
      for (const samples of [[], keeperSamples(round, 'strike').slice(0, 4)]) {
        const result = await s.core.attest((await strikeTx(s, 10n, samples)).tx);
        assert.equal(result.status, 422);
        assert.equal(body(result).reason, 'unpriced');
        assert.equal(s.logs.at(-1)?.ownSamples, 5);
      }
    });

    test('settle: no reads at all of the exit window, the keeper sends none: co-signed; ten samples are refused', async () => {
      const { s, round, inside } = await outageAfter(0, RoundStatus.Live);
      assert.equal(inside, 0);
      const ten = await settle({ priceAuthority: s.keeper, roundId: 10n, samples: keeperSamples(round, 'exit'), attestor: ATTESTOR });
      const refused = await s.core.attest(wire([ten], s.keeper.address).tx);
      assert.equal(refused.status, 422);
      assert.equal(body(refused).reason, 'too_few_samples');
      const none = await settle({ priceAuthority: s.keeper, roundId: 10n, samples: [], attestor: ATTESTOR });
      const result = await s.core.attest(wire([none], s.keeper.address).tx);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(s.logs.at(-1)?.verdict, 'unpriceable');
      assert.equal(s.logs.at(-1)?.ownSamples, 0);
    });
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
    for (const env of [
      {},
      { ATTESTOR_SECRET: 'not-a-key' },
      { ATTESTOR_SECRET, ATTEST_TOLERANCE_BPS: '1.5%' },
      { ATTESTOR_SECRET, ATTEST_MAX_TRIES: '0' },
      { ATTESTOR_SECRET, ATTEST_MAX_TRIES: 'six' },
      { ATTESTOR_SECRET, ATTEST_MAX_TRIES: '101' },
    ]) {
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

describe('the lock on a signed window: one sample set per round and window (audit of 2026-10-07, H3)', () => {
  type Row = { round: number; kind: string; tries: number; samples_hash: string | null; signed_at_ms: number | null; updated_ms: number };
  const locks = (s: Setup) => s.sql.rows<Row>('SELECT * FROM attest_windows ORDER BY round, kind');
  const verifies = async (s: Setup, result: { body: Record<string, unknown> }, messageBytes: Uint8Array) => {
    const signature = new Uint8Array(getBase58Encoder().encode(body(result).signature!));
    assert.ok(ed25519.verify(signature, messageBytes, ATTESTOR_PUBLIC));
    return signature;
  };

  test('a different set for the same round and window is refused after the first signature, and counts for nothing', async () => {
    const { s, round } = await strikeReady();
    const samples = keeperSamples(round, 'strike');
    const first = await s.core.attest((await strikeTx(s, 10n, samples)).tx);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(locks(s).length, 1);
    assert.equal(locks(s)[0]!.tries, 1);
    assert.ok(locks(s)[0]!.samples_hash);

    // Another subset of the same real readings: every other check passes, the lock refuses it.
    for (const subset of [samples.slice(1), samples.slice(0, 9), samples.slice(2).reverse().sort((a, b) => Number(a.slot - b.slot))]) {
      const second = await s.core.attest((await strikeTx(s, 10n, subset)).tx);
      assert.equal(second.status, 422);
      assert.equal(body(second).reason, 'already_signed');
      assert.equal(body(second).signature, undefined);
      assert.match(body(second).error!, /different set of samples was already signed for the strike window/);
    }
    const log = s.logs.at(-1)!;
    assert.equal(log.result, 'already_signed');
    assert.equal(log.signed, false);
    // The refusals are not attempts: the pair still says one try, and the signed set still passes.
    assert.equal(locks(s)[0]!.tries, 1);
    assert.equal((await s.core.attest((await strikeTx(s, 10n, samples)).tx)).status, 200);
    // An empty list is a different set as well.
    assert.equal(body(await s.core.attest((await strikeTx(s, 10n, [])).tx)).reason, 'already_signed');
  });

  test('the same set again is signed again, also in a transaction with another message (a retry after a timeout)', async () => {
    const { s, round } = await strikeReady();
    const samples = keeperSamples(round, 'strike');
    const one = await strikeTx(s, 10n, samples);
    const two = await strikeTx(s, 10n, samples, testAddress(77));
    assert.notDeepEqual(one.messageBytes, two.messageBytes);
    const a = await s.core.attest(one.tx);
    const b = await s.core.attest(two.tx);
    const c = await s.core.attest(one.tx);
    for (const [result, bytes] of [[a, one.messageBytes], [b, two.messageBytes], [c, one.messageBytes]] as const) {
      assert.equal(result.status, 200, JSON.stringify(result.body));
      await verifies(s, result, bytes);
    }
    assert.equal(body(a).signature, body(c).signature); // Ed25519 is deterministic: the same message, the same signature
    assert.equal(locks(s)[0]!.tries, 1); // retries of the signed set are not attempts
  });

  test('the strike and the exit window of a round, and different rounds, are locked apart', async () => {
    const s = await setup(T0 + 70_000);
    const round = s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL));
    s.devnet.add(makeRound(11n, OPENS, HIGGS_POOL));
    await s.core.ping();
    await runUntil(s, Number(round.strikeEnd) * 1000 + 1000);
    const strike = keeperSamples(round, 'strike');
    assert.equal((await s.core.attest((await strikeTx(s, 10n, strike)).tx)).status, 200);
    // Round 11 is a round of its own: a different set is fine there.
    assert.equal((await s.core.attest((await strikeTx(s, 11n, strike.slice(2))).tx)).status, 200);
    // The exit window of round 10: its strike landed, the round is Live.
    s.devnet.add({ ...round, status: RoundStatus.Live, strikePrice: 1n });
    await runUntil(s, Number(round.exitEnd) * 1000 + 1000);
    const exit = keeperSamples(round, 'exit');
    const ix = await settle({ priceAuthority: s.keeper, roundId: 10n, samples: exit, attestor: ATTESTOR });
    assert.equal((await s.core.attest(wire([ix], s.keeper.address).tx)).status, 200);
    assert.deepEqual(locks(s).map((r) => [r.round, r.kind, r.samples_hash !== null]), [
      [10, 'exit', true],
      [10, 'strike', true],
      [11, 'strike', true],
    ]);
    const again = await settle({ priceAuthority: s.keeper, roundId: 10n, samples: exit.slice(1), attestor: ATTESTOR });
    assert.equal(body(await s.core.attest(wire([again], s.keeper.address).tx)).reason, 'already_signed');
  });

  test('a round without a matched bank is locked too (its empty set, then any other)', async () => {
    const { s } = await strikeReady();
    const lonely = s.devnet.add(makeRound(12n, OPENS, HIGGS_POOL, { rawUp: SOL / 100n, rawDown: 0n, positionCount: 1 }));
    assert.equal((await s.core.attest((await strikeTx(s, 12n, [])).tx)).status, 200);
    assert.equal(s.logs.at(-1)?.verdict, 'not_activated');
    assert.equal(body(await s.core.attest((await strikeTx(s, 12n, keeperSamples(lonely, 'strike'))).tx)).reason, 'already_signed');
  });

  test('the lock survives an eviction: a new core over the same storage still refuses the other set', async () => {
    const { s, round } = await strikeReady();
    const samples = keeperSamples(round, 'strike');
    assert.equal((await s.core.attest((await strikeTx(s, 10n, samples)).tx)).status, 200);
    const reborn = new AttestorCore({
      sql: s.sql,
      alarms: s.alarms,
      env: { ATTESTOR_SECRET },
      now: s.clock.now,
      devnet: new Failover([{ name: 'devnet.test', rpc: s.devnet.rpc() }], s.clock.now),
      mainnet: new Failover([{ name: 'mainnet.test', rpc: s.mainnet.rpc() }], s.clock.now),
      log: () => undefined,
    });
    assert.equal(body(await reborn.attest((await strikeTx(s, 10n, samples.slice(1))).tx)).reason, 'already_signed');
    assert.equal((await reborn.attest((await strikeTx(s, 10n, samples)).tx)).status, 200);
  });

  test('two different sets in flight at the same moment: one signature goes out, the other call is refused', async () => {
    const { s, round } = await strikeReady();
    const samples = keeperSamples(round, 'strike');
    const [a, b] = await Promise.all([
      s.core.attest((await strikeTx(s, 10n, samples)).tx),
      s.core.attest((await strikeTx(s, 10n, samples.slice(1))).tx),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 422]);
    assert.equal(body(a.status === 422 ? a : b).reason, 'already_signed');
    assert.equal(locks(s).length, 1);
  });

  test('the lock is forgotten after ATTEST_RETAIN_MS, long after the round could be priced', async () => {
    const { s, round } = await strikeReady();
    assert.equal((await s.core.attest((await strikeTx(s, 10n, keeperSamples(round, 'strike'))).tx)).status, 200);
    assert.equal(locks(s).length, 1);
    s.clock.ms += ATTEST_RETAIN_MS - 60_000;
    s.alarms.at = null;
    await s.core.tick();
    assert.equal(locks(s).length, 1, 'still there just before');
    s.clock.ms += PRUNE_EVERY_MS + 120_000;
    s.alarms.at = null;
    await s.core.tick();
    assert.equal(locks(s).length, 0);
  });

  describe('attempts per round and window (ATTEST_MAX_TRIES)', () => {
    test(`by default ${DEFAULT_MAX_TRIES} attempts that reach the samples are answered, the next is too_many_attempts, even for a good set`, async () => {
      const { s, round } = await strikeReady();
      const good = keeperSamples(round, 'strike');
      // Six different bad sets: each reaches the samples and is refused there (a keeper only 2 percent off).
      for (let i = 0; i < DEFAULT_MAX_TRIES; i++) {
        const bad = keeperSamples(round, 'strike', { avoid: readSlots(s), scale: (p) => (p * BigInt(102 + i)) / 100n });
        assert.equal(body(await s.core.attest((await strikeTx(s, 10n, bad)).tx)).reason, 'price_mismatch', `attempt ${i + 1}`);
      }
      assert.equal(locks(s)[0]!.tries, DEFAULT_MAX_TRIES);
      const last = await s.core.attest((await strikeTx(s, 10n, good)).tx);
      assert.equal(last.status, 422);
      assert.equal(body(last).reason, 'too_many_attempts');
      assert.match(body(last).error!, /6 attempts were made for the strike window/);
      assert.equal(s.logs.at(-1)?.result, 'too_many_attempts');
      assert.equal(locks(s)[0]!.tries, DEFAULT_MAX_TRIES); // a refused call is not another attempt
      assert.equal(locks(s)[0]!.samples_hash, null);
      // Another round is not affected.
      s.devnet.add(makeRound(11n, OPENS, HIGGS_POOL));
      assert.equal((await s.core.attest((await strikeTx(s, 11n, good)).tx)).status, 200);
    });

    test('ATTEST_MAX_TRIES sets the number; a signed set may be asked for again beyond it', async () => {
      const { s, round } = await strikeReady({ ATTESTOR_SECRET, ATTEST_MAX_TRIES: '2' });
      assert.equal(((await s.core.health()).body as { maxTries: number }).maxTries, 2);
      const bad = (scale: bigint) => keeperSamples(round, 'strike', { avoid: readSlots(s), scale: (p) => (p * scale) / 100n });
      assert.equal(body(await s.core.attest((await strikeTx(s, 10n, bad(103n))).tx)).reason, 'price_mismatch');
      const good = keeperSamples(round, 'strike');
      assert.equal((await s.core.attest((await strikeTx(s, 10n, good)).tx)).status, 200); // the second attempt
      for (let i = 0; i < 5; i++) assert.equal((await s.core.attest((await strikeTx(s, 10n, good)).tx)).status, 200);
      assert.equal(locks(s)[0]!.tries, 2);
    });

    test('calls that stop before the samples are not attempts: window_open, round_state, devnet down, static refusals', async () => {
      const { s, round } = await strikeReady({ ATTESTOR_SECRET, ATTEST_MAX_TRIES: '1' });
      const good = keeperSamples(round, 'strike');
      const { tx } = await strikeTx(s, 10n, good);
      s.clock.ms = Number(round.strikeEnd) * 1000 - 1;
      for (let i = 0; i < 4; i++) assert.equal(body(await s.core.attest(tx)).reason, 'window_open');
      s.clock.ms = Number(round.strikeEnd) * 1000 + 1000;
      s.devnet.down = true;
      for (let i = 0; i < 4; i++) assert.equal(body(await s.core.attest(tx)).reason, 'devnet_unavailable');
      s.devnet.down = false;
      s.clock.ms += 1_500; // the endpoint's backoff after its failure is 1 s
      assert.equal((await s.core.attest((await strikeTx(s, 10n, good, ATTESTOR)).tx)).status, 422); // attestor_is_fee_payer
      assert.equal(locks(s).length, 0);
      assert.equal((await s.core.attest(tx)).status, 200); // the one attempt is still there
    });
  });
});

describe('the devnet read of an attest call has one time budget, however many endpoints it tries', () => {
  const BUDGET_MS = 800;
  /** Two devnet endpoints, each switchable; the budget is shortened so the test runs in real time. */
  async function ready(mode: { a: EndpointMode; b: EndpointMode }, calls = { a: { n: 0 }, b: { n: 0 } }) {
    const ctx = await strikeReady(undefined, (devnet) => ({
      devnetBudgetMs: BUDGET_MS,
      devnet: new Failover(
        [
          { name: 'a', rpc: modalRpc(devnet, () => mode.a, calls.a) },
          { name: 'b', rpc: modalRpc(devnet, () => mode.b, calls.b) },
        ],
        () => 0,
      ),
    }));
    return { ...ctx, calls };
  }

  test('the budget is 6 s: inside the 8 s the keeper gives an attest call', () => {
    assert.equal(ATTEST_DEVNET_BUDGET_MS, 6_000);
  });

  test('two endpoints that hang: the call ends at the budget with devnet_unavailable, not at the sum of two timeouts', { timeout: 15_000 }, async () => {
    const mode = { a: 'ok' as EndpointMode, b: 'ok' as EndpointMode };
    const { s, round } = await ready(mode);
    const { tx } = await strikeTx(s, 10n, keeperSamples(round, 'strike'));
    mode.a = 'hang';
    mode.b = 'hang';
    const started = Date.now();
    const result = await s.core.attest(tx);
    const took = Date.now() - started;
    assert.equal(result.status, 503);
    assert.equal(body(result).reason, 'devnet_unavailable');
    // One budget: about 800 ms. Two timeouts of 800 ms each would be 1600.
    assert.ok(took >= BUDGET_MS - 50 && took < BUDGET_MS * 1.6, `took ${took} ms for a budget of ${BUDGET_MS}`);
  });

  test('a slow first endpoint leaves the second only what is left: a first that hangs ends the call', { timeout: 15_000 }, async () => {
    const mode = { a: 'ok' as EndpointMode, b: 'ok' as EndpointMode };
    const { s, round, calls } = await ready(mode);
    const { tx } = await strikeTx(s, 10n, keeperSamples(round, 'strike'));
    mode.a = 'hang';
    const before = calls.b.n;
    const started = Date.now();
    assert.equal(body(await s.core.attest(tx)).reason, 'devnet_unavailable');
    assert.ok(Date.now() - started < BUDGET_MS * 1.6);
    assert.equal(calls.b.n, before, 'the budget was gone before the fallback');
  });

  test('a first endpoint that fails at once: the fallback answers inside the budget', { timeout: 15_000 }, async () => {
    const mode = { a: 'ok' as EndpointMode, b: 'ok' as EndpointMode };
    const { s, round } = await ready(mode);
    const { tx } = await strikeTx(s, 10n, keeperSamples(round, 'strike'));
    mode.a = 'fail';
    const started = Date.now();
    const result = await s.core.attest(tx);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(Date.now() - started < BUDGET_MS);
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
  // The refusals come first: once a set is signed for a window, a different one is refused as already_signed.
  await s.core.attest((await strikeTx(s, 10n, samples.slice(0, 4))).tx); // unpriced: no comparison
  await s.core.attest((await strikeTx(s, 10n, samples.map((x) => ({ ...x, price: x.price + 1n })))).tx); // slot_price_mismatch
  await s.core.attest((await strikeTx(s, 10n, samples)).tx); // signed
  const result = await s.core.health();
  assert.equal(result.status, 200);
  const h = result.body as any;
  assert.equal(h.attestor, ATTESTOR);
  assert.equal(h.toleranceBps, 150);
  assert.equal(h.maxTries, DEFAULT_MAX_TRIES);
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
  const { recent, since, coverage, maxDiffBps, ...totals } = h.attests;
  assert.equal(since !== null, true);
  assert.deepEqual(totals, { attests: 3, signed: 1, compared: 2, keeperSamples: 20, sharedSlots: 2 * shared });
  assert.equal(coverage, Math.round((shared / 10) * 100) / 100);
  // The gap between the two means of the signed call, for tuning ATTEST_TOLERANCE_BPS.
  assert.equal(typeof maxDiffBps, 'number');
  assert.ok(maxDiffBps >= 0 && maxDiffBps <= 150, `maxDiffBps ${maxDiffBps}`);
  assert.deepEqual(recent.map((r: any) => [r.verdict, r.diffBps]), [[null, null], [null, null], ['agree', maxDiffBps]]);
  assert.deepEqual(
    recent.map((r: any) => [r.round, r.instruction, r.result, r.keeperSamples, r.sharedSlots]),
    [
      ['10', 'set_strike', 'unpriced', 4, null],
      ['10', 'set_strike', 'slot_price_mismatch', 10, shared],
      ['10', 'set_strike', 'signed', 10, shared],
    ],
  );
  assert.ok(!JSON.stringify(h).includes(ATTESTOR_SECRET));
});

test('health keeps the diffBps of every comparison; maxDiffBps is the largest of the signed ones', async () => {
  const s = await setup(T0 + 70_000);
  const round = s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL));
  await s.core.ping();
  await runUntil(s, Number(round.strikeEnd) * 1000 + 1000);
  const before = (await s.core.health()).body as any;
  assert.equal(before.attests.maxDiffBps, null);
  // 2% high, no shared slot: refused with its gap; then the same reads at their true prices: signed.
  const high = keeperSamples(round, 'strike', { avoid: readSlots(s), scale: (p) => (p * 102n) / 100n });
  assert.equal(body(await s.core.attest((await strikeTx(s, 10n, high)).tx)).reason, 'price_mismatch');
  const fair = keeperSamples(round, 'strike', { avoid: readSlots(s) });
  assert.equal((await s.core.attest((await strikeTx(s, 10n, fair)).tx)).status, 200);
  const { recent, maxDiffBps } = ((await s.core.health()).body as any).attests;
  const [refused, signed] = recent as { result: string; diffBps: number | null }[];
  assert.equal(refused?.result, 'price_mismatch');
  assert.ok(refused!.diffBps! > 150, `refused at ${refused?.diffBps} bps`);
  assert.equal(signed?.result, 'signed');
  assert.ok(signed!.diffBps! <= 150);
  assert.equal(maxDiffBps, signed!.diffBps); // the refused call's gap does not count: it is not what honest keepers show
});

test('refresh interval: a devnet read at most every 15 s between windows', async () => {
  const s = await setup(T0 + 70_000);
  s.devnet.add(makeRound(10n, OPENS, HIGGS_POOL));
  await s.core.ping();
  await runUntil(s, T0 + 70_000 + 4 * REFRESH_MS);
  // One read without a hint, one around next_round_id, then one per refresh.
  assert.equal(s.devnet.reads, 2 + 4);
});
