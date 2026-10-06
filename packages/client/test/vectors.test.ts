// Byte-for-byte agreement with the Rust program (vectors.json is written by
// `cargo test --manifest-path programs/flip-the-meme/Cargo.toml --test vectors`).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { address, getAddressDecoder, isSignerRole, isWritableRole, type Address, type Instruction } from '@solana/kit';
import * as ix from '../src/instructions.ts';
import { decodeConfig, decodeHouseLimits, decodeOracleConfig, decodePosition, decodeRound, decodeSession, decodeVault } from '../src/accounts.ts';
import { positionPayout } from '../src/payout.ts';
import { EVENT, Outcome, RefundReason, RoundStatus, Side } from '../src/constants.ts';
import { PROGRAM_ERRORS } from '../src/tx.ts';

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
    closePosition: (await ix.closePosition({ roundId: 42n, owner: someone })).data as Uint8Array,
    initHouseLimits: (await ix.initHouseLimits({ admin: someone, roundCap: 50_000_000n, dailyCap: 2_000_000_000n })).data as Uint8Array,
    updateHouseLimits: (await ix.updateHouseLimits({ admin: someone, roundCap: 25_000_000n, dailyCap: 1_000_000_000n })).data as Uint8Array,
    initOracle: (await ix.initOracle({ admin: someone, attestor: key(6), required: false })).data as Uint8Array,
    setOracle: (await ix.setOracle({ admin: someone, attestor: key(6), required: true })).data as Uint8Array,
  };
  assert.deepEqual(Object.keys(built).sort(), Object.keys(vectors.instructions).sort());
  for (const [name, data] of Object.entries(built)) assert.equal(hex(data), vectors.instructions[name], name);
});

test('account order and roles match the program (instructions added or changed in October 2026)', async () => {
  // Same keys as vectors.rs: admin 9, house 2, price authority 1, attestor 6, attestor in office 8,
  // position owner 10, round 42.
  const built: Record<string, Instruction> = {
    closePosition: await ix.closePosition({ roundId: 42n, owner: key(10) }),
    initHouseLimits: await ix.initHouseLimits({ admin: key(9), roundCap: 1n, dailyCap: 2n }),
    updateHouseLimits: await ix.updateHouseLimits({ admin: key(9), roundCap: 1n, dailyCap: 2n }),
    initOracle: await ix.initOracle({ admin: key(9), attestor: key(6), required: false }),
    setOracle: await ix.setOracle({ admin: key(9), attestor: key(6), required: true }),
    setOracleCosigned: await ix.setOracle({ admin: key(9), attestor: key(6), required: false, currentAttestor: key(8) }),
    houseFill: await ix.houseFill({ house: key(2), roundId: 42n, amount: 1n }),
    setStrikeAttested: await ix.setStrike({ priceAuthority: key(1), roundId: 42n, samples: [], attestor: key(6) }),
    settleUnattested: await ix.settle({ priceAuthority: key(1), roundId: 42n, samples: [] }),
  };
  assert.deepEqual(Object.keys(built).sort(), Object.keys(vectors.accountMetas).sort());
  for (const [name, instruction] of Object.entries(built)) {
    const metas = (instruction.accounts ?? []).map((a) => ({ pubkey: a.address, signer: isSignerRole(a.role), writable: isWritableRole(a.role) }));
    assert.deepEqual(metas, vectors.accountMetas[name], name);
  }
});

test('event discriminators and error numbers match the program', () => {
  assert.deepEqual(Object.keys(EVENT).sort(), Object.keys(vectors.events).sort());
  for (const [name, h] of Object.entries(vectors.events)) assert.equal(hex(EVENT[name as keyof typeof EVENT]), h, name);
  // Codes are mapped by position (6000 + index): the list may only ever grow at the end.
  assert.equal(PROGRAM_ERRORS.length, Object.keys(vectors.errors).length);
  for (const [name, code] of Object.entries(vectors.errors as Record<string, number>)) assert.equal(PROGRAM_ERRORS[code - 6000], name, `${code}`);
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

  assert.deepEqual(decodeHouseLimits(bytes(vectors.accounts.houseLimits)), {
    roundCap: 50_000_000n,
    dailyCap: 2_000_000_000n,
    day: 20_833n,
    spent: 150_000_000n,
    bump: 249,
  });
  assert.deepEqual(decodeOracleConfig(bytes(vectors.accounts.oracle)), { attestor: key(6), required: true, bump: 248 });
  assert.throws(() => decodeOracleConfig(bytes(vectors.accounts.houseLimits)), /not a OracleConfig/);
});

test('payout mirror agrees with payout.rs', () => {
  assert.equal(vectors.payouts.length, 60);
  for (const v of vectors.payouts) {
    const got = positionPayout(BigInt(v.rawUp), BigInt(v.rawDown), v.outcome, v.feeWinBps, v.feeRefundBps, v.side, BigInt(v.stake));
    assert.equal(got, BigInt(v.payout), JSON.stringify(v));
  }
});
