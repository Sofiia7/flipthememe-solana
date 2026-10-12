import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Leaderboard, rank, scorePosition, type Score } from '../src/leaderboard.ts';
import { address, generateKeyPairSigner } from '@solana/kit';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SolanaRpc } from '../src/rpc.ts';
import { Outcome, RoundStatus, Side, type PositionAccount } from '@flipthememe/client';
import { makeRound } from './fake-chain.ts';

test('archive publication is signed, failed publication blocks closing, and restart requires republication', async () => {
  const signer = await generateKeyPairSigner();
  const dir = mkdtempSync(join(tmpdir(), 'ftm-archive-test-'));
  const file = join(dir, 'ledger.json');
  const position = address('11111111111111111111111111111112');
  const round = address('11111111111111111111111111111113');
  writeFileSync(file, JSON.stringify({ coverageSince: new Date().toISOString(), scores: [{ key: '1:' + signer.address, owner: signer.address, at: Date.now(), stake: '1', payout: '2', result: 'win', archive: { position, round, positionData: 'AA==', roundData: 'AA==' } }] }));
  const rpc = { getProgramAccounts: () => ({ send: async () => [] }) } as unknown as SolanaRpc;
  const original = globalThis.fetch;
  let fail = true;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const payload = String(init?.body);
    const signature = new Uint8Array(Buffer.from(new Headers(init?.headers).get('x-keeper-signature')!, 'base64'));
    assert.equal(await crypto.subtle.verify('Ed25519', signer.keyPair.publicKey, signature, new TextEncoder().encode('FlipTheMeme history v1\n' + payload)), true);
    assert.equal(JSON.parse(payload).owner, signer.address);
    return new Response('{}', { status: fail ? 503 : 200 });
  };
  try {
    const board = new Leaderboard(file, rpc, signer);
    assert.equal(board.archived(position), false);
    await assert.rejects(board.tick(), /503/);
    assert.equal(board.archived(position), false);
    fail = false;
    await board.tick();
    assert.equal(board.archived(position), true);
    const restarted = new Leaderboard(file, rpc, signer);
    assert.equal(restarted.archived(position), false);
    await restarted.tick();
    assert.equal(restarted.archived(position), true);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true });
  }
});

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
