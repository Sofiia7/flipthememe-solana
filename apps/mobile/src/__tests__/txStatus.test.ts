// Node tests for money safety (no React Native): what a sent transaction became, the store of
// wallet transactions with no known outcome, and the session list. Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  SolanaError,
  getAddressDecoder,
  getAddressEncoder,
} from '@solana/kit';
import { ACCOUNT, OFFSETS, TransactionFailed, decodeSession, type SessionAccount } from '@flipthememe/client';
import {
  LEGACY_EXPIRY_MS,
  checkSignature,
  classifyTx,
  sendErrorProof,
  settleSendError,
  settledError,
  type SendProof,
  type TxVerdict,
} from '../chain/txStatus.ts';
import { humanError } from '../lib/errors.ts';
import type { KeyValueStorage } from '../lib/boolStore.ts';
import {
  PENDING_TX_CAP,
  createPendingTxStore,
  isChecking,
  parsePendingTxs,
  pendingTxEntry,
  serializePendingTxs,
  type PendingTx,
} from '../wallet/pendingTx.ts';
import {
  MAX_REVOKES_PER_TX,
  SESSION_OFFSETS,
  SESSION_SPACE,
  revocableSigners,
  sessionRows,
  sessionStatusOf,
  withDeviceSession,
} from '../wallet/sessionList.ts';

const SOL = 1_000_000_000n;
const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const NOW = 1_800_000_000_000;

const preflight = (cause?: SolanaError) =>
  new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
    accounts: null,
    logs: ['Program failed: custom program error: 0x1772'],
    unitsConsumed: 1n,
    returnData: null,
    ...(cause ? { cause } : {}),
  } as never);

test('a status settles a transaction; without one, the block height says wait or expired', () => {
  const at = { blockHeight: 100n, lastValidBlockHeight: 150n, sentAt: NOW - 1_000, now: NOW };
  assert.equal(classifyTx({ ...at, status: { err: null, confirmationStatus: 'confirmed' } }), 'confirmed');
  assert.equal(classifyTx({ ...at, status: { err: null, confirmationStatus: 'finalized' } }), 'confirmed');
  // Found through history search (rooted): no confirmation level, still a result.
  assert.equal(classifyTx({ ...at, status: { err: null, confirmationStatus: null } }), 'confirmed');
  assert.equal(classifyTx({ ...at, status: { err: { InstructionError: [0, { Custom: 6002 }] }, confirmationStatus: 'confirmed' } }), 'failed');
  // Processed only: the fork can still drop it, either way.
  assert.equal(classifyTx({ ...at, status: { err: null, confirmationStatus: 'processed' } }), 'pending');
  assert.equal(classifyTx({ ...at, status: { err: { InstructionError: [0, 'X'] }, confirmationStatus: 'processed' } }), 'pending');

  // Not found: it can land up to and including its last valid block height.
  assert.equal(classifyTx({ ...at, status: null }), 'pending');
  assert.equal(classifyTx({ ...at, status: null, blockHeight: 150n }), 'pending');
  assert.equal(classifyTx({ ...at, status: null, blockHeight: 151n }), 'expired');

  // Older records without a lastValidBlockHeight fall back on time.
  const legacy = { status: null, blockHeight: 999n, lastValidBlockHeight: null, sentAt: NOW };
  assert.equal(classifyTx({ ...legacy, now: NOW + LEGACY_EXPIRY_MS }), 'pending');
  assert.equal(classifyTx({ ...legacy, now: NOW + LEGACY_EXPIRY_MS + 1 }), 'expired');
});

