import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Address } from '@solana/kit';
import { RoundStatus, Side } from '@flipthememe/client';
import { positionResult, refundTitle, roundResultLabel, type PositionResult, type ResultLabel } from '../chain/phase';
import type { RoundView } from '../chain/fetch';
import { devnetRpc, type SolanaRpc } from '../chain/rpc';
import { checkSignature, settledError } from '../chain/txStatus';
import { useArena, type ArenaData } from '../chain/useArena';
import { chainNowSec, useChainClock } from '../chain/useChainClock';
import { useMyAccount, type MyAccountData, type MyPosition } from '../chain/useMyAccount';
import { usePoolPrice, type PoolFeed } from '../chain/usePoolPrice';
import { peekTokenInfo } from '../chain/useTokenInfo';
import { faceToBytes, type Face } from '../face/faceModel';
import { loadOrCreateFace, saveFace } from '../face/faceStore';
import { humanError } from '../lib/errors';
import { parseRoundLink, roundLink, sol } from '../lib/format';
import { clearPendingBet, loadPendingBet, type PendingBet } from '../session/pendingBet';
import { loadOrCreateSessionKey, type SessionKey } from '../session/sessionKey';
import { useBetting, type Betting } from '../session/useBetting';
import { useWalletActions, type WalletActions } from '../wallet/useWalletActions';
import { awaySummary, type AwayItem, type AwaySummary } from './away';
import { challengeActive, createChallengeStore, type Challenge } from './challenge';
import { HISTORY_CAP, createHistoryStore, mergeHistory, reconcileHistory, type HistoryEntry, type HistoryRecord } from './history';
import { collectInPlay } from './reminders';
import type { DuelScore } from './rivalScore';
import { useRivalScore } from './useRivalScore';
import { useAskPermissionAfterFirstBet, useResultReminders } from './useResultReminders';

export { sessionStatusOf, type SessionStatus } from '../wallet/sessionList';

export type Tab = 'arena' | 'wallet' | 'history' | 'profile' | 'leaders';

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
  /** The round's start price and its exit price (the price scale of the pool): the move that decided it. */
  strike: bigint;
  exit: bigint;
  label: ResultLabel;
  title: string;
  body: string;
  /** Text share with the round's deep link (also the fallback when the picture share fails). */
  shareText: string;
};

