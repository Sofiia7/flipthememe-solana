import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSignatureFromTransaction, lamports, type Address, type Instruction, type Signature, type Transaction } from '@solana/kit';
import { transact, useMobileWallet, type KitMobileWallet } from '@wallet-ui/react-native-kit';
import {
  compileForWallet,
  revokeSession,
  sendAndConfirm,
  signLocally,
  startSession,
  transferSol,
  vaultAddress,
  withdraw,
} from '@flipthememe/client';
import { AIRDROP_LAMPORTS, SESSION_RULES } from '../config';
import { fetchAccounts } from '../chain/fetch';
import type { SolanaRpc } from '../chain/rpc';
import { checkSignature, sendErrorProof, settleSendError, settledError, type TxCheck } from '../chain/txStatus';
import { humanError, type TxAction } from '../lib/errors';
import { sol } from '../lib/format';
import type { SessionKey } from '../session/sessionKey';
import { createPendingTxStore, type GuardedAction, type PendingTx } from './pendingTx';
import { MAX_REVOKES_PER_TX } from './sessionList';
import { keyReturnAmount, shouldReturnKey, withdrawMessage, type KeyReturn } from './keyReturn';
import { prepareTopUp } from './topUpFlow';
import { sessionCapFor } from './topUpPlan';
import { WalletAccountChanged, withWallet, type WalletContext, type WalletStore } from './walletSession';

export type WalletBusy = Exclude<TxAction, 'bet' | 'claim'>;

export type WalletResult = {
  action: WalletBusy;
  ok: boolean;
  /** Sent, outcome not known yet: the action's button shows CHECKING until the chain answers. */
  checking?: boolean;
  message: string;
  signature?: string;
  at: number;
};

type Outcome = { message: string; signature?: string; checking?: boolean };
type Signed = { transaction: Transaction; lastValidBlockHeight: bigint };
/** What the one wallet session of connectAndPlay hands back: a settled earlier top up, or the signed transaction. */
type ConnectStep = { kind: 'settled'; outcome: Outcome } | { kind: 'signed'; payer: Address; signed: Signed };

/** How often a transaction of unknown outcome is looked up again. */
const CHECK_EVERY_MS = 3_000;
const CHECKING_TEXT = 'Sent. Checking devnet - no need to tap again.';
const NONE: PendingTx[] = [];

/** Money transactions of unknown outcome, per wallet, kept across app restarts (pendingTx.ts). */
const txStore = createPendingTxStore(AsyncStorage);

function settledResult(tx: PendingTx, check: TxCheck): WalletResult {
  if (check.verdict === 'confirmed') return { action: tx.action, ok: true, message: tx.done, signature: tx.signature, at: Date.now() };
  const reason = humanError(settledError(tx.signature, check.verdict, check, null), tx.action);
  return { action: tx.action, ok: false, message: reason, signature: tx.signature, at: Date.now() };
}

