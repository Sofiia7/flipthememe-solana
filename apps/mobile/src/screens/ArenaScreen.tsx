import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import * as Haptics from 'expo-haptics';
import { RoundStatus, Side } from '@flipthememe/client';
import { BET_AMOUNTS, ENTRY_GUARD_SECS, SESSION_RULES, explorer } from '../config';
import type { PositionView, RoundView } from '../chain/fetch';
import { useSkrNames } from '../chain/skr';
import {
  OVERDUE_SECS,
  classifyRounds,
  entryTick,
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
import { isFeedStale, type PoolFeed } from '../chain/usePoolPrice';
import { useRents } from '../chain/rent';
import { peekTokenInfo, useTokenInfo } from '../chain/useTokenInfo';
import { multiplierText } from '../chain/repeatBet';
import { faceFromBytes } from '../face/faceModel';
import { chipStates, effectiveAmount, maxBet, maxBetCaption } from '../lib/betChips';
import { deltaView, formatCountdown, formatSol, roundLink } from '../lib/format';
import { chatterOn, useBoolStore } from '../lib/prefs';
import { useNow } from '../lib/usePolling';
import { shareCard } from '../share/ShareCard';
import { playSound } from '../sound/sound';
import { sessionStatusOf, useApp, type SessionStatus } from '../state/AppProvider';
import { awayText } from '../state/away';
import { streakLabel, streakOf } from '../state/history';
import { C, MONO, T } from '../theme';
import { ArenaClock, type ClockSide } from '../ui/ArenaClock';
import { ChallengeCard } from '../ui/ChallengeCard';
import { PriceChart } from '../ui/Chart';
import { ChatterLane } from '../ui/ChatterLane';
import { Banner, Btn, ExtLink } from '../ui/common';
import { HowItWorksSheet } from '../ui/HowItWorks';
import { NeonButton } from '../ui/NeonButton';
import { PixelText } from '../ui/PixelText';
import { ExtraRoundLine, MyRoundPanel, NextRoundBar, OpenRoundPanel } from '../ui/RoundPanel';
import { TokenHeader } from '../ui/TokenHeader';
import { TopUpSheet } from '../ui/TopUpSheet';
import { canRenewSession, minStakeOf } from '../wallet/playState';
import { RENT_FALLBACK, maxWinProfit } from '../wallet/topUpPlan';

type Mine = { round: RoundView; position: PositionView };
type Standing = 'winning' | 'losing' | 'tie' | null;

const sideName = (side: number) => (side === Side.Up ? 'UP' : 'DOWN');

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
  const nowMs = useNow(500);
  const nowSec = chainNowSec(offsetSec, nowMs);
  const nowWhole = Math.floor(nowSec);
  const owner = wallet.owner;
  const myName = useSkrNames(owner ? [owner] : []).get(owner ?? '') ?? null;
  // The friend whose challenge link opened the app: their face in the round panels says RIVAL.
  const rival = app.challenge?.by ?? null;
  const [amount, setAmount] = useState<bigint>(BET_AMOUNTS[1]);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const chatter = useBoolStore(chatterOn);
  const chatterShown = chatter.loaded && chatter.value;
  // The chart takes the spare height of taller phones, a little less when the X lane is on. On a Seeker
  // that leaves my round in play and its CHALLENGE A FRIEND above the dock, even under a one-line note.
  const { height: screenHeight } = useWindowDimensions();
  const chartHeight = Math.round(Math.min(220, Math.max(140, screenHeight * (chatterShown ? 0.175 : 0.2))));

  // The rules stay behind the "?" in the header: nothing opens by itself on the first launch.
  useEffect(() => {
    void chatterOn.load();
  }, []);
  const closeHow = useCallback(() => setHowOpen(false), []);
  const closeTopUp = useCallback(() => setTopUpOpen(false), []);

  const streak = useMemo(() => streakOf(app.history), [app.history]);
  const streakText = streak.kind === 'win' ? streakLabel(streak) : null;

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
  const myRounds = myUnresolved.map((m) => m.round);

  const open = groups.open;
  const timer = selectTimer({ nowSec, open, upcoming: groups.upcoming, myUnresolved: myRounds });
  const panel = selectPanel({ nowSec, open, upcoming: groups.upcoming, myUnresolved: myRounds });
  const focus = panel.kind === 'mine' ? (mine.get(panel.round.id) ?? null) : null;

  // Prices: the charted pool, or my round's pool when the token rotated since I bet.
  const feedFor = (pool: string): PoolFeed | null => (feed.pool === pool ? feed : myFeed.pool === pool ? myFeed : null);
  const priceOf = (pool: string) => {
    const f = feedFor(pool);
    return f?.latest ? { price: f.latest.price, stale: isFeedStale(f, nowMs) } : null;
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
  const stagePool = focus?.round.account.pool ?? feed.pool;
  const stageFeed: PoolFeed = stagePool !== feed.pool && myFeed.pool === stagePool ? myFeed : feed;
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
            chartStrike.kind === 'pending' ? `START PRICE IN ${formatCountdown(chartStrike.secondsLeft)}` : chartStrike.kind === 'fixing' ? 'LOCKING START' : '',
          strong: chartStrike.kind === 'pending' || chartStrike.kind === 'fixing',
        }
      : null;

  // The big readout next to the timer: the live move of my round (or the charted one) against its strike.
  // Nothing once the exit window is over: the price after it no longer decides anything.
  const deltaRound = focus?.round ?? chartRound;
  let clockSide: ClockSide = null;
  if (deltaRound && nowSec < Number(deltaRound.account.exitEnd)) {
    const st = strikeState(deltaRound.account, nowSec);
    const id = `#${deltaRound.id}`;
    if (st.kind === 'fixed') {
      const p = priceOf(deltaRound.account.pool);
      const delta = p ? deltaView(st.strike, p.price) : null;
      if (p && delta) clockSide = { kind: 'delta', delta, label: `${id} VS START PRICE`, stale: p.stale };
    } else if (st.kind === 'pending') clockSide = { kind: 'note', text: `START PRICE IN ${formatCountdown(st.secondsLeft)}`, label: id };
    else if (st.kind === 'fixing') clockSide = { kind: 'note', text: 'LOCKING START', label: id };
  }

  // Header and chart describe the same pool: my round's while it plays, else the open round's, else the latest started one.
  const panelRound = panel.kind === 'empty' ? null : panel.round;
  const tokenRound =
    (focus && focus.round.account.pool === stageFeed.pool ? focus.round : null) ??
    (open && open.account.pool === stageFeed.pool ? open : null) ??
    arena.rounds.find((r) => stageFeed.pool !== null && r.account.pool === stageFeed.pool) ??
    open ??
    panelRound ??
    arena.rounds[0] ??
    null;
  const tokenMint = tokenRound?.account.tokenMint ?? null;
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
  const maxAmount = maxBet({ available, positionRent, sessionLeft: my.session ? remaining : null });
  const chips = chipStates(BET_AMOUNTS, maxAmount);
  const betAmount = effectiveAmount(amount, BET_AMOUNTS, maxAmount);
  const inOpen = open ? mine.get(open.id) : undefined;
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
  if (!open) blocked = 'The next round opens on the minute.';
  else if (arenaStaleSec !== null && arenaStaleSec > 10) blocked = 'Reconnecting to devnet - bets wait for fresh data.';
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

  // Countdown ticks in the last 5 seconds of entry.
  const tick = owner && open && !paused ? entryTick(secondsLeft) : null;
  useEffect(() => {
    if (tick === null) return;
    playSound('tick');
    void Haptics.selectionAsync().catch(() => undefined);
  }, [tick, open?.id]);

  const placeBet = (side: Side) => {
    if (!open || blocked || working || inOpen || pendingHere) return;
    void betting.place(open.id, side, betAmount);
  };

  // A challenge for my round, open or already live: the friend can rarely make it in time, so the link
  // invites them to any later round and carries my wallet and name for their RIVAL tag. It names the
  // round's own coin, which may differ from the stage's (the open round's often does).
  const challenge = (m: Mine, live: boolean) => {
    if (!owner) return;
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
  const challengeFocus = panel.kind === 'mine' && focus && owner && panel.stage !== 'settling' && !inOpen ? focus : null;
  // Outside a bet the same place invites a friend to play. The link names no side, only me (wallet and
  // name for their RIVAL tag) and the round open now, so their app shows where to meet.
  const inviteRound = challengeFocus || inOpen ? null : (open ?? groups.upcoming);
  const invite = (round: RoundView) => {
    const link = roundLink(round.id, { side: null, token: null, by: owner, name: myName });
    const text = `Play FlipTheMeme with me: call UP or DOWN on a busy Solana meme coin. A 1-minute move, result in about 2 minutes, a new round every minute (devnet, test SOL). Join me: ${link}`;
    setSharing(true);
    void shareCard({ kind: 'invite', face: app.face, roundId: round.id, name: myName }, text, 'Play with a friend').finally(() => setSharing(false));
  };

  const lateRounds = myUnresolved.filter((m) => nowSec > Number(m.round.account.exitEnd) + OVERDUE_SECS);
  const extraRounds = panel.kind === 'mine' ? panel.others.map((r) => mine.get(r.id)).filter((m): m is Mine => !!m) : [];

  return (
    <View style={styles.flex}>
      <View style={styles.header}>
        <View style={styles.brand}>
          <PixelText text="$FLIPTHEMEME" size={1.75} color={C.white} shadow={C.accent} />
          <Text style={styles.devnet}>DEVNET</Text>
        </View>
        <View style={styles.headerRight}>
          <Pressable onPress={() => setHowOpen(true)} hitSlop={8} style={styles.help} accessibilityRole="button" accessibilityLabel="How it works">
            <Text style={styles.helpText}>?</Text>
          </Pressable>
          <Pressable onPress={() => (owner ? app.setTab('wallet') : void wallet.connect())} style={styles.walletChip} accessibilityRole="button">
            <Text style={styles.walletText} numberOfLines={1}>
              {owner ? (myReady ? `${formatSol(available)} SOL` : '...') : wallet.busy === 'connect' ? 'CONNECTING' : 'CONNECT'}
            </Text>
          </Pressable>
        </View>
      </View>

      {chatterShown ? <ChatterLane symbol={symbol} mint={tokenMint} /> : null}

      <View style={styles.stage}>
        <ScrollView contentContainerStyle={styles.page}>
          {arena.error && (arenaStaleSec === null || arenaStaleSec > 10) ? (
            <Banner tone="error" text={`Devnet unreachable (${arena.error}).${arenaStaleSec !== null ? ` Data ${arenaStaleSec} s old.` : ''}`} />
          ) : arenaStaleSec !== null && arenaStaleSec > 10 ? (
            <Banner tone="warn" text={`Data ${arenaStaleSec} s old - devnet is slow, retrying.`} />
          ) : null}
          {app.challenge ? <ChallengeCard challenge={app.challenge} open={open} nowSec={nowSec} onClose={app.clearChallenge} /> : null}
          {app.pendingNote ? <Banner tone="warn" text={app.pendingNote} action={{ label: 'OK', onPress: app.clearPendingNote }} /> : null}
          {app.away ? <Banner tone="info" text={awayText(app.away, formatSol)} action={{ label: 'OK', onPress: app.ackAway }} /> : null}
          {wallet.result && !wallet.result.ok && wallet.result.action === 'connect' ? <Banner tone="error" text={wallet.result.message} /> : null}

          <TokenHeader mint={tokenMint} pool={tokenRound?.account.pool ?? null} nowMs={nowMs} />

          <PriceChart
            points={stageFeed.points}
            nowMs={nowMs}
            height={chartHeight}
            strike={chartStrike?.kind === 'fixed' ? chartStrike.strike : null}
            strikeLabel={chartRound ? `START #${chartRound.id}` : undefined}
            pairLabel={`${symbol ? symbol.toUpperCase() : 'TOKEN'} / SOL`}
            strikeWindow={strikeWindow}
            exitWindow={
              chartRound ? [chainToLocalMs(chartRound.account.exitStart, offsetSec), chainToLocalMs(chartRound.account.exitEnd, offsetSec)] : null
            }
            cutoffMs={open && open.account.pool === stageFeed.pool ? chainToLocalMs(open.account.cutoffAt, offsetSec) : null}
            stale={priceStale && stageFeed.points.length > 0}
            emptyText={
              stageFeed.pool ? (stageFeed.error ? `Price source unreachable: ${stageFeed.error}` : 'Reading the live price...') : 'Waiting for the first round'
            }
          />

          {arena.updatedAt === null ? (
            <View style={styles.loading}>
              <ActivityIndicator color={C.neonPurple} />
              <Text style={styles.loadingText}>{arena.error ? `Cannot reach devnet: ${arena.error}` : 'Loading the arena...'}</Text>
            </View>
          ) : (
            <ArenaClock timer={timer} side={clockSide} />
          )}
          {streakText || (myUnresolved.length === 0 && !pendingHere) ? (
            <View style={styles.hintRow}>
              {streakText ? <Text style={styles.streakPill}>{streakText}</Text> : null}
              {myUnresolved.length === 0 && !pendingHere ? <Text style={[T.subtle, styles.hintText]}>Call the next minute. Result in about 2 minutes.</Text> : null}
            </View>
          ) : null}

          {panel.kind === 'mine' && focus && owner ? (
            <MyRoundPanel
              round={focus.round}
              position={focus.position}
              positions={arena.positions.get(focus.round.id) ?? []}
              stage={panel.stage}
              standing={standingOf(focus)}
              me={owner}
              rival={rival}
            />
          ) : (
            <OpenRoundPanel
              round={panelRound}
              positions={panelRound ? (arena.positions.get(panelRound.id) ?? []) : []}
              me={owner}
              rival={rival}
              upcoming={panel.kind !== 'open'}
            />
          )}
          {challengeFocus ? (
            <Btn small kind="friend" title="CHALLENGE A FRIEND" busy={sharing} onPress={() => challenge(challengeFocus, true)} style={styles.friend} />
          ) : inviteRound ? (
            <Btn small kind="friend" title="PLAY WITH A FRIEND" busy={sharing} onPress={() => invite(inviteRound)} style={styles.friend} />
          ) : null}
          {extraRounds.map((m) => (
            <ExtraRoundLine key={m.round.id.toString()} round={m.round} position={m.position.account} standing={standingOf(m)} late={null} />
          ))}
          {lateRounds.map((m) => (
            <ExtraRoundLine
              key={m.round.id.toString()}
              round={m.round}
              position={m.position.account}
              standing={null}
              late={nowSec > Number(m.round.account.settleDeadline) ? 'REFUND IN HISTORY' : 'RESULT LATE'}
            />
          ))}

          <ResultsStrip finals={groups.finals.filter((r) => stageFeed.pool !== null && r.account.pool === stageFeed.pool)} mine={mine} />

        </ScrollView>
      </View>

      <View style={styles.dock}>
        {panel.kind === 'mine' && open ? (
          <NextRoundBar roundId={open.id} secondsLeft={secondsLeft} opens={false} token={open.account.tokenMint !== tokenMint ? openSymbol : null} />
        ) : null}
        {panel.kind === 'mine' && !open && groups.upcoming ? (
          <NextRoundBar roundId={groups.upcoming.id} secondsLeft={Number(groups.upcoming.account.opensAt) - nowSec} opens />
        ) : null}
        <BetStatusLine openId={open?.id ?? null} visible={(roundId) => mine.has(roundId)} />
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
                onPress={() => setTopUpOpen(true)}
                style={styles.flex}
              />
            ))}
          </View>
        ) : !myReady ? (
          <NeonButton title="LOADING YOUR BALANCE" kind="purple" big disabled onPress={() => undefined} />
        ) : inOpen ? (
          <View style={[styles.inCard, { borderColor: inOpen.position.account.side === Side.Up ? C.neonGreen : C.neonRed }]}>
            <Text style={styles.inText}>
              YOU'RE IN #{inOpen.round.id.toString()}{' '}
              <Text style={{ color: inOpen.position.account.side === Side.Up ? C.neonGreen : C.neonRed }}>
                {inOpen.position.account.side === Side.Up ? 'UP ▲' : 'DOWN ▼'}
              </Text>{' '}
              {formatSol(inOpen.position.account.stake)} SOL
            </Text>
            <NeonButton title="CHALLENGE A FRIEND" kind="purple" busy={sharing} onPress={() => challenge(inOpen, false)} />
          </View>
        ) : topUpReason && !pendingHere ? (
          <>
            <Text style={styles.reason}>{topUpReason}</Text>
            <NeonButton
              title={canRenew ? 'PLAY AGAIN' : 'TOP UP & PLAY'}
              subtitle={canRenew ? `${formatSol(available)} SOL ready · no deposit` : 'one wallet approval'}
              kind="gold"
              big
              onPress={() => setTopUpOpen(true)}
            />
          </>
        ) : (
          <>
            <View style={styles.amounts}>
              {chips.map(({ amount: a, fits }) => {
                const active = betAmount === a;
                return (
                  <Pressable
                    key={a.toString()}
                    disabled={!fits}
                    onPress={() => {
                      void Haptics.selectionAsync().catch(() => undefined);
                      setAmount(a);
                    }}
                    style={[styles.amount, active && styles.amountActive, !fits && styles.amountOff]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active, disabled: !fits }}
                  >
                    <Text style={[styles.amountText, active && styles.amountTextActive]}>{formatSol(a)}</Text>
                    {!fits ? <Text style={styles.amountCaption}>{maxBetCaption(maxAmount)}</Text> : null}
                  </Pressable>
                );
              })}
              <Text style={styles.amountUnit}>SOL</Text>
            </View>
            <View style={styles.sides}>
              <NeonButton
                title="UP ▲"
                subtitle={upFits ? `win up to +${formatSol(winProfit)}` : 'pool too shallow'}
                kind="up"
                big
                badge={multiplier}
                disabled={!!blocked || working || !!pendingHere || !upFits}
                busy={working && betting.bet.side === Side.Up}
                onPress={() => placeBet(Side.Up)}
                style={styles.flex}
              />
              <NeonButton
                title="DOWN ▼"
                subtitle={downFits ? `win up to +${formatSol(winProfit)}` : 'pool too shallow'}
                kind="down"
                big
                badge={multiplier}
                disabled={!!blocked || working || !!pendingHere || !downFits}
                busy={working && betting.bet.side === Side.Down}
                onPress={() => placeBet(Side.Down)}
                style={styles.flex}
              />
            </View>
            {blocked ? (
              <View style={styles.blockedRow}>
                <Text style={styles.reason}>{blocked}</Text>
                {blockedByFunds ? (
                  <Pressable onPress={() => setTopUpOpen(true)} hitSlop={8}>
                    <Text style={styles.topUpLink}>TOP UP</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </>
        )}
      </View>

      <TopUpSheet visible={topUpOpen} onClose={closeTopUp} />
      <HowItWorksSheet visible={howOpen} onClose={closeHow} />
    </View>
  );
}

