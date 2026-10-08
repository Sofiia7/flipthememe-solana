import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rank, scorePosition, type Score } from '../src/leaderboard.ts';
import { address } from '@solana/kit';
import { Outcome, RoundStatus, Side, type PositionAccount } from '@flipthememe/client';
import { makeRound } from './fake-chain.ts';

test('ranking uses exact net lamports, includes refund fees, excludes refunds from accuracy and old bets', () => {
  const now = 1_800_000_000_000;
  const row = (owner: string, result: Score['result'], stake: string, payout: string, at = now): Score => ({ key: owner + result, owner, result, stake, payout, at });
  const scores = [row('a', 'win', '20000000', '39200000'), row('a', 'loss', '20000000', '0'), row('a', 'refund', '20000000', '19800000'), row('b', 'win', '20000000', '39200000'), row('c', 'win', '1', '99999999999999', now - 8 * 86400_000)];
  const board = rank(scores, now);
  assert.deepEqual(board.map((p) => [p.owner, p.net, p.accuracy, p.refunds]), [['b', '19200000', 100, 0], ['a', '-1000000', 50, 1]]);
  assert.deepEqual(rank([row('a', 'refund', '20', '20')], now)[0].accuracy, null);
});
test('UP outcome pays the UP player and loses the DOWN player; house and open bets do not enter ranking', () => {
  const key = address('11111111111111111111111111111112');
  const r = makeRound(1n, 1_800_000_000n, key, key, { status: RoundStatus.Final, outcome: Outcome.Up, rawUp: 20_000_000n, rawDown: 20_000_000n, feeWinBps: 200 });
  const p: PositionAccount = { authority: key, round: key, side: Side.Up, stake: 20_000_000n, claimed: false, payout: 0n, isHouse: false, face: new Uint8Array(8), bump: 1 };
  assert.equal(scorePosition(r, p)?.payout, '39200000');
  assert.equal(scorePosition(r, p)?.result, 'win');
  assert.equal(scorePosition(r, { ...p, side: Side.Down })?.result, 'loss');
  assert.equal(scorePosition(r, { ...p, side: Side.Down })?.payout, '0');
  assert.equal(scorePosition(r, { ...p, isHouse: true }), null);
  assert.equal(scorePosition({ ...r, status: RoundStatus.Live }, p), null);
  assert.equal(scorePosition(r, { ...p, claimed: true, payout: 123n })?.payout, '123');
});


test('latest recorded pixel face survives ranking and missing legacy faces', () => {
  const now = 1_800_000_000_000;
  const base: Score = { key: '1:a', owner: 'a', at: now - 1000, stake: '1', payout: '2', result: 'win', face: '0001020304050607' };
  const rows = [ { ...base, key: '2:a', at: now, face: '08090a0b0c0d0e0f' }, base, { ...base, key: '3:a', at: now + 1, face: undefined } ];
  assert.equal(rank(rows, now + 1)[0].face, '08090a0b0c0d0e0f');
  assert.equal(rank([{ ...base, face: 'invalid' }], now)[0].face, undefined);
});
