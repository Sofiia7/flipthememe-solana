import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Linking } from 'react-native';
import type { Address, Signature } from '@solana/kit';
import { RoundStatus, Side, type SessionAccount } from '@flipthememe/client';
import { roundLink } from '../config';
import { positionResult, roundResultLabel, type PositionResult, type ResultLabel } from '../chain/phase';
import type { RoundView } from '../chain/fetch';
import { devnetRpc, type SolanaRpc } from '../chain/rpc';
import { useArena, type ArenaData } from '../chain/useArena';
import { chainNowSec, chainToLocalMs, useChainClock } from '../chain/useChainClock';
import { useMyAccount, type MyAccountData } from '../chain/useMyAccount';
import { usePoolPrice, type PoolFeed } from '../chain/usePoolPrice';
import { peekTokenInfo } from '../chain/useTokenInfo';
import { faceToBytes, type Face } from '../face/faceModel';
import { loadOrCreateFace, saveFace } from '../face/faceStore';
import { parseRoundLink, sol } from '../lib/format';
import { clearPendingBet, loadPendingBet, type PendingBet } from '../session/pendingBet';
import { loadOrCreateSessionKey, type SessionKey } from '../session/sessionKey';
import { useBetting, type Betting } from '../session/useBetting';
import { useWalletActions, type WalletActions } from '../wallet/useWalletActions';

export type Tab = 'arena' | 'wallet' | 'history' | 'profile';

/** One of my rounds turned final while the app was open: drives the win / rekt / refund overlays. */
export type Toast = {
  id: string;
  roundId: bigint;
  kind: Exclude<PositionResult['kind'], 'pending'>;
  tone: 'win' | 'loss' | 'neutral';
  side: number;
  stake: bigint;
  /** Credited to the game balance by this round (lamports). */
  payout: bigint;
  tokenMint: string;
  label: ResultLabel;
  title: string;
  body: string;
  /** Text share with the round's deep link (also the fallback when the picture share fails). */
  shareText: string;
};

export type SessionStatus = 'none' | 'active' | 'expired' | 'revoked' | 'used-up';

export function sessionStatusOf(session: SessionAccount | null, nowSec: number, minStake: bigint): SessionStatus {
  if (!session) return 'none';
  if (session.revoked) return 'revoked';
  if (nowSec >= Number(session.expiry)) return 'expired';
  if (session.spent + minStake > session.sessionCap) return 'used-up';
  return 'active';
}

type AppValue = {
  rpc: SolanaRpc;
  offsetSec: number;
  chainNow: () => number;
  arena: ArenaData & { refresh: () => void };
  my: MyAccountData & { refresh: () => void };
  /** True once my account data belongs to the connected wallet. */
  myReady: boolean;
  wallet: WalletActions;
  sessionKey: SessionKey | null;
  sessionKeyError: string | null;
  face: Face;
  setFace: (face: Face) => void;
  betting: Betting;
  pending: PendingBet | null;
  pendingNote: string | null;
  clearPendingNote: () => void;
  feed: PoolFeed;
  myFeed: PoolFeed;
  toasts: Toast[];
  dismissToast: () => void;
  /** Local ms when this app first saw my round (by address) final, or null. */
  finalSeenAt: (roundAddress: string) => number | null;
  tab: Tab;
  setTab: (tab: Tab) => void;
  deepLinkRound: bigint | null;
  clearDeepLink: () => void;
  refreshAll: () => void;
};

const AppContext = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp outside AppProvider');
  return value;
}

const DEFAULT_FACE: Face = { skin: 2, hairStyle: 0, hairColor: 0, eyes: 0, accessory: 0, mouth: 0 };

const sideName = (side: number) => (side === Side.Up ? 'UP' : 'DOWN');

