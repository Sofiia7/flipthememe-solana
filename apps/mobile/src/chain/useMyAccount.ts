import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from '@solana/kit';
import {
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
import { decodeRoundSafe, fetchAccounts, type PositionView, type RawAccount, type RoundView } from './fetch';
import { recentRound } from './roundStore';
import { readPositionSnapshot } from './recoverPosition';
import { rateLimitWaitMs, type SolanaRpc } from './rpc';

export type MyPosition = PositionView & { round: RoundView | null };

export type MyAccountData = {
  owner: Address | null;
  vaultAddress: Address | null;
  vault: VaultAccount | null;
  sessionAddress: Address | null;
  session: SessionAccount | null;
  /** Devnet SOL on the device key (pays the network fee of each bet). */
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

/** My positions as last read, with the state of my accounts at that read. */
type KnownPositions = { key: string; stamp: string; atMs: number; list: PositionView[]; readsLeft: number };

const bytesOf = (raw: RawAccount | null | undefined) => (raw ? raw.data.join(',') : '-');

/**
 * Vault, session, balances and my positions (with their rounds) for `owner`: every 4 s while one of
 * my rounds is in play or right after my own action, every 15 s otherwise.
 *
 * The positions list is one getProgramAccounts over the whole program, so it is read only when it can
 * have changed: every change to a position moves money in my vault (a bet locks the stake, a claim or
 * refund releases it) or my wallet (closing a paid position returns its rent), and a bet from this
 * phone also moves the session and its key; at least every 2 minutes all the same. Rounds the arena
 * has just read are taken from it, and final rounds are read once.
 */
export function useMyAccount(
  rpc: SolanaRpc,
  owner: Address | null,
  sessionKey: Address | null,
  sentRoundId: bigint | null = null,
): MyAccountData & { refresh: () => void } {
  const [data, setData] = useState<MyAccountData>(EMPTY);
  // Final rounds never change in a way the history needs, so they are read once (and kept while a position points at them).
  const finalRounds = useRef(new Map<Address, RoundView>());
  const known = useRef<KnownPositions | null>(null);
  const forceRef = useRef(false);
  const fastUntil = useRef(0);
  const key = `${owner ?? ''}|${sessionKey ?? ''}`;
  const keyRef = useRef(key);
  keyRef.current = key;

  const poll = useCallback(async (): Promise<number> => {
    if (!owner) {
      setData(EMPTY);
      return POLL.accountIdleMs;
    }
    const startedFor = `${owner}|${sessionKey ?? ''}`;
    const force = forceRef.current;
    forceRef.current = false;
    try {
      const vaultAddr = await vaultAddress(owner);
      const sessionAddr = sessionKey ? await sessionAddress(vaultAddr, sessionKey) : null;
      const addresses: Address[] = [vaultAddr, owner];
      if (sessionAddr && sessionKey) addresses.push(sessionAddr, sessionKey);
      const raw = await fetchAccounts(rpc, addresses);
      const vault = raw[0] ? safe(() => decodeVault(raw[0]!.data)) : null;
      const walletLamports = raw[1]?.lamports ?? 0n;
      const session = sessionAddr && raw[2] ? safe(() => decodeSession(raw[2]!.data)) : null;
      const keyLamports = sessionKey ? (raw[3]?.lamports ?? 0n) : null;

      // Read the positions when the vault, the session, the key or the wallet moved (closing a paid
      // position sends its rent to the wallet), and once more on the next poll in case this read came
      // from a node a slot behind the one that answered above.
      const stamp = `${bytesOf(raw[0])}|${bytesOf(raw[2])}|${keyLamports ?? '-'}|${walletLamports}`;
      let prev = known.current;
      if (!prev || prev.key !== startedFor || prev.stamp !== stamp || force) {
        prev = { key: startedFor, stamp, atMs: 0, list: prev?.key === startedFor ? prev.list : [], readsLeft: 2 };
      }
      let positions = prev.list;
      const scan = prev.readsLeft > 0 || Date.now() - prev.atMs > POLL.positionsMaxAgeMs;
      const snapshot = await readPositionSnapshot(rpc, owner, sentRoundId, positions, scan);
      const positionError = snapshot.error ? describeNetworkError(snapshot.error) : null;
      if (snapshot.scanSucceeded) {
        if (scan) prev = { ...prev, atMs: Date.now(), readsLeft: Math.max(0, prev.readsLeft - 1) };
      }
      const recovered = snapshot.recovered;
      positions = snapshot.positions;
      prev = { ...prev, list: positions };
      known.current = prev;

      const roundAddrs = new Set(positions.map((p) => p.account.round));
      for (const a of [...finalRounds.current.keys()]) if (!roundAddrs.has(a)) finalRounds.current.delete(a);
      const rounds = new Map<Address, RoundView>();
      if (recovered) rounds.set(recovered.round.address, recovered.round);
      const toFetch: Address[] = [];
      for (const a of roundAddrs) {
        if (rounds.has(a)) continue;
        const view = finalRounds.current.get(a) ?? recentRound(a, POLL.sharedRoundMs);
        if (view) rounds.set(a, view);
        else toFetch.push(a);
      }
      if (toFetch.length > 0) {
        const rows = await fetchAccounts(rpc, toFetch);
        rows.forEach((row, i) => {
          const account = decodeRoundSafe(row);
          if (account) rounds.set(toFetch[i], { id: account.id, address: toFetch[i], account });
        });
      }
      for (const [a, view] of rounds) if (view.account.status === RoundStatus.Final) finalRounds.current.set(a, view);
      const mine: MyPosition[] = positions.map((p) => ({ ...p, round: rounds.get(p.account.round) ?? null }));
      mine.sort((a, b) => {
        const x = a.round?.id ?? -1n;
        const y = b.round?.id ?? -1n;
        return x > y ? -1 : x < y ? 1 : 0;
      });
      if (keyRef.current !== startedFor) return POLL.accountMs; // the wallet changed while this poll ran
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
        error: positionError,
      });
      return sentRoundId !== null || positionError || inPlay(mine, Date.now()) || Date.now() < fastUntil.current ? POLL.accountMs : POLL.accountIdleMs;
    } catch (error) {
      if (keyRef.current === startedFor) {
        setData((prev) => ({ ...(prev.owner === owner ? prev : { ...EMPTY, owner }), error: describeNetworkError(error) }));
      }
      // The next poll reads everything again.
      if (force) forceRef.current = true;
      return Math.max(POLL.accountMs, rateLimitWaitMs(error) ?? 0);
    }
  }, [rpc, owner, sessionKey, sentRoundId]);

  const pollNow = usePolling(poll, POLL.accountMs, true, key);
  // After my own action (bet, top up, claim...): read everything now and keep the fast pace a little while.
  const refresh = useCallback(() => {
    forceRef.current = true;
    fastUntil.current = Date.now() + POLL.accountAfterActionMs;
    pollNow();
  }, [pollNow]);
  useEffect(() => { if (sentRoundId !== null) refresh(); }, [sentRoundId, refresh]);
  return { ...data, refresh };
}

/**
 * True while one of my rounds can still change: not final before its settle deadline, or final with
 * my position not yet paid out (the keeper claims within seconds of the result).
 */
function inPlay(positions: readonly MyPosition[], nowMs: number): boolean {
  const nowSec = nowMs / 1000;
  return positions.some((p) => {
    const a = p.round?.account;
    if (!a) return false;
    if (a.status !== RoundStatus.Final) return nowSec < Number(a.settleDeadline) + 60;
    return !p.account.claimed && nowSec < Number(a.exitEnd) + 180;
  });
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
