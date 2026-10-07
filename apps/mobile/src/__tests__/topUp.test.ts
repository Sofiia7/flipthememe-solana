// Node tests for the top up flow without a screen: the session allowance, the rent fallback, the bill
// before any wallet is known, and the transaction a first top up builds for a wallet read inside the
// same wallet session. Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddressDecoder, getAddressEncoder, type Address } from '@solana/kit';
import { ACCOUNT, IX, SYSTEM_PROGRAM_ID, decodeVault } from '@flipthememe/client';
import { SESSION_RULES } from '../config.ts';
import { ACCOUNT_SPACE, NETWORK_FEE, RENT_FALLBACK, U64_MAX, rentExempt, sessionCapFor, topUpPlan } from '../wallet/topUpPlan.ts';
import {
  TOP_UP_OVERHEAD,
  billLines,
  playRoute,
  prepareTopUp,
  topUpBill,
  walletNeed,
  type TopUpRules,
} from '../wallet/topUpFlow.ts';

const SOL = 1_000_000_000n;
const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const OWNER = addr(7);
const DEVICE = addr(9);
const RULES: TopUpRules = SESSION_RULES;

/** Vault account bytes: discriminator, authority, available, locked, bump. */
function vaultBytes(available: bigint, locked = 0n): Uint8Array {
  const data = new Uint8Array(57);
  const view = new DataView(data.buffer);
  data.set(ACCOUNT.Vault, 0);
  data.set(getAddressEncoder().encode(OWNER) as Uint8Array, 8);
  view.setBigUint64(40, available, true);
  view.setBigUint64(48, locked, true);
  data[56] = 255;
  return data;
}

/** The u64 that follows `offset` in an instruction's data. */
const u64At = (data: Uint8Array, offset: number) => new DataView(data.buffer, data.byteOffset).getBigUint64(offset, true);
const startsWith = (data: Uint8Array, prefix: Uint8Array) => prefix.every((b, i) => data[i] === b);

test('the session allowance is turnover, many times what is on the account, and never overflows a u64', () => {
  const rules = { maxPerBet: SOL / 10n, capTurnoverFactor: 100n };
  // 0.10 deposited and 0.00 available: 100 times, so five 0.02 bets cannot use it up.
  assert.equal(sessionCapFor(SOL / 10n, rules), 10n * SOL);
  assert.equal(sessionCapFor(SOL / 10n + (SOL * 8n) / 100n, rules), 18n * SOL);
  // The floor: a tiny balance still gets 100 bets of the largest size.
  assert.equal(sessionCapFor(0n, rules), 10n * SOL);
  assert.equal(sessionCapFor(1n, rules), 10n * SOL);
  // A u64 holds it: the program adds stakes with checked_add and compares with the cap.
  assert.equal(sessionCapFor(U64_MAX, rules), U64_MAX);
  assert.equal(sessionCapFor(U64_MAX / 50n, rules), U64_MAX);
  assert.ok(sessionCapFor(SOL * 1_000_000n, rules) <= U64_MAX);
  // The app's own numbers.
  assert.equal(SESSION_RULES.capTurnoverFactor, 100n);
  assert.equal(sessionCapFor(SOL / 10n, SESSION_RULES), 10n * SOL);
  // Over 50 bets of 0.02 stay under the allowance of a 0.10 top up (the old cap, 0.10, ended after 5).
  assert.ok(sessionCapFor(SOL / 10n, SESSION_RULES) > 50n * (SOL / 50n));
});

test('the position rent fallback is derived from the account size and sits just above the real figure', () => {
  assert.equal(rentExempt(ACCOUNT_SPACE.position), (128n + 100n) * 5_100n);
  assert.equal(RENT_FALLBACK.position, 1_162_800n);
  const real = 1_158_240n; // (100 + 128) x 5080, the rate devnet charges now
  assert.ok(RENT_FALLBACK.position > real, 'never below the real rent');
  assert.ok(RENT_FALLBACK.position - real < 10_000n, 'within a hair of it, not 38 percent above');
  assert.ok(RENT_FALLBACK.vault > 0n && RENT_FALLBACK.session > RENT_FALLBACK.vault);
});

