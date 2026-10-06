// Node tests for closing finished play sessions (no React Native): which rows the Wallet tab may
// close, how many go into one transaction, the re-check against fresh chain data and the result text.
// Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
} from '@solana/kit';
import { ACCOUNT, closeSession, type SessionAccount } from '@flipthememe/client';
import { SESSION_OFFSETS, SESSION_SPACE, sessionRows, type SessionEntry, type SessionRow } from '../wallet/sessionList.ts';
import {
  CLOSE_MARGIN_SECS,
  MAX_CLOSES_PER_TX,
  closableRows,
  closeBatches,
  closeDoneText,
  closeNothingText,
  closeOffer,
  confirmClosable,
  isClosable,
} from '../wallet/sessionClose.ts';
import { sol } from '../lib/format.ts';
import { humanError } from '../lib/errors.ts';
import { isChecking, parsePendingTxs, serializePendingTxs, type PendingTx } from '../wallet/pendingTx.ts';

const SOL = 1_000_000_000n;
const NOW = 1_800_000_000;
const MIN_STAKE = SOL / 100n;
const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const OWNER = addr(1);
const DEVICE = addr(5);

function account(over: Partial<SessionAccount> = {}): SessionAccount {
  return {
    authority: OWNER,
    vault: addr(4),
    signer: DEVICE,
    expiry: BigInt(NOW + 86_400),
    maxPerBet: SOL / 10n,
    sessionCap: 10n * SOL,
    spent: SOL / 50n,
    revoked: false,
    bump: 253,
    ...over,
  };
}

/** Rows at NOW, this phone's device key being DEVICE. */
function rowsOf(list: { address: Address; account: Partial<SessionAccount> }[]): SessionRow[] {
  const entries: SessionEntry[] = list.map((s) => ({ address: s.address, account: account(s.account) }));
  return sessionRows(entries, { deviceKey: DEVICE, nowSec: NOW, minStake: MIN_STAKE });
}

/** The program's bytes for a Session, written at the documented offsets. */
function sessionBytes(s: SessionAccount): Uint8Array {
  const data = new Uint8Array(SESSION_SPACE);
  const view = new DataView(data.buffer);
  const enc = getAddressEncoder();
  data.set(ACCOUNT.Session, 0);
  data.set(enc.encode(s.authority) as Uint8Array, SESSION_OFFSETS.authority);
  data.set(enc.encode(s.vault) as Uint8Array, SESSION_OFFSETS.vault);
  data.set(enc.encode(s.signer) as Uint8Array, SESSION_OFFSETS.signer);
  view.setBigInt64(SESSION_OFFSETS.expiry, s.expiry, true);
  view.setBigUint64(SESSION_OFFSETS.maxPerBet, s.maxPerBet, true);
  view.setBigUint64(SESSION_OFFSETS.sessionCap, s.sessionCap, true);
  view.setBigUint64(SESSION_OFFSETS.spent, s.spent, true);
  data[SESSION_OFFSETS.revoked] = s.revoked ? 1 : 0;
  data[SESSION_SPACE - 1] = s.bump;
  return data;
}

const RENT = 1_351_280n;

test('only a revoked session, or one expired for a short margin, can be closed: never one that can still bet', () => {
  const rows = rowsOf([
    // This phone's own session, active: not closable.
    { address: addr(10), account: { signer: DEVICE } },
    // A session whose cap is used up but that is neither revoked nor expired: still active.
    { address: addr(11), account: { signer: addr(21), sessionCap: SOL / 10n, spent: SOL / 10n } },
    { address: addr(12), account: { signer: addr(22), revoked: true } },
    { address: addr(13), account: { signer: addr(23), expiry: BigInt(NOW - 3_600) } },
    // Just expired: inside the clock margin, not offered yet.
    { address: addr(14), account: { signer: addr(24), expiry: BigInt(NOW - 1) } },
    // Revoked and expired both.
    { address: addr(15), account: { signer: addr(25), revoked: true, expiry: BigInt(NOW - 100) } },
  ]);
  const status = Object.fromEntries(rows.map((r) => [r.signer, r.status]));
  assert.deepEqual(status, {
    [DEVICE]: 'active',
    [addr(21)]: 'used-up',
    [addr(22)]: 'revoked',
    [addr(23)]: 'expired',
    [addr(24)]: 'expired',
    [addr(25)]: 'revoked',
  });
  const closable = new Set(closableRows(rows, NOW).map((r) => r.signer));
  assert.deepEqual(closable, new Set([addr(22), addr(23), addr(25)]));
  // Every row says the same through isClosable.
  for (const row of rows) assert.equal(isClosable(row, NOW), closable.has(row.signer), row.signer);

  // The margin: 30 s after the expiry second the just-expired one is offered too.
  assert.equal(CLOSE_MARGIN_SECS, 30);
  const justExpired = rows.find((r) => r.signer === addr(24))!;
  assert.equal(isClosable(justExpired, NOW + CLOSE_MARGIN_SECS - 2), false);
  assert.equal(isClosable(justExpired, NOW + CLOSE_MARGIN_SECS - 1), true, 'expiry + margin reached');
});

