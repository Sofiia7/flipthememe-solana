// Node tests for the small shared decisions of the play flow: the minimum stake fallback and "can this
// phone play again with the money already in the game balance", how a session row tells what its key
// can do, and what WITHDRAW ALL does with the device key's SOL. Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddressDecoder } from '@solana/kit';
import type { SessionAccount } from '@flipthememe/client';
import { DEFAULT_MIN_STAKE, SESSION_RULES } from '../config.ts';
import { formatSol, sol } from '../lib/format.ts';
import { keyReturnAmount, shouldReturnKey, withdrawMessage } from '../wallet/keyReturn.ts';
import { canRenewSession, minStakeOf } from '../wallet/playState.ts';
import { sessionLimitedBelow, sessionRows, sessionUsageText } from '../wallet/sessionList.ts';
import { NETWORK_FEE } from '../wallet/topUpPlan.ts';

const SOL = 1_000_000_000n;
const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));

test('the minimum stake is the open round, else the config, else the program default: one fallback, not three', () => {
  assert.equal(DEFAULT_MIN_STAKE, 10_000_000n);
  assert.equal(minStakeOf(20_000_000n, 30_000_000n), 20_000_000n);
  assert.equal(minStakeOf(undefined, 30_000_000n), 30_000_000n);
  assert.equal(minStakeOf(null, undefined), DEFAULT_MIN_STAKE);
  assert.equal(minStakeOf(), DEFAULT_MIN_STAKE);
  assert.equal(minStakeOf(0n, 5n), 0n, 'a zero minimum is still an answer');
});

test('play again needs money in the game balance and a session or device key that can no longer play', () => {
  const base = { myReady: true, available: SOL / 10n, minStake: DEFAULT_MIN_STAKE, status: 'active' as const, keyLamports: SOL / 100n };
  assert.equal(canRenewSession(base), false, 'a working session with fees on the key needs nothing');
  assert.equal(canRenewSession({ ...base, status: 'expired' }), true);
  assert.equal(canRenewSession({ ...base, status: 'revoked' }), true);
  assert.equal(canRenewSession({ ...base, status: 'used-up' }), true);
  assert.equal(canRenewSession({ ...base, status: 'none' }), true);
  assert.equal(canRenewSession({ ...base, keyLamports: SESSION_RULES.gasPerBet - 1n }), true, 'the key is out of fee money');
  assert.equal(canRenewSession({ ...base, keyLamports: SESSION_RULES.gasPerBet }), false);
  assert.equal(canRenewSession({ ...base, keyLamports: null }), true, 'an unread key counts as empty');
  assert.equal(canRenewSession({ ...base, status: 'expired', available: DEFAULT_MIN_STAKE - 1n }), false, 'under one minimum stake there is nothing to play with');
  assert.equal(canRenewSession({ ...base, status: 'expired', myReady: false }), false, 'before the account is read nothing is offered');
});

function session(over: Partial<SessionAccount> = {}): SessionAccount {
  return {
    authority: addr(3),
    vault: addr(4),
    signer: addr(5),
    expiry: 1_800_086_400n,
    maxPerBet: SOL / 10n,
    sessionCap: 10n * SOL,
    spent: (SOL * 6n) / 100n,
    revoked: false,
    bump: 253,
    ...over,
  };
}

test('a session row says what the key can do: staked so far and max per bet, no confusing budget', () => {
  const floor = sessionLimitedBelow(SESSION_RULES);
  assert.equal(floor, 10n * SOL);
  const [row] = sessionRows([{ address: addr(10), account: session() }], { deviceKey: addr(5), nowSec: 1_800_000_000, minStake: DEFAULT_MIN_STAKE });
  assert.equal(sessionUsageText(row, floor, formatSol), 'staked 0.06 SOL so far');
  assert.equal(row.maxPerBet, SOL / 10n);
  // A session with nothing staked yet.
  const fresh = sessionRows([{ address: addr(10), account: session({ spent: 0n }) }], { deviceKey: null, nowSec: 1_800_000_000, minStake: DEFAULT_MIN_STAKE })[0];
  assert.equal(sessionUsageText(fresh, floor, formatSol), 'no bets yet');
});

test('a session made with the old small cap stays readable: staked of limit', () => {
  const floor = sessionLimitedBelow(SESSION_RULES);
  const old = sessionRows([{ address: addr(11), account: session({ sessionCap: SOL / 10n, spent: (SOL * 4n) / 100n }) }], {
    deviceKey: null,
    nowSec: 1_800_000_000,
    minStake: DEFAULT_MIN_STAKE,
  })[0];
  assert.equal(sessionUsageText(old, floor, formatSol), 'staked 0.04 of its 0.10 SOL limit');
  // A used-up old session reads the same, and says so through the row's status.
  const usedUp = sessionRows([{ address: addr(12), account: session({ sessionCap: SOL / 10n, spent: SOL / 10n }) }], {
    deviceKey: null,
    nowSec: 1_800_000_000,
    minStake: DEFAULT_MIN_STAKE,
  })[0];
  assert.equal(usedUp.status, 'used-up');
  assert.equal(sessionUsageText(usedUp, floor, formatSol), 'staked 0.10 of its 0.10 SOL limit');
  // The widest an old session can be is still below what a new one carries.
  assert.ok(SOL / 2n < floor);
});

test('what the device key returns: everything above one fee, only when it holds more than a fee', () => {
  assert.equal(keyReturnAmount(NETWORK_FEE + 1_000_000n), 1_000_000n);
  assert.equal(keyReturnAmount(NETWORK_FEE), 0n);
  assert.equal(keyReturnAmount(0n), 0n);
  assert.equal(keyReturnAmount(NETWORK_FEE - 1n), 0n);
  assert.equal(shouldReturnKey({ keyLamports: NETWORK_FEE + 1n, betInFlight: false }), true);
  assert.equal(shouldReturnKey({ keyLamports: NETWORK_FEE, betInFlight: false }), false, 'only a fee: nothing worth moving');
  assert.equal(shouldReturnKey({ keyLamports: 5n * SOL, betInFlight: true }), false, 'a bet is still landing and needs the key');
});

test('the withdraw message: a returned key adds a line, a failed second step never turns the withdraw into an error', () => {
  const done = `Withdrew ${sol(SOL / 12n)} to your wallet.`;
  assert.equal(done, 'Withdrew 0.0833 SOL to your wallet.');
  assert.equal(withdrawMessage(done, { kind: 'returned', amount: 4_995_000n }), `${done} The device key's 0.00499 SOL came back too.`);
  assert.equal(withdrawMessage(done, { kind: 'empty' }), done);
  assert.equal(withdrawMessage(done, { kind: 'busy' }), `${done} The device key keeps its fee money while a bet is landing.`);
  assert.equal(withdrawMessage(done, { kind: 'checking' }), `${done} The device key's SOL is on its way - check the balance in a minute.`);
  assert.equal(
    withdrawMessage(done, { kind: 'failed' }),
    `${done} The device key's SOL stays on this phone; RETURN TO WALLET under ADVANCED sends it.`,
  );
  for (const kind of ['returned', 'empty', 'busy', 'checking', 'failed'] as const) {
    const message = withdrawMessage(done, kind === 'returned' ? { kind, amount: 1n } : { kind });
    assert.ok(message.startsWith(done), 'the withdraw itself always comes first');
  }
});
