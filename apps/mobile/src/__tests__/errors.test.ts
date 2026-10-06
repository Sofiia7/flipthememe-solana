// Node tests for the sentences a player reads when something fails: plain words, no raw wallet tails, no
// hard-coded limits, no web address that cannot be tapped. Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransactionFailed } from '@flipthememe/client';
import { humanError, walletDetail } from '../lib/errors.ts';
import { WalletStepError } from '../wallet/walletSession.ts';

const rnError = (code: number, message: string) => Object.assign(new Error(message), { code: 'JSON_RPC_ERROR', userInfo: { jsonRpcErrorCode: code } });
const program = (code: number) => new TransactionFailed('sig' as never, { InstructionError: [0n, { Custom: BigInt(code) }] });

test('the raw wallet tail goes to the console only, never into the message a player reads', () => {
  const connect = new WalletStepError('authorize', rnError(-1, 'authorization request failed'));
  assert.equal(humanError(connect, 'topup'), 'The wallet did not connect. Check that it is set to Devnet and try again.');
  const declined = new WalletStepError('sign', rnError(-3, 'transaction not signed'));
  assert.equal(humanError(declined, 'topup'), 'Request declined in the wallet.');
  for (const error of [connect, declined]) assert.ok(!humanError(error, 'connect').includes('['), 'no bracket tail');
  // The detail still exists for the console.
  assert.match(walletDetail(connect), /\[authorize -1: authorization request failed\]/);
});

test('an amount outside the limits is told without made-up numbers', () => {
  const message = humanError(program(6000), 'bet');
  assert.equal(message, "That amount is outside this round's limits.");
  assert.ok(!/0\.01|0\.1/.test(message));
});

test('the one-tap allowance message names no budget', () => {
  const message = humanError(program(6004), 'bet');
  assert.ok(!/budget/i.test(message));
  assert.match(message, /one-tap/i);
});

test('airdrop trouble is told in words: no web address that cannot be tapped', () => {
  const limited = humanError(new Error('429 Too Many Requests'), 'airdrop');
  assert.equal(limited, 'The devnet faucet is rate limited. Use the faucet link to get test SOL.');
  const failed = humanError(new Error('boom'), 'airdrop');
  assert.equal(failed, 'Airdrop failed. Use the faucet link to get test SOL.');
  for (const message of [limited, failed]) assert.ok(!/https?:\/\/|\.com/.test(message), message);
  const poor = humanError(new Error('Transaction results in an account with insufficient funds for rent'), 'topup');
  assert.equal(poor, 'Not enough devnet SOL in the wallet - use Airdrop or the faucet link.');
});

test('the device key is called the device key, not the session key', () => {
  const noFees = humanError(new Error('Attempt to debit an account but found no record of a prior credit.'), 'bet');
  assert.equal(noFees, 'The device key is out of devnet SOL for fees - Top up & play refills it.');
});