type AppValue = {
  rpc: SolanaRpc;
  offsetSec: number;
  chainNow: () => number;
  arena: ArenaData & { refresh: () => void };
  my: MyAccountData & { refresh: () => void };
  /** True once my account data belongs to the connected wallet. */
  myReady: boolean;
  /** My positions on chain plus finished rounds kept on this phone after their accounts closed; newest first. */
  history: HistoryEntry<MyPosition>[];
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
  /** My rounds that turned final while the app was closed, until acknowledged. */
  away: AwaySummary | null;
  ackAway: () => void;
  /** Local ms when this app first saw my round (by address) final, or null. */
  finalSeenAt: (roundAddress: string) => number | null;
  tab: Tab;
  setTab: (tab: Tab) => void;
  /** A friend's challenge from the last round link that opened the app: kept a week, until OK. */
  challenge: Challenge | null;
  clearChallenge: () => void;
  /** My score against the friend of the challenge (rounds where we called opposite sides, seen since the app opened); null without one. */
  rivalScore: DuelScore | null;
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

  // The arena polls fast and the price feeds run only while the Arena tab is on screen.
  const [tab, setTab] = useState<Tab>('arena');
  const onArena = tab === 'arena';
  const arenaRead = useArena(rpc, onArena);
  // The reads come back as a new object on every render; the context gets one object per read.
  const { config: arenaConfig, rounds: arenaRounds, positions: arenaPositions, updatedAt: arenaUpdatedAt, error: arenaError, refresh: refreshArena } = arenaRead;
  const arena = useMemo(
    () => ({ config: arenaConfig, rounds: arenaRounds, positions: arenaPositions, updatedAt: arenaUpdatedAt, error: arenaError, refresh: refreshArena }),
    [arenaConfig, arenaRounds, arenaPositions, arenaUpdatedAt, arenaError, refreshArena],
  );

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

  // A bet of this phone in flight still needs the device key: the wallet actions read this when a withdraw ends.
  const betInFlightRef = useRef(false);
  const betInFlight = useCallback(() => betInFlightRef.current, []);
  const wallet = useWalletActions({ rpc, sessionKey, chainNowSec: chainNow, onChanged: refreshAll, betInFlight });
  const owner = wallet.owner;

  const myRead = useMyAccount(rpc, owner, sessionKey?.address ?? null);
  const {
    owner: myOwner,
    vaultAddress: myVaultAddress,
    vault: myVault,
    sessionAddress: mySessionAddress,
    session: mySession,
    keyLamports: myKeyLamports,
    walletLamports: myWalletLamports,
    positions: myPositions,
    updatedAt: myUpdatedAt,
    error: myError,
    refresh: refreshMy,
  } = myRead;
  const myRaw = useMemo(
    () => ({
      owner: myOwner,
      vaultAddress: myVaultAddress,
      vault: myVault,
      sessionAddress: mySessionAddress,
      session: mySession,
      keyLamports: myKeyLamports,
      walletLamports: myWalletLamports,
      positions: myPositions,
      updatedAt: myUpdatedAt,
      error: myError,
      refresh: refreshMy,
    }),
    [myOwner, myVaultAddress, myVault, mySessionAddress, mySession, myKeyLamports, myWalletLamports, myPositions, myUpdatedAt, myError, refreshMy],
  );
  const myReady = owner !== null && myRaw.owner === owner && myRaw.updatedAt !== null;
  refreshRef.current = () => {
    arena.refresh();
    myRaw.refresh();
  };

  // History kept on the phone per wallet: finished rounds stay listed after the keeper closes
  // their Position accounts (a day after the round ends).
  const [kept, setKept] = useState<{ owner: string; records: readonly HistoryRecord[] } | null>(null);
  useEffect(() => {
    setKept(null);
    if (!owner) return undefined;
    let alive = true;
    historyStore
      .load(owner)
      .catch(() => [] as HistoryRecord[])
      .then((records) => {
        if (alive) setKept({ owner, records });
      });
    return () => {
      alive = false;
    };
  }, [owner]);
  useEffect(() => {
    if (!myReady || !owner || !kept || kept.owner !== owner) return;
    const next = reconcileHistory(kept.records, myRaw.positions, { cap: HISTORY_CAP, nowMs: Date.now() });
    if (next === kept.records) return;
    setKept({ owner, records: next });
    void historyStore.save(owner, next).catch(() => undefined);
  }, [myReady, owner, myRaw.positions, kept]);

  // Pending bet: shown as pending (never as a placed bet) until its Position account exists, and
  // dropped only when its signature proves it refused or expired (never on a transport error).
  const [pending, setPending] = useState<PendingBet | null>(null);
  const [pendingNote, setPendingNote] = useState<string | null>(null);
  /** The pending bet's signature once the chain shows it confirmed, and when that was seen. */
  const [landed, setLanded] = useState<{ signature: string; at: number } | null>(null);
  useEffect(() => {
    loadPendingBet()
      .then((stored) => {
        if (stored) setPending((cur) => cur ?? stored);
      })
      .catch(() => undefined);
  }, []);

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
    // Confirmed but its position never showed (already closed, or unreadable): it is placed all the same.
    const landedLongAgo = landed !== null && landed.signature === pending.signature && Date.now() - landed.at > LANDED_GRACE_MS;
    if (hasPosition || landedLongAgo) {
      void clearPendingBet(pending.signature).catch(() => undefined);
      setPending(null);
    }
  }, [pending, landed, arena.positions, myRaw.owner, myRaw.positions, myRaw.updatedAt]);

  // While no send is running, the pending bet's signature is looked up until the chain answers:
  // confirmed (placed), refused (the reason is shown) or expired (nothing was taken).
  const betSending = betting.bet.phase === 'signing' || betting.bet.phase === 'sending' || betting.bet.phase === 'confirming';
  betInFlightRef.current = pending !== null || betSending || betting.claiming !== null;
  const pendingLanded = pending !== null && landed?.signature === pending.signature;
  useEffect(() => {
    if (!pending || betSending || pendingLanded) return undefined;
    const bet = pending;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      timer = null;
      const check = await checkSignature(rpc, bet).catch(() => null);
      if (stopped) return;
      if (check?.verdict === 'confirmed') {
        setLanded({ signature: bet.signature, at: Date.now() });
        refreshAll();
        return;
      }
      if (check?.verdict === 'failed' || check?.verdict === 'expired') {
        void clearPendingBet(bet.signature).catch(() => undefined);
        setPending((cur) => (cur?.signature === bet.signature ? null : cur));
        setPendingNote(
          check.verdict === 'failed'
            ? `Bet in round #${bet.roundId} refused: ${humanError(settledError(bet.signature, 'failed', check, null), 'bet')}`
            : `Your bet in round #${bet.roundId} did not go through - nothing was taken.`,
        );
        return;
      }
      timer = setTimeout(tick, PENDING_CHECK_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [pending, betSending, pendingLanded, rpc, refreshAll]);

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
  const feed = usePoolPrice(pools.chartPool, onArena);
  const myFeed = usePoolPrice(pools.myPool, onArena);

  // Result overlays when one of my rounds turns final during this session (they play their own haptics and sound).
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [away, setAway] = useState<AwaySummary | null>(null);
  const ackRef = useRef<{ owner: string | null; id: bigint | null }>({ owner: null, id: null });
  const saveAck = useCallback((forOwner: string, id: bigint) => {
    const cur = ackRef.current;
    if (cur.owner === forOwner && cur.id !== null && id <= cur.id) return;
    ackRef.current = { owner: forOwner, id };
    AsyncStorage.setItem(ackKey(forOwner), id.toString()).catch(() => undefined);
  }, []);
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
      // Results that arrived while the app was closed: one summary, against the last acknowledged round.
      setAway(null);
      const finals = myRaw.positions.filter((p) => p.round?.account.status === RoundStatus.Final);
      const nowSec = chainNow();
      const forOwner = owner;
      AsyncStorage.getItem(ackKey(forOwner))
        .then((raw) => {
          const newest = finals.reduce((m, p) => (p.round!.id > m ? p.round!.id : m), 0n);
          const ack = raw !== null && /^\d+$/.test(raw) ? BigInt(raw) : null;
          // A first launch on this phone starts from now: old history is not news.
          if (ack === null) return saveAck(forOwner, newest);
          ackRef.current = { owner: forOwner, id: ack };
          const items: AwayItem[] = [];
          for (const p of finals) {
            if (p.round!.id <= ack) continue;
            const r = positionResult(p.account, p.round!.account, nowSec);
            if (r.kind !== 'pending') items.push({ id: p.round!.id, kind: r.kind, stake: p.account.stake, payout: r.payout ?? 0n });
          }
          if (seen.current.owner === forOwner) setAway(awaySummary(items));
        })
        .catch(() => undefined);
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
    if (fresh.length > 0) {
      setToasts((prev) => [...prev, ...fresh]);
      // Seen here, so not news on the next launch.
      saveAck(owner, fresh.reduce((m, t) => (t.roundId > m ? t.roundId : m), 0n));
    }
  }, [myReady, owner, myRaw.positions, chainNow, saveAck]);
  const dismissToast = useCallback(() => setToasts((prev) => prev.slice(1)), []);
  const ackAway = useCallback(() => {
    if (away && owner) saveAck(owner, away.lastId);
    setAway(null);
  }, [away, owner, saveAck]);
  const finalSeenAt = useCallback((roundAddress: string) => finalSeen.current.get(roundAddress) ?? null, []);

  // A round link that opens the app (at launch or later) becomes the challenge, replacing an older one.
  // It is kept on the phone, so it outlives installing, connecting and topping up; OK clears it.
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  // Once a link arrived or OK was tapped, the stored challenge read at start is out of date.
  const challengeTouched = useRef(false);
  useEffect(() => {
    challengeStore
      .load(Date.now())
      .then((stored) => {
        if (stored && !challengeTouched.current) setChallenge(stored);
      })
      .catch(() => undefined);
    const handle = (url: string | null) => {
      const link = parseRoundLink(url);
      if (!link) return;
      const next: Challenge = { ...link, at: Date.now() };
      challengeTouched.current = true;
      setChallenge(next);
      setTab('arena');
      void challengeStore.save(next).catch(() => undefined);
    };
    // Android hands the launch link over again when it restores a killed app: one launch link
    // counts once, so a challenge dismissed with OK does not come back by itself.
    Linking.getInitialURL()
      .then(async (url) => {
        if (!url || (await AsyncStorage.getItem(LAUNCH_LINK_KEY).catch(() => null)) === url) return;
        await AsyncStorage.setItem(LAUNCH_LINK_KEY, url).catch(() => undefined);
        handle(url);
      })
      .catch(() => undefined);
    const subscription = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => subscription.remove();
  }, []);
  const clearChallenge = useCallback(() => {
    challengeTouched.current = true;
    setChallenge(null);
    void challengeStore.clear().catch(() => undefined);
  }, []);

  // Until the data belongs to the connected wallet the screens see an empty account.
  const my = useMemo(
    () => (myReady ? myRaw : { ...myRaw, positions: NO_POSITIONS, vault: null, session: null, keyLamports: null, walletLamports: null }),
    [myReady, myRaw],
  );
  const chainPositions = myReady ? myRaw.positions : NO_POSITIONS;
  const keptRecords = kept && kept.owner === owner ? kept.records : NO_RECORDS;
  const history = useMemo(() => mergeHistory(chainPositions, keptRecords), [chainPositions, keptRecords]);
  const pendingOfOwner = pending && owner && pending.owner === owner ? pending : null;
  // A challenge shows for a week; it is read against the clock whenever the arena data moves (every few seconds).
  const activeChallenge = useMemo(
    () => (challenge && challengeActive(challenge, Date.now()) ? challenge : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [challenge, arena],
  );

  const rivalScore = useRivalScore(owner, activeChallenge?.by ?? null, arena.rounds, arena.positions);

  // Local "did your call win?" notifications for my rounds in play, when the app goes to the background.
  const inPlay = useMemo(
    () => collectInPlay({ positions: chainPositions, pending: pendingOfOwner, rounds: arena.rounds }),
    [chainPositions, pendingOfOwner, arena.rounds],
  );
  useResultReminders(inPlay, offsetSec);
  useAskPermissionAfterFirstBet(betting.bet.phase);

  const value = useMemo<AppValue>(
    () => ({
      rpc,
      offsetSec,
      chainNow,
      arena,
      my,
      myReady,
      history,
      wallet,
      sessionKey,
      sessionKeyError,
      face,
      setFace,
      betting,
      pending: pendingOfOwner,
      pendingNote,
      clearPendingNote,
      feed,
      myFeed,
      toasts,
      dismissToast,
      away,
      ackAway,
      finalSeenAt,
      tab,
      setTab,
      challenge: activeChallenge,
      clearChallenge,
      rivalScore,
      refreshAll,
    }),
    [
      rpc,
      offsetSec,
      chainNow,
      arena,
      my,
      myReady,
      history,
      wallet,
      sessionKey,
      sessionKeyError,
      face,
      setFace,
      betting,
      pendingOfOwner,
      pendingNote,
      clearPendingNote,
      feed,
      myFeed,
      toasts,
      dismissToast,
      away,
      ackAway,
      finalSeenAt,
      tab,
      activeChallenge,
      clearChallenge,
      rivalScore,
      refreshAll,
    ],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

const ackKey = (owner: string) => `ftm.resultsAck.v1.${owner}`;

/** Finished rounds per wallet, on the phone (state/history.ts). */
const historyStore = createHistoryStore(AsyncStorage);
/** The friend's challenge from the last round link (state/challenge.ts). */
const challengeStore = createChallengeStore(AsyncStorage);
/** The last link that launched the app, so a restored app does not replay it. */
const LAUNCH_LINK_KEY = 'ftm.launchLink.v1';
const NO_POSITIONS: MyPosition[] = [];
const NO_RECORDS: readonly HistoryRecord[] = [];
/** How often a pending bet's signature is looked up. */
const PENDING_CHECK_MS = 3_000;
/** A confirmed bet stops showing as pending this long after, even if its position never shows. */
const LANDED_GRACE_MS = 30_000;

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
  const r = positionResult({ side: side as Side, stake, claimed, payout, isHouse: false }, a, nowSec);
  const amount = r.payout ?? 0n;
  const symbol = peekTokenInfo(a.tokenMint)?.symbol;
  const token = symbol ? `$${symbol}` : 'a trending meme coin';
  const base = { id: `${round.id}`, roundId: round.id, side, stake, payout: amount, tokenMint: a.tokenMint, strike: a.strikePrice, exit: a.exitPrice, label };
  if (r.kind === 'won') {
    return {
      ...base,
      kind: 'won',
      tone: 'win',
      title: 'YOU WON',
      body: `+${sol(amount - stake)}`,
      shareText: `I called ${sideName(side)} on ${token} in FlipTheMeme round #${round.id} and won +${sol(amount - stake)} (Solana devnet test SOL). ${roundLink(round.id)}`,
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
  const title = refundTitle({ kind: r.kind === 'full-refund' ? 'full-refund' : 'refund', label, payout: amount, stake });
  return {
    ...base,
    kind: r.kind === 'full-refund' ? 'full-refund' : 'refund',
    tone: 'neutral',
    title,
    body: r.kind === 'refund' && a.feeRefundBps > 0 ? `+${sol(amount)} (${a.feeRefundBps / 100}% fee)` : `+${sol(amount)}`,
    shareText: `Round #${round.id} on ${token} ended ${label} in FlipTheMeme (Solana devnet). ${roundLink(round.id)}`,
  };
}