test('what a send error proves: only an on-chain failure or a refused simulation, never a transport error', () => {
  assert.equal(sendErrorProof(new TransactionFailed('s' as never, { InstructionError: [0n, { Custom: 6002n }] })), 'failed');
  assert.equal(sendErrorProof(new TransactionFailed('s' as never, 'timeout')), 'unknown');
  // The client's own expiry check reads the status before the height: re-checked, not trusted.
  assert.equal(sendErrorProof(new TransactionFailed('s' as never, 'blockhash expired')), 'unknown');
  assert.equal(sendErrorProof(preflight(new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND))), 'refused');
  assert.equal(sendErrorProof(preflight()), 'refused');
  // An earlier send of the same transaction got in: look it up.
  assert.equal(sendErrorProof(preflight(new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED))), 'unknown');

  // The errors the old classifier treated as a failed bet now keep it pending.
  const http = (statusCode: number) =>
    new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: 'x', statusCode } as never);
  assert.equal(sendErrorProof(http(429)), 'unknown');
  assert.equal(sendErrorProof(http(503)), 'unknown');
  assert.equal(sendErrorProof(new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY, {} as never)), 'unknown');
  assert.equal(sendErrorProof(new TypeError('Network request failed')), 'unknown');
  assert.equal(sendErrorProof(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), 'unknown');
  assert.equal(sendErrorProof(new Error('socket hang up')), 'unknown');
  assert.equal(sendErrorProof('weird'), 'unknown');
});

test('after a send error, one look at the chain decides; without an answer it stays CHECKING', () => {
  const cases: [SendProof, TxVerdict | null, TxVerdict][] = [
    ['failed', null, 'failed'],
    ['failed', 'confirmed', 'failed'],
    ['unknown', 'confirmed', 'confirmed'],
    ['unknown', 'failed', 'failed'],
    ['unknown', 'expired', 'expired'],
    ['unknown', 'pending', 'pending'],
    ['unknown', null, 'pending'],
    ['refused', 'confirmed', 'confirmed'],
    ['refused', 'failed', 'failed'],
    ['refused', 'pending', 'failed'],
    ['refused', 'expired', 'failed'],
    ['refused', null, 'failed'],
  ];
  for (const [proof, check, want] of cases) assert.equal(settleSendError(proof, check), want, `${proof} + ${check}`);

  // The bet that lost its answer to a dropped connection: kept pending, then settled by the chain.
  const dropped = sendErrorProof(new TypeError('Network request failed'));
  assert.equal(settleSendError(dropped, null), 'pending');
  assert.equal(settleSendError(dropped, 'pending'), 'pending');
  assert.equal(settleSendError(dropped, 'confirmed'), 'confirmed');
  assert.equal(settleSendError(dropped, 'expired'), 'expired');
});

test('settled failures explain themselves: the program reason, or nothing taken on expiry', () => {
  assert.equal(
    humanError(settledError('s', 'expired', { verdict: 'expired', err: null }, new Error('x')), 'topup'),
    'The network was too slow and the transaction expired - nothing was taken. Try again.',
  );
  const refused = settledError('s', 'failed', { verdict: 'failed', err: { InstructionError: [0n, { Custom: 6002n }] } }, null);
  assert.ok(refused instanceof TransactionFailed);
  assert.equal(humanError(refused, 'withdraw'), 'Not enough available balance - top up first.');
  const original = preflight();
  assert.equal(settledError('s', 'failed', null, original), original, 'a refused simulation keeps its own error');
  assert.equal(humanError(new TransactionFailed('s' as never, { InsufficientFundsForRent: { account_index: 0 } }), 'sweep'), 'The device key balance just changed - try again.');
});

test('checkSignature reads the block height before the status, with history search', async () => {
  const calls: string[] = [];
  const fake = (status: unknown, height: bigint) => ({
    getBlockHeight: (config: { commitment: string }) => ({
      send: async () => {
        calls.push(`height ${config.commitment}`);
        return height;
      },
    }),
    getSignatureStatuses: (signatures: string[], config: { searchTransactionHistory: boolean }) => ({
      send: async () => {
        calls.push(`status ${signatures[0]} history=${config.searchTransactionHistory}`);
        return { context: { slot: 1n }, value: [status] };
      },
    }),
  });
  const tx = { signature: 'SiG', lastValidBlockHeight: 150n, at: Date.now() };
  assert.deepEqual(await checkSignature(fake(null, 151n) as never, tx), { verdict: 'expired', err: null });
  assert.deepEqual(calls, ['height confirmed', 'status SiG history=true']);
  assert.equal((await checkSignature(fake(null, 120n) as never, tx)).verdict, 'pending');
  const err = { InstructionError: [0, { Custom: 6015 }] };
  assert.deepEqual(await checkSignature(fake({ err, confirmationStatus: 'finalized' }, 999n) as never, tx), { verdict: 'failed', err });
  assert.equal((await checkSignature(fake({ err: null, confirmationStatus: 'confirmed' }, 999n) as never, tx)).verdict, 'confirmed');
});

