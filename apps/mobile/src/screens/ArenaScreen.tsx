import { useMarketStatus } from '../chain/useMarketStatus';
import { waitingView } from '../lib/marketStatus';
import { recordEvent } from '../lib/diagnostics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RoundStatus, Side, acceptedStake } from '@flipthememe/client';
import { BET_AMOUNTS, ENTRY_GUARD_SECS, SESSION_RULES, explorer } from '../config';
import type { PositionView, RoundView } from '../chain/fetch';
import { withOwnPosition, showBetReceipt } from '../chain/arenaPositions';
import { useSkrNames } from '../chain/skr';
import {
  classifyRounds,
  fitsDepth,
  roundResultLabel,
  selectChartRound,
  selectPanel,
  selectTimer,
  standingNow,
  strikeState,
  type RoundGroups,
} from '../chain/phase';
import { chainNowSec, chainToLocalMs } from '../chain/useChainClock';
import { isFeedStale, usePoolPrice, type PoolFeed } from '../chain/usePoolPrice';
import { useRents } from '../chain/rent';
import { peekTokenInfo, useTokenInfo } from '../chain/useTokenInfo';
import { multiplierText } from '../chain/repeatBet';
import { faceFromBytes } from '../face/faceModel';
import { chipStates, effectiveAmount, maxBet, maxBetCaption } from '../lib/betChips';
import { deltaView, formatCountdown, formatSol, roundLink } from '../lib/format';
import { chatterOn, useBoolStore } from '../lib/prefs';
import { useNow } from '../lib/usePolling';
import { shareCard } from '../share/ShareCard';
import { sessionStatusOf, useApp, type SessionStatus } from '../state/AppProvider';
import { awayText } from '../state/away';
import { dayWindow, streakLabel, streakOf, todayLine, todayStats } from '../state/history';
import { armIntent, commitIntent, decideIntent, intentAfterSheetClosed, intentText, type BetIntent } from '../state/intent';
import { C, MONO, T } from '../theme';
import type { ClockSide } from '../ui/ArenaClock';
import { ChallengeCard } from '../ui/ChallengeCard';
import { PriceChart } from '../ui/Chart';
import { ChatterLane } from '../ui/ChatterLane';
import { Btn, ExtLink } from '../ui/common';
import { DailyRecord } from '../ui/DailyRecord';
import { HowItWorksSheet } from '../ui/HowItWorks';
import { EntryTicker, LiveClock, type ClockView } from '../ui/LiveClock';
import { NeonButton } from '../ui/NeonButton';
import { PixelText } from '../ui/PixelText';
import { ExtraRoundLine, MyRoundPanel, OpenRoundPanel } from '../ui/RoundPanel';
import { TokenHeader } from '../ui/TokenHeader';
import { RoundProgress } from '../ui/RoundProgress';
import { TopUpSheet } from '../ui/TopUpSheet';
import { canRenewSession, minStakeOf } from '../wallet/playState';
import { RENT_FALLBACK, maxWinProfit } from '../wallet/topUpPlan';

type Mine = { round: RoundView; position: PositionView };
type Standing = 'winning' | 'losing' | 'tie' | null;

const sideName = (side: number) => (side === Side.Up ? 'UP' : 'DOWN');
/** The subtitle of a side button that cannot take the amount (the other side still can); short enough for half the dock. */
const SIDE_FULL = 'full - try other side';
/** One empty list for every panel without players, so a memoized panel sees the same prop each render. */
const NO_PLAYERS: PositionView[] = [];

const SESSION_REASON: Record<Exclude<SessionStatus, 'active'>, string> = {
  none: 'One approval, then every bet is one tap.',
  expired: 'Your play session expired.',
  revoked: 'Your play session was revoked.',
  'used-up': 'Your one-tap limit is used up.',
};