export function useWalletActions(input: {
  rpc: SolanaRpc;
  sessionKey: SessionKey | null;
  chainNowSec: () => number;
  onChanged: () => void;
  /** A bet of this phone is signing, sending or unconfirmed: the device key is still needed (read when a withdraw ends). */
  betInFlight: () => boolean;
}) {
  const { rpc, sessionKey, chainNowSec, onChanged, betInFlight } = input;
  const keyAddress = sessionKey?.address ?? null;
  const mwa = useMobileWallet();
  const owner = mwa.account?.address ?? null;
  const [busy, setBusy] = useState<WalletBusy | null>(null);
  const [result, setResult] = useState<WalletResult | null>(null);
  const busyRef = useRef(false);
  const clearResult = useCallback(() => setResult(null), []);

  // Sent money transactions whose outcome is not known yet (their buttons show CHECKING).
  const [unknown, setUnknown] = useState<{ owner: string | null; list: PendingTx[] }>({ owner: null, list: NONE });
  useEffect(() => {
    if (!owner) return undefined;
    let alive = true;
    txStore
      .load(owner)
      .then((stored) => {
        if (!alive) return;
        // Keep anything tracked while the read ran (a settled one is removed after this read, in order).
        setUnknown((prev) => {
          const tracked = prev.owner === owner ? prev.list.filter((t) => !stored.some((s) => s.signature === t.signature)) : NONE;
          return { owner, list: [...stored, ...tracked] };
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [owner]);
  const pendingTx = unknown.owner !== null && unknown.owner === owner ? unknown.list : NONE;
  const track = useCallback(
    (tx: PendingTx) =>
      setUnknown((prev) => ({
        owner: tx.owner,
        list: [...(prev.owner === tx.owner ? prev.list : NONE).filter((t) => t.signature !== tx.signature), tx],
      })),
    [],
  );
  /** A settled transaction leaves the phone's store and the CHECKING list. */
  const forget = useCallback(async (tx: PendingTx) => {
    await txStore.remove(tx.owner, tx.signature).catch(() => undefined);
    setUnknown((prev) => (prev.owner === tx.owner ? { ...prev, list: prev.list.filter((t) => t.signature !== tx.signature) } : prev));
  }, []);

  const run = useCallback(
    async (action: WalletBusy, work: () => Promise<Outcome>) => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(action);
      setResult(null);
      try {
        const done = await work();
        setResult({ action, ok: !done.checking, checking: done.checking, message: done.message, signature: done.signature, at: Date.now() });
        onChanged();
        return !done.checking;
      } catch (error) {
        setResult({ action, ok: false, message: humanError(error, action), at: Date.now() });
        return false;
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [onChanged],
  );

  // The kit's own connect/sign cannot recover from a cached authorization the wallet rejects
  // (see walletSession.ts), so every wallet trip goes through withWallet.
  const { store, chain, identity } = mwa;
  const walletCtx = useMemo<WalletContext<KitMobileWallet>>(
    () => ({
      store: store as unknown as WalletStore,
      transact: async (callback) => await transact(callback),
      authorize: (wallet, authToken) => wallet.authorize({ chain, identity, auth_token: authToken }),
    }),
    [store, chain, identity],
  );

  /**
   * Wallet signs (sign only), the app submits to devnet, whatever network the wallet shows. The
   * transaction is compiled after the wallet authorizes, so the blockhash is fresh even when the
   * wallet first asks for a password.
   */
  const walletSign = useCallback(
    (payer: Address, instructions: Instruction[]): Promise<Signed> =>
      withWallet(walletCtx, async (wallet, account) => {
        if (account.address !== payer) throw new WalletAccountChanged(account.address);
        const compiled = await compileForWallet(rpc, payer, instructions);
        const [transaction] = await wallet.signTransactions({ transactions: [compiled.transaction] });
        return { transaction, lastValidBlockHeight: compiled.lastValidBlockHeight };
      }),
    [rpc, walletCtx],
  );

  /** Claims only: repeating one is harmless (the program refuses a second claim). */
  const signAndSubmit = useCallback(
    async (payer: Address, instructions: Instruction[]): Promise<Signature> => sendAndConfirm(rpc, await walletSign(payer, instructions)),
    [rpc, walletSign],
  );

  /**
   * Sends a signed money transaction. Its signature and blockhash expiry are stored first; if
   * sending ends without proof (timeout, dropped connection, app closed) it stays CHECKING until the
   * chain shows it confirmed, refused or expired, and nothing new is sent meanwhile.
   */
  const submitGuarded = useCallback(
    async (action: GuardedAction, forOwner: Address, signed: Signed, done: string, targets: string[] = []): Promise<Outcome> => {
      const signature = getSignatureFromTransaction(signed.transaction);
      const tx: PendingTx = { action, owner: forOwner, signature, lastValidBlockHeight: signed.lastValidBlockHeight, at: Date.now(), done, targets };
      await txStore.put(tx).catch(() => undefined);
      try {
        await sendAndConfirm(rpc, signed);
      } catch (error) {
        const proof = sendErrorProof(error);
        let check: TxCheck | null = null;
        if (proof !== 'failed') check = await checkSignature(rpc, tx).catch(() => null);
        const verdict = settleSendError(proof, check?.verdict ?? null);
        if (verdict === 'pending') {
          track(tx);
          return { message: CHECKING_TEXT, signature, checking: true };
        }
        await forget(tx);
        if (verdict === 'confirmed') return { message: done, signature };
        throw settledError(signature, verdict, check, error);
      }
      await forget(tx);
      return { message: done, signature };
    },
    [rpc, track, forget],
  );

  /**
   * Before a new transaction of `action`, an earlier one of unknown outcome is looked up first:
   * confirmed means it is done (nothing new is sent), refused shows why, not found yet keeps
   * CHECKING, expired lets the new one go.
   */
  const settleEarlier = useCallback(
    async (forOwner: Address, action: GuardedAction): Promise<Outcome | null> => {
      const earlier = (await txStore.load(forOwner).catch(() => NONE)).filter((t) => t.action === action);
      for (const tx of earlier) {
        const check = await checkSignature(rpc, tx).catch(() => null);
        if (!check || check.verdict === 'pending') {
          track(tx);
          return { message: CHECKING_TEXT, signature: tx.signature, checking: true };
        }
        await forget(tx);
        if (check.verdict === 'confirmed') return { message: tx.done, signature: tx.signature };
        if (check.verdict === 'failed') throw settledError(tx.signature, 'failed', check, null);
      }
      return null;
    },
    [rpc, track, forget],
  );

  // Looks up every CHECKING transaction until the chain answers (also right after a restart).
  const pendingRef = useRef(pendingTx);
  pendingRef.current = pendingTx;
  const hasUnknown = pendingTx.length > 0;
  useEffect(() => {
    if (!hasUnknown) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      timer = null;
      for (const tx of pendingRef.current) {
        // A running action settles its own earlier transactions (settleEarlier).
        if (busyRef.current) break;
        const check = await checkSignature(rpc, tx).catch(() => null);
        if (stopped) return;
        if (!check || check.verdict === 'pending' || busyRef.current) continue;
        setResult(settledResult(tx, check));
        if (check.verdict === 'confirmed') onChanged();
        await forget(tx);
      }
      if (!stopped) timer = setTimeout(tick, CHECK_EVERY_MS);
    };
    timer = setTimeout(tick, 0);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [hasUnknown, rpc, forget, onChanged]);

  const connect = useCallback(
    () =>
      run('connect', async () => {
        const account = await withWallet(walletCtx, async (_wallet, authorized) => authorized);
        return { message: `Connected ${account.address.slice(0, 4)}...${account.address.slice(-4)}` };
      }),
    [run, walletCtx],
  );

  const disconnect = useCallback(async () => {
    setResult(null);
    await mwa.disconnect();
    onChanged();
  }, [mwa, onChanged]);

  /**
   * What a top up reads once the wallet's address is known: its vault, its balance and the device
   * key's. prepareTopUp (topUpFlow.ts) turns that into the transaction and refuses a wallet with too
   * little devnet SOL here, before the wallet is asked to sign anything.
   */
  const prepareFor = useCallback(
    async (payer: Address, amount: bigint) => {
      if (!keyAddress) throw new Error('The device key is still loading - try again in a second.');
      const vaultAddr = await vaultAddress(payer);
      const [vaultRaw, walletRaw, keyRaw] = await fetchAccounts(rpc, [vaultAddr, payer, keyAddress]);
      return prepareTopUp({
        owner: payer,
        deviceKey: keyAddress,
        deposit: amount,
        nowSec: chainNowSec(),
        rules: SESSION_RULES,
        reads: { vaultData: vaultRaw?.data ?? null, walletLamports: walletRaw?.lamports ?? 0n, keyLamports: keyRaw?.lamports ?? 0n },
      });
    },
    [rpc, keyAddress, chainNowSec],
  );
  const topUpDone = (amount: bigint) => `Topped up ${sol(amount)}. One-tap bets are on for 7 days.`;

  /**
   * One wallet approval: open the vault if needed, deposit, grant the device key a 7-day session
   * (an allowance of turnover, see sessionCapFor), and send the key a little SOL for network fees when
   * it runs low.
   */
  const topUpAndPlay = useCallback(
    (amount: bigint) =>
      run('topup', async () => {
        const payer = owner;
        if (!payer) throw new Error('Connect a wallet first.');
        if (!keyAddress) throw new Error('The device key is still loading - try again in a second.');
        const earlier = await settleEarlier(payer, 'topup');
        if (earlier) return earlier;
        const prepared = await prepareFor(payer, amount);
        const signed = await walletSign(payer, prepared.instructions);
        return submitGuarded('topup', payer, signed, topUpDone(amount));
      }),
    [run, owner, keyAddress, settleEarlier, prepareFor, walletSign, submitGuarded],
  );

  /**
   * The same top up for a visitor, in ONE wallet session: the wallet authorizes, the app reads the
   * accounts of the wallet it just learned (the address only exists after authorize), checks that it
   * holds enough devnet SOL, and the wallet signs the transaction in that same session. The signature
   * is stored before the transaction is sent, as for every money action (submitGuarded).
   */
  const connectAndPlay = useCallback(
    (amount: bigint) =>
      run('topup', async () => {
        if (!keyAddress) throw new Error('The device key is still loading - try again in a second.');
        const step = await withWallet<KitMobileWallet, ConnectStep>(walletCtx, async (wallet, account) => {
          const payer = account.address;
          // A top up of this wallet sent earlier with no answer yet: settle it, sign nothing new.
          const earlier = await settleEarlier(payer, 'topup');
          if (earlier) return { kind: 'settled', outcome: earlier };
          const prepared = await prepareFor(payer, amount);
          const compiled = await compileForWallet(rpc, payer, prepared.instructions);
          const [transaction] = await wallet.signTransactions({ transactions: [compiled.transaction] });
          return { kind: 'signed', payer, signed: { transaction, lastValidBlockHeight: compiled.lastValidBlockHeight } };
        });
        if (step.kind === 'settled') return step.outcome;
        return submitGuarded('topup', step.payer, step.signed, topUpDone(amount));
      }),
    [run, keyAddress, walletCtx, rpc, settleEarlier, prepareFor, submitGuarded],
  );

  /**
   * One-tap bets again without a deposit: a new 7-day session over the game balance the player already
   * has (shown on the button), plus a little SOL for the key's network fees when it runs low.
   */
  const renewSession = useCallback(
    (available: bigint) =>
      run('renew', async () => {
        const payer = owner;
        if (!payer) throw new Error('Connect a wallet first.');
        if (!keyAddress) throw new Error('The device key is still loading - try again in a second.');
        if (available <= 0n) throw new Error('Nothing in the game balance to play with - top up first.');
        const earlier = await settleEarlier(payer, 'renew');
        if (earlier) return earlier;
        const [keyRaw] = await fetchAccounts(rpc, [keyAddress]);
        const needsKeyGas = (keyRaw?.lamports ?? 0n) < SESSION_RULES.gasMin;
        const ixs: Instruction[] = [
          await startSession({
            owner: payer,
            sessionSigner: keyAddress,
            expiry: BigInt(Math.floor(chainNowSec()) + SESSION_RULES.durationSecs),
            maxPerBet: SESSION_RULES.maxPerBet,
            sessionCap: sessionCapFor(available, SESSION_RULES),
          }),
        ];
        if (needsKeyGas) ixs.push(transferSol({ from: payer, to: keyAddress, lamports: SESSION_RULES.gasTopUp }));
        const signed = await walletSign(payer, ixs);
        return submitGuarded('renew', payer, signed, `One-tap bets are on for 7 days, up to ${sol(SESSION_RULES.maxPerBet)} per bet.`);
      }),
    [run, owner, keyAddress, rpc, chainNowSec, settleEarlier, walletSign, submitGuarded],
  );

  /**
   * The SOL on this phone's device key (bet fees) back to `forOwner`. The key signs and pays the fee
   * itself, so no wallet popup; it is left empty (the next top up refills it).
   */
  const sweepKey = useCallback(
    async (forOwner: Address, key: SessionKey): Promise<{ outcome: Outcome; amount: bigint }> => {
      const earlier = await settleEarlier(forOwner, 'sweep');
      if (earlier) return { outcome: earlier, amount: 0n };
      const { value } = await rpc.getBalance(key.address, { commitment: 'confirmed' }).send();
      const amount = keyReturnAmount(BigInt(value));
      if (amount <= 0n) throw new Error('Nothing on the device key to return.');
      const signed = await signLocally(rpc, key.signer, [transferSol({ from: key.signer, to: forOwner, lamports: amount })]);
      const outcome = await submitGuarded('sweep', forOwner, signed, `Returned ${sol(amount, { maxDecimals: 5 })} to your wallet.`);
      return { outcome, amount };
    },
    [rpc, settleEarlier, submitGuarded],
  );

  /**
   * The second step of WITHDRAW ALL: the device key's SOL follows the game balance home. Best effort,
   * signed by the device key, only when the key holds more than a fee and no bet of this phone is in
   * flight. It never throws: a failure here must not turn a successful withdraw into an error.
   */
  const returnKeyAfterWithdraw = useCallback(
    async (forOwner: Address): Promise<KeyReturn> => {
      try {
        if (!sessionKey) return { kind: 'empty' };
        if (betInFlight()) return { kind: 'busy' };
        const { value } = await rpc.getBalance(sessionKey.address, { commitment: 'confirmed' }).send();
        if (!shouldReturnKey({ keyLamports: BigInt(value), betInFlight: false })) return { kind: 'empty' };
        const { outcome, amount } = await sweepKey(forOwner, sessionKey);
        return outcome.checking ? { kind: 'checking' } : { kind: 'returned', amount };
      } catch (error) {
        console.warn('[ftm] returning the device key funds after a withdraw failed', error);
        return { kind: 'failed' };
      }
    },
    [sessionKey, betInFlight, rpc, sweepKey],
  );

  const withdrawAll = useCallback(
    (available: bigint) =>
      run('withdraw', async () => {
        if (!owner) throw new Error('Connect a wallet first.');
        const earlier = await settleEarlier(owner, 'withdraw');
        if (earlier) return earlier;
        if (available <= 0n) throw new Error('Nothing available to withdraw.');
        const signed = await walletSign(owner, [await withdraw({ owner, amount: available })]);
        const done = `Withdrew ${sol(available)} to your wallet.`;
        const outcome = await submitGuarded('withdraw', owner, signed, done);
        // Sent with no answer yet: nothing more is sent until the chain says.
        if (outcome.checking) return outcome;
        return { ...outcome, message: withdrawMessage(done, await returnKeyAfterWithdraw(owner)) };
      }),
    [run, owner, settleEarlier, walletSign, submitGuarded, returnKeyAfterWithdraw],
  );

  /** Revokes the sessions of these device keys in one wallet approval (any device, this phone included). */
  const revokeSessions = useCallback(
    (signers: readonly string[]) =>
      run('revoke', async () => {
        if (!owner) throw new Error('Connect a wallet first.');
        const earlier = await settleEarlier(owner, 'revoke');
        if (earlier) return earlier;
        const list = [...new Set(signers)].slice(0, MAX_REVOKES_PER_TX) as Address[];
        if (list.length === 0) throw new Error('No active session to revoke.');
        const ixs = await Promise.all(list.map((signer) => revokeSession({ owner, sessionSigner: signer })));
        const signed = await walletSign(owner, ixs);
        const mine = keyAddress !== null && list.includes(keyAddress);
        const done =
          list.length > 1 ? `${list.length} sessions revoked.` : mine ? 'Session revoked. This phone needs a new approval to bet.' : 'Session revoked.';
        return submitGuarded('revoke', owner, signed, done, list);
      }),
    [run, owner, keyAddress, settleEarlier, walletSign, submitGuarded],
  );

  /** RETURN TO WALLET (Wallet tab, ADVANCED): the device key's SOL back to the wallet, no wallet popup. */
  const returnKeyFunds = useCallback(
    () =>
      run('sweep', async () => {
        if (!owner || !sessionKey) throw new Error('Connect a wallet first.');
        return (await sweepKey(owner, sessionKey)).outcome;
      }),
    [run, owner, sessionKey, sweepKey],
  );

  const airdrop = useCallback(
    () =>
      run('airdrop', async () => {
        if (!owner) throw new Error('Connect a wallet first.');
        const signature = await rpc.requestAirdrop(owner, lamports(AIRDROP_LAMPORTS), { commitment: 'confirmed' }).send();
        const started = Date.now();
        for (;;) {
          const { value } = await rpc.getSignatureStatuses([signature]).send();
          const status = value[0];
          if (status?.err) throw new Error('The airdrop transaction failed.');
          if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) break;
          if (Date.now() - started > 45_000) throw new Error('Airdrop not confirmed after 45 s - check the balance in a minute.');
          await new Promise((r) => setTimeout(r, 1_000));
        }
        return { message: `Airdropped ${sol(AIRDROP_LAMPORTS)} of devnet test SOL.`, signature };
      }),
    [run, owner, rpc],
  );

  /** Claim through the wallet (used when the device key cannot pay the fee). */
  const signWithWallet = signAndSubmit;

  return {
    owner,
    busy,
    result,
    clearResult,
    /** Sent money transactions whose outcome is not known yet (see isChecking in pendingTx.ts). */
    pendingTx,
    connect,
    disconnect,
    topUpAndPlay,
    connectAndPlay,
    renewSession,
    withdrawAll,
    revokeSessions,
    returnKeyFunds,
    airdrop,
    signWithWallet,
  };
}

export type WalletActions = ReturnType<typeof useWalletActions>;