const OWNER = addr(1);
const tx = (over: Partial<PendingTx> = {}): PendingTx => ({
  action: 'topup',
  owner: OWNER,
  signature: 'sig-a',
  lastValidBlockHeight: 300_000_123n,
  at: NOW,
  done: 'Topped up 0.1 SOL.',
  targets: [],
  ...over,
});

function memoryStorage() {
  const data = new Map<string, string>();
  const storage: KeyValueStorage = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      await new Promise((r) => setTimeout(r, 1));
      data.set(key, value);
    },
  };
  return { data, storage };
}

test('unknown-outcome wallet transactions are kept per wallet until settled', async () => {
  const { data, storage } = memoryStorage();
  const store = createPendingTxStore(storage);
  const a = tx();
  const b = tx({ action: 'revoke', signature: 'sig-b', targets: [addr(7), addr(8)], done: '2 sessions revoked.' });
  // Writes run in order even when fired together.
  await Promise.all([store.put(a), store.put(b), store.remove(OWNER, 'sig-a')]);
  assert.deepEqual(await store.load(OWNER), [b]);
  assert.deepEqual([...data.keys()], [pendingTxEntry(OWNER)]);
  assert.equal(pendingTxEntry(OWNER), `ftm.pendingTx.v1.${OWNER}`);
  assert.deepEqual(await store.load(addr(2)), [], 'another wallet has its own entry');
  await store.remove(OWNER, 'sig-b');
  assert.deepEqual(await store.load(OWNER), []);

  // The matching button shows CHECKING; a revoke only on the sessions it covers.
  const list = [a, b];
  assert.equal(isChecking(list, 'topup'), true);
  assert.equal(isChecking(list, 'withdraw'), false);
  assert.equal(isChecking(list, 'revoke'), true);
  assert.equal(isChecking(list, 'revoke', addr(8)), true);
  assert.equal(isChecking(list, 'revoke', addr(9)), false);

  // Round trip; rows of another wallet, unknown actions or bad heights are not trusted.
  assert.deepEqual(parsePendingTxs(serializePendingTxs(list), OWNER), list);
  const raw = JSON.parse(serializePendingTxs(list)) as { v: number; txs: Record<string, unknown>[] };
  raw.txs.push({ ...raw.txs[0], owner: addr(3) }, { ...raw.txs[0], action: 'bet' }, { ...raw.txs[0], lastValidBlockHeight: '-1' });
  assert.deepEqual(parsePendingTxs(JSON.stringify(raw), OWNER), list);
  assert.deepEqual(parsePendingTxs(JSON.stringify({ ...raw, v: 2 }), OWNER), []);
  assert.deepEqual(parsePendingTxs('{', OWNER), []);

  const many = createPendingTxStore(memoryStorage().storage);
  for (let i = 0; i < PENDING_TX_CAP + 3; i++) await many.put(tx({ signature: `s${i}` }));
  const kept = await many.load(OWNER);
  assert.equal(kept.length, PENDING_TX_CAP);
  assert.equal(kept[0].signature, 's3', 'the oldest go first');
});

function session(over: Partial<SessionAccount> = {}): SessionAccount {
  return {
    authority: OWNER,
    vault: addr(4),
    signer: addr(5),
    expiry: 1_800_086_400n,
    maxPerBet: SOL / 10n,
    sessionCap: SOL / 4n,
    spent: SOL / 50n,
    revoked: false,
    bump: 253,
    ...over,
  };
}

