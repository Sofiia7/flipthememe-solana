// Mobile Wallet Adapter sessions that recover when the wallet no longer accepts the cached
// authorization (it expired, or it was issued to an earlier install or by another wallet app).
//
// The kit (@wallet-ui/react-native-kit 4.3) means to retry such a failure with a fresh authorize,
// but on Android the wallet's error reaches it in its raw React Native shape (code
// "JSON_RPC_ERROR"), its `instanceof` check misses, and every approval after that fails with
// "authorization request failed". Here the failure is recognised in both shapes and the wallet is
// asked again in a new session: a second authorize inside the failed session is not reliable either.
// Pure TypeScript (no React Native imports), so node:test covers it.
import { getAddressDecoder, getBase64Encoder, type Address } from '@solana/kit';

/** MWA protocol code for "authorization failed" (also what wallets send when the user declines). */
export const MWA_AUTHORIZATION_FAILED = -1;

/** The wallet step that was running when a call failed; shown in the error detail. */
export type WalletStep = 'reauthorize' | 'authorize' | 'sign';

/**
 * A wallet failure with the step it happened in. It has no `code` of its own on purpose: MWA's
 * `transact` rewraps every error that has one and would drop the step.
 */
export class WalletStepError extends Error {
  readonly step: WalletStep;
  /** MWA protocol code (-1 authorization failed, -3 not signed, ...) or an MWA error code string. */
  readonly walletCode: number | string | null;

  constructor(step: WalletStep, error: unknown) {
    const { code, message } = walletErrorFields(error);
    super(message, { cause: error });
    this.name = 'WalletStepError';
    this.step = step;
    this.walletCode = code;
  }
}

/** The authorized account no longer matches the one the transaction was built for. */
export class WalletAccountChanged extends Error {
  readonly account: Address;

  constructor(account: Address) {
    super(`The wallet connected another account (${account.slice(0, 4)}...${account.slice(-4)}). Tap again to use it.`);
    this.name = 'WalletAccountChanged';
    this.account = account;
  }
}

/** Code and message of a wallet error, whether raw from React Native or already converted by MWA. */
export function walletErrorFields(error: unknown): { code: number | string | null; message: string } {
  const e = error as { code?: unknown; message?: unknown; userInfo?: { jsonRpcErrorCode?: unknown } | null } | null;
  const message = typeof e?.message === 'string' ? e.message : String(error);
  if (e?.code === 'JSON_RPC_ERROR' && typeof e.userInfo?.jsonRpcErrorCode === 'number') {
    return { code: e.userInfo.jsonRpcErrorCode, message };
  }
  if (typeof e?.code === 'number' || typeof e?.code === 'string') return { code: e.code, message };
  return { code: null, message };
}

export type WalletAccount = { address: Address; addressBase64: string; icon?: string; label?: string };
export type WalletAuthorization = { accounts: WalletAccount[]; authToken: string; selectedAccount: WalletAccount };

/** What the wallet answers to `authorize`: base64 addresses and a token for the next session. */
export type AuthorizeResult = { accounts: readonly { address: string; label?: string; icon?: string }[]; auth_token: string };

/** The kit's authorization store, as far as this module uses it. */
export type WalletStore = {
  $authToken: { get(): string | undefined };
  $selectedAccount: { get(): { addressBase64: string } | undefined };
  persist(auth: WalletAuthorization | null): Promise<void>;
};

export type WalletContext<W> = {
  store: WalletStore;
  transact<T>(callback: (wallet: W) => Promise<T>): Promise<T>;
  authorize(wallet: W, authToken: string | undefined): Promise<AuthorizeResult>;
};

const base64 = getBase64Encoder();
const addresses = getAddressDecoder();

/** The new authorization, keeping the selected account when the wallet still offers it. */
export function authorizationFrom(result: AuthorizeResult, previous: { addressBase64: string } | undefined): WalletAuthorization {
  const accounts: WalletAccount[] = result.accounts.map((a) => {
    const address = addresses.decode(base64.encode(a.address));
    return { address, addressBase64: a.address, icon: a.icon, label: a.label ?? `${address.slice(0, 8)}..${address.slice(-8)}` };
  });
  const first = accounts[0];
  if (!first) throw new Error('The wallet authorized no account.');
  const selectedAccount = accounts.find((a) => a.addressBase64 === previous?.addressBase64) ?? first;
  return { accounts, authToken: result.auth_token, selectedAccount };
}

/** True for errors thrown by a wallet call (they carry a `code`), as opposed to our own. */
function isWalletCallError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' || typeof code === 'string';
}

async function session<W, T>(ctx: WalletContext<W>, authToken: string | undefined, work: (wallet: W, account: WalletAccount) => Promise<T>) {
  return ctx.transact(async (wallet) => {
    let result: AuthorizeResult;
    try {
      result = await ctx.authorize(wallet, authToken);
    } catch (error) {
      throw new WalletStepError(authToken ? 'reauthorize' : 'authorize', error);
    }
    const auth = authorizationFrom(result, ctx.store.$selectedAccount.get());
    await ctx.store.persist(auth);
    try {
      return await work(wallet, auth.selectedAccount);
    } catch (error) {
      throw isWalletCallError(error) ? new WalletStepError('sign', error) : error;
    }
  });
}

/**
 * Opens a wallet session, authorizes (with the cached token when there is one) and runs `work`
 * with the authorized account. When the wallet rejects the cached token, a second session asks for
 * a fresh authorization: the wallet opens twice, once.
 */
export async function withWallet<W, T>(ctx: WalletContext<W>, work: (wallet: W, account: WalletAccount) => Promise<T>): Promise<T> {
  const cached = ctx.store.$authToken.get();
  try {
    return await session(ctx, cached, work);
  } catch (error) {
    const stale = error instanceof WalletStepError && error.step === 'reauthorize' && error.walletCode === MWA_AUTHORIZATION_FAILED;
    if (!stale) throw error;
    return await session(ctx, undefined, work);
  }
}
