// Scheduler wiring against a fake devnet: which instruction each step signs, with which accounts
// and arguments. The fake chain never applies a transaction, so a second tick sees the same state.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  DEPTH_K,
  Outcome,
  PROGRAM_ID,
  RoundStatus,
  Side,
  SYSTEM_PROGRAM_ID,
  configAddress,
  houseLimitsAddress,
  oracleAddress,
  positionAddress,
  roundAddress,
  vaultAddress,
  type PositionAccount,
  type PriceObservation,
} from '@flipthememe/client';
import { address, generateKeyPairSigner, getPublicKeyFromAddress, verifySignature, type Address, type KeyPairSigner, type SignatureBytes } from '@solana/kit';
import { AttestorClient, NO_ATTESTOR } from '../src/attest.ts';
import { ChainClock } from '../src/chain.ts';
import { PositionCloser } from '../src/closer.ts';
import { loadConfig } from '../src/config.ts';
import type { LogFields } from '../src/log.ts';
import { ObservationStore } from '../src/observations.ts';
import { Scheduler } from '../src/scheduler.ts';
import type { PoolSelector, Selection } from '../src/selector.ts';
import { StateStore } from '../src/state.ts';
import { fakeAttestor } from './fake-attestor.ts';
import { FakeChain, SOL, makeConfig, makeRound, readAddress, readI64, readU32, readU64, type SentInstruction } from './fake-chain.ts';

const POOL = address('11111111111111111111111111111112');
const MINT = address('11111111111111111111111111111113');
const TREASURY = address('11111111111111111111111111111114');
const ADMIN_ELSEWHERE = address('11111111111111111111111111111115');
// Rounds in these tests are placed relative to the start of the current minute (unix seconds).
const MINUTE = Math.floor(Date.now() / 60_000) * 60;
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

type Harness = { chain: FakeChain; scheduler: Scheduler; signer: KeyPairSigner; store: ObservationStore; state: StateStore; logs: LogFields[] };

type HarnessOptions = {
  pool?: boolean;
  /** Separate PRICE_KEYPAIR / HOUSE_KEYPAIR signers; Config names them as the roles. */
  priceSigner?: KeyPairSigner;
  houseSigner?: KeyPairSigner;
  attestor?: AttestorClient;
  /** Builds the position closer (default: the scheduler's own, first scan a minute after start). */
  closer?: (chain: FakeChain, signer: KeyPairSigner, logs: LogFields[]) => PositionCloser;
};

async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'ftm-scheduler-'));
  dirs.push(dir);
  const signer = await generateKeyPairSigner();
  const chain = new FakeChain(signer.address);
  const house = opts.houseSigner?.address ?? signer.address;
  chain.house = house;
  chain.config = makeConfig(signer.address, { nextRoundId: 10n, houseAuthority: house, priceAuthority: opts.priceSigner?.address ?? signer.address });
  chain.vault = { authority: house, available: 2n * SOL, locked: 0n, bump: 255 };
  // What the upgrade runbook sets up: on-chain caps as the keeper defaults, no attestor required.
  chain.houseLimits = { roundCap: 50_000_000n, dailyCap: 2n * SOL, day: BigInt(Math.floor(Date.now() / 86_400_000)), spent: 0n, bump: 253 };
  chain.oracle = { attestor: NO_ATTESTOR, required: false, bump: 252 };
  const cfg = loadConfig({ STATE_FILE: join(dir, 'state.json') }, dir);
  const state = new StateStore(cfg.stateFile, Date.now());
  const store = new ObservationStore();
  const logs: LogFields[] = [];
  const selection: Selection = { pool: POOL, baseMint: MINT, name: 'TEST / SOL', selectedAtMs: Date.now(), rung: 0, fallback: false, quoteReserve: 400n * SOL, reserveAtMs: Date.now() };
  const selector = { current: opts.pool === false ? null : selection } as unknown as PoolSelector;
  const scheduler = new Scheduler({
    rpc: chain.rpc(),
    signer,
    priceSigner: opts.priceSigner,
    houseSigner: opts.houseSigner,
    attestor: opts.attestor,
    closer: opts.closer?.(chain, signer, logs),
    cfg,
    state,
    selector,
    store,
    clock: new ChainClock(0),
    logger: (f) => logs.push(f),
  });
  return { chain, scheduler, signer, store, state, logs };
}