test('session list: this phone first, then sessions that can still bet; revoke only those', () => {
  const now = 1_800_000_000;
  const min = SOL / 100n;
  assert.equal(sessionStatusOf(null, now, min), 'none');
  assert.equal(sessionStatusOf(session(), now, min), 'active');
  assert.equal(sessionStatusOf(session({ revoked: true }), now, min), 'revoked');
  assert.equal(sessionStatusOf(session({ expiry: BigInt(now) }), now, min), 'expired');
  assert.equal(sessionStatusOf(session({ spent: SOL / 4n }), now, min), 'used-up');

  const list = [
    { address: addr(10), account: session({ signer: addr(20), expiry: 1_800_050_000n }) },
    { address: addr(11), account: session({ signer: addr(21), revoked: true, expiry: 1_800_090_000n }) },
    { address: addr(12), account: session({ signer: addr(22), expiry: 1_799_999_000n }) },
    { address: addr(13), account: session({ signer: addr(23), expiry: 1_800_080_000n, spent: SOL / 4n }) },
    { address: addr(14), account: session({ signer: addr(24), expiry: 1_800_010_000n }) },
  ];
  const rows = sessionRows(list, { deviceKey: addr(24), nowSec: now, minStake: min });
  assert.deepEqual(
    rows.map((r) => [r.signer, r.mine, r.status, r.revocable]),
    [
      [addr(24), true, 'active', true],
      [addr(23), false, 'used-up', true],
      [addr(20), false, 'active', true],
      [addr(21), false, 'revoked', false],
      [addr(22), false, 'expired', false],
    ],
  );
  assert.equal(rows[0].secondsLeft, 10_000);
  assert.equal(rows[0].expiry, 1_800_010_000);
  assert.equal(rows[4].secondsLeft, 0);
  assert.deepEqual(rows[2].budget, SOL / 4n);
  assert.deepEqual(revocableSigners(rows), [addr(24), addr(23), addr(20)]);

  // This phone's session read fresh replaces its listed copy (or joins the list).
  const fresh = { address: addr(14), account: session({ signer: addr(24), spent: SOL / 10n, expiry: 1_800_010_000n }) };
  const merged = withDeviceSession(list, fresh);
  assert.equal(merged.length, 5);
  assert.equal(merged.find((s) => s.address === addr(14))?.account.spent, SOL / 10n);
  assert.equal(withDeviceSession([], fresh).length, 1);
  assert.equal(withDeviceSession(list, null).length, 5);

  const lots = Array.from({ length: MAX_REVOKES_PER_TX + 5 }, (_, i) => ({ address: addr(40 + i), account: session({ signer: addr(80 + i) }) }));
  assert.equal(revocableSigners(sessionRows(lots, { deviceKey: null, nowSec: now, minStake: min })).length, MAX_REVOKES_PER_TX);
});

test('session layout: the offsets the list filters on match the program and the decoder', () => {
  const data = new Uint8Array(SESSION_SPACE);
  const view = new DataView(data.buffer);
  const enc = getAddressEncoder();
  data.set(ACCOUNT.Session, 0);
  data.set(enc.encode(OWNER) as Uint8Array, SESSION_OFFSETS.authority);
  data.set(enc.encode(addr(4)) as Uint8Array, SESSION_OFFSETS.vault);
  data.set(enc.encode(addr(5)) as Uint8Array, SESSION_OFFSETS.signer);
  view.setBigInt64(SESSION_OFFSETS.expiry, 1_800_086_400n, true);
  view.setBigUint64(SESSION_OFFSETS.maxPerBet, SOL / 10n, true);
  view.setBigUint64(SESSION_OFFSETS.sessionCap, SOL / 4n, true);
  view.setBigUint64(SESSION_OFFSETS.spent, SOL / 50n, true);
  data[SESSION_OFFSETS.revoked] = 1;
  data[SESSION_SPACE - 1] = 253;
  assert.deepEqual(decodeSession(data), session({ revoked: true }));
  // 8 discriminator + 3 keys + 4 u64/i64 + revoked + bump.
  assert.equal(SESSION_SPACE, 8 + 32 * 3 + 8 * 4 + 1 + 1);
  assert.equal(OFFSETS.sessionAuthority, SESSION_OFFSETS.authority);
});
