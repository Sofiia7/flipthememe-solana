// Byte-for-byte agreement with the Rust program (vectors.json is written by
// `cargo test --manifest-path programs/flip-the-meme/Cargo.toml --test vectors`).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { address, getAddressDecoder, type Address } from '@solana/kit';
import * as ix from '../src/instructions.ts';
import { decodeConfig, decodePosition, decodeRound, decodeSession, decodeVault } from '../src/accounts.ts';
import { positionPayout } from '../src/payout.ts';
import { Outcome, RefundReason, RoundStatus, Side } from '../src/constants.ts';

const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));
const key = (n: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const someone = address('11111111111111111111111111111111');

const params = {
  priceAuthority: key(1),
  houseAuthority: key(2),
  treasury: key(3),
  minStake: 10_000_000n,
  maxStake: 100_000_000n,
  minBank: 20_000_000n,
  feeWinBps: 200,
  feeRefundBps: 100,
};

test('instruction data matches the program', async () => {
  const built: Record<string, Uint8Array> = {
    initializeConfig: (await ix.initializeConfig({ admin: someone, params })).data as Uint8Array,
    updateConfig: (await ix.updateConfig({ admin: someone, params })).data as Uint8Array,
    setPause: (await ix.setPause({ admin: someone, paused: true })).data as Uint8Array,
    openVault: (await ix.openVault({ owner: someone })).data as Uint8Array,
    deposit: (await ix.deposit({ owner: someone, amount: 123_456_789n })).data as Uint8Array,
    withdraw: (await ix.withdraw({ owner: someone, amount: 987_654_321n })).data as Uint8Array,
    startSession: (
      await ix.startSession({ owner: someone, sessionSigner: key(7), expiry: 1_800_003_600n, maxPerBet: 100_000_000n, sessionCap: 1_000_000_000n })
    ).data as Uint8Array,
    revokeSession: (await ix.revokeSession({ owner: someone, sessionSigner: key(7) })).data as Uint8Array,
    createRound: (
      await ix.createRound({
        admin: someone,
        roundId: 42n,
        args: {
          tokenMint: key(4),
          pool: key(5),
          opensAt: 1_800_000_000n,
          cutoffAt: 1_800_000_060n,
          strikeStart: 1_800_000_090n,
          strikeEnd: 1_800_000_100n,
          exitStart: 1_800_000_150n,
          exitEnd: 1_800_000_160n,
          settleDeadline: 1_800_000_760n,
          maxBank: 270_000_000n,
        },
      })
    ).data as Uint8Array,
    placeBet: (
      await ix.placeBet({ owner: someone, sessionSigner: key(7), roundId: 42n, side: Side.Down, amount: 50_000_000n, face: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) })
    ).data as Uint8Array,
    houseFill: (await ix.houseFill({ house: someone, roundId: 42n, amount: 30_000_000n })).data as Uint8Array,
    setStrike: (
      await ix.setStrike({ priceAuthority: someone, roundId: 42n, samples: [{ slot: 100n, price: 1_000n }, { slot: 101n, price: 1_001n }] })
    ).data as Uint8Array,
    settle: (await ix.settle({ priceAuthority: someone, roundId: 42n, samples: [{ slot: 200n, price: 900n }] })).data as Uint8Array,
    refundExpired: (await ix.refundExpired({ roundId: 42n })).data as Uint8Array,
    claim: (await ix.claim({ roundId: 42n, owner: someone })).data as Uint8Array,
    sweepFees: (await ix.sweepFees({ roundId: 42n, treasury: someone })).data as Uint8Array,
    closeEmptyRound: (await ix.closeEmptyRound({ roundId: 42n, admin: someone })).data as Uint8Array,
  };
  assert.deepEqual(Object.keys(built).sort(), Object.keys(vectors.instructions).sort());
  for (const [name, data] of Object.entries(built)) assert.equal(hex(data), vectors.instructions[name], name);
});

test('account decoders read the program layout', () => {
  const config = decodeConfig(bytes(vectors.accounts.config));
  assert.equal(config.admin, key(9));
  assert.equal(config.treasury, key(3));
  assert.equal(config.paused, true);
  assert.equal(config.nextRoundId, 77n);
  assert.equal(config.feeRefundBps, 100);
  assert.equal(config.totalLocked, 70_000_000n);
  assert.equal(config.bump, 254);

  const vault = decodeVault(bytes(vectors.accounts.vault));
  assert.deepEqual([vault.authority, vault.available, vault.locked, vault.bump], [key(10), 900_000_000n, 50_000_000n, 253]);

  const session = decodeSession(bytes(vectors.accounts.session));
  assert.deepEqual([session.signer, session.expiry, session.spent, session.revoked, session.bump], [key(12), 1_800_003_600n, 50_000_000n, false, 252]);

  const round = decodeRound(bytes(vectors.accounts.round));
  assert.equal(round.id, 42n);
  assert.equal(round.pool, key(5));
  assert.equal(round.exitEnd, 1_800_000_160n);
  assert.equal(round.maxBank, 270_000_000n);
  assert.deepEqual([round.rawUp, round.rawDown, round.positionCount, round.claimedCount], [80_000_000n, 20_000_000n, 3, 1]);
  assert.deepEqual([round.status, round.outcome, round.refundReason], [RoundStatus.Final, Outcome.Refund, RefundReason.Tie]);
  assert.deepEqual([round.strikePrice, round.strikeSamples, round.exitSamples, round.bump], [15_302_000_000n, 9, 10, 251]);

  const position = decodePosition(bytes(vectors.accounts.position));
  assert.equal(position.side, Side.Down);
  assert.deepEqual([...position.face], [9, 8, 7, 6, 5, 4, 3, 2]);
  assert.deepEqual([position.isHouse, position.claimed, position.payout, position.bump], [true, true, 98_000_000n, 250]);
  assert.throws(() => decodeVault(bytes(vectors.accounts.round)), /not a Vault/);
});

test('payout mirror agrees with payout.rs', () => {
  assert.equal(vectors.payouts.length, 60);
  for (const v of vectors.payouts) {
    const got = positionPayout(BigInt(v.rawUp), BigInt(v.rawDown), v.outcome, v.feeWinBps, v.feeRefundBps, v.side, BigInt(v.stake));
    assert.equal(got, BigInt(v.payout), JSON.stringify(v));
  }
});