export function AppProvider({ children }: { children: ReactNode }) {
  const rpc = devnetRpc;
  const offsetSec = useChainClock(rpc);
  const offsetRef = useRef(offsetSec);
  offsetRef.current = offsetSec;
  const chainNow = useCallback(() => chainNowSec(offsetRef.current), []);

  const arena = useArena(rpc);

  const [sessionKey, setSessionKey] = useState<SessionKey | null>(null);
  const [sessionKeyError, setSessionKeyError] = useState<string | null>(null);
  useEffect(() => {
    loadOrCreateSessionKey()
      .then(setSessionKey)
      .catch((e: unknown) => setSessionKeyError(e instanceof Error ? e.message : String(e)));
  }, []);

  const [face, setFaceState] = useState<Face>(DEFAULT_FACE);
  useEffect(() => {
    loadOrCreateFace().then(setFaceState).catch(() => undefined);
  }, []);
  const setFace = useCallback((next: Face) => {
    setFaceState(next);
    void saveFace(next).catch(() => undefined);
  }, []);

  // Late-bound refresh so the wallet actions can trigger polls defined below.
  const refreshRef = useRef<() => void>(() => undefined);
  const refreshAll = useCallback(() => refreshRef.current(), []);

  const wallet = useWalletActions({ rpc, sessionKey: sessionKey?.address ?? null, chainNowSec: chainNow, onChanged: refreshAll });
  const owner = wallet.owner;

  const myRaw = useMyAccount(rpc, owner, sessionKey?.address ?? null);
  const myReady = owner !== null && myRaw.owner === owner && myRaw.updatedAt !== null;
  refreshRef.current = () => {
    arena.refresh();
    myRaw.refresh();
  };

  // Pending bet: shown as pending (never as a placed bet) until its Position account exists.
  const [pending, setPending] = useState<PendingBet | null>(null);
  const [pendingNote, setPendingNote] = useState<string | null>(null);
  useEffect(() => {
    loadPendingBet().then((stored) => {
      if (!stored) return;
      setPending(stored);
      // A restored bet whose transaction failed on chain is dropped at once.
      rpc
        .getSignatureStatuses([stored.signature as Signature])
        .send()
        .then(({ value }) => {
          if (value[0]?.err) {
            void clearPendingBet();
            setPending(null);
            setPendingNote(`Your bet in round #${stored.roundId} did not go through.`);
          }
        })
        .catch(() => undefined);
    });
  }, [rpc]);

  const faceBytes = useMemo(() => faceToBytes(face), [face]);
  const onPending = useCallback((bet: PendingBet | null) => {
    setPending(bet);
    if (bet) setPendingNote(null);
  }, []);
  const clearPendingNote = useCallback(() => setPendingNote(null), []);
  const betting = useBetting({
    rpc,
    owner,
    sessionKey,
    faceBytes,
    onPending,
    onChanged: refreshAll,
    signWithWallet: wallet.signWithWallet,
  });

  useEffect(() => {
    if (!pending) return;
    const hasPosition =
      (arena.positions.get(pending.roundId) ?? []).some((p) => p.account.authority === pending.owner && !p.account.isHouse) ||
      (myRaw.owner === pending.owner && myRaw.positions.some((p) => p.round?.id === pending.roundId));
    if (hasPosition) {
      void clearPendingBet();
      setPending(null);
      return;
    }
    const round: RoundView | undefined = arena.rounds.find((r) => r.id === pending.roundId);
    const settledAfterMs = round ? chainToLocalMs(Number(round.account.cutoffAt) + 20, offsetRef.current) : pending.at + 5 * 60_000;
    // My positions were read after the round closed (+20 s) and the bet is not among them: it did not land.
    const checkedLate = myRaw.owner === pending.owner && myRaw.updatedAt !== null && myRaw.updatedAt > settledAfterMs;
    if (checkedLate || Date.now() - pending.at > 10 * 60_000) {
      void clearPendingBet();
      setPending(null);
      setPendingNote(`Your bet in round #${pending.roundId} did not go through.`);
    }
  }, [pending, arena.positions, arena.rounds, myRaw.owner, myRaw.positions, myRaw.updatedAt]);

  // Price feeds: the pool of the round now open (or the latest started), plus my round's pool if different.
  const pools = useMemo(() => {
    const now = chainNowSec(offsetRef.current);
    const started = arena.rounds.find((r) => Number(r.account.opensAt) <= now) ?? arena.rounds[arena.rounds.length - 1];
    const chartPool = started?.account.pool ?? null;
    let myPool: Address | null = null;
    if (myRaw.owner === owner) {
      const unresolved = myRaw.positions
        .filter((p) => p.round && p.round.account.status !== RoundStatus.Final)
        .sort((a, b) => ((a.round?.id ?? 0n) < (b.round?.id ?? 0n) ? -1 : 1))[0];
      myPool = unresolved?.round?.account.pool ?? null;
    }
    return { chartPool, myPool: myPool && myPool !== chartPool ? myPool : null };
  }, [arena.rounds, myRaw.positions, myRaw.owner, owner]);
  const feed = usePoolPrice(pools.chartPool);
  const myFeed = usePoolPrice(pools.myPool);

  // Result overlays when one of my rounds turns final during this session (they play their own haptics and sound).
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seen = useRef<{ owner: string | null; status: Map<string, number> }>({ owner: null, status: new Map() });
  // Local ms when this app first saw each of my rounds final (the manual Claim waits 20 s after it).
  const finalSeen = useRef(new Map<string, number>());
  useEffect(() => {
    if (!myReady || !owner) return;
    for (const p of myRaw.positions) {
      if (p.round?.account.status === RoundStatus.Final && !finalSeen.current.has(p.round.address)) {
        finalSeen.current.set(p.round.address, Date.now());
      }
    }
    const memory = seen.current;
    if (memory.owner !== owner) {
      memory.owner = owner;
      memory.status = new Map(myRaw.positions.filter((p) => p.round).map((p) => [p.round!.address, p.round!.account.status]));
      return;
    }
    const fresh: Toast[] = [];
    for (const p of myRaw.positions) {
      const round = p.round;
      if (!round) continue;
      const before = memory.status.get(round.address);
      memory.status.set(round.address, round.account.status);
      if (before === undefined || before === RoundStatus.Final || round.account.status !== RoundStatus.Final) continue;
      fresh.push(resultToast(p.account.side, p.account.stake, p.account.claimed, p.account.payout, round, chainNow()));
    }
    if (fresh.length > 0) setToasts((prev) => [...prev, ...fresh]);
  }, [myReady, owner, myRaw.positions, chainNow]);
  const dismissToast = useCallback(() => setToasts((prev) => prev.slice(1)), []);
  const finalSeenAt = useCallback((roundAddress: string) => finalSeen.current.get(roundAddress) ?? null, []);

  const [tab, setTab] = useState<Tab>('arena');
  const [deepLinkRound, setDeepLinkRound] = useState<bigint | null>(null);
  useEffect(() => {
    const handle = (url: string | null) => {
      const id = parseRoundLink(url);
      if (id !== null) {
        setDeepLinkRound(id);
        setTab('arena');
      }
    };
    Linking.getInitialURL().then(handle).catch(() => undefined);
    const subscription = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => subscription.remove();
  }, []);
  const clearDeepLink = useCallback(() => setDeepLinkRound(null), []);

  const my = myReady ? myRaw : { ...myRaw, positions: [], vault: null, session: null, keyLamports: null, walletLamports: null };

  const value: AppValue = {
    rpc,
    offsetSec,
    chainNow,
    arena,
    my,
    myReady,
    wallet,
    sessionKey,
    sessionKeyError,
    face,
    setFace,
    betting,
    pending: pending && owner && pending.owner === owner ? pending : null,
    pendingNote,
    clearPendingNote,
    feed,
    myFeed,
    toasts,
    dismissToast,
    finalSeenAt,
    tab,
    setTab,
    deepLinkRound,
    clearDeepLink,
    refreshAll,
  };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function resultToast(
  side: number,
  stake: bigint,
  claimed: boolean,
  payout: bigint,
  round: RoundView,
  nowSec: number,
): Toast {
  const a = round.account;
  const label = roundResultLabel(a);
  const r = positionResult({ side: side as Side, stake, claimed, payout }, a, nowSec);
  const amount = r.payout ?? 0n;
  const symbol = peekTokenInfo(a.tokenMint)?.symbol;
  const token = symbol ? `$${symbol}` : 'a fresh meme coin';
  const base = { id: `${round.id}`, roundId: round.id, side, stake, payout: amount, tokenMint: a.tokenMint, label };
  if (r.kind === 'won') {
    return {
      ...base,
      kind: 'won',
      tone: 'win',
      title: 'YOU WON',
      body: `+${sol(amount)}`,
      shareText: `I called ${sideName(side)} on ${token} in FlipTheMeme round #${round.id} and won ${sol(amount)} (Solana devnet test SOL). ${roundLink(round.id)}`,
    };
  }
  if (r.kind === 'lost') {
    return {
      ...base,
      kind: 'lost',
      tone: 'loss',
      title: 'REKT',
      body: amount > 0n ? `-${sol(stake - amount)}, ${sol(amount)} unmatched back` : `-${sol(stake - amount)}`,
      shareText: `Round #${round.id} on ${token} went ${label} in FlipTheMeme. Rematch? ${roundLink(round.id)}`,
    };
  }
  const title =
    r.kind === 'full-refund'
      ? 'No match - stake back'
      : label === 'TIE'
        ? 'Tie - stake back'
        : label === 'NO PRICE'
          ? 'No price - stake back'
          : label === 'EXPIRED'
            ? 'Expired - stake back'
            : 'Refund - stake back';
  return {
    ...base,
    kind: r.kind === 'full-refund' ? 'full-refund' : 'refund',
    tone: 'neutral',
    title,
    body: r.kind === 'full-refund' ? `+${sol(amount)}` : `+${sol(amount)} (1% fee)`,
    shareText: `Round #${round.id} on ${token} ended ${label} in FlipTheMeme (Solana devnet). ${roundLink(round.id)}`,
  };
}
