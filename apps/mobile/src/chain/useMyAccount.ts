import { useCallback, useRef, useState } from 'react';
import type { Address } from '@solana/kit';
import {
  OFFSETS,
  RoundStatus,
  decodeSession,
  decodeVault,
  sessionAddress,
  vaultAddress,
  type SessionAccount,
  type VaultAccount,
} from '@flipthememe/client';
import { POLL } from '../config';
import { describeNetworkError } from '../lib/errors';
import { usePolling } from '../lib/usePolling';
import { decodeRoundSafe, fetchAccounts, fetchPositionsBy, type PositionView, type RoundView } from './fetch';
import type { SolanaRpc } from './rpc';

export type MyPosition = PositionView & { round: RoundView | null };

export type MyAccountData = {
  owner: Address | null;
  vaultAddress: Address | null;
  vault: VaultAccount | null;
  sessionAddress: Address | null;
  session: SessionAccount | null;
  /** Devnet SOL on the session key (pays fees and position rent). */
  keyLamports: bigint | null;
  /** Devnet SOL in the connected wallet. */
  walletLamports: bigint | null;
  /** All my positions, newest round first. */
  positions: MyPosition[];
  updatedAt: number | null;
  error: string | null;
};

const EMPTY: MyAccountData = {
  owner: null,
  vaultAddress: null,
  vault: null,
  sessionAddress: null,
  session: null,
  keyLamports: null,
  walletLamports: null,
  positions: [],
  updatedAt: null,
  error: null,
};

/** Vault, session, balances and my positions (with their rounds) for `owner`, every 4 s. */
export function useMyAccount(
  rpc: SolanaRpc,
  owner: Address | null,
  sessionKey: Address | null,
): MyAccountData & { refresh: () => void } {
  const [data, setData] = useState<MyAccountData>(EMPTY);
  // Final rounds never change in a way the history needs, so they are read once.
  const finalRounds = useRef(new Map<Address, RoundView>());
  const key = `${owner ?? ''}|${sessionKey ?? ''}`;
  const keyRef = useRef(key);
  keyRef.current = key;

  const poll = useCallback(async () => {
    if (!owner) {
      setData(EMPTY);
      return;
    }
    const startedFor = `${owner}|${sessionKey ?? ''}`;
    try {
      const vaultAddr = await vaultAddress(owner);
      const sessionAddr = sessionKey ? await sessionAddress(vaultAddr, sessionKey) : null;
      const addresses: Address[] = [vaultAddr, owner];
      if (sessionAddr && sessionKey) addresses.push(sessionAddr, sessionKey);
      const [raw, positions] = await Promise.all([
        fetchAccounts(rpc, addresses),
        fetchPositionsBy(rpc, OFFSETS.positionAuthority, owner),
      ]);
      const vault = raw[0] ? safe(() => decodeVault(raw[0]!.data)) : null;
      const walletLamports = raw[1]?.lamports ?? 0n;
      const session = sessionAddr && raw[2] ? safe(() => decodeSession(raw[2]!.data)) : null;
      const keyLamports = sessionKey ? (raw[3]?.lamports ?? 0n) : null;

      const roundAddrs = [...new Set(positions.map((p) => p.account.round))];
      const toFetch = roundAddrs.filter((a) => !finalRounds.current.has(a));
      const fetched = new Map<Address, RoundView>();
      if (toFetch.length > 0) {
        const rows = await fetchAccounts(rpc, toFetch);
        rows.forEach((row, i) => {
          const account = decodeRoundSafe(row);
          if (!account) return;
          const view: RoundView = { id: account.id, address: toFetch[i], account };
          fetched.set(toFetch[i], view);
          if (account.status === RoundStatus.Final) finalRounds.current.set(toFetch[i], view);
        });
      }
      const mine: MyPosition[] = positions.map((p) => ({
        ...p,
        round: finalRounds.current.get(p.account.round) ?? fetched.get(p.account.round) ?? null,
      }));
      mine.sort((a, b) => {
        const x = a.round?.id ?? -1n;
        const y = b.round?.id ?? -1n;
        return x > y ? -1 : x < y ? 1 : 0;
      });
      if (keyRef.current !== startedFor) return; // the wallet changed while this poll ran
      setData({
        owner,
        vaultAddress: vaultAddr,
        vault,
        sessionAddress: sessionAddr,
        session,
        keyLamports,
        walletLamports,
        positions: mine,
        updatedAt: Date.now(),
        error: null,
      });
    } catch (error) {
      if (keyRef.current !== startedFor) return;
      setData((prev) => ({ ...(prev.owner === owner ? prev : { ...EMPTY, owner }), error: describeNetworkError(error) }));
    }
  }, [rpc, owner, sessionKey]);

  const refresh = usePolling(poll, POLL.accountMs, true, key);
  return { ...data, refresh };
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