test('this phone is closable once its own session is revoked or expired, never while it is active', () => {
  const [mine] = rowsOf([{ address: addr(10), account: { signer: DEVICE } }]);
  assert.equal(mine.mine, true);
  assert.equal(isClosable(mine, NOW), false);
  const [revoked] = rowsOf([{ address: addr(10), account: { signer: DEVICE, revoked: true } }]);
  assert.deepEqual([revoked.mine, isClosable(revoked, NOW)], [true, true]);
  const [expired] = rowsOf([{ address: addr(10), account: { signer: DEVICE, expiry: BigInt(NOW - 3_600) } }]);
  assert.deepEqual([expired.mine, isClosable(expired, NOW)], [true, true]);
});

test('batches keep their order, hold at most MAX_CLOSES_PER_TX and lose nothing', () => {
  assert.deepEqual(closeBatches([]), []);
  const items = Array.from({ length: MAX_CLOSES_PER_TX * 2 + 3 }, (_, i) => i);
  const batches = closeBatches(items);
  assert.deepEqual(batches.map((b) => b.length), [MAX_CLOSES_PER_TX, MAX_CLOSES_PER_TX, 3]);
  assert.deepEqual(batches.flat(), items);
  assert.deepEqual(closeBatches([1, 2, 3], 2), [[1, 2], [3]]);
  assert.throws(() => closeBatches([1], 0), /size/);
});

test('the offer: every closable row, the first batch the next tap closes, and how many wait', () => {
  const none = closeOffer(rowsOf([{ address: addr(10), account: { signer: DEVICE } }]), NOW);
  assert.deepEqual([none.targets.length, none.batch.length, none.later], [0, 0, 0]);

  const old = Array.from({ length: MAX_CLOSES_PER_TX + 5 }, (_, i) => ({
    address: addr(100 + i),
    account: { signer: addr(150 + i), expiry: BigInt(NOW - 3_600 - i) },
  }));
  const rows = rowsOf([{ address: addr(10), account: { signer: DEVICE } }, ...old]);
  const offer = closeOffer(rows, NOW);
  assert.equal(offer.targets.length, MAX_CLOSES_PER_TX + 5);
  assert.equal(offer.batch.length, MAX_CLOSES_PER_TX);
  assert.equal(offer.later, 5);
  assert.deepEqual(offer.batch, offer.targets.slice(0, MAX_CLOSES_PER_TX));
  // A target is the session account to read and the device key to build the instruction with.
  assert.deepEqual(offer.targets[0], { signer: rows.find((r) => r.signer === addr(150))!.signer, address: addr(100) });
  assert.ok(offer.targets.every((t) => t.signer !== DEVICE), 'the active session of this phone is not in it');
});

test('a batch of MAX_CLOSES_PER_TX closes fits one transaction with room for what a wallet adds', async () => {
  const blockhash = { blockhash: addr(9) as unknown as Blockhash, lastValidBlockHeight: 1n };
  const compile = async (n: number) => {
    const ixs = await Promise.all(Array.from({ length: n }, (_, i) => closeSession({ owner: OWNER, sessionSigner: addr(50 + i) })));
    return compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(OWNER, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(ixs, m),
      ),
    );
  };
  const size = async (n: number) => getTransactionEncoder().encode(await compile(n)).length;
  const PACKET = 1232;
  let fitting = 0;
  while ((await size(fitting + 1)) <= PACKET) fitting++;
  const used = await size(MAX_CLOSES_PER_TX);
  // Leave a wallet 300 bytes for instructions of its own (a guard, a memo), and keep one batch well inside.
  assert.ok(used + 300 <= PACKET, `${MAX_CLOSES_PER_TX} closes take ${used} of ${PACKET} bytes`);
  assert.ok(MAX_CLOSES_PER_TX <= fitting && fitting - MAX_CLOSES_PER_TX >= 6, `at most ${fitting} fit, the batch is ${MAX_CLOSES_PER_TX}`);
  // The owner's signature is the only one: a batch needs no other signer.
  assert.deepEqual(Object.keys((await compile(MAX_CLOSES_PER_TX)).signatures), [OWNER]);
});

