import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { RoundStatus, Side, winMultiplierBps } from '@flipthememe/client';
import { BET_AMOUNTS, ENTRY_GUARD_SECS, SESSION_RULES, explorer, roundLink } from '../config';
import type { PositionView, RoundView } from '../chain/fetch';
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
import { peekTokenInfo } from '../chain/useTokenInfo';
import { faceFromBytes } from '../face/faceModel';
import { deltaView, formatCountdown, formatSol } from '../lib/format';
import { chatterOn, howItWorksSeen, useBoolStore } from '../lib/prefs';
import { useNow } from '../lib/usePolling';
import { shareCard } from '../share/ShareCard';
import { playSound } from '../sound/sound';
import { sessionStatusOf, useApp, type SessionStatus } from '../state/AppProvider';
import { C, MONO } from '../theme';
import { ArenaClock, type ClockSide } from '../ui/ArenaClock';
import { PriceChart } from '../ui/Chart';
import { ChatterLane } from '../ui/ChatterLane';
import { Banner, ExtLink } from '../ui/common';
import { HowItWorksSheet } from '../ui/HowItWorks';
import { NeonButton } from '../ui/NeonButton';
import { PixelText } from '../ui/PixelText';
import { ExtraRoundLine, MyRoundPanel, NextRoundBar, OpenRoundPanel } from '../ui/RoundPanel';
import { TokenHeader } from '../ui/TokenHeader';
import { TopUpSheet } from '../ui/TopUpSheet';

type Mine = { round: RoundView; position: PositionView };
type Standing = 'winning' | 'losing' | 'tie' | null;

const sideName = (side: number) => (side === Side.Up ? 'UP' : 'DOWN');

function multiplierText(feeWinBps: number): string {
  const bps = winMultiplierBps(feeWinBps);
  return `x${bps / 10_000n}.${((bps % 10_000n) / 100n).toString().padStart(2, '0')}`;
}

const SESSION_REASON: Record<Exclude<SessionStatus, 'active'>, string> = {
  none: 'One approval, then every bet is one tap.',
  expired: 'Your play session expired.',
  revoked: 'Your play session was revoked.',
  'used-up': 'Session limit used up.',
};

