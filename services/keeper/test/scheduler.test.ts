// Scheduler wiring against a fake devnet: which instruction each step signs, with which accounts
// and arguments. The fake chain never applies a transaction, so a second tick sees the same state.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test, type TestContext } from 'node:test';
import {
  DEPTH_K,
  Outcome,
  PROGRAM_ID,
  RefundReason,
  RoundStatus,
  Side,
  SYSTEM_PROGRAM_ID,
  configAddress,
  houseLimitsAddress,
  oracleAddress,
  positionAddress,
  roundAddress,
  vaultAddress,
  attestedPriceInstructions,
  ED25519_PROGRAM,
  type PositionAccount,
  type PriceObservation,
} from '@flipthememe/client';
import { address, generateKeyPairSigner, getPublicKeyFromAddress, verifySignature, type Address, type KeyPairSigner, type SignatureBytes } from '@solana/kit';
import { AttestRefused, AttestorClient, NO_ATTESTOR } from '../src/attest.ts';
import { ChainClock } from '../src/chain.ts';
import { PositionCloser } from '../src/closer.ts';
import { loadConfig } from '../src/config.ts';
import type { LogFields } from '../src/log.ts';
import { JsonlFile } from '../src/jsonl.ts';
import { ObservationStore } from '../src/observations.ts';
import { RoundLog } from '../src/roundlog.ts';
import { CLAIM_RETRY_MS, CLOCK_WARN_MS, ClaimIncomplete, Scheduler, retryDelayMs } from '../src/scheduler.ts';
import type { PoolSelector, Selection } from '../src/selector.ts';
import { StateStore } from '../src/state.ts';
import { fakeAttestor } from './fake-attestor.ts';
import { FAKE_POSITION_RENT, FakeChain, SOL, makeConfig, makeRound, readAddress, readI64, readU32, readU64, type SentInstruction } from './fake-chain.ts';

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
  certificates?: ConstructorParameters<typeof Scheduler>[0]['certificates'];
  marketReady?: ConstructorParameters<typeof Scheduler>[0]['marketReady'];
  /** Builds the position closer (default: the scheduler's own, first scan a minute after start). */
  closer?: (chain: FakeChain, signer: KeyPairSigner, logs: LogFields[]) => PositionCloser;
  /** Environment of loadConfig on top of the test's own (the house budget is not spread over the day here). */
  env?: Record<string, string>;
  /** When the selector picked the pool (default: an hour ago, so the house is not in its post-switch pause). */
  selectedAtMs?: number;
  roundLog?: RoundLog;
  /** The keeper's estimate of devnet's clock minus its own, in ms (default 0). */
  clockOffsetMs?: number;
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
  const cfg = loadConfig({ STATE_FILE: join(dir, 'state.json'), HOUSE_PACE_DIVISOR: '0', LEGACY_PRICES: 'true', ...opts.env }, dir);
  const state = new StateStore(cfg.stateFile, Date.now());
  const store = new ObservationStore();
  const logs: LogFields[] = [];
  const selection: Selection = { pool: POOL, baseMint: MINT, name: 'TEST / SOL', selectedAtMs: opts.selectedAtMs ?? Date.now() - 3_600_000, rung: 0, fallback: false, quoteReserve: 400n * SOL, reserveAtMs: Date.now() };
  const selector = { current: opts.pool === false ? null : selection } as unknown as PoolSelector;
  const scheduler = new Scheduler({
    rpc: chain.rpc(),
    signer,
    priceSigner: opts.priceSigner,
    houseSigner: opts.houseSigner,
    attestor: opts.attestor,
    certificates: opts.certificates,
    marketReady: opts.marketReady,
    closer: opts.closer?.(chain, signer, logs),
    roundLog: opts.roundLog,
    cfg,
    state,
    selector,
    store,
    clock: new ChainClock(opts.clockOffsetMs ?? 0),
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
  test('an unobserved market never accepts a round; a ready one can open normally', async () => {
    let reason: string | null = 'observing market: 9/10 priced shadow minutes';
    const h = await harness({ marketReady: async () => reason });
    const now = MINUTE + 50;
    h.store.add(POOL, obs(now * 1000 - 400, 1));
    await tick(h, now);
    assert.equal(h.chain.sent.length, 0);
    assert.ok(h.logs.some((l) => l.reason === reason));
    reason = null;
    h.store.add(POOL, obs((now + 60) * 1000 - 400, 2));
    await tick(h, now + 60);
    assert.equal(only(h).name, 'createRound');
  });
  test('creates the next minute round 10 s before it opens, sized by the pool depth, once', async () => {
    const h = await harness();
    const now = MINUTE + 50;
    h.chain.rounds.set(9n, makeRound(9n, BigInt(MINUTE), POOL, MINT, { maxBank: 40_000_000n }));
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
    assert.equal(readU64(ix.data, 136), 40_000_000n); // a quarter of the shared 400 SOL / 2500 budget, with 0.04 already committed
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
      maxBank: 0n,
      minBank: 20_000_000n,
    });
  });

  test('max_bank must reach min_bank as Config sets it: 4 x K x min_bank sustains overlapping rounds, one lamport less does not', async () => {
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
    const below = await open(4n * DEPTH_K * minBank - 1n);
    assert.equal(below.chain.sent.length, 0);
    assert.equal(below.logs.find((l) => l.event === 'round_skipped_shallow_pool')?.maxBank, minBank - 1n);
    const at = await open(4n * DEPTH_K * minBank);
    assert.equal(readU64(only(at).data, 136), minBank); // max_bank
  });

  test('four overlapping same-pool rounds fit the depth budget; the fifth cannot exceed it', async () => {
    const h = await harness();
    const now = MINUTE + 50;
    for (let i = 0; i < 4; i++) {
      h.store.add(POOL, obs((now + i * 60) * 1000 - 400, i + 1));
      await tick(h, now + i * 60);
      const creates = h.chain.sent.flat().filter(ix => ix.name === 'createRound');
      assert.equal(creates.length, i + 1);
      const ix = creates.at(-1)!;
      assert.equal(readU64(ix.data, 136), 40_000_000n);
      const id = BigInt(10 + i);
      h.chain.rounds.set(id, makeRound(id, BigInt(MINUTE + (i + 1) * 60), POOL, MINT, { maxBank: 40_000_000n }));
      h.chain.config = { ...h.chain.config!, nextRoundId: id + 1n };
    }
    h.store.add(POOL, obs((now + 240) * 1000 - 400, 5));
    await tick(h, now + 240);
    assert.equal(h.chain.sent.flat().filter(ix => ix.name === 'createRound').length, 4);
    assert.ok(h.logs.some(l => l.event === 'round_skipped_shallow_pool' && l.maxBank === 0n));
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
    h.store.add(POOL, { ...obs(now * 1000 - 300, 1), quoteAmount: 10_000n * SOL });
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

  test('house fill: the house vault must also cover the position rent, which the program takes from it', async () => {
    const now = MINUTE + 30;
    const tight = await harness();
    // 0.05 SOL plus the rent, less one lamport: the fill is one lamport short of 0.05 SOL.
    tight.chain.vault = { authority: tight.signer.address, available: 50_000_000n + FAKE_POSITION_RENT - 1n, locked: 0n, bump: 255 };
    tight.chain.rounds.set(9n, lone(now));
    await tick(tight, now);
    assert.equal(readU64(only(tight).data, 8), 49_999_999n);
    assert.equal(tight.scheduler.status().positionRent, FAKE_POSITION_RENT);

    const empty = await harness();
    empty.chain.vault = { authority: empty.signer.address, available: FAKE_POSITION_RENT, locked: 0n, bump: 255 };
    empty.chain.rounds.set(9n, lone(now));
    await tick(empty, now);
    assert.equal(empty.chain.sent.length, 0);
    assert.equal(empty.logs.find((l) => l.step === 'fill')?.skipped, 'vault');
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

  test('canonical strike relays the public proof with only the fee payer; a certificate outage sends nothing', async () => {
    const att = await fakeAttestor();
    let unavailable = false;
    const calls: string[] = [];
    const h = await harness({
      env: { LEGACY_PRICES: 'false' }, attestor: makeClient(att.fetch),
      certificates: async (url, round, kind, key) => {
        calls.push(`${url}/${round.id}/${kind}`);
        if (unavailable) throw new Error('certificate unavailable');
        return attestedPriceInstructions(round, kind, [{ slot: 1n, price: 100n }], key, '1'.repeat(64));
      },
    });
    h.chain.oracle = { attestor: att.address, required: true, bump: 252 };
    const now = MINUTE + 30;
    h.chain.config!.priceAuthority = ADMIN_ELSEWHERE;
    h.chain.rounds.set(8n, played(now));
    await tick(h, now);
    assert.deepEqual(calls, ['https://attest.example/8/strike']);
    assert.equal(att.seen.length, 0, 'never calls legacy transaction co-signing');
    assert.equal(h.chain.sent[0]?.[0]?.program, ED25519_PROGRAM);
    assert.deepEqual(h.chain.sent[0]?.[1]?.accounts.slice(0, 2), [await roundAddress(8n), await oracleAddress()]);
    assert.deepEqual(Object.keys(h.chain.signed[0]!.signatures), [h.signer.address]);
    unavailable = true;
    h.chain.rounds.delete(8n);
    h.chain.rounds.set(7n, { ...played(now), id: 7n });
    await tick(h, now + 1);
    assert.equal(h.chain.sent.length, 1, 'no fallback to privileged or unsigned price');
  });

  test('legacy rollout compatibility: the attestor co-signs; accounts are config, round, price authority, oracle, attestor', async () => {
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
    assert.deepEqual(h.chain.sent[1]?.[0]?.accounts, [
      await configAddress(),
      round5,
      await positionAddress(round5, owners[0] as Address),
      await vaultAddress(owners[0] as Address),
    ]);
  });

  test('once the last position of a round is closed the round is closed too, its rent to config.admin, in a later quiet tick', async (t) => {
    // The success cooldown of a step runs on the real clock: move Date along with the ticks.
    const clock = clockAt(t, (MINUTE + 10) * 1000);
    const h = await harness({ closer: (chain, signer, logs) => new PositionCloser({ rpc: chain.rpc(), signer, logger: (f) => logs.push(f), startMs: 0 }) });
    if (!h.chain.config) throw new Error('no config');
    h.chain.config = { ...h.chain.config, admin: ADMIN_ELSEWHERE };
    h.chain.applyUpgradedCloses();
    const round2 = await roundAddress(2n);
    const owners = [(await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address];
    // Round 2 is older than the per-tick window (ids 4 to 9): the closer alone takes care of it.
    h.chain.rounds.set(2n, makeRound(2n, BigInt(MINUTE - 2 * 86_400), POOL, MINT, { status: RoundStatus.Final, outcome: Outcome.Up, positionCount: 2, claimedCount: 2, feesSwept: true, rawUp: SOL / 100n, rawDown: SOL / 100n }));
    h.chain.positions.set(
      2n,
      owners.map((owner) => ({ round: round2, authority: owner, side: Side.Up, stake: SOL / 100n, face: new Uint8Array(8), isHouse: false, claimed: true, payout: 0n, bump: 250 })),
    );
    await tick(h, MINUTE + 10); // scan
    clock.setOffsetSecs(11);
    await tick(h, MINUTE + 21); // both positions in one transaction; the round is read and queued behind it
    assert.deepEqual(h.chain.sent.map((tx) => tx.map((ix) => ix.name)), [['closePosition', 'closePosition']]);
    assert.equal(h.logs.some((l) => l.event === 'round_closed'), false);
    clock.setOffsetSecs(15);
    await tick(h, MINUTE + 25); // within CLOSE_INTERVAL_MS of the last one
    assert.equal(h.chain.sent.length, 1);
    clock.setOffsetSecs(22);
    await tick(h, MINUTE + 32);
    assert.deepEqual(h.chain.sent.slice(1).map((tx) => tx.map((ix) => ix.name)), [['closeEmptyRound']]);
    assert.deepEqual(h.chain.sent[1]?.[0]?.accounts, [await configAddress(), round2, ADMIN_ELSEWHERE]);
    assert.deepEqual(h.logs.filter((l) => l.event === 'round_closed').map((l) => [l.round, l.lamports]), [[2n, 2_000_000n]]);
    assert.deepEqual(h.scheduler.status().positions, {
      closeAfterSecs: 86_400n,
      queued: 0,
      queuedLamports: 0n,
      closed: 2,
      closedLamports: 4_000_000n,
      nextScanAt: new Date((MINUTE + 10) * 1000 + 300_000).toISOString(),
      closedRounds: 1,
      closedRoundLamports: 2_000_000n,
      roundsQueued: 0,
      roundsPending: 0,
    });
  });
});

/** The tests below move the clock by hand: only Date is mocked, promises and the fake chain stay real. */
function clockAt(t: TestContext, startMs: number): { setOffsetSecs: (secs: number) => void } {
  t.mock.timers.enable({ apis: ['Date'], now: startMs });
  return { setOffsetSecs: (secs) => t.mock.timers.setTime(startMs + secs * 1000) };
}

describe('scheduler: attestor refusals back off by their reason', () => {
  const NOW = MINUTE + 30;
  const live = () => makeRound(6n, BigInt(NOW - 162), POOL, MINT, { status: RoundStatus.Live, rawUp: 50_000_000n, rawDown: 50_000_000n, positionCount: 2 });

  /** A settle against an attestor that refuses with `refusal`; returns how many requests it had seen after each probe. */
  async function probe(t: TestContext, refusal: { status: number; reason: string }, offsetsSecs: number[]): Promise<number[]> {
    const clock = clockAt(t, NOW * 1000);
    const att = await fakeAttestor();
    att.mode = 'refuse';
    att.refusal = refusal;
    const h = await harness({ attestor: new AttestorClient({ url: 'https://attest.example', fetch: att.fetch, pauseMs: 1 }) });
    h.chain.oracle = { attestor: att.address, required: true, bump: 252 };
    h.chain.rounds.set(6n, live());
    const counts: number[] = [];
    for (const at of offsetsSecs) {
      clock.setOffsetSecs(at);
      await tick(h, NOW + at);
      counts.push(att.seen.length);
    }
    assert.equal(h.chain.sent.length, 0, 'a refused price is never sent');
    return counts;
  }

  test('a transient refusal (too_few_samples) is asked again after 5 s, 15 s, 60 s, then every 120 s', async (t) => {
    // Requests at 0, 5, 20, 80, 200 and 320 s; one second before each of them nothing is sent.
    const counts = await probe(t, { status: 422, reason: 'too_few_samples' }, [0, 4, 5, 19, 20, 79, 80, 199, 200, 319, 320]);
    assert.deepEqual(counts, [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6]);
  });

  test('a refusal that cannot change (price_mismatch) waits 120 s at once, and every 120 s after', async (t) => {
    const counts = await probe(t, { status: 422, reason: 'price_mismatch' }, [0, 5, 30, 119, 120, 239, 240]);
    assert.deepEqual(counts, [1, 1, 1, 1, 2, 2, 3]);
  });

  test('a wrong ATTEST_TOKEN (401, unauthorized) is not hammered either', async (t) => {
    const counts = await probe(t, { status: 401, reason: 'missing or wrong bearer token' }, [0, 60, 119, 120]);
    assert.deepEqual(counts, [1, 1, 1, 2]);
  });

  test('a reason the keeper does not know is treated as transient', async (t) => {
    const counts = await probe(t, { status: 422, reason: 'something_new' }, [0, 4, 5, 19, 20]);
    assert.deepEqual(counts, [1, 1, 2, 2, 3]);
  });

  test('an attestor that is down (a failure, not a refusal) keeps the step backoff of 2 s, 4 s, 8 s', async (t) => {
    const clock = clockAt(t, NOW * 1000);
    const att = await fakeAttestor();
    att.mode = 'down';
    const h = await harness({ attestor: new AttestorClient({ url: 'https://attest.example', fetch: att.fetch, pauseMs: 1 }) });
    h.chain.oracle = { attestor: att.address, required: true, bump: 252 };
    h.chain.rounds.set(6n, live());
    const counts: number[] = [];
    for (const at of [0, 1, 2, 5, 6]) {
      clock.setOffsetSecs(at);
      await tick(h, NOW + at);
      counts.push(att.seen.length);
    }
    // Two tries per step (ATTEST_ATTEMPTS): the step runs at 0, 2 and 6 s.
    assert.deepEqual(counts, [2, 2, 4, 4, 6]);
  });

  test('retryDelayMs: refusals by reason, NotDue 1 s, a stuck claim 60 s, everything else 2^n s up to 30 s', () => {
    assert.equal(retryDelayMs(new AttestRefused('too_few_samples', 422, 1), 2), 15_000);
    assert.equal(retryDelayMs(new AttestRefused('price_mismatch', 422, 1), 1), 120_000);
    assert.equal(retryDelayMs(Object.assign(new Error('x'), { context: { logs: ['Error Code: NotDue. Error Number: 6009.'] } }), 4), 1_000);
    assert.equal(retryDelayMs(new ClaimIncomplete(7n, 1), 1), CLAIM_RETRY_MS);
    assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map((n) => retryDelayMs(new Error('boom'), n)), [2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });
});

describe('scheduler: claim falls back to one position per transaction', () => {
  const programError = (name: string) =>
    Object.assign(new Error('Transaction simulation failed'), { context: { logs: [`Program log: AnchorError occurred. Error Code: ${name}. Error Number: 6000.`] } });

  async function finalRound(h: Harness, id: bigint, count: number): Promise<Address[]> {
    const round = await roundAddress(id);
    h.chain.rounds.set(id, makeRound(id, BigInt(MINUTE - 200), POOL, MINT, { status: RoundStatus.Final, outcome: Outcome.Up, positionCount: count, rawUp: SOL / 10n, rawDown: SOL / 10n }));
    const owners: Address[] = [];
    for (let i = 0; i < count; i++) owners.push((await generateKeyPairSigner()).address);
    const positions: PositionAccount[] = owners.map((owner, i) => ({
      round,
      authority: owner,
      side: i % 2 === 0 ? Side.Up : Side.Down,
      stake: SOL / 100n,
      face: new Uint8Array(8),
      isHouse: false,
      claimed: false,
      payout: 0n,
      bump: 250,
    }));
    h.chain.positions.set(id, positions);
    return owners;
  }

  /** The chain refuses every transaction that claims `stuck` with `error`; `attempts` lists the sizes of those transactions. */
  async function refuse(h: Harness, id: bigint, stuck: Address, error: Error): Promise<{ attempts: number[] }> {
    const bad = await positionAddress(await roundAddress(id), stuck);
    const seen = { attempts: [] as number[] };
    h.chain.failWhen = (ixs) => {
      if (!ixs.some((ix) => ix.accounts.includes(bad))) return null;
      seen.attempts.push(ixs.length);
      return error;
    };
    return seen;
  }

  test('one position the program refuses does not stop the others: they are claimed one by one, the bad one is named in the log', async () => {
    const h = await harness();
    const owners = await finalRound(h, 5n, 4);
    const stuck = owners[2] as Address;
    const seen = await refuse(h, 5n, stuck, programError('NotFinal'));
    await tick(h, MINUTE + 30);
    // The batch of four failed once, then every position was tried alone: three landed, one was refused again.
    assert.deepEqual(seen.attempts, [4, 1]);
    assert.deepEqual(h.chain.sent.map((tx) => tx.length), [1, 1, 1]);
    const claimed = h.chain.sent.flat().map((ix) => ix.accounts[3]);
    assert.deepEqual(claimed, await Promise.all([owners[0], owners[1], owners[3]].map((o) => vaultAddress(o as Address))));
    assert.deepEqual(h.logs.filter((l) => l.event === 'claim_position_failed'), [
      { event: 'claim_position_failed', round: 5n, owner: stuck, position: await positionAddress(await roundAddress(5n), stuck), error: 'NotFinal' },
    ]);
  });

  test('the stuck position is asked again after CLAIM_RETRY_MS, alone; the claimed ones are not touched', async (t) => {
    const clock = clockAt(t, (MINUTE + 30) * 1000);
    const h = await harness();
    const owners = await finalRound(h, 5n, 3);
    const stuck = owners[1] as Address;
    const seen = await refuse(h, 5n, stuck, programError('NotFinal'));
    await tick(h, MINUTE + 30);
    assert.equal(h.chain.sent.length, 2);
    // On chain the two that landed are claimed now.
    h.chain.positions.set(5n, (h.chain.positions.get(5n) ?? []).map((p) => (p.authority === stuck ? p : { ...p, claimed: true })));
    seen.attempts.length = 0;
    const secs = CLAIM_RETRY_MS / 1000;
    clock.setOffsetSecs(secs - 1);
    await tick(h, MINUTE + 30 + secs - 1);
    assert.deepEqual(seen.attempts, []);
    clock.setOffsetSecs(secs);
    await tick(h, MINUTE + 30 + secs);
    assert.deepEqual(seen.attempts, [1]);
    assert.equal(h.chain.sent.length, 2);
  });

  test('a position the player claimed meanwhile (AlreadyClaimed) is no failure: the rest is claimed and nothing is flagged', async () => {
    const h = await harness();
    const owners = await finalRound(h, 5n, 3);
    await refuse(h, 5n, owners[0] as Address, programError('AlreadyClaimed'));
    await tick(h, MINUTE + 30);
    assert.deepEqual(h.chain.sent.map((tx) => tx.length), [1, 1]);
    assert.equal(h.logs.some((l) => l.event === 'claim_position_failed'), false);
  });

  test('a failure that is not a program error (a timeout, a 429) is not split up: the outcome is unknown, the next tick reads the chain', async () => {
    const h = await harness();
    const owners = await finalRound(h, 5n, 3);
    const seen = await refuse(h, 5n, owners[0] as Address, new Error('fetch failed'));
    await tick(h, MINUTE + 30);
    assert.deepEqual(seen.attempts, [3]);
    assert.equal(h.chain.sent.length, 0);
  });

  test('a batch that is too large still halves first; only a program error splits it per position', async () => {
    const h = await harness();
    await finalRound(h, 5n, 5);
    let tooLarge = 1;
    h.chain.failWhen = (ixs) => (ixs.length > 2 && tooLarge-- > 0 ? new Error('transaction too large') : null);
    await tick(h, MINUTE + 30);
    assert.deepEqual(h.chain.sent.map((tx) => tx.length), [2, 2, 1]);
    assert.ok(h.logs.some((l) => l.event === 'claim_batch_shrunk' && l.claimBatch === 2));
  });

  test('with a batch of one, the refused position is named, not resent, and the rest of the round goes through', async () => {
    const h = await harness();
    const owners = await finalRound(h, 5n, 3);
    // The first two batches are too large, so the batch is down to one position.
    let shrink = 2;
    const bad = await positionAddress(await roundAddress(5n), owners[1] as Address);
    const attempts: number[] = [];
    h.chain.failWhen = (ixs) => {
      if (ixs.length > 1 && shrink-- > 0) return new Error('transaction too large');
      if (ixs.some((ix) => ix.accounts.includes(bad))) {
        attempts.push(ixs.length);
        return programError('NotFinal');
      }
      return null;
    };
    await tick(h, MINUTE + 30);
    assert.deepEqual(attempts, [1]);
    assert.deepEqual(h.chain.sent.map((tx) => tx.length), [1, 1]);
    assert.equal(h.logs.filter((l) => l.event === 'claim_position_failed').length, 1);
  });
});

// ---- the audit of 7 October 2026 -------------------------------------------------------------

/** A position as the program stores it: one per owner and round. */
async function position(roundId: bigint, authority: Address, side: Side, stake: bigint, isHouse = false): Promise<PositionAccount> {
  return { round: await roundAddress(roundId), authority, side, stake, face: new Uint8Array(8), isHouse, claimed: false, payout: 0n, bump: 250 };
}

describe('scheduler: house fills are paused, spread over the day and limited per wallet', () => {
  const lone = (now: number) => makeRound(9n, BigInt(now - 65), POOL, MINT, { rawUp: 50_000_000n, positionCount: 1 });
  const now = MINUTE + 30;

  test('config.paused: no house fill is asked for (the program answers Paused), and the log says why', async () => {
    const h = await harness();
    if (!h.chain.config) throw new Error('no config');
    h.chain.config = { ...h.chain.config, paused: true };
    h.chain.rounds.set(9n, lone(now));
    await tick(h, now);
    await tick(h, now + 1);
    assert.equal(h.chain.sent.length, 0);
    assert.ok(h.logs.some((l) => l.event === 'house_fill_paused'));
    // Resumed: the same round gets its fill.
    h.chain.config = { ...h.chain.config, paused: false };
    await tick(h, now + 2);
    assert.equal(only(h).name, 'houseFill');
  });

  test('a pool picked less than HOUSE_SWITCH_PAUSE_SECS ago gets no house fill; after that it does', async () => {
    const fresh = await harness({ selectedAtMs: Date.now() - 20_000 });
    fresh.chain.rounds.set(9n, lone(now));
    await tick(fresh, now);
    assert.equal(fresh.chain.sent.length, 0);
    const skip = fresh.logs.find((l) => l.step === 'fill');
    assert.equal(skip?.skipped, 'pool-switch-pause');
    assert.equal(skip?.pauseSecs, 60);

    const settled = await harness({ selectedAtMs: Date.now() - 61_000 });
    settled.chain.rounds.set(9n, lone(now));
    await tick(settled, now);
    assert.equal(only(settled).name, 'houseFill');

    const off = await harness({ selectedAtMs: Date.now() - 1_000, env: { HOUSE_SWITCH_PAUSE_SECS: '0' } });
    off.chain.rounds.set(9n, lone(now));
    await tick(off, now);
    assert.equal(only(off).name, 'houseFill');

    // Only the round's own pool counts: a round of an older pool is not held back by the new one.
    const otherPool = await harness({ selectedAtMs: Date.now() - 1_000 });
    otherPool.chain.rounds.set(9n, makeRound(9n, BigInt(now - 65), address('11111111111111111111111111111116'), MINT, { rawUp: 50_000_000n, positionCount: 1 }));
    await tick(otherPool, now);
    assert.equal(only(otherPool).name, 'houseFill');
  });

  test('the daily budget is spread: a lone stake is matched with the paced amount, which the log names', async () => {
    // 40 mSOL of budget left: spread over the rest of the UTC day the cap is far below it (at most 160 mSOL / 5 rounds
    // in the last minutes of the day; the floor that activates the round is 10 mSOL).
    const h = await harness({ env: { HOUSE_PACE_DIVISOR: '4', HOUSE_DAILY_BUDGET_LAMPORTS: '40000000' } });
    h.chain.rounds.set(9n, lone(now));
    await tick(h, now);
    const amount = readU64(only(h).data, 8);
    assert.ok(amount >= 10_000_000n && amount < 40_000_000n, String(amount));
    assert.equal(h.logs.find((l) => l.step === 'fill' && typeof l.sig === 'string')?.paced !== undefined, true);
    assert.equal(h.state.state.house.spent, amount);
  });

  test('a wallet that already had HOUSE_WALLET_DAILY_FILLS fills today gets none; another wallet is not affected', async () => {
    const heavy = (await generateKeyPairSigner()).address;
    const light = (await generateKeyPairSigner()).address;
    const run = async (owner: Address, fillsToday: number) => {
      const h = await harness({ env: { HOUSE_WALLET_DAILY_FILLS: '3' } });
      h.state.state.house = { ...h.state.state.house, fills: { [heavy]: 3, [light]: fillsToday } };
      h.chain.rounds.set(9n, lone(now));
      h.chain.positions.set(9n, [await position(9n, owner, Side.Up, 50_000_000n)]);
      await tick(h, now);
      await tick(h, now + 9); // after the success cooldown: a skipped round is not read again
      return h;
    };
    const blocked = await run(heavy, 0);
    assert.equal(blocked.chain.sent.length, 0);
    assert.deepEqual(blocked.logs.find((l) => l.event === 'fill_skipped_wallet_limit'), {
      round: 9n,
      step: 'fill',
      skipped: 'wallet-limit',
      rawUp: 50_000_000n,
      rawDown: 0n,
      event: 'fill_skipped_wallet_limit',
      wallet: heavy,
      fillsToday: 3,
      limit: 3,
    });
    assert.equal(blocked.logs.filter((l) => l.skipped === 'wallet-limit').length, 1, 'logged once per round');

    const open = await run(light, 2);
    assert.equal(only(open).name, 'houseFill');
    // The fill counts against the wallet (3 now) and the day's spend.
    assert.equal(open.state.state.house.fills?.[light], 3);
    assert.equal(open.state.state.house.fills?.[heavy], 3);
    assert.equal(open.logs.find((l) => l.step === 'fill' && typeof l.sig === 'string')?.wallet, light);
  });

  test('the wallet is the owner of the biggest stake on the matched side; HOUSE_WALLET_DAILY_FILLS=0 means no limit', async () => {
    const big = (await generateKeyPairSigner()).address;
    const small = (await generateKeyPairSigner()).address;
    const other = (await generateKeyPairSigner()).address;
    const h = await harness({ env: { HOUSE_WALLET_DAILY_FILLS: '1' } });
    h.state.state.house = { ...h.state.state.house, fills: { [small]: 1 } };
    h.chain.rounds.set(9n, makeRound(9n, BigInt(now - 65), POOL, MINT, { rawUp: 80_000_000n, rawDown: 10_000_000n, positionCount: 3 }));
    h.chain.positions.set(9n, [
      await position(9n, small, Side.Up, 30_000_000n),
      await position(9n, big, Side.Up, 50_000_000n),
      await position(9n, other, Side.Down, 10_000_000n),
    ]);
    await tick(h, now);
    const ix = only(h);
    assert.equal(ix.name, 'houseFill'); // 'small' is at its limit, but the fill is for 'big'
    assert.equal(h.state.state.house.fills?.[big], 1);
    assert.equal(h.state.state.house.fills?.[small], 1);

    const unlimited = await harness({ env: { HOUSE_WALLET_DAILY_FILLS: '0' } });
    unlimited.state.state.house = { ...unlimited.state.state.house, fills: { [big]: 500 } };
    unlimited.chain.rounds.set(9n, lone(now));
    unlimited.chain.positions.set(9n, [await position(9n, big, Side.Up, 50_000_000n)]);
    await tick(unlimited, now);
    assert.equal(only(unlimited).name, 'houseFill');
    assert.equal(unlimited.state.state.house.fills?.[big], 500, 'no counting either');
  });

  test('a day starts the counters over', async () => {
    const wallet = (await generateKeyPairSigner()).address;
    const h = await harness({ env: { HOUSE_WALLET_DAILY_FILLS: '1' } });
    // Yesterday's ledger: the wallet was at its limit, but that day is over.
    h.state.state.house = { day: '2026-01-01', spent: 5n, rounds: ['1'], fills: { [wallet]: 9 } };
    h.chain.rounds.set(9n, lone(now));
    h.chain.positions.set(9n, [await position(9n, wallet, Side.Up, 50_000_000n)]);
    await tick(h, now);
    assert.equal(only(h).name, 'houseFill');
    assert.deepEqual(h.state.state.house.fills, { [wallet]: 1 });
  });
});

describe('scheduler: rounds.jsonl at the sweep', () => {
  function roundLogIn(): { log: RoundLog; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ftm-rounds-'));
    dirs.push(dir);
    const path = join(dir, 'rounds.jsonl');
    return { log: new RoundLog({ file: new JsonlFile(path, 1000), logger: () => undefined }), path };
  }

  test('one line per swept round: outcome, prices, banks, humans, wallets and positions', async () => {
    const { log, path } = roundLogIn();
    const h = await harness({ roundLog: log });
    const [w1, w2, w3] = [await generateKeyPairSigner(), await generateKeyPairSigner(), await generateKeyPairSigner()];
    const id = 6n;
    h.chain.rounds.set(
      id,
      makeRound(id, BigInt(MINUTE - 300), POOL, MINT, {
        status: RoundStatus.Final,
        outcome: Outcome.Up,
        strikePrice: 1_000n,
        exitPrice: 1_050n,
        rawUp: 60_000_000n,
        rawDown: 60_000_000n,
        houseAmount: 10_000_000n,
        positionCount: 4,
        claimedCount: 4,
      }),
    );
    h.chain.positions.set(id, [
      await position(id, w1.address, Side.Up, 50_000_000n),
      await position(id, w2.address, Side.Up, 10_000_000n),
      await position(id, w3.address, Side.Down, 50_000_000n),
      await position(id, h.signer.address, Side.Down, 10_000_000n, true),
    ]);
    await tick(h, MINUTE + 30);
    assert.equal(only(h).name, 'sweepFees');
    await tick(h, MINUTE + 40); // the fake chain never applies the sweep: asked again, written once
    const rows = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.deepEqual(
      { ...row, ts: typeof row?.ts },
      {
        id: '6',
        ts: 'string',
        opensAt: MINUTE - 300,
        pool: POOL,
        name: 'TEST / SOL',
        outcome: 'up',
        refundReason: 'none',
        strike: '1000',
        exit: '1050',
        rawUp: '60000000',
        rawDown: '60000000',
        houseAmount: '10000000',
        humans: 3,
        wallets: 3,
        players: [w1.address, w2.address, w3.address],
        positions: 4,
      },
    );
  });

  test('a round whose positions are gone, or that never had any, is written with null humans', async () => {
    const { log, path } = roundLogIn();
    const h = await harness({ roundLog: log });
    h.chain.rounds.set(
      7n,
      makeRound(7n, BigInt(MINUTE - 400), POOL, MINT, { status: RoundStatus.Final, outcome: Outcome.Refund, refundReason: RefundReason.Tie, rawUp: 30_000_000n, rawDown: 30_000_000n, positionCount: 0, feesSwept: false, totalPaid: 0n }),
    );
    await tick(h, MINUTE + 30);
    assert.equal(only(h).name, 'sweepFees');
    const [row] = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual([row?.outcome, row?.refundReason, row?.humans, row?.wallets, row?.players, row?.positions], ['refund', 'tie', null, null, null, 0]);
  });

  test('no log configured: the sweep goes out as before', async () => {
    const h = await harness();
    h.chain.rounds.set(6n, makeRound(6n, BigInt(MINUTE - 300), POOL, MINT, { status: RoundStatus.Final, outcome: Outcome.Down, positionCount: 2, claimedCount: 2, rawUp: 1n, rawDown: 1n }));
    await tick(h, MINUTE + 30);
    assert.equal(only(h).name, 'sweepFees');
  });
});

describe('scheduler: clock drift and a second keeper', () => {
  test('clock_offset_warning beyond 3 s either way, throttled; nothing within', async () => {
    assert.equal(CLOCK_WARN_MS, 3_000);
    for (const offset of [-3_000, 0, 2_999, 3_000]) {
      const h = await harness({ clockOffsetMs: offset });
      await tick(h, MINUTE + 10);
      assert.equal(h.logs.some((l) => l.event === 'clock_offset_warning'), false, `offset ${offset}`);
      assert.equal(h.scheduler.status().clockOffsetWarning, false);
    }
    for (const offset of [-3_001, 4_500]) {
      const h = await harness({ clockOffsetMs: offset });
      await tick(h, MINUTE + 10);
      await tick(h, MINUTE + 11);
      await tick(h, MINUTE + 12);
      const warnings = h.logs.filter((l) => l.event === 'clock_offset_warning');
      assert.equal(warnings.length, 1, 'once, not on every tick');
      assert.equal(warnings[0]?.offsetMs, offset);
      assert.equal(warnings[0]?.limitMs, 3_000);
      assert.equal(h.scheduler.status().clockOffsetWarning, true);
    }
  });

  /** A round standing at the next minute boundary, as another keeper would have created it. */
  const foreign = (h: Harness, id: bigint, opensAt: number) => h.chain.rounds.set(id, makeRound(id, BigInt(opensAt), POOL, MINT));
  const events = (h: Harness, name: string) => h.logs.filter((l) => l.event === name);

  test('a round at the next boundary that this keeper did not create is another_keeper_suspected; three in a row stop create for 5 minutes', async () => {
    const h = await harness();
    if (!h.chain.config) throw new Error('no config');
    h.chain.config = { ...h.chain.config, nextRoundId: 13n };
    const at = (minute: number) => MINUTE + 60 * minute + 50; // second 50: create is due for the boundary 10 s ahead
    // The first minute: nothing standing at the boundary 60 s ahead of the tick yet (before CREATE_LEAD_MS), so no sign.
    foreign(h, 10n, MINUTE + 60);
    await tick(h, MINUTE + 20);
    assert.equal(events(h, 'another_keeper_suspected').length, 0);
    await tick(h, at(0));
    await tick(h, at(0) + 1); // the same boundary again: counted once
    assert.deepEqual(events(h, 'another_keeper_suspected').map((l) => [l.consecutive, l.sign, l.round]), [[1, 'round_exists', 10n]]);
    assert.equal(h.chain.sent.some((tx) => tx[0]?.name === 'createRound'), false, 'the round stands: nothing to create');

    foreign(h, 11n, MINUTE + 120);
    await tick(h, at(1));
    foreign(h, 12n, MINUTE + 180);
    await tick(h, at(2));
    assert.equal(events(h, 'another_keeper_create_paused').length, 1);
    assert.equal(h.scheduler.guard.paused(at(2)), true);
    assert.equal((h.scheduler.status().anotherKeeper as { suspected: number }).suspected, 3);
    // One line per boundary (they are a minute apart; the line itself is throttled to one per 30 s).
    assert.deepEqual(events(h, 'another_keeper_suspected').map((l) => l.consecutive), [1, 2, 3]);
  });

  test('while create is paused no round is created, even with nothing standing; after 5 minutes it creates again', async () => {
    const h = await harness();
    h.store.add(POOL, obs((MINUTE + 50) * 1000 - 300, 1));
    for (let m = 0; m < 3; m++) h.scheduler.guard.foreignRound(BigInt(MINUTE + 60 * (m + 1)), BigInt(10 + m), (MINUTE + 60 * m + 50) * 1000);
    assert.equal(h.scheduler.guard.paused((MINUTE + 160) * 1000), true);
    const at = MINUTE + 3 * 60 + 50; // 10 s before a boundary, inside the pause
    h.store.add(POOL, obs(at * 1000 - 300, 2));
    await tick(h, at);
    assert.equal(h.chain.sent.length, 0);
    assert.ok(h.logs.some((l) => l.event === 'create_paused_another_keeper'));
    // The pause began at second 50 of minute 2 and lasts 5 minutes (to MINUTE + 470 s): at second 50 of minute 9 create is due again.
    const resumeAt = MINUTE + 9 * 60 + 50;
    h.store.add(POOL, obs(resumeAt * 1000 - 300, 3));
    await tick(h, resumeAt);
    assert.equal(only(h).name, 'createRound');
  });

  test('a round this process created is not a sign of anything', async () => {
    const h = await harness();
    const now = MINUTE + 50;
    h.chain.rounds.set(9n, makeRound(9n, BigInt(MINUTE), POOL, MINT, { maxBank: 40_000_000n }));
    h.store.add(POOL, obs(now * 1000 - 300, 1));
    await tick(h, now);
    assert.equal(only(h).name, 'createRound'); // round 10, opens at MINUTE + 60
    h.chain.rounds.set(10n, makeRound(10n, BigInt(MINUTE + 60), POOL, MINT)); // the chain caught up
    if (!h.chain.config) throw new Error('no config');
    h.chain.config = { ...h.chain.config, nextRoundId: 11n };
    await tick(h, now + 1); // still before the boundary: the round at it is ours
    await tick(h, now + 2);
    assert.equal(events(h, 'another_keeper_suspected').length, 0);
  });

  test('a create that fails with InvalidRoundId is a sign too (another transaction took the id)', async () => {
    const h = await harness();
    const now = MINUTE + 50;
    h.store.add(POOL, obs(now * 1000 - 300, 1));
    h.chain.failWhen = (ixs) =>
      ixs[0]?.name === 'createRound' ? Object.assign(new Error('Transaction simulation failed'), { context: { logs: ['Program 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz failed: custom program error: 0x1778'] } }) : null;
    await tick(h, now);
    const suspected = events(h, 'another_keeper_suspected');
    assert.equal(suspected.length, 1);
    assert.equal(suspected[0]?.sign, 'invalid_round_id');
    assert.ok(h.logs.some((l) => l.step === 'create' && l.error === 'InvalidRoundId'));
  });
});