test('who is connected decides the route: the connected wallet tops up, a visitor connects and plays in one session', () => {
  assert.deepEqual(playRoute(OWNER), { kind: 'top-up', owner: OWNER });
  assert.deepEqual(playRoute(null), { kind: 'connect-and-play' });
});

test('the bill without a wallet assumes no vault, no session and an empty device key, and says "up to"', () => {
  const rent = { vault: 1_000_000n, session: 2_000_000n };
  const guest = topUpBill({ known: false, deposit: SOL / 10n, vaultExists: true, sessionExists: true, keyLamports: SOL, rent, rules: RULES });
  // The known state is ignored: a visitor's own accounts are not known yet.
  assert.equal(guest.upTo, true);
  assert.equal(guest.plan.setup, 3_000_000n);
  assert.equal(guest.plan.keyFees, SESSION_RULES.gasTopUp);
  assert.equal(guest.plan.total, SOL / 10n + SESSION_RULES.gasTopUp + 3_000_000n + NETWORK_FEE);

  const sameAsPlan = topUpPlan({ deposit: SOL / 10n, vaultExists: false, sessionExists: false, keyLamports: null, rent, gasMin: SESSION_RULES.gasMin, gasTopUp: SESSION_RULES.gasTopUp });
  assert.deepEqual(guest.plan, sameAsPlan);

  // Once the account is read the bill is exact: a funded device key and existing accounts cost only the deposit and the fee.
  const known = topUpBill({ known: true, deposit: SOL / 10n, vaultExists: true, sessionExists: true, keyLamports: SOL / 100n, rent, rules: RULES });
  assert.equal(known.upTo, false);
  assert.deepEqual([known.plan.keyFees, known.plan.setup, known.plan.total], [0n, 0n, SOL / 10n + NETWORK_FEE]);
  // The visitor's worst case is never below the exact bill.
  assert.ok(guest.plan.total >= known.plan.total);
});

test('a first top up in one wallet session: open the vault, deposit, start the session, fund the device key', async () => {
  const prepared = await prepareTopUp({
    owner: OWNER,
    deviceKey: DEVICE,
    deposit: SOL / 10n,
    nowSec: 1_800_000_000,
    rules: RULES,
    reads: { vaultData: null, walletLamports: SOL, keyLamports: 0n },
  });
  assert.equal(prepared.vaultExists, false);
  assert.equal(prepared.plan.keyFees, SESSION_RULES.gasTopUp);
  const [open, dep, session, fund] = prepared.instructions;
  assert.equal(prepared.instructions.length, 4);
  assert.ok(startsWith(open.data as Uint8Array, IX.openVault));
  assert.ok(startsWith(dep.data as Uint8Array, IX.deposit));
  assert.equal(u64At(dep.data as Uint8Array, 8), SOL / 10n);
  assert.ok(startsWith(session.data as Uint8Array, IX.startSession));
  assert.equal(fund.programAddress, SYSTEM_PROGRAM_ID);
  assert.equal(u64At(fund.data as Uint8Array, 4), SESSION_RULES.gasTopUp);
  // start_session data: discriminator, expiry i64, max_per_bet u64, session_cap u64.
  const s = session.data as Uint8Array;
  assert.equal(u64At(s, 8), BigInt(1_800_000_000 + SESSION_RULES.durationSecs));
  assert.equal(u64At(s, 16), SESSION_RULES.maxPerBet);
  assert.equal(u64At(s, 24), 10n * SOL, 'the allowance is turnover, not the deposit');
  assert.equal(prepared.sessionCap, 10n * SOL);
});