export function ArenaScreen() {
  const app = useApp();
  const { arena, my, myReady, wallet, betting, pending, feed, myFeed, offsetSec } = app;
  const nowMs = useNow(500);
  const nowSec = chainNowSec(offsetSec, nowMs);
  const nowWhole = Math.floor(nowSec);
  const owner = wallet.owner;
  const [amount, setAmount] = useState<bigint>(BET_AMOUNTS[1]);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const chatter = useBoolStore(chatterOn);
  const chatterShown = chatter.loaded && chatter.value;
  // The chart takes the spare height of taller phones, a little less when the X lane is on.
  const { height: screenHeight } = useWindowDimensions();
  const chartHeight = Math.round(Math.min(220, Math.max(140, screenHeight * (chatterShown ? 0.2 : 0.22))));

  // The rules open by themselves once, on the first launch.
  useEffect(() => {
    let alive = true;
    void chatterOn.load();
    void howItWorksSeen.load().then((seen) => {
      if (alive && !seen) setHowOpen(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  const closeHow = useCallback(() => {
    setHowOpen(false);
    howItWorksSeen.set(true);
  }, []);
  const closeTopUp = useCallback(() => setTopUpOpen(false), []);

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
    return p ? standingNow(m.position.account.side, st.strike, p.price) : null;
  };

  // The chart follows my round, else the latest live round on this pool.
  const chartRound = selectChartRound({ pool: feed.pool, focus: focus?.round ?? null, inFlight: groups.inFlight });
  const chartStrike = chartRound ? strikeState(chartRound.account, nowSec) : null;
  const priceStale = isFeedStale(feed, nowMs);
  // The strike window: bright while the strike is measured, faint once the strike line is drawn.
  const strikeWindow =
    chartRound && chartStrike && chartStrike.kind !== 'none'
      ? {
          range: [chainToLocalMs(chartRound.account.strikeStart, offsetSec), chainToLocalMs(chartRound.account.strikeEnd, offsetSec)] as const,
          label:
            chartStrike.kind === 'pending' ? `STRIKE IN ${formatCountdown(chartStrike.secondsLeft)}` : chartStrike.kind === 'fixing' ? 'FIXING STRIKE' : '',
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
      if (p && delta) clockSide = { kind: 'delta', delta, label: `${id} VS STRIKE`, stale: p.stale };
    } else if (st.kind === 'pending') clockSide = { kind: 'note', text: `STRIKE IN ${formatCountdown(st.secondsLeft)}`, label: id };
    else if (st.kind === 'fixing') clockSide = { kind: 'note', text: 'FIXING STRIKE', label: id };
  }

  // Header and chart describe the same pool: the open round's, else the latest started one.
  const panelRound = panel.kind === 'empty' ? null : panel.round;
  const tokenRound = open ?? arena.rounds.find((r) => feed.pool !== null && r.account.pool === feed.pool) ?? panelRound ?? arena.rounds[0] ?? null;
  const tokenMint = tokenRound?.account.tokenMint ?? null;
  const tokenInfo = peekTokenInfo(tokenMint);
  const symbol = tokenInfo?.symbol ?? null;

  // Betting preconditions.
  const minStake = open?.account.minStake ?? arena.config?.minStake ?? 10_000_000n;
  const status = sessionStatusOf(my.session, nowSec, minStake);
  const available = my.vault?.available ?? 0n;
  const remaining = my.session ? my.session.sessionCap - my.session.spent : 0n;
  const keyGasOk = (my.keyLamports ?? 0n) >= SESSION_RULES.gasPerBet;
  const inOpen = open ? mine.get(open.id) : undefined;
  const pendingHere = pending && open && pending.roundId === open.id ? pending : null;
  const working = betting.bet.phase === 'signing' || betting.bet.phase === 'sending' || betting.bet.phase === 'confirming';
  const secondsLeft = open ? Number(open.account.cutoffAt) - nowSec : 0;
  const paused = arena.config?.paused ?? false;

  let topUpReason: string | null = null;
  if (owner && myReady) {
    if (status !== 'active') topUpReason = SESSION_REASON[status];
    else if (available < minStake) topUpReason = 'Your game balance is empty.';
    else if (!keyGasOk) topUpReason = 'The session key needs devnet SOL for fees.';
  }

  let blocked: string | null = null;
  let blockedByFunds = false;
  if (!open) blocked = 'The next round opens on the minute.';
  else if (paused) blocked = 'Betting is paused by the operator.';
  else if (inOpen || pendingHere) blocked = null;
  else if (secondsLeft <= ENTRY_GUARD_SECS) blocked = 'Entry is closing - catch the next round.';
  else if (amount > available) {
    blocked = `Balance ${formatSol(available)} SOL - pick less or top up.`;
    blockedByFunds = true;
  } else if (amount > remaining) {
    blocked = `Session limit left ${formatSol(remaining)} SOL - top up to renew.`;
    blockedByFunds = true;
  } else if (amount > open.account.maxStake || amount < open.account.minStake) blocked = "Out of this round's limits.";
  const upFits = open ? fitsDepth(open.account, Side.Up, amount) : false;
  const downFits = open ? fitsDepth(open.account, Side.Down, amount) : false;
  const multiplier = multiplierText(open?.account.feeWinBps ?? arena.config?.feeWinBps ?? 200);

  // Countdown ticks in the last 5 seconds of entry.
  const tick = owner && open && !paused ? entryTick(secondsLeft) : null;
  useEffect(() => {
    if (tick !== null) playSound('tick');
  }, [tick, open?.id]);

  const placeBet = (side: Side) => {
    if (!open || blocked || working || inOpen || pendingHere) return;
    void betting.place(open.id, side, amount);
  };

  const challenge = (roundId: bigint, side: number, position?: PositionView) => {
    const token = symbol ? `$${symbol}` : 'a fresh meme coin';
    const text = `I'm ${sideName(side)} on ${token} in FlipTheMeme round #${roundId} (Solana devnet, test SOL). Take the other side: ${roundLink(roundId, { side: sideName(side), token: symbol })}`;
    setSharing(true);
    void shareCard(
      {
        kind: 'challenge',
        face: position ? faceFromBytes(position.account.face) : app.face,
        side,
        roundId,
        symbol,
        imageUrl: tokenInfo?.imageUrl ?? null,
      },
      text,
      'Challenge a friend',
    ).finally(() => setSharing(false));
  };

  const arenaStaleSec = arena.updatedAt ? Math.floor((nowMs - arena.updatedAt) / 1000) : null;
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
          {app.deepLinkRound !== null ? (
            <Banner
              tone="info"
              text={
                open && app.deepLinkRound === open.id
                  ? `You were challenged! Round #${app.deepLinkRound} is open - pick your side.`
                  : `Round #${app.deepLinkRound} has closed${open ? ` - #${open.id} is open now.` : '.'}`
              }
              action={{ label: 'OK', onPress: app.clearDeepLink }}
            />
          ) : null}
          {app.pendingNote ? <Banner tone="warn" text={app.pendingNote} action={{ label: 'OK', onPress: app.clearPendingNote }} /> : null}
          {wallet.result && !wallet.result.ok && wallet.result.action === 'connect' ? <Banner tone="error" text={wallet.result.message} /> : null}

          <TokenHeader mint={tokenMint} pool={tokenRound?.account.pool ?? null} nowMs={nowMs} />

          <PriceChart
            points={feed.points}
            nowMs={nowMs}
            height={chartHeight}
            strike={chartStrike?.kind === 'fixed' ? chartStrike.strike : null}
            strikeLabel={chartRound ? `STRIKE #${chartRound.id}` : undefined}
            strikeWindow={strikeWindow}
            exitWindow={
              chartRound ? [chainToLocalMs(chartRound.account.exitStart, offsetSec), chainToLocalMs(chartRound.account.exitEnd, offsetSec)] : null
            }
            cutoffMs={open ? chainToLocalMs(open.account.cutoffAt, offsetSec) : null}
            stale={priceStale && feed.points.length > 0}
            emptyText={feed.pool ? (feed.error ? `Price source unreachable: ${feed.error}` : 'Reading the live price...') : 'Waiting for the first round'}
          />

          {arena.updatedAt === null ? (
            <View style={styles.loading}>
              <ActivityIndicator color={C.neonPurple} />
              <Text style={styles.loadingText}>{arena.error ? `Cannot reach devnet: ${arena.error}` : 'Loading the arena...'}</Text>
            </View>
          ) : (
            <ArenaClock timer={timer} side={clockSide} />
          )}

          {panel.kind === 'mine' && focus && owner ? (
            <MyRoundPanel
              round={focus.round}
              position={focus.position}
              positions={arena.positions.get(focus.round.id) ?? []}
              stage={panel.stage}
              standing={standingOf(focus)}
              me={owner}
            />
          ) : (
            <OpenRoundPanel
              round={panelRound}
              positions={panelRound ? (arena.positions.get(panelRound.id) ?? []) : []}
              me={owner}
              upcoming={panel.kind !== 'open'}
            />
          )}
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

          <ResultsStrip finals={groups.finals} mine={mine} />

          <Pressable onPress={() => tokenRound && void Linking.openURL(explorer.dexscreener(tokenRound.account.pool)).catch(() => undefined)}>
            <Text style={styles.footer}>Devnet test SOL · price from the PumpSwap pool on mainnet</Text>
          </Pressable>
        </ScrollView>
      </View>

      <View style={styles.dock}>
        {panel.kind === 'mine' && open ? <NextRoundBar roundId={open.id} secondsLeft={secondsLeft} opens={false} /> : null}
        {panel.kind === 'mine' && !open && groups.upcoming ? (
          <NextRoundBar roundId={groups.upcoming.id} secondsLeft={Number(groups.upcoming.account.opensAt) - nowSec} opens />
        ) : null}
        <BetStatusLine openId={open?.id ?? null} visible={(roundId) => mine.has(roundId)} />
        {!owner ? (
          // Visitors see the real buttons; a tap connects the wallet first.
          <View style={styles.sides}>
            {[Side.Up, Side.Down].map((side) => (
              <NeonButton
                key={side}
                title={side === Side.Up ? 'UP ▲' : 'DOWN ▼'}
                subtitle={wallet.busy === 'connect' ? 'connecting...' : 'tap to connect'}
                kind={side === Side.Up ? 'up' : 'down'}
                big
                badge={multiplier}
                busy={wallet.busy === 'connect'}
                onPress={() => void wallet.connect()}
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
            <NeonButton
              title="CHALLENGE A FRIEND"
              kind="purple"
              busy={sharing}
              onPress={() => challenge(inOpen.round.id, inOpen.position.account.side, inOpen.position)}
            />
          </View>
        ) : topUpReason && !pendingHere ? (
          <>
            <Text style={styles.reason}>{topUpReason}</Text>
            <NeonButton title="TOP UP & PLAY" subtitle="one wallet approval" kind="gold" big onPress={() => setTopUpOpen(true)} />
          </>
        ) : (
          <>
            <View style={styles.amounts}>
              {BET_AMOUNTS.map((a) => (
                <Pressable
                  key={a.toString()}
                  onPress={() => setAmount(a)}
                  style={[styles.amount, amount === a && styles.amountActive]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: amount === a }}
                >
                  <Text style={[styles.amountText, amount === a && styles.amountTextActive]}>{formatSol(a)}</Text>
                </Pressable>
              ))}
              <Text style={styles.amountUnit}>SOL</Text>
            </View>
            <View style={styles.sides}>
              <NeonButton
                title="UP ▲"
                subtitle={upFits ? `${formatSol(amount)} SOL` : 'pool too shallow'}
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
                subtitle={downFits ? `${formatSol(amount)} SOL` : 'pool too shallow'}
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
  page: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 16, gap: 10 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 50 },
  loadingText: { color: C.subtle, fontSize: 12, flexShrink: 1 },
  results: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5 },
  resultsLabel: { color: C.label, fontSize: 10, fontWeight: '900', fontFamily: MONO, marginRight: 2 },
  resultChip: { borderWidth: 1, paddingHorizontal: 5, paddingVertical: 2, alignItems: 'center', minWidth: 42 },
  resultArrow: { fontSize: 13, fontWeight: '900' },
  resultWord: { fontSize: 8, fontWeight: '900', fontFamily: MONO, paddingVertical: 2 },
  resultId: { color: C.subtle, fontSize: 9, fontFamily: MONO },
  footer: { color: C.dim, fontSize: 10, textAlign: 'center', textDecorationLine: 'underline' },
  dock: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 10,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: '#3a2c5e',
    backgroundColor: '#140f26',
  },
  amounts: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  amount: { flex: 1, borderWidth: 2, borderColor: '#48405c', paddingVertical: 7, alignItems: 'center' },
  amountActive: { backgroundColor: C.neonPurple, borderColor: '#d9b8ff' },
  amountText: { color: C.white, fontSize: 15, fontWeight: '900', fontFamily: MONO },
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