/** One line about the bet in progress; the YOU'RE IN card takes over once the arena shows the position. */
function BetStatusLine({ openId, visible }: { openId: bigint | null; visible: (roundId: bigint) => boolean }) {
  const { betting, pending } = useApp();
  const b = betting.bet;
  if (b.phase === 'idle') {
    if (!pending) return null;
    return (
      <View style={styles.status}>
        <ActivityIndicator size="small" color={C.neonYellow} />
        <Text style={styles.statusText} numberOfLines={2}>
          Waiting for devnet: {sideName(pending.side)} {formatSol(pending.amount)} SOL in #{pending.roundId.toString()}
        </Text>
      </View>
    );
  }
  const what = b.side !== null && b.amount !== null && b.roundId !== null ? `${sideName(b.side)} ${formatSol(b.amount)} SOL in #${b.roundId}` : '';
  if (b.phase === 'failed') {
    return (
      <View style={styles.status}>
        <Text style={[styles.statusText, { color: C.danger }]} numberOfLines={3}>
          Bet not placed: {b.error}
        </Text>
        <Pressable hitSlop={8} onPress={betting.reset}>
          <Text style={styles.statusAction}>OK</Text>
        </Pressable>
      </View>
    );
  }
  if (b.phase === 'confirmed') {
    if (b.roundId === null || b.roundId !== openId || visible(b.roundId)) return null;
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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.borderSoft,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  devnet: { color: C.neonYellow, fontSize: 9, fontWeight: '900', fontFamily: MONO, borderWidth: 1, borderColor: C.neonYellow, paddingHorizontal: 4 },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hintText: { flexShrink: 1 },
  streakPill: { color: '#2a1a00', backgroundColor: C.neonYellow, fontFamily: MONO, fontWeight: '900', fontSize: 12, paddingHorizontal: 8, paddingVertical: 3 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  help: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    borderColor: C.neonPurple,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: `0 0 8px ${C.neonPurple}88`,
  },
  helpText: { color: C.white, fontSize: 15, fontWeight: '900' },
  walletChip: { borderWidth: 1, borderColor: C.accentSoft, paddingHorizontal: 9, paddingVertical: 6, flexShrink: 1 },
  walletText: { color: C.accentText, fontSize: 12, fontWeight: '900', fontFamily: MONO },
  stage: { flex: 1, overflow: 'hidden' },
  page: { paddingHorizontal: 14, paddingTop: 6, paddingBottom: 16, gap: 8 },
  friend: { minHeight: 32, paddingVertical: 6 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 50 },
  loadingText: { color: C.subtle, fontSize: 12, flexShrink: 1 },
  results: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5 },
  resultsLabel: { color: C.label, fontSize: 10, fontWeight: '900', fontFamily: MONO, marginRight: 2 },
  resultChip: { borderWidth: 1, paddingHorizontal: 5, paddingVertical: 2, alignItems: 'center', minWidth: 42 },
  resultArrow: { fontSize: 13, fontWeight: '900' },
  resultWord: { fontSize: 8, fontWeight: '900', fontFamily: MONO, paddingVertical: 2 },
  resultId: { color: C.subtle, fontSize: 9, fontFamily: MONO },
  dock: {
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 8,
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: '#3a2c5e',
    backgroundColor: '#140f26',
  },
  amounts: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // A fixed height, so the caption of an off chip never moves the dock.
  amount: { flex: 1, borderWidth: 2, borderColor: '#48405c', paddingVertical: 2, minHeight: 35, alignItems: 'center', justifyContent: 'center' },
  amountOff: { opacity: 0.45 },
  amountCaption: { color: C.subtle, fontSize: 8, lineHeight: 10, fontWeight: '800', fontFamily: MONO },
  amountActive: { backgroundColor: C.neonPurple, borderColor: '#d9b8ff' },
  amountText: { color: C.white, fontSize: 15, lineHeight: 17, fontWeight: '900', fontFamily: MONO },
  amountTextActive: { color: C.white },
  amountUnit: { color: C.subtle, fontSize: 10, fontWeight: '900', fontFamily: MONO },
  sides: { flexDirection: 'row', gap: 10 },
  blockedRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  reason: { color: C.neonYellow, fontSize: 12, fontWeight: '800', flexShrink: 1 },
  topUpLink: { color: C.neonYellow, fontSize: 12, fontWeight: '900', textDecorationLine: 'underline' },
  inCard: { borderWidth: 2, padding: 8, gap: 8, backgroundColor: C.panelDeep },
  inText: { color: C.white, fontSize: 15, fontWeight: '900', fontFamily: MONO, textAlign: 'center' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusText: { color: C.text, fontSize: 12, fontWeight: '700', flex: 1 },
  statusAction: { color: C.accentText, fontSize: 12, fontWeight: '900' },
});