async function tick(h: Harness, nowSecs: number): Promise<void> {
  await h.scheduler.tick(nowSecs * 1000);
  await h.scheduler.drain(5_000);
}

const obs = (atMs: number, slot: number): PriceObservation => ({
  atMs,
  slot: BigInt(slot),
  baseAmount: 1_000_000_000_000n,
  quoteAmount: 400n * SOL,
  price: 1_000_000n + BigInt(slot),
});

function only(h: Harness): SentInstruction {
  assert.equal(h.chain.sent.length, 1, `expected one transaction, got ${h.chain.sent.map((t) => t.map((i) => i.name).join('+')).join(', ')}`);
  const [ix] = h.chain.sent[0] ?? [];
  assert.ok(ix);
  return ix;
}

async function byRound(h: Harness, id: bigint): Promise<SentInstruction[][]> {
  const key = await roundAddress(id);
  return h.chain.sent.filter((tx) => tx.some((ix) => ix.accounts.includes(key)));
}

describe('scheduler', () => {
  test('creates the next minute round 10 s before it opens, sized by the pool depth, once', async () => {
    const h = await harness();
    const now = MINUTE + 50;
    h.chain.rounds.set(9n, makeRound(9n, BigInt(MINUTE), POOL, MINT));
    h.store.add(POOL, obs(now * 1000 - 400, 1));
    await tick(h, now);
    const ix = only(h);
    assert.equal(ix.name, 'createRound');
    assert.equal(readU64(ix.data, 8), 10n); // round id = next_round_id
    assert.equal(readAddress(ix.data, 16), MINT);
    assert.equal(readAddress(ix.data, 48), POOL);
    assert.equal(readI64(ix.data, 80), BigInt(MINUTE + 60)); // opens_at: next minute boundary
    assert.equal(readI64(ix.data, 88), BigInt(MINUTE + 120)); // cutoff_at
    assert.equal(readI64(ix.data, 128), BigInt(MINUTE + 60 + 760)); // settle_deadline
    assert.equal(readU64(ix.data, 136), 160_000_000n); // max_bank = 400 SOL / 2500
    assert.deepEqual(ix.accounts, [await configAddress(), await roundAddress(10n), h.signer.address, SYSTEM_PROGRAM_ID]);
    assert.ok(h.logs.some((l) => l.step === 'create' && l.round === 10n && typeof l.sig === 'string'));
    // The chain has not caught up yet (the fake never applies it): no second create.
    await tick(h, now + 1);
    assert.equal(h.chain.sent.length, 1);
  });

  test('opens no round without a pool or without a fresh price observation', async () => {
    const stale = await harness();
    stale.store.add(POOL, obs((MINUTE + 50) * 1000 - 20_000, 1));
    await tick(stale, MINUTE + 50);
    assert.equal(stale.chain.sent.length, 0);
    assert.ok(stale.logs.some((l) => l.event === 'create_skipped'));
    const noPool = await harness({ pool: false });
    await tick(noPool, MINUTE + 50);
    assert.equal(noPool.chain.sent.length, 0);
  });

  test('opens no round on a pool too shallow to activate it, and keeps serving the rounds in flight', async () => {
    const h = await harness();
    const now = MINUTE + 50;
    // Audit A12: the pool fell to 1 SOL, max_bank 1 SOL / 2500 = 0.0004 SOL against min_bank 0.02 SOL.
    h.store.add(POOL, { ...obs(now * 1000 - 400, 1), quoteAmount: SOL });
    h.chain.rounds.set(8n, makeRound(8n, BigInt(now - 102), POOL, MINT)); // strike
    h.chain.rounds.set(7n, makeRound(7n, BigInt(now - 400), POOL, MINT, { status: RoundStatus.Final, outcome: Outcome.NotActivated })); // close
    h.chain.rounds.set(6n, makeRound(6n, BigInt(now - 162), POOL, MINT, { status: RoundStatus.Live, rawUp: 50_000_000n, rawDown: 50_000_000n, positionCount: 2 })); // settle
    await tick(h, now);
    await tick(h, now + 1);
    assert.deepEqual(h.chain.sent.map((tx) => tx[0]?.name).sort(), ['closeEmptyRound', 'setStrike', 'settle']);
    assert.deepEqual(h.logs.find((l) => l.event === 'round_skipped_shallow_pool'), {
      event: 'round_skipped_shallow_pool',
      pool: POOL,
      reserve: SOL,
      maxBank: 400_000n,
      minBank: 20_000_000n,
    });
  });

  test('max_bank must reach min_bank as Config sets it: K x min_bank opens a round, one lamport less does not', async () => {
    const now = MINUTE + 50;
    const minBank = SOL / 10n; // not the 0.02 SOL default: the check reads Config
    const open = async (reserve: bigint): Promise<Harness> => {
      const h = await harness();
      if (!h.chain.config) throw new Error('no config');
      h.chain.config = { ...h.chain.config, minBank };
      h.store.add(POOL, { ...obs(now * 1000 - 400, 1), quoteAmount: reserve });
      await tick(h, now);
      return h;
    };
    const below = await open(DEPTH_K * minBank - 1n);
    assert.equal(below.chain.sent.length, 0);
    assert.equal(below.logs.find((l) => l.event === 'round_skipped_shallow_pool')?.maxBank, minBank - 1n);
    const at = await open(DEPTH_K * minBank);
    assert.equal(readU64(only(at).data, 136), minBank); // max_bank
  });

  test('house fill: tops up the empty side of a lone bet and books it against the daily budget', async () => {
    const h = await harness();
    const now = MINUTE + 30;
    h.chain.rounds.set(9n, makeRound(9n, BigInt(now - 65), POOL, MINT, { rawUp: 50_000_000n, positionCount: 1 }));
    await tick(h, now);
    const ix = only(h);
    assert.equal(ix.name, 'houseFill');
    assert.equal(readU64(ix.data, 8), 50_000_000n);
    const round = await roundAddress(9n);
    assert.deepEqual(ix.accounts, [
      await configAddress(),
      round,
      await vaultAddress(h.signer.address),
      await houseLimitsAddress(),
      await positionAddress(round, h.signer.address),
      h.signer.address,
      SYSTEM_PROGRAM_ID,
    ]);
    assert.equal(h.state.state.house.spent, 50_000_000n);
    assert.deepEqual(h.state.state.house.rounds, ['9']);
  });

  test('strike carries the strike-window samples; a round without a matched bank carries none', async () => {
    const h = await harness();
    const now = MINUTE + 30;
    const played = makeRound(8n, BigInt(now - 102), POOL, MINT, { rawUp: 50_000_000n, rawDown: 50_000_000n, positionCount: 2 });
    h.chain.rounds.set(8n, played);
    h.chain.rounds.set(7n, makeRound(7n, BigInt(now - 103), POOL, MINT));
    for (let k = 0; k < 12; k++) h.store.add(POOL, obs(Number(played.strikeStart) * 1000 + k * 900, 100 + k));
    await tick(h, now);
    const [playedTx] = await byRound(h, 8n);
    const [emptyTx] = await byRound(h, 7n);
    assert.equal(playedTx?.[0]?.name, 'setStrike');
    assert.equal(readU32(playedTx?.[0]?.data ?? new Uint8Array(12), 8), 12);
    assert.equal(readU64(playedTx?.[0]?.data ?? new Uint8Array(20), 12), 100n); // first sample: lowest slot
    // No attestor: the program id fills the optional attestor slot after OracleConfig.
    assert.deepEqual(playedTx?.[0]?.accounts, [await configAddress(), await roundAddress(8n), h.signer.address, await oracleAddress(), PROGRAM_ID]);
    assert.equal(emptyTx?.[0]?.name, 'setStrike');
    assert.equal(readU32(emptyTx?.[0]?.data ?? new Uint8Array(12), 8), 0);
  });

  test('settle carries the exit-window samples', async () => {
    const h = await harness();
    const now = MINUTE + 30;
    const live = makeRound(6n, BigInt(now - 162), POOL, MINT, { status: RoundStatus.Live, rawUp: 50_000_000n, rawDown: 50_000_000n, positionCount: 2 });
    h.chain.rounds.set(6n, live);
    for (let k = 0; k < 6; k++) h.store.add(POOL, obs(Number(live.exitStart) * 1000 + k * 1_000, 300 + k));
    await tick(h, now);
    const ix = only(h);
    assert.equal(ix.name, 'settle');
    assert.equal(readU32(ix.data, 8), 6);
  });

  test('claims every unclaimed position, five per transaction', async () => {
    const h = await harness();
    const id = 5n;
    const round = await roundAddress(id);
    h.chain.rounds.set(id, makeRound(id, BigInt(MINUTE - 200), POOL, MINT, { status: RoundStatus.Final, outcome: Outcome.Up, positionCount: 8, claimedCount: 1, rawUp: SOL / 10n, rawDown: SOL / 10n }));
    const owners: Address[] = [];
    for (let i = 0; i < 8; i++) owners.push((await generateKeyPairSigner()).address);
    const positions: PositionAccount[] = owners.map((owner, i) => ({
      round,
      authority: owner,
      side: i % 2 === 0 ? Side.Up : Side.Down,
      stake: SOL / 100n,
      face: new Uint8Array(8),
      isHouse: false,
      claimed: i === 3,
      payout: 0n,
      bump: 250,
    }));
    h.chain.positions.set(id, positions);
    await tick(h, MINUTE + 30);
    assert.deepEqual(h.chain.sent.map((tx) => tx.length), [5, 2]);
    const claimed = h.chain.sent.flat();
    assert.ok(claimed.every((ix) => ix.name === 'claim'));
    const expected = owners.filter((_, i) => i !== 3);
    assert.deepEqual(claimed.map((ix) => ix.accounts[3]), await Promise.all(expected.map((o) => vaultAddress(o))));
    for (const [i, ix] of claimed.entries()) {
      const owner = expected[i] as Address;
      assert.deepEqual(ix.accounts, [await configAddress(), round, await positionAddress(round, owner), await vaultAddress(owner)]);
    }
  });

  test('at most two transactions at once, time-critical steps first', async () => {
    const h = await harness();
    const now = MINUTE + 50;
    h.store.add(POOL, obs(now * 1000 - 300, 1));
    h.chain.rounds.set(9n, makeRound(9n, BigInt(now - 65), POOL, MINT, { rawUp: 50_000_000n, positionCount: 1 })); // fill
    h.chain.rounds.set(8n, makeRound(8n, BigInt(now - 102), POOL, MINT)); // strike
    h.chain.rounds.set(7n, makeRound(7n, BigInt(now - 400), POOL, MINT, { status: RoundStatus.Final, outcome: Outcome.NotActivated })); // close
    await tick(h, now);
    assert.deepEqual(h.chain.sent.map((tx) => tx[0]?.name).sort(), ['createRound', 'houseFill']);
    await tick(h, now + 1);
    assert.deepEqual(h.chain.sent.slice(2).map((tx) => tx[0]?.name).sort(), ['closeEmptyRound', 'setStrike']);
  });

  test('sweep pays config.treasury, close refunds config.admin, a round past its deadline is refunded', async () => {
    const h = await harness();
    if (!h.chain.config) throw new Error('no config');
    h.chain.config = { ...h.chain.config, treasury: TREASURY, admin: ADMIN_ELSEWHERE };
    const now = MINUTE + 30;
    h.chain.rounds.set(6n, makeRound(6n, BigInt(now - 300), POOL, MINT, { status: RoundStatus.Final, outcome: Outcome.Down, positionCount: 2, claimedCount: 2 }));
    h.chain.rounds.set(5n, makeRound(5n, BigInt(now - 400), POOL, MINT, { status: RoundStatus.Final, outcome: Outcome.NotActivated }));
    h.chain.rounds.set(4n, makeRound(4n, BigInt(now - 800), POOL, MINT, { status: RoundStatus.Open, rawUp: 30_000_000n, positionCount: 1 }));
    await tick(h, now);
    assert.equal(h.chain.sent.length, 2); // at most two at once; the third goes out next tick
    await tick(h, now + 1);
    const [sweep] = (await byRound(h, 6n))[0] ?? [];
    const [close] = (await byRound(h, 5n))[0] ?? [];
    const [expire] = (await byRound(h, 4n))[0] ?? [];
    assert.equal(sweep?.name, 'sweepFees');
    assert.deepEqual(sweep?.accounts, [await configAddress(), await roundAddress(6n), TREASURY]);
    assert.equal(close?.name, 'closeEmptyRound');
    assert.deepEqual(close?.accounts, [await configAddress(), await roundAddress(5n), ADMIN_ELSEWHERE]);
    assert.equal(expire?.name, 'refundExpired');
    assert.deepEqual(expire?.accounts, [await roundAddress(4n)]);
    assert.equal(h.chain.sent.length, 3);
  });
});