export function ArenaScreen() {
  const app = useApp();
  const { arena, my, myReady, wallet, betting, pending, feed, myFeed, offsetSec } = app;
  // Each bet parks its position rent from the game balance until the keeper closes it (a day later).
  // Until the real figure is read the rent comes from the account size (RENT_FALLBACK, a hair above the real one).
  const positionRent = useRents(app.rpc)?.position ?? RENT_FALLBACK.position;
  // The screen follows a one-second clock: the big timer and the countdown ticks run on their own half-second
  // clocks inside small components (ui/LiveClock.tsx), so the chart and the panels are not redrawn twice a second.
  const nowMs = useNow(1_000);
  const secMs = Math.floor(nowMs / 1000) * 1000;
  const nowSec = chainNowSec(offsetSec, nowMs);
  const nowWhole = Math.floor(nowSec);
  const market = useMarketStatus();
  const waiting = waitingView(market, nowMs);
  const owner = wallet.owner;
  const myName = useSkrNames(owner ? [owner] : []).get(owner ?? '') ?? null;
  // The friend whose challenge link opened the app: their face in the round panels says RIVAL.
  const rival = app.challenge?.by ?? null;
  const [amount, setAmount] = useState<bigint>(BET_AMOUNTS[1]);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  // The side a visitor tapped, remembered while the wallet connects and approves (state/intent.ts).
  const [intent, setIntent] = useState<BetIntent | null>(null);
  const [intentNotice, setIntentNotice] = useState<string | null>(null);
  const [selectedRound, setSelectedRound] = useState<bigint | null>(null);
  const [showNewCall, setShowNewCall] = useState(false);
  const chatter = useBoolStore(chatterOn);
  const insets = useSafeAreaInsets();
  // The chart depends only on the device window, never on player count, hints or dock contents.
  const { height: windowHeight } = useWindowDimensions();
  const arenaHeight = windowHeight - insets.top - insets.bottom - 48;
  const chartHeight = arenaHeight < 600 ? 100 : arenaHeight < 700 ? 120 : 140;
  const chatterShown = chatter.loaded && chatter.value && arenaHeight >= 660;

  // The rules stay behind the "?" in the header: nothing opens by itself on the first launch.
  useEffect(() => {
    void chatterOn.load();
  }, []);
  const closeHow = useCallback(() => setHowOpen(false), []);
  // A sheet closed without the approval forgets the side that was tapped; one closing after it keeps it.
  const closeTopUp = useCallback(() => {
    setTopUpOpen(false);
    setIntent(intentAfterSheetClosed);
  }, []);

  const streak = useMemo(() => streakOf(app.history), [app.history]);
  const streakText = streak.kind === 'win' ? streakLabel(streak) : null;
  // "today: 5 calls · 3 won · +0.0192" from the history on this phone; absent before the first call of the day.
  const { startMs: dayStart, endMs: dayEnd } = dayWindow(nowMs);
  const day = useMemo(() => todayStats(app.history, { startMs: dayStart, endMs: dayEnd }), [app.history, dayStart, dayEnd]);
  const dayText = todayLine(day, formatSol);
  const dayColor = day.finished === 0 || day.net === 0n ? C.accentText : day.net > 0n ? C.neonGreen : C.neonRed;

  const groups: RoundGroups<RoundView> = useMemo(() => classifyRounds(arena.rounds, nowWhole), [arena.rounds, nowWhole]);

  // My confirmed positions by round id: history plus the fresher arena reads.
  const mine = useMemo(() => {
    const out = new Map<bigint, Mine>();
    if (!owner) return out;
    for (const p of my.positions) if (p.round) out.set(p.round.id, { round: p.round, position: p });
    for (const r of arena.rounds) {
      const position = (arena.positions.get(r.id) ?? []).find((x) => x.account.authority === owner && !x.account.isHouse);
      const known = out.get(r.id);
      if (position) out.set(r.id, { round: r, position });
      else if (known) out.set(r.id, { ...known, round: r });
    }
    return out;
  }, [owner, my.positions, arena.rounds, arena.positions]);
  const myUnresolved = useMemo(
    () => [...mine.values()].filter((m) => m.round.account.status !== RoundStatus.Final).sort((a, b) => (a.round.id < b.round.id ? -1 : 1)),
    [mine],
  );
  // Follow the oldest unfinished call until the player explicitly selects another.
  const latest = myUnresolved.find(m => m.round.id === selectedRound)?.round ?? myUnresolved[0]?.round ?? null;
  const myRounds = latest && !showNewCall ? [latest] : [];

  const open = groups.open;
  const panel = selectPanel({ nowSec, open, upcoming: groups.upcoming, myUnresolved: myRounds });
  const focus = latest && !showNewCall ? mine.get(latest.id) ?? null : null;
  const selectedFeed = usePoolPrice(focus && focus.round.account.pool !== feed.pool && focus.round.account.pool !== myFeed.pool ? focus.round.account.pool : null, app.tab === 'arena');

  // Prices: the charted pool, or my round's pool when the token rotated since I bet.
  const feedFor = (pool: string): PoolFeed | null => (feed.pool === pool ? feed : myFeed.pool === pool ? myFeed : selectedFeed.pool === pool ? selectedFeed : null);
  const priceOf = (pool: string, atMs: number = nowMs) => {
    const f = feedFor(pool);
    return f?.latest ? { price: f.latest.price, stale: isFeedStale(f, atMs) } : null;
  };
  const standingOf = (m: Mine): Standing => {
    const st = strikeState(m.round.account, nowSec);
    if (st.kind !== 'fixed') return null;
    const p = priceOf(m.round.account.pool);
    // An old price must not say "winning now": the panel then shows no standing until it is fresh.
    return p && !p.stale ? standingNow(m.position.account.side, st.strike, p.price) : null;
  };

  // While a round of mine plays, the stage (token header, X lane, chart) follows it, even after the
  // keeper moved the next rounds to another token: the strike line I bet on stays on screen.
  const preview = usePoolPrice(!focus && !feed.pool && market && nowMs - Date.parse(market.updatedAt) <= 240_000 ? market.pool?.pool ?? null : null, app.tab === 'arena');
  const stagePool = focus?.round.account.pool ?? feed.pool ?? preview.pool;
  const stageFeed: PoolFeed = stagePool === selectedFeed.pool ? selectedFeed : stagePool === myFeed.pool ? myFeed : stagePool === feed.pool ? feed : stagePool === preview.pool ? preview : { pool: stagePool, ref: null, points: [], latest: null, error: null };
  // The chart follows my round, else the latest live round on this pool.
  const chartRound = selectChartRound({ pool: stageFeed.pool, focus: focus?.round ?? null, inFlight: groups.inFlight });
  const chartStrike = chartRound ? strikeState(chartRound.account, nowSec) : null;
  const priceStale = isFeedStale(stageFeed, nowMs);
  // The strike window: bright while the strike is measured, faint once the strike line is drawn.
  const strikeWindow =
    chartRound && chartStrike && chartStrike.kind !== 'none'
      ? {
          range: [chainToLocalMs(chartRound.account.strikeStart, offsetSec), chainToLocalMs(chartRound.account.strikeEnd, offsetSec)] as const,
          label:
            chartStrike.kind === 'pending' ? 'START PRICE SOON' : chartStrike.kind === 'fixing' ? 'REFERENCE' : '',
          strong: chartStrike.kind === 'pending' || chartStrike.kind === 'fixing',
        }
      : null;

  // The big timer and the readout next to it (the live move of my round, or the charted one, against its strike;
  // nothing once the exit window is over: the price after it no longer decides anything). Worked out for a given
  // local time, because the clock component asks twice a second.
  const deltaRound = focus?.round ?? chartRound;
  const clockAt = (atMs: number): ClockView => {
    const sec = chainNowSec(offsetSec, atMs);
    const timer = selectTimer({ nowSec: sec, open, upcoming: groups.upcoming, myUnresolved: myRounds });
    let side: ClockSide = null;
    if (deltaRound && sec < Number(deltaRound.account.exitEnd)) {
      const st = strikeState(deltaRound.account, sec);
      const id = `#${deltaRound.id}`;
      if (st.kind === 'fixed') {
        const p = priceOf(deltaRound.account.pool, atMs);
        const delta = p ? deltaView(st.strike, p.price) : null;
        if (p && delta) side = { kind: 'delta', delta, label: `${id} VS START PRICE`, stale: p.stale };
      } else if (st.kind === 'pending') side = { kind: 'note', text: formatCountdown(st.secondsLeft), label: 'START PRICE IN' };
      else if (st.kind === 'fixing') side = { kind: 'note', text: sec < Number(deltaRound.account.strikeEnd) ? 'MEASURING' : 'CONFIRMING', label: 'START PRICE' };
    }
    return { timer, side };
  };

  // Header and chart describe the same pool: my round's while it plays, else the open round's, else the latest started one.
  const panelRound = focus?.round ?? (panel.kind === 'empty' ? null : panel.round);
  const panelPositions = panelRound ? withOwnPosition(arena.positions.get(panelRound.id) ?? NO_PLAYERS, mine.get(panelRound.id)?.position) : NO_PLAYERS;
  const tokenRound =
    (focus && focus.round.account.pool === stageFeed.pool ? focus.round : null) ??
    (open && open.account.pool === stageFeed.pool ? open : null) ??
    arena.rounds.find((r) => stageFeed.pool !== null && r.account.pool === stageFeed.pool) ??
    open ??
    panelRound ??
    arena.rounds[0] ??
    null;
  const tokenMint = tokenRound?.account.tokenMint ?? (preview.pool ? market?.pool?.baseMint ?? null : null);
  const tokenInfo = peekTokenInfo(tokenMint);
  const symbol = tokenInfo?.symbol ?? null;
  // The open round's token, named in the NEXT bar and in a challenge when it differs from the stage.
  const openInfo = useTokenInfo(open && open.account.tokenMint !== tokenMint ? open.account.tokenMint : null, open?.account.pool ?? null);
  const openSymbol = open && open.account.tokenMint !== tokenMint ? (openInfo?.symbol ?? null) : symbol;

  // Betting preconditions.
  const minStake = minStakeOf(open?.account.minStake, arena.config?.minStake);
  const status = sessionStatusOf(my.session, nowSec, minStake);
  const available = my.vault?.available ?? 0n;
  const remaining = my.session ? my.session.sessionCap - my.session.spent : 0n;
  const keyGasOk = (my.keyLamports ?? 0n) >= SESSION_RULES.gasPerBet;
  // Money already in the game balance: one-tap bets come back with one approval and no deposit.
  const canRenew = canRenewSession({ myReady, available, minStake, status, keyLamports: my.keyLamports });
  // A bet takes its stake and the rent of its position account from the game balance; a session made
  // before the allowance was widened is limited too. A chip over that is off, and the amount used
  // falls back to the largest chip that fits (the choice itself returns once the balance does).
  const balanceMax = maxBet({ available, positionRent, sessionLeft: my.session ? remaining : null });
  const maxAmount = my.session && my.session.maxPerBet < balanceMax ? my.session.maxPerBet : balanceMax;
  const chips = chipStates(BET_AMOUNTS, maxAmount);
  const betAmount = effectiveAmount(amount, BET_AMOUNTS, maxAmount);
  const inOpen = open ? mine.get(open.id) : undefined;
  const followedConfirmation = useRef<bigint | null>(null);
  useEffect(() => {
    const id = betting.bet.roundId;
    if (betting.bet.phase === 'confirmed' && id !== null && id !== followedConfirmation.current && mine.has(id)) {
      followedConfirmation.current = id;
      setSelectedRound(id);
      setShowNewCall(false);
    }
  }, [mine, betting.bet.phase, betting.bet.roundId]);
  const quotedAmount = owner ? betAmount : amount;
  const upMatch = open ? acceptedStake(open.account.rawUp + quotedAmount, open.account.rawDown, Side.Up, quotedAmount) : null;
  const downMatch = open ? acceptedStake(open.account.rawUp, open.account.rawDown + quotedAmount, Side.Down, quotedAmount) : null;
  const pendingHere = pending && open && pending.roundId === open.id ? pending : null;
  const working = betting.bet.phase === 'signing' || betting.bet.phase === 'sending' || betting.bet.phase === 'confirming';
  const secondsLeft = open ? Number(open.account.cutoffAt) - nowSec : 0;
  const paused = arena.config?.paused ?? false;

  let topUpReason: string | null = null;
  if (owner && myReady) {
    if (status !== 'active') topUpReason = SESSION_REASON[status];
    else if (available < minStake) topUpReason = 'Your game balance is empty.';
    else if (!keyGasOk) topUpReason = 'The device key needs devnet SOL for fees.';
  }

  const arenaStaleSec = arena.updatedAt ? Math.floor((nowMs - arena.updatedAt) / 1000) : null;
  let blocked: string | null = null;
  let blockedByFunds = false;
  // A passing refusal (the device key is still loading, arena data is a few seconds old): a remembered first call waits through it.
  let blockedPassing = false;
  if (!open) blocked = waiting.detail;
  else if (owner && !app.sessionKey) {
    blocked = app.sessionKeyError ? 'Device key unavailable. Open Wallet to recover.' : 'Loading device key - try again shortly.';
    blockedPassing = !app.sessionKeyError;
  } else if (arenaStaleSec !== null && arenaStaleSec > 10) {
    blocked = 'Reconnecting to devnet - bets wait for fresh data.';
    blockedPassing = true;
  }
  else if (paused) blocked = 'Betting is paused by the operator.';
  else if (inOpen || pendingHere) blocked = null;
  else if (secondsLeft <= ENTRY_GUARD_SECS) blocked = 'Entry is closing - catch the next round.';
  else if (betAmount + positionRent > available) {
    // Only when no chip fits: the chips under the balance are always chosen first.
    blocked = `Balance ${formatSol(available)} SOL - top up to bet.`;
    blockedByFunds = true;
  } else if (betAmount > remaining) {
    blocked = `One-tap limit left ${formatSol(remaining)} SOL - top up to renew.`;
    blockedByFunds = true;
  } else if (betAmount > open.account.maxStake || betAmount < open.account.minStake) blocked = "Out of this round's limits.";
  const upFits = open ? fitsDepth(open.account, Side.Up, betAmount) : false;
  const downFits = open ? fitsDepth(open.account, Side.Down, betAmount) : false;
  const feeWinBps = open?.account.feeWinBps ?? arena.config?.feeWinBps ?? 200;
  const multiplier = multiplierText(feeWinBps);
  // x1.96 pays on the matched part; this is the profit when the whole amount gets matched.
  const winProfit = maxWinProfit(betAmount, feeWinBps);

  const placeBet = (side: Side, wanted: bigint = betAmount) => {
    if (working || pendingHere) return;
    if (!open || blocked || inOpen) {
      setIntentNotice(inOpen ? `Call #${open!.id} already saved.` : `NOT PLACED: ${blocked ?? 'Next round is not open yet.'}`);
      return;
    }
    // The screen's clock is up to a second old: the entry guard is read again at the tap itself.
    const tapSecondsLeft = Number(open.account.cutoffAt) - chainNowSec(offsetSec, Date.now());
    if (tapSecondsLeft <= ENTRY_GUARD_SECS) {
      setIntentNotice(`NOT PLACED: entry ${tapSecondsLeft <= 0 ? 'closed' : 'closing'}. Choose the next round.`);
      return;
    }
    setIntentNotice(null);
    app.clearPendingNote();
    // A bet placed by hand ends any remembered first call, so the two can never both go in.
    setIntent(null);
    void betting.place(open.id, side, wanted);
  };

  // A visitor's tap on UP or DOWN: remember the side and the chip, and open the sheet that connects the wallet
  // and approves in one go. Once the approval is through, the call goes in by itself (decideIntent).
  const tapAsVisitor = (side: Side) => {
    if (wallet.busy !== null) return;
    setIntentNotice(null);
    recordEvent('intent');
    setIntent(armIntent({ side, amount, roundId: open?.id ?? null, pool: open?.account.pool ?? null, nowMs: Date.now() }));
    setTopUpOpen(true);
  };
  useEffect(() => {
    const r = wallet.result;
    if (intent && !intent.committed && r && r.ok && r.action === 'topup' && r.at >= intent.armedAt) setIntent(commitIntent(intent));
  }, [wallet.result, intent]);
  const intentDecision = decideIntent(intent, {
    nowMs,
    connected: owner !== null,
    myReady,
    sessionActive: status === 'active',
    openRoundId: open?.id ?? null,
    openRoundPool: open?.account.pool ?? null,
    secondsLeft,
    refusal: blocked === null ? null : blockedByFunds ? 'funds' : blockedPassing ? 'transient' : 'other',
    working,
    alreadyIn: !!inOpen || !!pendingHere,
    guardSecs: ENTRY_GUARD_SECS,
  });
  useEffect(() => {
    if (intentDecision.kind === 'drop') {
      if (intentDecision.reason !== 'already-in') {
        setIntentNotice(
          intentDecision.reason === 'token-changed' ? 'NOT PLACED: the coin changed. Tap a side again.'
            : intentDecision.reason === 'expired' ? 'NOT PLACED: it took too long. Tap a side again.'
            : intentDecision.reason === 'no-wallet' ? 'NOT PLACED: wallet not connected.'
            : 'NOT PLACED: ' + (blocked ?? 'could not place. Tap a side again.'),
        );
      }
      setIntent(null);
    }
    else if (intentDecision.kind === 'place' && intent) {
      setIntent(null);
      if (intent.amount > maxAmount) setIntentNotice('NOT PLACED: amount no longer fits. Pick again.');
      else placeBet(intentDecision.side, intent.amount);
    }
    // placeBet is re-made every render; what starts it is the decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentDecision.kind, intent]);
  const intentWaiting = intent?.committed === true && intentDecision.kind === 'wait';
  const betNotice = intentNotice ?? app.pendingNote;

  // A challenge for my round, open or already live: the friend can rarely make it in time, so the link
  // invites them to any later round and carries my wallet and name for their RIVAL tag. It names the
  // round's own coin, which may differ from the stage's (the open round's often does).
  const challenge = (m: Mine, live: boolean) => {
    if (!owner) return;
    recordEvent('invite_shared');
    const side = m.position.account.side;
    const info = peekTokenInfo(m.round.account.tokenMint);
    const symbol = info?.symbol ?? null;
    const token = symbol ? `$${symbol}` : 'a trending meme coin';
    const link = roundLink(m.round.id, { side: sideName(side), token: symbol, by: owner, name: myName });
    const text = `I'm ${sideName(side)} on ${token} in FlipTheMeme round #${m.round.id}${live ? ', live now' : ''} (Solana devnet, test SOL). Take the other side: rounds start every minute, join any time: ${link}`;
    setSharing(true);
    void shareCard(
      {
        kind: 'challenge',
        face: faceFromBytes(m.position.account.face),
        side,
        roundId: m.round.id,
        symbol,
        imageUrl: info?.imageUrl ?? null,
        name: myName,
      },
      text,
      'Challenge a friend',
    ).finally(() => setSharing(false));
  };

  // My round in play can be shared too; the dock offers it for a call in the open round instead.
  const challengeFocus = focus && owner && nowSec < Number(focus.round.account.exitEnd) ? focus : null;
  // Outside a bet the same place invites a friend to play. The link names no side, only me (wallet and
  // name for their RIVAL tag) and the round open now, so their app shows where to meet.
  const inviteRound = challengeFocus || inOpen ? null : (open ?? groups.upcoming);
  const invite = (round: RoundView | null) => {
    const id = round?.id ?? arena.rounds[0]?.id ?? 0n;
    const link = roundLink(id, { side: null, token: null, by: owner, name: myName });
    const text = `Play FlipTheMeme with me: call UP or DOWN on a busy Solana meme coin. A 1-minute move, result in about 2 minutes, a new round every minute (devnet, test SOL). Join me: ${link}`;
    setSharing(true);
    void shareCard({ kind: 'invite', face: app.face, roundId: id, name: myName }, text, 'Play with a friend').finally(() => setSharing(false));
  };


  return (
    <View style={styles.flex}>
      <View style={styles.screen}>
      <View style={styles.headerWrap}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <View style={{ flex: 1, minWidth: 0 }}><PixelText text="$FLIPTHEMEME" size={1.75} color={C.white} shadow={C.accent} fit style={{ alignItems: 'flex-start' }} /></View>
            <Text style={styles.devnet}>DEVNET</Text>
          </View>
          <View style={styles.headerRight}>
            <Pressable onPress={() => setHowOpen(true)} hitSlop={8} style={styles.help} accessibilityRole="button" accessibilityLabel="Rules and current round">
              <Text style={styles.helpText}>RULES</Text>
            </Pressable>
            {/* A visitor's chip opens the same sheet as UP and DOWN (connect and approve in one wallet trip); a player's opens the wallet tab. */}
            <Pressable onPress={() => (owner ? app.setTab('wallet') : setTopUpOpen(true))} style={styles.walletChip} accessibilityRole="button">
              <Text style={styles.walletText} numberOfLines={1}>
                {owner ? (myReady ? `${formatSol(available)} SOL` : '...') : wallet.busy !== null ? 'CONNECTING' : 'CONNECT'}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>

      {chatterShown && tokenMint ? <ChatterLane symbol={symbol} mint={tokenMint} /> : null}

      <View style={styles.page}>
          <TokenHeader mint={tokenMint} pool={tokenRound?.account.pool ?? preview.pool} nowMs={secMs} />
          <View style={styles.roundSelection}>
            <Text numberOfLines={1} style={styles.dayText}>{focus ? `YOUR CALL #${focus.round.id} - ${sideName(focus.position.account.side)}` : open ? `CALL #${open.id} - OPEN` : 'NEXT ROUND'}</Text>
            {myUnresolved.length > 0 ? <Pressable hitSlop={10} onPress={() => { if (focus) setShowNewCall(true); else { setShowNewCall(false); setSelectedRound(myUnresolved[(myUnresolved.findIndex(m => m.round.id === selectedRound) + 1) % myUnresolved.length].round.id); } }} style={styles.viewCall} accessibilityRole="button"><Text style={styles.walletText}>{focus ? 'NEXT CALL' : 'MY CALL'}</Text></Pressable> : null}
          </View>

          <View style={[styles.chartSpace, { height: chartHeight }]}>
          <PriceChart
            points={stageFeed.points}
            nowMs={secMs}
            height={chartHeight}
            strike={chartStrike?.kind === 'fixed' ? chartStrike.strike : null}
            strikeLabel={chartRound ? `START #${chartRound.id}` : undefined}
            pairLabel={`${symbol ? symbol.toUpperCase() : 'TOKEN'} / SOL`}
            strikeWindow={strikeWindow}
            exitWindow={
              chartRound ? [chainToLocalMs(chartRound.account.exitStart, offsetSec), chainToLocalMs(chartRound.account.exitEnd, offsetSec)] : null
            }
            cutoffMs={!focus && open && open.account.pool === stageFeed.pool ? chainToLocalMs(open.account.cutoffAt, offsetSec) : null}
            stale={priceStale && stageFeed.points.length > 0}
            emptyText={
              stageFeed.pool ? (stageFeed.error ? `Price source unreachable: ${stageFeed.error}` : 'Reading the live price...') : waiting.title
            }
          />
          </View>

          {arena.updatedAt === null ? (
            <View style={styles.loading}>
              <ActivityIndicator color={C.neonPurple} />
              <Text style={styles.loadingText}>{arena.error ? `Cannot reach devnet: ${arena.error}` : 'Loading the arena...'}</Text>
            </View>
          ) : (
            panel.kind === 'empty' && groups.inFlight.length === 0 ? (
              <View style={{ paddingVertical: 16, gap: 10 }}>
                <PixelText text={waiting.title} size={2} color={C.neonYellow} fit />
                {waiting.progress ? <Text style={[T.subtle, { color: C.white }]}>{waiting.progress.observed}/{waiting.progress.required} measured minutes</Text> : null}
              </View>
            ) : <LiveClock at={clockAt} />
          )}
          <View style={styles.panelSpace}>
          {panel.kind === 'mine' && focus && owner ? (
            <MyRoundPanel
              round={focus.round}
              position={focus.position}
              positions={panelPositions}
              stage={panel.stage}
              standing={standingOf(focus)}
              me={owner}
              rival={rival}
            />
          ) : panelRound ? (
            <OpenRoundPanel
              previewFace={app.face}
              round={panelRound}
              positions={panelPositions}
              me={owner}
              rival={rival}
              upcoming={panel.kind !== 'open'}
            />
          ) : null}
          </View>
      </View>

      <View style={styles.dock}>
        <Btn small kind="ghost" title={challengeFocus ? 'CHALLENGE A FRIEND' : 'PLAY WITH A FRIEND'} busy={sharing} onPress={() => challengeFocus ? challenge(challengeFocus, nowSec >= Number(challengeFocus.round.account.cutoffAt)) : invite(inviteRound)} style={styles.friend} />
        <View style={styles.betContext}>
          {betNotice ? (
            <Pressable onPress={() => setHowOpen(true)} style={{ flex: 1 }}><Text style={[styles.nextExplanation, { color: C.neonRed }]} numberOfLines={1}>{betNotice}</Text></Pressable>
          ) : pending || showBetReceipt(betting.bet.phase, betting.bet.roundId, betting.bet.roundId !== null && mine.has(betting.bet.roundId)) ? (
            <BetStatusLine visible={(roundId) => mine.has(roundId)} />
          ) : app.away ? (
            <Pressable onPress={app.ackAway} style={{ flex: 1 }} accessibilityRole="button" accessibilityLabel="Dismiss the summary of results while you were away"><Text style={[styles.nextExplanation, { color: C.neonYellow }]} numberOfLines={1}>{awayText(app.away, formatSol)}</Text></Pressable>
          ) : app.challenge ? (
            <Pressable onPress={() => setHowOpen(true)} style={{ flex: 1 }}><Text style={[styles.nextExplanation, { color: C.neonPink }]} numberOfLines={1}>FRIEND CHALLENGE: tap to see round #{String(app.challenge.round)}</Text></Pressable>
          ) : (
            <Pressable onPress={() => setHowOpen(true)} style={{ flex: 1 }}><Text style={styles.nextExplanation} numberOfLines={1}>{open ? `${focus && focus.round.id !== open.id ? 'NEXT ' : ''}CALL #${open.id} - ${openSymbol ? '$' + openSymbol : 'TOKEN'} - ${inOpen ? 'SAVED' : 'matched payout ' + multiplier}` : 'Next round - preparing entry'}</Text></Pressable>
          )}
        </View>
            <View style={styles.amounts}>
              {chips.map(({ amount: a, fits }) => {
                const active = (owner ? betAmount : amount) === a;
                return (
                  <Pressable
                    key={a.toString()}
                    disabled={!!owner && !fits}
                    onPress={() => {
                      void Haptics.selectionAsync().catch(() => undefined);
                      setAmount(a);
                    }}
                    style={[styles.amount, active && styles.amountActive, !!owner && !fits && styles.amountOff]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active, disabled: !!owner && !fits }}
                  >
                    <Text style={[styles.amountText, active && styles.amountTextActive]}>{formatSol(a)}</Text>
                    {owner && !fits ? <Text style={styles.amountCaption}>{maxBetCaption(maxAmount)}</Text> : null}
                  </Pressable>
                );
              })}
              <Text style={styles.amountUnit}>SOL</Text>
            </View>
        {!owner ? (
          // Visitors see the real buttons; a tap opens the top up sheet, which connects the wallet and approves in one go.
          <View style={styles.sides}>
            {[Side.Up, Side.Down].map((side) => (
              <NeonButton
                key={side}
                title={side === Side.Up ? 'UP ▲' : 'DOWN ▼'}
                subtitle={wallet.busy === 'connect' ? 'connecting...' : 'connect & play'}
                kind={side === Side.Up ? 'up' : 'down'}
                big
                badge={multiplier}
                busy={wallet.busy === 'connect'}
                onPress={() => tapAsVisitor(side)}
                style={styles.flex}
              />
            ))}
          </View>
        ) : (intent && intentWaiting && !inOpen) || !myReady || (topUpReason && !pendingHere) ? (
          <View style={styles.sides}>{[Side.Up, Side.Down].map(side => <NeonButton key={side} title={side === Side.Up ? 'UP' : 'DOWN'} kind={side === Side.Up ? 'up' : 'down'} big badge={multiplier} subtitle={!myReady ? 'loading balance' : intentWaiting ? 'placing call...' : canRenew ? 'renew & play' : 'top up & play'} busy={!!intentWaiting && intent?.side === side} disabled={!myReady || !!intentWaiting} onPress={() => setTopUpOpen(true)} style={styles.flex} />)}</View>
        ) : (
          <>
            <View style={styles.sides}>
              <NeonButton
                title="UP ▲"
                subtitle={inOpen ? 'CALL SAVED' : !open ? 'NEXT ROUND SOON' : upFits ? `win up to +${formatSol(winProfit)}` : SIDE_FULL}
                kind="up"
                big
                badge={multiplier}
                disabled={!!inOpen || !!blocked || working || !!pendingHere || !upFits}
                busy={working && betting.bet.side === Side.Up}
                onPress={() => placeBet(Side.Up)}
                style={styles.flex}
              />
              <NeonButton
                title="DOWN ▼"
                subtitle={inOpen ? 'CALL SAVED' : !open ? 'NEXT ROUND SOON' : downFits ? `win up to +${formatSol(winProfit)}` : SIDE_FULL}
                kind="down"
                big
                badge={multiplier}
                disabled={!!inOpen || !!blocked || working || !!pendingHere || !downFits}
                busy={working && betting.bet.side === Side.Down}
                onPress={() => placeBet(Side.Down)}
                style={styles.flex}
              />
            </View>
          </>
        )}
              <View style={styles.blockedRow}>
                <Text numberOfLines={1} style={styles.reason}>{!blocked ? 'Only matched stake plays - excess returned' : !open ? market?.phase === 'paused' ? 'New calls paused' : market?.phase === 'ready' ? 'Next round soon' : 'Checking markets' : blocked}</Text>
                {blockedByFunds ? (
                  <Pressable onPress={() => setTopUpOpen(true)} hitSlop={8}>
                    <Text style={styles.topUpLink}>TOP UP</Text>
                  </Pressable>
                ) : null}
              </View>
      </View>
      </View>

      <EntryTicker cutoffAt={open?.account.cutoffAt ?? null} offsetSec={offsetSec} active={!!owner && !!open && !paused} roundId={open?.id ?? null} />
      <TopUpSheet
        visible={topUpOpen}
        onClose={closeTopUp}
        // Named in the sheet while its round is still open: a round that closed under the sheet is not promised.
        call={intent && !intent.committed && open?.id === intent.roundId ? { side: intent.side, text: intentText(intent, sideName, formatSol) } : null}
      />
      <HowItWorksSheet visible={howOpen} onClose={closeHow} context={
        howOpen ? <View style={{ gap: 8 }}>
          {app.challenge ? <ChallengeCard challenge={app.challenge} open={open ?? null} nowSec={nowSec} onClose={app.clearChallenge} /> : null}
          <Text style={T.subtle}>Only matched stake plays; excess is returned. Current matching can change before entry closes.</Text>
          {open && upMatch !== null && downMatch !== null ? <Text style={T.subtle}>For {formatSol(quotedAmount)} SOL: UP matches {formatSol(upMatch)}, returns {formatSol(quotedAmount - upMatch)}; DOWN matches {formatSol(downMatch)}, returns {formatSol(quotedAmount - downMatch)}.</Text> : null}
          {blocked ? <Text style={T.subtle}>{blocked}</Text> : null}
          {app.pendingNote ? <Text style={T.subtle}>{app.pendingNote}</Text> : null}
          {intentNotice ? <Text style={T.subtle}>{intentNotice}</Text> : null}
          {app.away ? <Text style={T.subtle}>{awayText(app.away, formatSol)}</Text> : null}
          {betting.bet.phase === 'failed' ? <Text style={T.subtle}>{betting.bet.error}</Text> : null}
          {dayText ? <DailyRecord text={`${dayText}${streakText ? ' - ' + streakText : ''}`} won={day.won} finished={day.finished} color={dayColor} /> : null}
          {focus ? <RoundProgress round={focus.round} position={focus.position} nowSec={nowSec} /> : null}
          {myUnresolved.filter(m => m.round.id !== focus?.round.id).map(m => <ExtraRoundLine key={m.round.id.toString()} round={m.round} position={m.position.account} standing={standingOf(m)} late={null} />)}
          <ResultsStrip finals={groups.finals.filter(r => r.account.pool === stageFeed.pool)} mine={mine} />
        </View> : null
      } />
    </View>
  );
}

/** One line about the bet in progress; the YOU'RE IN card takes over once the arena shows the position. */
function BetStatusLine({ visible }: { visible: (roundId: bigint) => boolean }) {
  const { betting, pending } = useApp();
  const b = betting.bet;
  if (b.phase === 'idle') {
    if (!pending) return null;
    return (
      <View style={styles.status}>
        <ActivityIndicator size="small" color={C.neonYellow} />
        <Text style={styles.statusText} numberOfLines={1}>
          Waiting for devnet: {sideName(pending.side)} {formatSol(pending.amount)} SOL in #{pending.roundId.toString()}
        </Text>
      </View>
    );
  }
  const what = b.side !== null && b.amount !== null && b.roundId !== null ? `${sideName(b.side)} ${formatSol(b.amount)} SOL in #${b.roundId}` : '';
  if (b.phase === 'failed') {
    return (
      <View style={styles.status}>
        <Text style={[styles.statusText, { color: C.danger }]} numberOfLines={1}>
          Bet not placed: {b.error}
        </Text>
        <Pressable hitSlop={8} onPress={betting.reset}>
          <Text style={styles.statusAction}>OK</Text>
        </Pressable>
      </View>
    );
  }
  if (b.phase === 'confirmed') {
    if (b.roundId === null || visible(b.roundId)) return null;
    return (
      <View style={styles.status}>
        <Text style={[styles.statusText, { color: C.neonGreen }]} numberOfLines={1}>
          Bet in: {what}
        </Text>
        {b.signature ? <ExtLink label="tx" url={explorer.tx(b.signature)} /> : null}
      </View>
    );
  }
  const label = b.phase === 'signing' ? 'Signing' : b.phase === 'sending' ? 'Sending' : 'Confirming';
  return (
    <View style={styles.status}>
      <ActivityIndicator size="small" color={C.neonYellow} />
      <Text style={styles.statusText} numberOfLines={1}>
        {label}... {what}
      </Text>
    </View>
  );
}

function ResultsStrip({ finals, mine }: { finals: RoundView[]; mine: Map<bigint, Mine> }) {
  if (finals.length === 0) return null;
  return (
    <View style={styles.results}>
      <Text style={styles.resultsLabel}>LAST</Text>
      {finals.slice(0, 6).map((r) => {
        const label = roundResultLabel(r.account);
        const color = label === 'UP' ? C.neonGreen : label === 'DOWN' ? C.neonRed : C.neonYellow;
        const mark = label === 'UP' ? '▲' : label === 'DOWN' ? '▼' : label;
        const isMine = mine.has(r.id);
        return (
          <View key={r.id.toString()} style={[styles.resultChip, { borderColor: color }, isMine && { backgroundColor: `${color}26` }]}>
            <Text style={[label === 'UP' || label === 'DOWN' ? styles.resultArrow : styles.resultWord, { color }]}>{mark}</Text>
            <Text style={styles.resultId}>
              #{r.id.toString()}
              {isMine ? ' you' : ''}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerWrap: { borderBottomWidth: 1, borderBottomColor: C.borderSoft },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 2,
    paddingBottom: 4,
  },
  dayText: { color: C.accentText, fontSize: 11, fontWeight: '900', fontFamily: MONO },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  devnet: { color: C.neonYellow, fontSize: 9, fontWeight: '900', fontFamily: MONO, borderWidth: 1, borderColor: C.neonYellow, paddingHorizontal: 4 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  help: {
    width: 48,
    height: 48,
    borderRadius: 0,
    borderWidth: 2,
    borderColor: C.neonPurple,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: `0 0 8px ${C.neonPurple}88`,
  },
  helpText: { color: C.white, fontSize: 10, fontWeight: '900', fontFamily: MONO },
  nextExplanation: { color: C.accentText, fontSize: 12, lineHeight: 17 },
  walletChip: { borderWidth: 1, borderColor: C.accentSoft, paddingHorizontal: 9, paddingVertical: 6, flexShrink: 1 },
  walletText: { color: C.accentText, fontSize: 12, fontWeight: '900', fontFamily: MONO },
  screen: { flex: 1 },
  roundSelection: { height: 24, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  viewCall: { paddingHorizontal: 8, height: 28, justifyContent: 'center' },
  panelSpace: { flex: 1, minHeight: 0 },
  betContext: { height: 20, justifyContent: 'center' },
  page: { flex: 1, minHeight: 0, paddingHorizontal: 14, paddingTop: 0, paddingBottom: 4, gap: 4 },
  chartSpace: { flexShrink: 0 },
  friend: { minHeight: 48, paddingVertical: 6 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 50 },
  loadingText: { color: C.subtle, fontSize: 12, flexShrink: 1 },
  results: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5 },
  resultsLabel: { color: C.label, fontSize: 10, fontWeight: '900', fontFamily: MONO, marginRight: 2 },
  resultChip: { borderWidth: 1, paddingHorizontal: 5, paddingVertical: 2, alignItems: 'center', minWidth: 42 },
  resultArrow: { fontSize: 13, fontWeight: '900' },
  resultWord: { fontSize: 8, fontWeight: '900', fontFamily: MONO, paddingVertical: 2 },
  resultId: { color: C.subtle, fontSize: 9, fontFamily: MONO },
  dock: {
    flexShrink: 0,
    paddingHorizontal: 14,
    paddingTop: 4,
    paddingBottom: 8,
    gap: 4,
    borderTopWidth: 1,
    borderTopColor: '#3a2c5e',
    backgroundColor: '#140f26',
  },
  amounts: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // A fixed height, so the caption of an off chip never moves the dock.
  amount: { flex: 1, borderWidth: 2, borderColor: '#48405c', paddingVertical: 2, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  amountOff: { opacity: 0.45 },
  amountCaption: { color: C.subtle, fontSize: 8, lineHeight: 10, fontWeight: '800', fontFamily: MONO },
  amountActive: { backgroundColor: C.neonPurple, borderColor: '#d9b8ff' },
  amountText: { color: C.white, fontSize: 15, lineHeight: 17, fontWeight: '900', fontFamily: MONO },
  amountTextActive: { color: C.white },
  amountUnit: { color: C.subtle, fontSize: 10, fontWeight: '900', fontFamily: MONO },
  sides: { flexDirection: 'row', gap: 10 },
  blockedRow: { height: 18, flexDirection: 'row', alignItems: 'center', gap: 10 },
  reason: { color: C.neonYellow, fontSize: 12, fontWeight: '800', flexShrink: 1 },
  topUpLink: { color: C.neonYellow, fontSize: 12, fontWeight: '900', textDecorationLine: 'underline' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusText: { color: C.text, fontSize: 12, fontWeight: '700', flex: 1 },
  statusAction: { color: C.accentText, fontSize: 12, fontWeight: '900' },
});
