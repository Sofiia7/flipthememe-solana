// Scheduler wiring against a fake devnet: which instruction each step signs, with which accounts
// and arguments. The fake chain never applies a transaction, so a second tick sees the same state.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  Outcome,
  RoundStatus,
  Side,
  SYSTEM_PROGRAM_ID,
  configAddress,
  positionAddress,
  roundAddress,
  vaultAddress,
  type PositionAccount,
  type PriceObservation,
} from '@flipthememe/client';
import { address, generateKeyPairSigner, type Address, type KeyPairSigner } from '@solana/kit';
import { ChainClock } from '../src/chain.ts';
import { loadConfig } from '../src/config.ts';
import type { LogFields } from '../src/log.ts';
import { ObservationStore } from '../src/observations.ts';
import { Scheduler } from '../src/scheduler.ts';
import type { PoolSelector, Selection } from '../src/selector.ts';
import { StateStore } from '../src/state.ts';
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

async function harness(opts: { pool?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'ftm-scheduler-'));
  dirs.push(dir);
  const signer = await generateKeyPairSigner();
  const chain = new FakeChain(signer.address);
  chain.config = makeConfig(signer.address, { nextRoundId: 10n });
  chain.vault = { authority: signer.address, available: 2n * SOL, locked: 0n, bump: 255 };
  const cfg = loadConfig({ STATE_FILE: join(dir, 'state.json') }, dir);
  const state = new StateStore(cfg.stateFile, Date.now());
  const store = new ObservationStore();
  const logs: LogFields[] = [];
  const selection: Selection = { pool: POOL, baseMint: MINT, name: 'TEST / SOL', selectedAtMs: Date.now(), fallback: false, quoteReserve: 400n * SOL, reserveAtMs: Date.now() };
  const selector = { current: opts.pool === false ? null : selection } as unknown as PoolSelector;
  const scheduler = new Scheduler({ rpc: chain.rpc(), signer, cfg, state, selector, store, clock: new ChainClock(0), logger: (f) => logs.push(f) });
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
    assert.deepEqual(playedTx?.[0]?.accounts, [await configAddress(), await roundAddress(8n), h.signer.address]);
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