describe('scheduler: October 2026 upgrade', () => {
  const lone = (now: number) => makeRound(9n, BigInt(now - 65), POOL, MINT, { rawUp: 50_000_000n, positionCount: 1 });
  const played = (now: number) => makeRound(8n, BigInt(now - 102), POOL, MINT, { rawUp: 50_000_000n, rawDown: 50_000_000n, positionCount: 2 });
  const withSamples = (h: Harness, round: ReturnType<typeof played>) => {
    for (let k = 0; k < 6; k++) h.store.add(POOL, obs(Number(round.strikeStart) * 1000 + k * 900, 100 + k));
  };
  const limitsOf = (h: Harness) => {
    if (!h.chain.houseLimits) throw new Error('no house limits');
    return h.chain.houseLimits;
  };
  function makeClient(fetch: ConstructorParameters<typeof AttestorClient>[0]['fetch']): AttestorClient {
    return new AttestorClient({ url: 'https://attest.example', fetch, pauseMs: 1 });
  }

  test('house fill: never more than the on-chain round cap; a spent on-chain daily cap skips with a clear log', async () => {
    const now = MINUTE + 30;
    const capped = await harness();
    capped.chain.houseLimits = { ...limitsOf(capped), roundCap: 30_000_000n };
    capped.chain.rounds.set(9n, lone(now));
    await tick(capped, now);
    assert.equal(readU64(only(capped).data, 8), 30_000_000n);

    const spent = await harness();
    spent.chain.houseLimits = { ...limitsOf(spent), spent: 2n * SOL };
    spent.chain.rounds.set(9n, lone(now));
    await tick(spent, now);
    assert.equal(spent.chain.sent.length, 0);
    assert.deepEqual(spent.logs.find((l) => l.event === 'fill_skipped_onchain_cap'), {
      round: 9n,
      step: 'fill',
      skipped: 'chain-daily-cap',
      rawUp: 50_000_000n,
      rawDown: 0n,
      event: 'fill_skipped_onchain_cap',
      roundCap: 50_000_000n,
      houseAmount: 0n,
      dailyCap: 2n * SOL,
      spentToday: 2n * SOL,
    });

    // Spent on an earlier UTC day: the program starts the new day from zero, so does the keeper.
    const yesterday = await harness();
    yesterday.chain.houseLimits = { ...limitsOf(yesterday), day: limitsOf(yesterday).day - 1n, spent: 2n * SOL };
    yesterday.chain.rounds.set(9n, lone(now));
    await tick(yesterday, now);
    assert.equal(readU64(only(yesterday).data, 8), 50_000_000n);
  });

  test('house fill: no HouseLimits account, no fill', async () => {
    const h = await harness();
    h.chain.houseLimits = null;
    h.chain.rounds.set(9n, lone(MINUTE + 30));
    await tick(h, MINUTE + 30);
    assert.equal(h.chain.sent.length, 0);
    assert.ok(h.logs.some((l) => l.event === 'house_limits_missing'));
  });

  test('separate price and house keys: each signs its own step, the keeper key pays every fee', async () => {
    const price = await generateKeyPairSigner();
    const house = await generateKeyPairSigner();
    const h = await harness({ priceSigner: price, houseSigner: house });
    h.chain.wallets.set(house.address, SOL);
    const now = MINUTE + 30;
    h.chain.rounds.set(9n, lone(now));
    h.chain.rounds.set(8n, played(now));
    withSamples(h, played(now));
    await tick(h, now);
    const fillAt = h.chain.sent.findIndex((tx) => tx[0]?.name === 'houseFill');
    const strikeAt = h.chain.sent.findIndex((tx) => tx[0]?.name === 'setStrike');
    const round9 = await roundAddress(9n);
    assert.deepEqual(h.chain.sent[fillAt]?.[0]?.accounts, [
      await configAddress(),
      round9,
      await vaultAddress(house.address),
      await houseLimitsAddress(),
      await positionAddress(round9, house.address),
      house.address,
      SYSTEM_PROGRAM_ID,
    ]);
    assert.equal(h.chain.sent[strikeAt]?.[0]?.accounts[2], price.address);
    assert.deepEqual(Object.keys(h.chain.signed[fillAt]?.signatures ?? {}), [h.signer.address, house.address]);
    assert.deepEqual(Object.keys(h.chain.signed[strikeAt]?.signatures ?? {}), [h.signer.address, price.address]);
  });

  test('attested strike: the attestor co-signs; accounts are config, round, price authority, oracle, attestor', async () => {
    const att = await fakeAttestor();
    const h = await harness({ attestor: makeClient(att.fetch) });
    h.chain.oracle = { attestor: att.address, required: true, bump: 252 };
    const now = MINUTE + 30;
    h.chain.rounds.set(8n, played(now));
    withSamples(h, played(now));
    await tick(h, now);
    const ix = only(h);
    assert.equal(ix.name, 'setStrike');
    assert.deepEqual(ix.accounts, [await configAddress(), await roundAddress(8n), h.signer.address, await oracleAddress(), att.address]);
    const tx = h.chain.signed[0];
    assert.ok(tx);
    const signature = tx.signatures[att.address];
    assert.ok(signature && (await verifySignature(await getPublicKeyFromAddress(att.address), signature as SignatureBytes, tx.messageBytes)));
    assert.ok(h.logs.some((l) => l.event === 'attest_ok' && l.round === 8n && l.step === 'strike'));
    assert.equal(h.logs.find((l) => l.step === 'strike' && typeof l.sig === 'string')?.attested, true);
  });

  test('a required attestor that refuses: nothing is sent, and the step is retried later', async () => {
    const att = await fakeAttestor();
    att.mode = 'refuse';
    const h = await harness({ attestor: makeClient(att.fetch) });
    h.chain.oracle = { attestor: att.address, required: true, bump: 252 };
    const now = MINUTE + 30;
    h.chain.rounds.set(6n, makeRound(6n, BigInt(now - 162), POOL, MINT, { status: RoundStatus.Live, rawUp: 50_000_000n, rawDown: 50_000_000n, positionCount: 2 }));
    await tick(h, now);
    assert.equal(h.chain.sent.length, 0);
    assert.deepEqual(h.logs.find((l) => l.event === 'attest_refused'), {
      event: 'attest_refused',
      round: 6n,
      step: 'settle',
      reason: 'samples disagree',
      status: 422,
      attempts: 1,
      required: true,
    });
    assert.equal(h.logs.find((l) => l.step === 'settle' && 'error' in l)?.error, 'attestation refused: samples disagree');
  });

  test('an attestor that is not required yet: an outage falls back to the price without it', async () => {
    const att = await fakeAttestor();
    att.mode = 'down';
    const h = await harness({ attestor: makeClient(att.fetch) });
    h.chain.oracle = { attestor: att.address, required: false, bump: 252 };
    const now = MINUTE + 30;
    h.chain.rounds.set(8n, played(now));
    withSamples(h, played(now));
    await tick(h, now);
    assert.equal(only(h).accounts[4], PROGRAM_ID); // no attestor in the slot
    assert.deepEqual(h.logs.find((l) => l.event === 'attest_failed'), {
      event: 'attest_failed',
      round: 8n,
      step: 'strike',
      reason: 'HTTP 503: unavailable',
      attempts: 2,
      required: false,
    });
    assert.equal(h.logs.find((l) => l.step === 'strike' && typeof l.sig === 'string')?.attested, false);
  });

  test('no attestor for an unmatched strike; nothing sent without ATTEST_URL when required, or without OracleConfig', async () => {
    const att = await fakeAttestor();
    const now = MINUTE + 30;
    const h = await harness({ attestor: makeClient(att.fetch) });
    h.chain.oracle = { attestor: att.address, required: true, bump: 252 };
    h.chain.rounds.set(7n, makeRound(7n, BigInt(now - 103), POOL, MINT, { rawUp: 50_000_000n, positionCount: 1 }));
    await tick(h, now);
    assert.equal(only(h).accounts[4], PROGRAM_ID);
    assert.equal(att.seen.length, 0);

    const noUrl = await harness();
    noUrl.chain.oracle = { attestor: att.address, required: true, bump: 252 };
    noUrl.chain.rounds.set(8n, played(now));
    await tick(noUrl, now);
    assert.equal(noUrl.chain.sent.length, 0);
    assert.ok(noUrl.logs.some((l) => l.event === 'attestor_required_no_url'));

    const noOracle = await harness();
    noOracle.chain.oracle = null;
    noOracle.chain.rounds.set(8n, played(now));
    await tick(noOracle, now);
    assert.equal(noOracle.chain.sent.length, 0);
    assert.ok(noOracle.logs.some((l) => l.event === 'oracle_missing'));
  });

  test('paid positions are closed only when nothing else is in flight, in the quiet part of the minute', async () => {
    const h = await harness({ closer: (chain, signer, logs) => new PositionCloser({ rpc: chain.rpc(), signer, logger: (f) => logs.push(f), startMs: 0 }) });
    const round5 = await roundAddress(5n);
    const round4 = await roundAddress(4n);
    const owners = [(await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address];
    const position = (round: Address, authority: Address, claimed: boolean): PositionAccount => ({
      round,
      authority,
      side: Side.Up,
      stake: SOL / 100n,
      face: new Uint8Array(8),
      isHouse: false,
      claimed,
      payout: 0n,
      bump: 250,
    });
    // Round 5 is done (claimed and swept) and two days old; round 4 still has a claim to make.
    h.chain.rounds.set(5n, makeRound(5n, BigInt(MINUTE - 2 * 86_400), POOL, MINT, { status: RoundStatus.Final, outcome: Outcome.Up, positionCount: 2, claimedCount: 2, feesSwept: true }));
    h.chain.positions.set(5n, owners.map((owner) => position(round5, owner, true)));
    h.chain.rounds.set(4n, makeRound(4n, BigInt(MINUTE - 3 * 86_400), POOL, MINT, { status: RoundStatus.Final, outcome: Outcome.Up, positionCount: 1, claimedCount: 0 }));
    h.chain.positions.set(4n, [position(round4, owners[0] as Address, false)]);
    const scans = () => h.logs.filter((l) => l.event === 'positions_scan').length;

    await tick(h, MINUTE + 10); // the claim of round 4 goes out: no scan beside it
    assert.deepEqual([h.chain.sent.map((tx) => tx[0]?.name), scans()], [['claim'], 0]);
    await tick(h, MINUTE + 11); // the claim is cooling down and nothing is in flight: scan
    assert.deepEqual(h.logs.find((l) => l.event === 'positions_scan'), { event: 'positions_scan', claimed: 2, closable: 2, lamports: 4_000_000n, waiting: 0, skipped: 0 });
    await tick(h, MINUTE + 15); // within CLOSE_INTERVAL_MS of the scan
    await tick(h, MINUTE + 40); // strike, settle, claims and the next create own the end of the minute
    assert.equal(h.chain.sent.length, 1);
    await tick(h, MINUTE + 21);
    assert.deepEqual(h.chain.sent.slice(1).map((tx) => tx.map((ix) => ix.name)), [['closePosition', 'closePosition']]);
    assert.deepEqual(h.chain.sent[1]?.[0]?.accounts, [round5, await positionAddress(round5, owners[0] as Address), owners[0]]);
  });
});
