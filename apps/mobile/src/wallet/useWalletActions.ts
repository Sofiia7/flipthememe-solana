import { useCallback, useRef, useState } from 'react';
import { lamports, type Address, type Instruction, type Signature } from '@solana/kit';
import { useMobileWallet } from '@wallet-ui/react-native-kit';
import {
  compileForWallet,
  decodeVault,
  deposit,
  openVault,
  revokeSession,
  sendAndConfirm,
  startSession,
  transferSol,
  vaultAddress,
  withdraw,
} from '@flipthememe/client';
import { AIRDROP_LAMPORTS, SESSION_RULES } from '../config';
import { fetchAccounts } from '../chain/fetch';
import type { SolanaRpc } from '../chain/rpc';
import { humanError, type TxAction } from '../lib/errors';
import { sol } from '../lib/format';

export type WalletBusy = Exclude<TxAction, 'bet' | 'claim'>;

export type WalletResult = { action: WalletBusy; ok: boolean; message: string; signature?: string; at: number };

/** Lamports a Top up transaction needs in the wallet beyond the deposit (rent, fees, margin). */
const TOP_UP_OVERHEAD = 10_000_000n;

export function useWalletActions(input: {
  rpc: SolanaRpc;
  sessionKey: Address | null;
  chainNowSec: () => number;
  onChanged: () => void;
}) {
  const { rpc, sessionKey, chainNowSec, onChanged } = input;
  const mwa = useMobileWallet();
  const owner = mwa.account?.address ?? null;
  const [busy, setBusy] = useState<WalletBusy | null>(null);
  const [result, setResult] = useState<WalletResult | null>(null);
  const busyRef = useRef(false);
  const clearResult = useCallback(() => setResult(null), []);

  const run = useCallback(
    async (action: WalletBusy, work: () => Promise<{ message: string; signature?: string }>) => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(action);
      setResult(null);
      try {
        const done = await work();
        setResult({ action, ok: true, message: done.message, signature: done.signature, at: Date.now() });
        onChanged();
        return true;
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

  /** Wallet signs (sign only), the app submits to devnet, whatever network the wallet shows. */
  const signAndSubmit = useCallback(
    async (payer: Address, instructions: Instruction[]): Promise<Signature> => {
      const compiled = await compileForWallet(rpc, payer, instructions);
      const signed = await mwa.signTransactions(compiled.transaction);
      return sendAndConfirm(rpc, { transaction: signed, lastValidBlockHeight: compiled.lastValidBlockHeight });
    },
    [rpc, mwa],
  );

  const connect = useCallback(
    () =>
      run('connect', async () => {
        const account = await mwa.connect();
        return { message: `Connected ${account.address.slice(0, 4)}...${account.address.slice(-4)}` };
      }),
    [run, mwa],
  );

  const disconnect = useCallback(async () => {
    setResult(null);
    await mwa.disconnect();
    onChanged();
  }, [mwa, onChanged]);

  /**
   * One wallet approval: open the vault if needed, deposit, grant the session key a 24 h budget
   * equal to the deposit, and send the key 0.03 SOL for fees when it runs low.
   */
  const topUpAndPlay = useCallback(
    (amount: bigint) =>
      run('topup', async () => {
        const payer = owner;
        if (!payer) throw new Error('Connect a wallet first.');
        if (!sessionKey) throw new Error('The session key is still loading - try again in a second.');
        const vaultAddr = await vaultAddress(payer);
        const [vaultRaw, walletRaw, keyRaw] = await fetchAccounts(rpc, [vaultAddr, payer, sessionKey]);
        const needsKeyGas = (keyRaw?.lamports ?? 0n) < SESSION_RULES.gasMin;
        const need = amount + (needsKeyGas ? SESSION_RULES.gasTopUp : 0n) + TOP_UP_OVERHEAD;
        const walletLamports = walletRaw?.lamports ?? 0n;
        if (walletLamports < need) {
          throw new Error(
            `The wallet has ${sol(walletLamports)} on devnet; this top up needs about ${sol(need)}. Use Airdrop 1 devnet SOL first.`,
          );
        }
        let vaultExists = false;
        if (vaultRaw) {
          try {
            decodeVault(vaultRaw.data);
            vaultExists = true;
          } catch {
            vaultExists = false;
          }
        }
        const ixs: Instruction[] = [];
        if (!vaultExists) ixs.push(await openVault({ owner: payer }));
        ixs.push(await deposit({ owner: payer, amount }));
        ixs.push(
          await startSession({
            owner: payer,
            sessionSigner: sessionKey,
            expiry: BigInt(Math.floor(chainNowSec()) + SESSION_RULES.durationSecs),
            maxPerBet: SESSION_RULES.maxPerBet,
            sessionCap: amount,
          }),
        );
        if (needsKeyGas) ixs.push(transferSol({ from: payer, to: sessionKey, lamports: SESSION_RULES.gasTopUp }));
        const signature = await signAndSubmit(payer, ixs);
        return { message: `Topped up ${sol(amount)}. Bets are one tap for 24 h, up to ${sol(amount)} in total.`, signature };
      }),
    [run, owner, sessionKey, rpc, chainNowSec, signAndSubmit],
  );

  const withdrawAll = useCallback(
    (available: bigint) =>
      run('withdraw', async () => {
        if (!owner) throw new Error('Connect a wallet first.');
        if (available <= 0n) throw new Error('Nothing available to withdraw.');
        const signature = await signAndSubmit(owner, [await withdraw({ owner, amount: available })]);
        return { message: `Withdrew ${sol(available)} to your wallet.`, signature };
      }),
    [run, owner, signAndSubmit],
  );

  const revoke = useCallback(
    () =>
      run('revoke', async () => {
        if (!owner || !sessionKey) throw new Error('Connect a wallet first.');
        const signature = await signAndSubmit(owner, [await revokeSession({ owner, sessionSigner: sessionKey })]);
        return { message: 'Session revoked. This phone can no longer bet until you top up again.', signature };
      }),
    [run, owner, sessionKey, signAndSubmit],
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

  /** Claim through the wallet (used when the session key cannot pay the fee). */
  const signWithWallet = signAndSubmit;

  return {
    owner,
    busy,
    result,
    clearResult,
    connect,
    disconnect,
    topUpAndPlay,
    withdrawAll,
    revoke,
    airdrop,
    signWithWallet,
  };
}

export type WalletActions = ReturnType<typeof useWalletActions>;
