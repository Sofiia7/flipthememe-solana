import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import {
  RoundStatus,
  Side,
  acceptedStake,
  previewBet,
  winMultiplierBps,
  type PositionAccount,
} from '@flipthememe/client';
import { BET_AMOUNTS, ENTRY_GUARD_SECS, SESSION_RULES, explorer, roundLink } from '../config';
import type { PositionView, RoundView } from '../chain/fetch';
import {
  classifyRounds,
  OVERDUE_SECS,
  fitsDepth,
  matchedPerSide,
  roundResultLabel,
  selectTimer,
  standingNow,
  type RoundGroups,
} from '../chain/phase';
import { chainNowSec, chainToLocalMs } from '../chain/useChainClock';
import { isFeedStale, type PoolFeed } from '../chain/usePoolPrice';
import { peekTokenInfo } from '../chain/useTokenInfo';
import { changeMicroPct, formatMicroPct, formatSol, shortAddress, sol } from '../lib/format';
import { useNow } from '../lib/usePolling';
import { sessionStatusOf, useApp, type SessionStatus } from '../state/AppProvider';
import { C, MONO, T } from '../theme';
import { PriceChart } from '../ui/Chart';
import { Banner, Btn, ExtLink, Pill } from '../ui/common';
import { SideGroup } from '../ui/SideGroup';
import { TimerBox } from '../ui/Timer';
import { TokenHeader } from '../ui/TokenHeader';
import { TopUpSheet } from '../ui/TopUpSheet';

type Mine = { round: RoundView; position: PositionView };

const sideName = (side: number) => (side === Side.Up ? 'UP' : 'DOWN');

function multiplierText(feeWinBps: number): string {
  const bps = winMultiplierBps(feeWinBps);
  return `${bps / 10_000n}.${((bps % 10_000n) / 100n).toString().padStart(2, '0')}`;
}

const SESSION_REASON: Record<Exclude<SessionStatus, 'active'>, string> = {
  none: 'Start a 24 h play session to bet with one tap.',
  expired: 'Your play session expired - renew it to keep betting.',
  revoked: 'Your play session was revoked - start a new one.',
  'used-up': "This session's limit is used up - top up to renew it.",
};