test('the fresh read decides: what is gone or can bet again again is left out, the rent is what the accounts hold', () => {
  const targets = [
    { signer: addr(21), address: addr(11) },
    { signer: addr(22), address: addr(12) },
    { signer: addr(23), address: addr(13) },
    { signer: addr(24), address: addr(14) },
    { signer: addr(25), address: addr(15) },
    { signer: addr(26), address: addr(16) },
  ];
  const expired = BigInt(NOW - 3_600);
  const reads = [
    { data: sessionBytes(account({ signer: addr(21), revoked: true })), lamports: RENT },
    // Closed since the list was read.
    null,
    // The owner granted it again meanwhile: active.
    { data: sessionBytes(account({ signer: addr(23) })), lamports: RENT },
    { data: sessionBytes(account({ signer: addr(24), expiry: expired })), lamports: RENT + 5n },
    // Not a session of this owner, or not a session at all: left out.
    { data: sessionBytes(account({ signer: addr(25), authority: addr(77), revoked: true })), lamports: RENT },
    { data: new Uint8Array(SESSION_SPACE), lamports: RENT },
  ];
  const plan = confirmClosable(OWNER, targets, reads, NOW);
  assert.deepEqual(plan.close.map((t) => t.signer), [addr(21), addr(24)]);
  assert.equal(plan.rent, RENT + RENT + 5n, 'what the program will send back: every lamport of the accounts');
  assert.deepEqual([plan.gone, plan.active, plan.foreign], [1, 1, 2]);

  // The expiry margin applies to the fresh read as well.
  const edge = confirmClosable(OWNER, [targets[0]], [{ data: sessionBytes(account({ signer: addr(21), expiry: BigInt(NOW - 1) })), lamports: RENT }], NOW);
  assert.equal(edge.close.length, 0);
  assert.equal(edge.active, 1);
  assert.throws(() => confirmClosable(OWNER, targets, reads.slice(1), NOW), /one read per target/);
});

test('the result text says how many sessions were closed and how much rent came back', () => {
  const format = (lamports: bigint) => sol(lamports, { maxDecimals: 5 });
  assert.equal(closeDoneText({ count: 2, rent: 2n * RENT, later: 0, skipped: 0 }, format), 'Closed 2 old sessions, 0.0027 SOL of rent came back.');
  assert.equal(closeDoneText({ count: 1, rent: RENT, later: 0, skipped: 0 }, format), 'Closed 1 old session, 0.00135 SOL of rent came back.');
  assert.equal(
    closeDoneText({ count: 12, rent: 12n * RENT, later: 5, skipped: 0 }, format),
    'Closed 12 old sessions, 0.01621 SOL of rent came back. 5 more to close.',
  );
  assert.equal(
    closeDoneText({ count: 3, rent: 3n * RENT, later: 0, skipped: 2 }, format),
    'Closed 3 old sessions, 0.00405 SOL of rent came back. 2 skipped: closed already, or in use again.',
  );
  assert.match(closeNothingText({ gone: 2, active: 0, foreign: 0 }), /already closed/i);
  assert.match(closeNothingText({ gone: 0, active: 1, foreign: 0 }), /in use again/i);
  assert.match(closeNothingText({ gone: 0, active: 0, foreign: 1 }), /not found|could not/i);
  // Plain words for a player: the device key, never "session key".
  for (const text of [
    closeDoneText({ count: 2, rent: 2n * RENT, later: 1, skipped: 1 }, format),
    closeNothingText({ gone: 1, active: 1, foreign: 1 }),
  ]) {
    assert.doesNotMatch(text, /session key|fast bet/i);
  }
});

test('the close action is a guarded wallet action: its transaction is kept while its outcome is unknown, per session', () => {
  const tx: PendingTx = {
    action: 'close',
    owner: OWNER,
    signature: 'sig-close',
    lastValidBlockHeight: 150n,
    at: 1,
    done: 'Closed 2 old sessions, 0.0027 SOL of rent came back.',
    targets: [addr(21), addr(22)],
  };
  const back = parsePendingTxs(serializePendingTxs([tx]), OWNER);
  assert.deepEqual(back, [tx], 'a stored close survives an app restart');
  assert.equal(isChecking(back, 'close'), true);
  assert.equal(isChecking(back, 'close', addr(22)), true);
  assert.equal(isChecking(back, 'close', addr(23)), false);
  assert.equal(isChecking(back, 'revoke'), false, 'a close is not a revoke');
});

test('a failed close says why in plain words', () => {
  const failed = (code: number) => ({ context: { __code: 0 }, message: `custom program error: 0x${code.toString(16)}` });
  // 6032 = SessionStillActive, appended after MaxBankBelowMin (6031).
  assert.equal(
    humanError(failed(6032), 'close'),
    'That session can still bet. Revoke it first, then close it.',
  );
  assert.equal(humanError(failed(6016), 'close'), 'This wallet is not allowed to do that.');
});
