// Node tests for the wallet session recovery (no React Native). Run from the repo root:
//   node --test apps/mobile/src/__tests__/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanError } from '../lib/errors.ts';
import {
  WalletAccountChanged,
  WalletStepError,
  withWallet,
  type AuthorizeResult,
  type WalletAuthorization,
  type WalletContext,
} from '../wallet/walletSession.ts';

const A = Buffer.alloc(32, 1).toString('base64');
const B = Buffer.alloc(32, 2).toString('base64');

/** A wallet error as React Native delivers it inside the session: code "JSON_RPC_ERROR". */
function rnError(code: number, message: string) {
  return Object.assign(new Error(`${code}/${message}`), { code: 'JSON_RPC_ERROR', userInfo: { jsonRpcErrorCode: code } });
}

type FakeWallet = { authorize: (token: string | undefined) => Promise<AuthorizeResult>; sign?: () => Promise<string> };

/**
 * One fake wallet per session. Like MWA's transact on Android, an error with a `code` that leaves
 * the callback is rewrapped (JSON_RPC_ERROR into a protocol error); one without a code passes as is.
 */
function setup(wallets: FakeWallet[], cached?: string, selected?: string) {
  const tokens: (string | undefined)[] = [];
  const persisted: (WalletAuthorization | null)[] = [];
  let sessions = 0;
  const ctx: WalletContext<FakeWallet> = {
    store: {
      $authToken: { get: () => cached },
      $selectedAccount: { get: () => (selected ? { addressBase64: selected } : undefined) },
      persist: async (auth) => {
        persisted.push(auth);
      },
    },
    transact: async (callback) => {
      const wallet = wallets[sessions++];
      if (!wallet) throw new Error('no more sessions');
      try {
        return await callback(wallet);
      } catch (e) {
        const err = e as { code?: unknown; message: string; userInfo?: { jsonRpcErrorCode: number } };
        if (err.code === undefined) throw e;
        const wrapped = Object.assign(new Error(err.message), {
          code: err.code === 'JSON_RPC_ERROR' ? err.userInfo?.jsonRpcErrorCode : err.code,
        });
        wrapped.name = err.code === 'JSON_RPC_ERROR' ? 'SolanaMobileWalletAdapterProtocolError' : 'SolanaMobileWalletAdapterError';
        throw wrapped;
      }
    },
    authorize: (wallet, token) => {
      tokens.push(token);
      return wallet.authorize(token);
    },
  };
  return { ctx, tokens, persisted, sessions: () => sessions };
}

const granted = (token: string, ...accounts: string[]) => async (): Promise<AuthorizeResult> => ({
  accounts: accounts.map((address) => ({ address })),
  auth_token: token,
});

test('a cached token the wallet rejects is replaced by a fresh authorization in a second session', async () => {
  const t = setup(
    [
      {
        authorize: async () => {
          throw rnError(-1, 'authorization request failed');
        },
      },
      { authorize: granted('fresh', A), sign: async () => 'signed' },
    ],
    'stale',
  );
  const out = await withWallet(t.ctx, async (wallet) => wallet.sign!());
  assert.equal(out, 'signed');
  assert.equal(t.sessions(), 2);
  assert.deepEqual(t.tokens, ['stale', undefined]);
  assert.equal(t.persisted.at(-1)?.authToken, 'fresh');
});

test('a failed fresh authorization reports its step and code, without a retry', async () => {
  const t = setup([
    {
      authorize: async () => {
        throw rnError(-1, 'authorization request failed');
      },
    },
  ]);
  const error = await withWallet(t.ctx, async () => 'never').catch((e: unknown) => e);
  assert.ok(error instanceof WalletStepError);
  assert.equal(error.step, 'authorize');
  assert.equal(error.walletCode, -1);
  assert.equal(t.sessions(), 1);
  // The wallet's raw code and text stay in the console; the player reads one plain sentence.
  assert.equal(humanError(error, 'topup'), 'The wallet did not connect. Check that it is set to Devnet and try again.');
});

test('a declined signature is reported as such and not retried', async () => {
  const t = setup(
    [
      {
        authorize: granted('tok', A),
        sign: async () => {
          throw rnError(-3, 'transaction not signed');
        },
      },
    ],
    'tok',
  );
  const error = await withWallet(t.ctx, async (wallet) => wallet.sign!()).catch((e: unknown) => e);
  assert.ok(error instanceof WalletStepError);
  assert.equal(error.step, 'sign');
  assert.equal(error.walletCode, -3);
  assert.equal(t.sessions(), 1);
  assert.equal(humanError(error, 'topup'), 'Request declined in the wallet.');
});

test('other failures while reauthorizing are not retried', async () => {
  const t = setup(
    [
      {
        authorize: async () => {
          throw Object.assign(new Error('timeout'), { code: 'Timed out waiting for response' });
        },
      },
    ],
    'tok',
  );
  const error = await withWallet(t.ctx, async () => 'never').catch((e: unknown) => e);
  assert.ok(error instanceof WalletStepError);
  assert.equal(error.step, 'reauthorize');
  assert.equal(t.sessions(), 1);
  assert.equal(humanError(error, 'topup'), 'The wallet did not answer in time - try again.');
});

test('the selected account stays when the wallet still offers it, else the first one is taken', async () => {
  const kept = setup([{ authorize: granted('t1', A, B) }], undefined, B);
  const first = await withWallet(kept.ctx, async (_w, account) => account);
  assert.equal(first.addressBase64, B);
  const moved = setup([{ authorize: granted('t2', A) }], undefined, B);
  const second = await withWallet(moved.ctx, async (_w, account) => account);
  assert.equal(second.addressBase64, A);
  assert.equal(moved.persisted.at(-1)?.selectedAccount.addressBase64, A);
});

test('errors of our own pass through untouched', async () => {
  const t = setup([{ authorize: granted('tok', A) }], 'tok');
  const error = await withWallet(t.ctx, async (_w, account) => {
    throw new WalletAccountChanged(account.address);
  }).catch((e: unknown) => e);
  assert.ok(error instanceof WalletAccountChanged);
  assert.equal(t.sessions(), 1);
  assert.match(humanError(error, 'topup'), /^The wallet connected another account/);
});
