// Node test for the one number that decides whether the device key may pay a claim fee itself (no React
// Native). Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAIM_KEY_MIN_LAMPORTS, FAUCET_API, FAUCET_TIMEOUT_MS, RESULT_REMINDER_DELAY_SECS, SESSION_RULES } from '../config.ts';
import { NETWORK_FEE, rentExempt } from '../wallet/topUpPlan.ts';

test('the claim threshold of the device key is the same one a bet needs, and leaves the key rent-exempt after the fee', () => {
  assert.equal(CLAIM_KEY_MIN_LAMPORTS, SESSION_RULES.gasPerBet);
  // An account with no data stays alive only above its rent-exempt minimum: the key must keep that after paying the fee.
  assert.ok(CLAIM_KEY_MIN_LAMPORTS >= rentExempt(0) + NETWORK_FEE, 'fee plus the key own rent-exempt minimum');
  // The old loose number was far under that minimum: a key holding it could not pay and stay alive.
  assert.ok(20_000n < rentExempt(0));
});

test('the faucet endpoint is the project own, and a slow one gives up in seconds', () => {
  assert.equal(FAUCET_API, 'https://sol.flipthememe.com/v1/faucet');
  assert.equal(FAUCET_TIMEOUT_MS, 12_000);
});

test('the result reminder waits 15 seconds after the exit window', () => {
  assert.equal(RESULT_REMINDER_DELAY_SECS, 15);
});