export function ArenaScreen() {
  const app = useApp();
  const { arena, my, myReady, wallet, betting, pending, feed, myFeed, offsetSec } = app;
  const nowMs = useNow(500);
  const nowSec = chainNowSec(offsetSec, nowMs);
  const nowWhole = Math.floor(nowSec);
  const owner = wallet.owner;
  const [amount, setAmount] = useState<bigint>(BET_AMOUNTS[1]);
  const [sheet, setSheet] = useState<string | null | undefined>(undefined);

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

  const timer = selectTimer({ nowSec, open: groups.open, upcoming: groups.upcoming, myUnresolved: myUnresolved.map((m) => m.round) });

  const open = groups.open;
  const shownRound = open ?? groups.upcoming ?? groups.inFlight[groups.inFlight.length - 1] ?? null;
  const shownPositions = shownRound ? (arena.positions.get(shownRound.id) ?? []) : [];
  const ups = shownPositions.filter((p) => p.account.side === Side.Up);
  const downs = shownPositions.filter((p) => p.account.side === Side.Down);

  // The chart's strike line: my earliest live round on the charted pool, else the latest live round there.
  const chartRound = useMemo(() => {
    const samePool = (r: RoundView) => feed.pool !== null && r.account.pool === feed.pool;
    const myLive = myUnresolved.find((m) => samePool(m.round) && nowWhole >= Number(m.round.account.cutoffAt));
    if (myLive) return myLive.round;
    const live = [...groups.inFlight].reverse().find((r) => samePool(r) && r.account.status === RoundStatus.Live);
    return live ?? null;
  }, [myUnresolved, groups.inFlight, feed.pool, nowWhole]);
  const strike = chartRound && chartRound.account.status === RoundStatus.Live ? chartRound.account.strikePrice : null;
  const priceStale = isFeedStale(feed, nowMs);
  const vsStrike = strike && feed.latest ? changeMicroPct(strike, feed.latest.price) : null;

  // Header and chart describe the same pool: the open round's, else the latest started one.
  const tokenRound = open ?? arena.rounds.find((r) => feed.pool !== null && r.account.pool === feed.pool) ?? shownRound ?? arena.rounds[0] ?? null;
  const tokenMint = tokenRound?.account.tokenMint ?? null;
  const symbol = peekTokenInfo(tokenMint)?.symbol;

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
  if (!open) blocked = 'Entry is closed for this minute - the next round opens on the minute.';
  else if (paused) blocked = 'Betting is paused by the operator. Settlement and withdrawals keep working.';
  else if (inOpen || pendingHere) blocked = null;
  else if (secondsLeft <= ENTRY_GUARD_SECS) blocked = 'Entry is closing - wait for the next round.';
  else if (amount > available) {
    blocked = `Balance ${sol(available)} - pick a smaller amount or top up.`;
    blockedByFunds = true;
  } else if (amount > remaining) {
    blocked = `Session limit left: ${sol(remaining)} - top up to renew.`;
    blockedByFunds = true;
  } else if (amount > open.account.maxStake || amount < open.account.minStake) blocked = "Amount out of this round's limits.";
  const upFits = open ? fitsDepth(open.account, Side.Up, amount) : false;
  const downFits = open ? fitsDepth(open.account, Side.Down, amount) : false;

  const placeBet = (side: Side) => {
    if (!open || blocked || working || inOpen || pendingHere) return;
    void betting.place(open.id, side, amount);
  };

  const challenge = (roundId: bigint, side: number) => {
    const token = symbol ? `$${symbol}` : 'a fresh meme coin';
    void Share.share({
      message: `I'm ${sideName(side)} on ${token} in FlipTheMeme round #${roundId} (Solana devnet, test SOL). Take the other side: ${roundLink(roundId)}`,
    }).catch(() => undefined);
  };

  const preview = open ? previewBet(open.account, Side.Up, amount) : null;
  const previewDown = open ? previewBet(open.account, Side.Down, amount) : null;
  const multiplier = multiplierText(open?.account.feeWinBps ?? arena.config?.feeWinBps ?? 200);

  const arenaStaleSec = arena.updatedAt ? Math.floor((nowMs - arena.updatedAt) / 1000) : null;

  return (
    <View style={styles.flex}>
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <Text style={styles.wordmark}>$FLIPTHEMEME</Text>
            <Pill text="DEVNET" color={C.gold} />
          </View>
          <Pressable onPress={() => (owner ? app.setTab('wallet') : void wallet.connect())} style={styles.walletChip}>
            <Text style={styles.walletText} numberOfLines={1}>
              {owner ? `${shortAddress(owner)} • ${myReady ? formatSol(available) : '...'} SOL` : wallet.busy === 'connect' ? 'CONNECTING...' : 'CONNECT'}
            </Text>
          </Pressable>
        </View>

        {arena.error && (arenaStaleSec === null || arenaStaleSec > 10) ? (
          <Banner tone="error" text={`Offline or devnet unreachable: ${arena.error}. Showing the last data${arenaStaleSec !== null ? ` (${arenaStaleSec} s old)` : ''}.`} />
        ) : arenaStaleSec !== null && arenaStaleSec > 10 ? (
          <Banner tone="warn" text={`Data is ${arenaStaleSec} s old - devnet is slow, retrying.`} />
        ) : null}
        {app.deepLinkRound !== null ? (
          <Banner
            tone="info"
            text={
              open && app.deepLinkRound === open.id
                ? `You were challenged to round #${app.deepLinkRound} - entry is open, pick your side.`
                : `Round #${app.deepLinkRound} from your link has closed${open ? `. Round #${open.id} is open now.` : '.'}`
            }
            action={{ label: 'DISMISS', onPress: app.clearDeepLink }}
          />
        ) : null}
        {app.pendingNote ? <Banner tone="warn" text={app.pendingNote} action={{ label: 'OK', onPress: app.clearPendingNote }} /> : null}
        {wallet.result && !wallet.result.ok && wallet.result.action === 'connect' ? <Banner tone="error" text={wallet.result.message} /> : null}

        <TokenHeader mint={tokenMint} pool={tokenRound?.account.pool ?? null} nowMs={nowMs} />

        <View style={styles.chartHead}>
          {strike && chartRound ? (
            <Text style={[styles.chartLabel, { color: vsStrike !== null && vsStrike >= 0n ? C.up : C.down }]}>
              STRIKE #{chartRound.id.toString()} • {formatMicroPct(vsStrike)} now
            </Text>
          ) : (
            <Text style={styles.chartLabel}>LIVE PRICE • LAST 2 MIN</Text>
          )}
          {priceStale && feed.pool ? <Text style={styles.stale}>{feed.error ? 'price offline' : 'price stale'}</Text> : null}
        </View>
        <PriceChart
          points={feed.points}
          nowMs={nowMs}
          strike={strike}
          stale={priceStale}
          windows={
            chartRound
              ? {
                  strike: [chainToLocalMs(chartRound.account.strikeStart, offsetSec), chainToLocalMs(chartRound.account.strikeEnd, offsetSec)],
                  exit: [chainToLocalMs(chartRound.account.exitStart, offsetSec), chainToLocalMs(chartRound.account.exitEnd, offsetSec)],
                }
              : undefined
          }
          cutoffMs={open ? chainToLocalMs(open.account.cutoffAt, offsetSec) : null}
          emptyText={feed.pool ? (feed.error ? `Price source unreachable: ${feed.error}` : 'Reading the live price...') : 'No round yet'}
        />

        {arena.updatedAt === null ? (
          <View style={styles.loading}>
            <ActivityIndicator color={C.accentSoft} />
            <Text style={T.subtle}>{arena.error ? `Cannot reach devnet: ${arena.error}` : 'Loading the arena from devnet...'}</Text>
          </View>
        ) : (
          <TimerBox timer={timer} />
        )}

        {shownRound ? (
          <Text style={T.label}>
            ROUND #{shownRound.id.toString()} • {open ? 'OPEN FOR ENTRY' : shownRound === groups.upcoming ? 'OPENS ON THE MINUTE' : 'ENTRY CLOSED'}
          </Text>
        ) : null}
        <View style={styles.groups}>
          <SideGroup side={Side.Up} total={shownRound?.account.rawUp ?? 0n} positions={ups} me={owner} highlight={inOpen?.position.account.side === Side.Up} />
          <SideGroup side={Side.Down} total={shownRound?.account.rawDown ?? 0n} positions={downs} me={owner} highlight={inOpen?.position.account.side === Side.Down} />
        </View>
        {shownRound ? <MatchedLine round={shownRound} nowSec={nowSec} /> : null}

        <View style={styles.betPanel}>
          <View style={styles.amounts}>
            {BET_AMOUNTS.map((a) => (
              <Pressable key={a.toString()} onPress={() => setAmount(a)} style={[styles.amount, amount === a && styles.amountActive]}>
                <Text style={styles.amountText}>{formatSol(a)} SOL</Text>
              </Pressable>
            ))}
          </View>
          {preview ? (
            <Text style={styles.preview}>
              If matched, a win pays {multiplier}x = {sol(preview.payoutIfMatched)}. You predict the move from the strike (fixed 30 s after
              entry closes) to 60 s later, not from the price now.
            </Text>
          ) : null}
          {preview && previewDown && (preview.acceptedNow < amount || previewDown.acceptedNow < amount) ? (
            <Text style={styles.previewDim}>
              Matched right now: UP {formatSol(preview.acceptedNow)} / DOWN {formatSol(previewDown.acceptedNow)} of {formatSol(amount)}. Unmatched
              stake returns without fee; after entry closes the house tops up the smaller side within its cap.
            </Text>
          ) : null}

          {!owner ? (
            <Btn title="CONNECT WALLET" subtitle="Watching works without one" busy={wallet.busy === 'connect'} onPress={() => void wallet.connect()} />
          ) : !myReady ? (
            <Btn title="LOADING YOUR BALANCE..." disabled onPress={() => undefined} />
          ) : topUpReason && !inOpen && !pendingHere ? (
            <>
              <Text style={styles.reason}>{topUpReason}</Text>
              <Btn title="TOP UP & PLAY" subtitle="One wallet approval" kind="gold" onPress={() => setSheet(topUpReason)} />
            </>
          ) : inOpen ? (
            <View style={styles.inCard}>
              <Text style={styles.inText}>
                You are in round #{inOpen.round.id.toString()}: {sideName(inOpen.position.account.side)} {sol(inOpen.position.account.stake)}
              </Text>
              <Btn
                small
                kind="ghost"
                title="CHALLENGE A FRIEND TO TAKE THE OTHER SIDE"
                onPress={() => challenge(inOpen.round.id, inOpen.position.account.side)}
              />
            </View>
          ) : (
            <>
              <View style={styles.sides}>
                <Btn
                  title="UP"
                  subtitle={upFits ? `${formatSol(amount)} SOL` : 'pool too shallow'}
                  kind="up"
                  disabled={!!blocked || working || !!pendingHere || !upFits}
                  busy={working && betting.bet.side === Side.Up}
                  onPress={() => placeBet(Side.Up)}
                  style={styles.sideBtn}
                />
                <Btn
                  title="DOWN"
                  subtitle={downFits ? `${formatSol(amount)} SOL` : 'pool too shallow'}
                  kind="down"
                  disabled={!!blocked || working || !!pendingHere || !downFits}
                  busy={working && betting.bet.side === Side.Down}
                  onPress={() => placeBet(Side.Down)}
                  style={styles.sideBtn}
                />
              </View>
              {blocked ? <Text style={styles.reason}>{blocked}</Text> : null}
              {blockedByFunds ? <Btn small kind="gold" title="TOP UP & PLAY" onPress={() => setSheet(blocked)} /> : null}
            </>
          )}
          <BetStatus
            onChallenge={challenge}
            arenaHasPosition={(roundId) => mine.has(roundId)}
          />
        </View>

        <InFlight rounds={myUnresolved.filter((m) => nowWhole >= Number(m.round.account.cutoffAt))} nowSec={nowSec} feed={feed} myFeed={myFeed} />

        <ResultsStrip finals={groups.finals} mine={mine} />

        <Text style={styles.footer}>
          Devnet test SOL only. Bets, matching and payouts run in the program on Solana devnet; the price comes from a PumpSwap pool
          on mainnet and is posted by the keeper.
        </Text>
      </ScrollView>
      <TopUpSheet visible={sheet !== undefined} reason={sheet ?? null} onClose={() => setSheet(undefined)} />
    </View>
  );
}