test('a returning wallet: no new vault, no key top up when the key still has fees, the allowance counts what is already there', async () => {
  const prepared = await prepareTopUp({
    owner: OWNER,
    deviceKey: DEVICE,
    deposit: SOL / 4n,
    nowSec: 1_800_000_000,
    rules: RULES,
    reads: { vaultData: vaultBytes((SOL * 8n) / 100n), walletLamports: SOL, keyLamports: SESSION_RULES.gasMin },
  });
  assert.equal(prepared.vaultExists, true);
  assert.equal(prepared.plan.keyFees, 0n);
  assert.deepEqual(
    prepared.instructions.map((ix) => (ix.data as Uint8Array).slice(0, 8).join(',')),
    [IX.deposit.join(','), IX.startSession.join(',')],
  );
  // (0.25 + 0.08) x 100.
  assert.equal(prepared.sessionCap, 33n * SOL);
  assert.equal(decodeVault(vaultBytes(5n)).available, 5n);
});

test('an unreadable vault counts as missing, so it is opened again rather than deposited into blindly', async () => {
  const prepared = await prepareTopUp({
    owner: OWNER,
    deviceKey: DEVICE,
    deposit: SOL / 10n,
    nowSec: 1_800_000_000,
    rules: RULES,
    reads: { vaultData: new Uint8Array(57), walletLamports: SOL, keyLamports: SOL },
  });
  assert.equal(prepared.vaultExists, false);
});

test('a wallet with too little devnet SOL fails with the friendly sentence before anything is signed', async () => {
  const poor = {
    owner: OWNER,
    deviceKey: DEVICE,
    deposit: SOL / 10n,
    nowSec: 1_800_000_000,
    rules: RULES,
    reads: { vaultData: null, walletLamports: SOL / 1000n, keyLamports: 0n },
  };
  await assert.rejects(
    prepareTopUp(poor),
    new Error('The wallet has 0.001 SOL on devnet; this top up needs about 0.115 SOL. Get test SOL first.'),
  );
  // The margin is the one the old inline check used: deposit, the key's fees, and 0.01.
  const plan = topUpPlan({ deposit: SOL / 10n, vaultExists: false, sessionExists: false, keyLamports: 0n, rent: null, gasMin: RULES.gasMin, gasTopUp: RULES.gasTopUp });
  assert.equal(walletNeed(plan), SOL / 10n + SESSION_RULES.gasTopUp + TOP_UP_OVERHEAD);
  // Exactly enough passes.
  const exact = { ...poor, reads: { ...poor.reads, walletLamports: walletNeed(plan) } };
  assert.equal((await prepareTopUp(exact)).instructions.length, 4);
  const short = { ...poor, reads: { ...poor.reads, walletLamports: walletNeed(plan) - 1n } };
  await assert.rejects(prepareTopUp(short));
});

test('start_session accepts the new allowance: a positive u64, no upper bound in the program', () => {
  // programs/flip-the-meme: start_session requires session_cap > 0 and place_bet adds each stake with checked_add.
  const cap = sessionCapFor(SOL / 10n, SESSION_RULES);
  assert.ok(cap > 0n && cap <= U64_MAX);
});

test('the bill is two lines, Deposit and Network & setup, and they add up to what leaves the wallet', () => {
  const rent = { vault: RENT_FALLBACK.vault, session: RENT_FALLBACK.session };
  for (const input of [
    { vaultExists: false, sessionExists: false, keyLamports: null },
    { vaultExists: true, sessionExists: true, keyLamports: SESSION_RULES.gasMin },
    { vaultExists: true, sessionExists: false, keyLamports: 0n },
  ]) {
    const plan = topUpPlan({ deposit: SOL / 10n, ...input, rent, gasMin: RULES.gasMin, gasTopUp: RULES.gasTopUp });
    const lines = billLines(plan);
    assert.deepEqual(
      lines.map(([label]) => label),
      ['Deposit', 'Network & setup'],
    );
    assert.equal(lines[0][1], SOL / 10n);
    assert.equal(lines[0][1] + lines[1][1], plan.total);
  }
  // A returning wallet with a funded key pays the deposit and the network fee only.
  const light = topUpPlan({ deposit: SOL / 10n, vaultExists: true, sessionExists: true, keyLamports: SESSION_RULES.gasMin, rent, gasMin: RULES.gasMin, gasTopUp: RULES.gasTopUp });
  assert.equal(billLines(light)[1][1], NETWORK_FEE);
});