function MatchedLine({ round, nowSec }: { round: RoundView; nowSec: number }) {
  const a = round.account;
  const m = matchedPerSide(a);
  const afterCutoff = nowSec >= Number(a.cutoffAt);
  return (
    <View style={styles.matched}>
      {m > 0n ? (
        <Text style={styles.matchedText}>
          Matched: <Text style={styles.mono}>{formatSol(m)} SOL</Text> per side - surplus returns without fee
        </Text>
      ) : (
        <Text style={styles.matchedText}>
          No match yet - {afterCutoff ? 'unmatched stakes return in full' : 'after entry closes the house tops up the smaller side; unmatched stakes return in full'}
        </Text>
      )}
      {a.houseAmount > 0n ? <Text style={styles.matchedDim}>House filled {sol(a.houseAmount)} on the smaller side.</Text> : null}
      <Text style={styles.matchedDim}>
        Bank cap for this pool: {sol(a.maxBank)} matched in total. Money on a side is not a probability.
      </Text>
    </View>
  );
}

function BetStatus({ onChallenge, arenaHasPosition }: { onChallenge: (roundId: bigint, side: number) => void; arenaHasPosition: (roundId: bigint) => boolean }) {
  const { betting, pending } = useApp();
  const b = betting.bet;
  if (b.phase === 'idle') {
    if (pending) {
      return (
        <View style={styles.status}>
          <ActivityIndicator size="small" color={C.gold} />
          <Text style={styles.statusText}>
            Pending: {sideName(pending.side)} {sol(pending.amount)} in round #{pending.roundId.toString()} - waiting for devnet. Not placed until
            it shows in the arena.
          </Text>
        </View>
      );
    }
    return null;
  }
  const what = b.side !== null && b.amount !== null && b.roundId !== null ? `${sideName(b.side)} ${sol(b.amount)} in round #${b.roundId}` : '';
  if (b.phase === 'failed') {
    return (
      <View style={[styles.status, styles.statusFail]}>
        <Text style={[styles.statusText, { color: C.danger }]}>Bet not placed: {b.error}</Text>
        <Pressable hitSlop={8} onPress={betting.reset}>
          <Text style={styles.statusAction}>OK</Text>
        </Pressable>
      </View>
    );
  }
  if (b.phase === 'confirmed') {
    const visible = b.roundId !== null && arenaHasPosition(b.roundId);
    return (
      <View style={styles.statusCol}>
        <Text style={[styles.statusText, { color: C.up }]}>
          Bet confirmed: {what}.{visible ? '' : ' Adding your face to the arena...'}
        </Text>
        <View style={styles.statusRow}>
          {b.roundId !== null && b.side !== null ? (
            <Pressable hitSlop={8} onPress={() => onChallenge(b.roundId!, b.side!)}>
              <Text style={styles.statusAction}>CHALLENGE A FRIEND</Text>
            </Pressable>
          ) : null}
          {b.signature ? <ExtLink label="Transaction" url={explorer.tx(b.signature)} /> : null}
          <Pressable hitSlop={8} onPress={betting.reset}>
            <Text style={styles.statusAction}>OK</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  const label = b.phase === 'signing' ? 'Signing with the session key' : b.phase === 'sending' ? 'Sending to devnet' : 'Confirming on devnet';
  return (
    <View style={styles.status}>
      <ActivityIndicator size="small" color={C.gold} />
      <Text style={styles.statusText}>
        {label}... {what}
      </Text>
    </View>
  );
}

function InFlight({ rounds, nowSec, feed, myFeed }: { rounds: Mine[]; nowSec: number; feed: PoolFeed; myFeed: PoolFeed }) {
  if (rounds.length === 0) return null;
  return (
    <View style={styles.inflight}>
      <Text style={T.label}>MY ROUNDS IN FLIGHT</Text>
      {rounds.map(({ round, position }) => (
        <InFlightRow key={round.id.toString()} round={round} position={position.account} nowSec={nowSec} feed={feed} myFeed={myFeed} />
      ))}
    </View>
  );
}

function InFlightRow({ round, position, nowSec, feed, myFeed }: { round: RoundView; position: PositionAccount; nowSec: number; feed: PoolFeed; myFeed: PoolFeed }) {
  const a = round.account;
  const priceFeed = feed.pool === a.pool ? feed : myFeed.pool === a.pool ? myFeed : null;
  const price = priceFeed?.latest?.price ?? null;
  const bookFixed = nowSec >= Number(a.strikeStart) || a.status !== RoundStatus.Open;
  const accepted = bookFixed ? acceptedStake(a.rawUp, a.rawDown, position.side, position.stake) : null;
  let line: string;
  let color: string = C.subtle;
  if (nowSec > Number(a.settleDeadline)) {
    line = 'Not settled by the deadline - refund it from History (stake minus 1%).';
    color = C.warn;
  } else if (nowSec > Number(a.exitEnd) + OVERDUE_SECS) {
    line = 'Result overdue - the keeper is late. After the deadline anyone can refund the round.';
    color = C.warn;
  } else if (nowSec >= Number(a.exitEnd)) {
    line = 'Exit window done - confirming the result...';
    color = C.gold;
  } else if (a.status === RoundStatus.Live && a.strikePrice > 0n) {
    if (price === null) {
      line = 'Strike fixed - live price unavailable';
    } else {
      const standing = standingNow(position.side, a.strikePrice, price);
      const pct = formatMicroPct(changeMicroPct(a.strikePrice, price));
      line = standing === 'tie' ? `Tie with the strike now (${pct})` : `${standing === 'winning' ? 'Winning' : 'Losing'} now: ${pct} vs strike`;
      color = standing === 'winning' ? C.up : standing === 'losing' ? C.down : C.gold;
    }
  } else if (nowSec < Number(a.strikeStart)) {
    line = 'Waiting for the strike: fixed 30-40 s after entry closes';
  } else {
    line = 'Fixing the strike from the pool...';
  }
  return (
    <View style={styles.flightRow}>
      <View style={styles.flightHead}>
        <Text style={styles.flightTitle}>
          #{round.id.toString()} {sideName(position.side)} {sol(position.stake)}
        </Text>
        <Text style={styles.flightMeta}>{accepted !== null ? `matched ${formatSol(accepted)}` : 'book still open'}</Text>
      </View>
      <Text style={[styles.flightLine, { color }]}>{line}</Text>
      {a.houseAmount > 0n ? <Text style={styles.flightMeta}>House matched {sol(a.houseAmount)}</Text> : null}
    </View>
  );
}

function ResultsStrip({ finals, mine }: { finals: RoundView[]; mine: Map<bigint, Mine> }) {
  return (
    <View style={styles.results}>
      <Text style={T.label}>LAST RESULTS</Text>
      {finals.length === 0 ? (
        <Text style={T.dim}>No finished rounds with bets in the last few minutes.</Text>
      ) : (
        <View style={styles.resultRow}>
          {finals.slice(0, 6).map((r) => {
            const label = roundResultLabel(r.account);
            const color = label === 'UP' ? C.up : label === 'DOWN' ? C.down : C.gold;
            return (
              <View key={r.id.toString()} style={[styles.resultChip, { borderColor: color }]}>
                <Text style={[styles.resultLabel, { color }]}>{label}</Text>
                <Text style={styles.resultId}>
                  #{r.id.toString()}
                  {mine.has(r.id) ? ' • you' : ''}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { padding: 16, gap: 12, paddingBottom: 28 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  wordmark: { color: C.white, fontFamily: MONO, fontWeight: '900', fontSize: 16 },
  walletChip: { borderWidth: 1, borderColor: C.accentSoft, paddingHorizontal: 10, paddingVertical: 7, maxWidth: '55%' },
  walletText: { color: C.accentText, fontSize: 11, fontWeight: '800', fontFamily: MONO },
  chartHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: -6 },
  chartLabel: { color: C.label, fontSize: 10, fontWeight: '900', fontFamily: MONO },
  stale: { color: C.warn, fontSize: 10, fontWeight: '800' },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  groups: { flexDirection: 'row', gap: 10 },
  matched: { gap: 2 },
  matchedText: { color: C.text, fontSize: 11 },
  matchedDim: { color: C.dim, fontSize: 10 },
  mono: { fontFamily: MONO, fontWeight: '800', color: C.white },
  betPanel: { gap: 9, borderWidth: 1, borderColor: '#7650a6', backgroundColor: C.panelMine, padding: 10 },
  amounts: { flexDirection: 'row', gap: 7 },
  amount: { flex: 1, borderWidth: 1, borderColor: '#48405c', paddingVertical: 10, alignItems: 'center' },
  amountActive: { backgroundColor: C.accent, borderColor: '#b982ff' },
  amountText: { color: C.white, fontSize: 11, fontWeight: '900', fontFamily: MONO },
  preview: { color: C.text, fontSize: 11, lineHeight: 16 },
  previewDim: { color: C.subtle, fontSize: 10, lineHeight: 14 },
  sides: { flexDirection: 'row', gap: 10 },
  sideBtn: { flex: 1, minHeight: 60 },
  reason: { color: C.gold, fontSize: 11, fontWeight: '700' },
  inCard: { gap: 8 },
  inText: { color: C.white, fontSize: 13, fontWeight: '800' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusCol: { gap: 6 },
  statusRow: { flexDirection: 'row', gap: 16, alignItems: 'center' },
  statusFail: { justifyContent: 'space-between' },
  statusText: { color: C.text, fontSize: 11, lineHeight: 15, flex: 1 },
  statusAction: { color: C.accentText, fontSize: 11, fontWeight: '900' },
  inflight: { gap: 6 },
  flightRow: { borderWidth: 1, borderColor: C.borderSoft, backgroundColor: C.panelDeep, padding: 8, gap: 3 },
  flightHead: { flexDirection: 'row', justifyContent: 'space-between' },
  flightTitle: { color: C.white, fontSize: 12, fontWeight: '900', fontFamily: MONO },
  flightMeta: { color: C.subtle, fontSize: 10, fontFamily: MONO },
  flightLine: { fontSize: 11, fontWeight: '800' },
  results: { gap: 6 },
  resultRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  resultChip: { borderWidth: 1, paddingHorizontal: 6, paddingVertical: 4, minWidth: 64 },
  resultLabel: { fontSize: 11, fontWeight: '900' },
  resultId: { color: C.subtle, fontSize: 9, fontFamily: MONO },
  footer: { color: C.dim, fontSize: 10, textAlign: 'center', lineHeight: 14 },
});
