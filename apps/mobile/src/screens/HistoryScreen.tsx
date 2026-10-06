import type { ReactNode } from 'react';
import { FlatList, Share, StyleSheet, Text, View } from 'react-native';
import type { Address } from '@solana/kit';
import { RoundStatus, Side } from '@flipthememe/client';
import { CLAIM_FALLBACK_SECS, explorer } from '../config';
import { positionResult, roundResultLabel, type PositionResult, type ResultLabel } from '../chain/phase';
import { chainNowSec, chainToLocalMs } from '../chain/useChainClock';
import type { MyPosition } from '../chain/useMyAccount';
import { useTokenInfo, type TokenInfo } from '../chain/useTokenInfo';
import { changeMicroPct, formatDateTime, formatMicroPct, formatSol, roundLink, shortAddress, sol } from '../lib/format';
import { useNow } from '../lib/usePolling';
import { faceFromBytes } from '../face/faceModel';
import { shareCard } from '../share/ShareCard';
import { useApp } from '../state/AppProvider';
import { recordFace, type HistoryEntry, type HistoryRecord } from '../state/history';
import { C, MONO, T } from '../theme';
import { Banner, Btn, ExtLink } from '../ui/common';

const KIND_TEXT = { won: 'WON', lost: 'LOST', refund: 'REFUND', 'full-refund': 'FULL REFUND', pending: 'IN PLAY' } as const;

export function HistoryScreen() {
  const { wallet, my, myReady, history } = useApp();
  const nowMs = useNow(1_000);
  if (!wallet.owner) {
    return (
      <View style={styles.page}>
        <Text style={T.h1}>History</Text>
        <Text style={T.subtle}>Connect a wallet to see every bet you placed: wins, losses and refunds.</Text>
        <Btn title="CONNECT WALLET" busy={wallet.busy === 'connect'} onPress={() => void wallet.connect()} />
      </View>
    );
  }
  return (
    <FlatList
      data={history}
      keyExtractor={(e) => e.key}
      contentContainerStyle={styles.page}
      ListHeaderComponent={
        <View style={styles.headBox}>
          <Text style={T.h1}>History</Text>
          <Text style={T.subtle}>All your positions on devnet, newest first. Payouts go to your game balance.</Text>
          {my.error ? <Banner tone="warn" text={`Could not refresh: ${my.error}`} /> : null}
        </View>
      }
      ListEmptyComponent={
        myReady ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>NO CALLS YET</Text>
            <Text style={[T.subtle, styles.emptyHint]}>No bets yet. Pick UP or DOWN in the arena.</Text>
          </View>
        ) : (
          <Text style={T.subtle}>Loading your positions...</Text>
        )
      }
      extraData={nowMs}
      renderItem={({ item }) => <HistoryItem entry={item} nowMs={nowMs} />}
    />
  );
}

function HistoryItem({ entry, nowMs }: { entry: HistoryEntry<MyPosition>; nowMs: number }) {
  return entry.kind === 'chain' ? <HistoryRow item={entry.position} nowMs={nowMs} /> : <KeptRow record={entry.record} />;
}

/** "+0.12% (start -> exit)" or where the round stopped. */
function moveText(strike: bigint, exit: bigint, final: boolean): string {
  if (strike > 0n && exit > 0n) return `${formatMicroPct(changeMicroPct(strike, exit))} (start -> exit)`;
  if (strike > 0n) return 'start price fixed, exit pending';
  return final ? 'no start price (round not played)' : 'start price pending';
}

function shareResult(r: {
  kind: PositionResult['kind'];
  side: number;
  /** As shown: "$PEPE" or a short mint. */
  symbol: string;
  info: TokenInfo | null;
  roundId: bigint;
  stake: bigint;
  payout: bigint | null;
  face: Uint8Array;
  label: ResultLabel;
}) {
  const side = r.side === Side.Up ? 'UP' : 'DOWN';
  if (r.kind === 'won') {
    // Wins go out as the picture card; the text (with the round link) is the fallback.
    const profit = (r.payout ?? 0n) - r.stake;
    const text = `I called ${side} on ${r.symbol} in FlipTheMeme round #${r.roundId} and won +${sol(profit)} (Solana devnet test SOL). ${roundLink(r.roundId)}`;
    void shareCard(
      { kind: 'win', face: faceFromBytes(r.face), side: r.side, roundId: r.roundId, symbol: r.info?.symbol ?? null, imageUrl: r.info?.imageUrl ?? null, profit },
      text,
      'Share your win',
    );
    return;
  }
  const text = `Round #${r.roundId} on ${r.symbol} went ${r.label} in FlipTheMeme (Solana devnet). ${roundLink(r.roundId)}`;
  void Share.share({ message: text }).catch(() => undefined);
}

/** One position with its round: the same card for rows read from the chain and rows kept on the phone. */
function ResultCard(props: {
  symbol: string;
  roundId: bigint;
  opensAt: number;
  side: number;
  stake: bigint;
  accepted: bigint | null;
  move: string;
  kind: PositionResult['kind'];
  label: ResultLabel;
  final: boolean;
  payout: bigint | null;
  claimed: boolean;
  positionAddress: string;
  roundAddress: string;
  onShare: () => void;
  children?: ReactNode;
}) {
  const { kind, final } = props;
  const color = kind === 'won' ? C.up : kind === 'lost' ? C.down : kind === 'pending' ? C.accentText : C.gold;
  return (
    <View style={styles.card}>
      <View style={styles.rowBetween}>
        <Text style={styles.title}>
          {props.symbol} • #{props.roundId.toString()}
        </Text>
        <Text style={styles.time}>{formatDateTime(props.opensAt)}</Text>
      </View>
      <View style={styles.rowBetween}>
        <Text style={[styles.side, { color: props.side === Side.Up ? C.up : C.down }]}>
          {props.side === Side.Up ? 'UP' : 'DOWN'} {sol(props.stake)}
        </Text>
        <Text style={styles.meta}>{props.accepted !== null ? `matched ${formatSol(props.accepted)}` : 'book open'}</Text>
      </View>
      <Text style={styles.meta}>Move: {props.move}</Text>
      <View style={styles.rowBetween}>
        <Text style={[styles.outcome, { color }]}>
          {KIND_TEXT[kind]}
          {final ? ` • ${props.label}` : ''}
        </Text>
        <Text style={[styles.payout, { color }]}>{props.payout !== null ? `+${sol(props.payout)}` : '-'}</Text>
      </View>
      {final ? (
        <Text style={styles.meta}>{props.claimed ? 'Paid to your game balance' : 'Credited automatically. CLAIM appears here if it takes longer.'}</Text>
      ) : null}
      {kind === 'refund' && props.label === 'EXPIRED' && props.payout !== null && props.payout > props.stake ? (
        <Text style={styles.meta}>Expired: your stake back plus a share of the house stake.</Text>
      ) : null}
      <View style={styles.links}>
        <ExtLink label="Position on Explorer" url={explorer.address(props.positionAddress)} />
        <ExtLink label="Round" url={explorer.address(props.roundAddress)} />
        {final ? (
          <Text style={T.link} onPress={props.onShare}>
            Share
          </Text>
        ) : null}
      </View>
      {props.children}
    </View>
  );
}

function HistoryRow({ item, nowMs }: { item: MyPosition; nowMs: number }) {
  const { offsetSec, betting, my, finalSeenAt } = useApp();
  const nowSec = chainNowSec(offsetSec, nowMs);
  const round = item.round;
  const info = useTokenInfo(round?.account.tokenMint ?? null, round?.account.pool ?? null);
  const p = item.account;
  const side = p.side === Side.Up ? 'UP' : 'DOWN';
  if (!round) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>
          {side} {sol(p.stake)}
        </Text>
        <Text style={T.dim}>Round data unavailable.</Text>
        <ExtLink label="Position on Explorer" url={explorer.address(item.address)} />
      </View>
    );
  }
  const a = round.account;
  const final = a.status === RoundStatus.Final;
  const result = positionResult(p, a, nowSec);
  const label = roundResultLabel(a);
  const symbol = info?.symbol ? `$${info.symbol}` : shortAddress(a.tokenMint);
  const seenFinal = finalSeenAt(round.address);
  const exitEndLocal = chainToLocalMs(a.exitEnd, offsetSec);
  const canClaim = final && !p.claimed && seenFinal !== null && nowMs - Math.max(seenFinal, exitEndLocal) >= CLAIM_FALLBACK_SECS * 1000;
  const expired = !final && nowSec > Number(a.settleDeadline);
  const claimingThis = betting.claiming === item.address;
  const claimError = betting.claimError?.position === item.address ? betting.claimError.message : null;
  return (
    <ResultCard
      symbol={symbol}
      roundId={round.id}
      opensAt={Number(a.opensAt)}
      side={p.side}
      stake={p.stake}
      accepted={result.accepted}
      move={moveText(a.strikePrice, a.exitPrice, final)}
      kind={result.kind}
      label={label}
      final={final}
      payout={result.payout}
      claimed={p.claimed}
      positionAddress={item.address}
      roundAddress={round.address}
      onShare={() =>
        shareResult({ kind: result.kind, side: p.side, symbol, info, roundId: round.id, stake: p.stake, payout: result.payout, face: p.face, label })
      }
    >
      {canClaim ? (
        <Btn
          small
          kind="gold"
          title="CLAIM TO MY BALANCE"
          busy={claimingThis}
          disabled={betting.claiming !== null}
          onPress={() => void betting.claimPosition(item.address, round.id, p.authority, my.keyLamports)}
        />
      ) : null}
      {expired && !p.claimed ? (
        <Btn
          small
          kind="gold"
          title="REFUND EXPIRED ROUND"
          subtitle="Not settled by the deadline"
          busy={claimingThis}
          disabled={betting.claiming !== null}
          onPress={() => void betting.claimPosition(item.address, round.id, p.authority, my.keyLamports, true)}
        />
      ) : null}
      {claimError ? <Text style={styles.error}>{claimError}</Text> : null}
    </ResultCard>
  );
}

/** A finished round kept on the phone after the program closed its position account. */
function KeptRow({ record }: { record: HistoryRecord }) {
  const info = useTokenInfo(record.tokenMint as Address, record.pool as Address);
  const symbol = info?.symbol ? `$${info.symbol}` : shortAddress(record.tokenMint);
  return (
    <ResultCard
      symbol={symbol}
      roundId={record.roundId}
      opensAt={record.opensAt}
      side={record.side}
      stake={record.stake}
      accepted={record.accepted}
      move={moveText(record.strike, record.exit, true)}
      kind={record.kind}
      label={record.label}
      final
      payout={record.payout}
      claimed={record.claimed}
      positionAddress={record.position}
      roundAddress={record.round}
      onShare={() =>
        shareResult({
          kind: record.kind,
          side: record.side,
          symbol,
          info,
          roundId: record.roundId,
          stake: record.stake,
          payout: record.payout,
          face: recordFace(record),
          label: record.label,
        })
      }
    />
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 10, paddingBottom: 28 },
  headBox: { gap: 6, marginBottom: 4 },
  // As loud as the arena's "BE THE FIRST TO CALL IT": the first thing a new player sees here.
  empty: { alignItems: 'center', gap: 8, paddingVertical: 28 },
  emptyTitle: {
    color: C.neonYellow,
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '900',
    textAlign: 'center',
    fontFamily: MONO,
    textShadowColor: C.neonYellow,
    textShadowRadius: 10,
    textShadowOffset: { width: 0, height: 0 },
  },
  emptyHint: { textAlign: 'center' },
  card: { borderWidth: 1, borderColor: C.border, backgroundColor: C.panel, padding: 10, gap: 4 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  title: { color: C.white, fontSize: 13, fontWeight: '900', flexShrink: 1 },
  time: { color: C.subtle, fontSize: 10, fontFamily: MONO },
  side: { fontSize: 13, fontWeight: '900', fontFamily: MONO },
  meta: { color: C.subtle, fontSize: 11, fontFamily: MONO },
  outcome: { fontSize: 12, fontWeight: '900' },
  payout: { fontSize: 13, fontWeight: '900', fontFamily: MONO },
  links: { flexDirection: 'row', gap: 14, flexWrap: 'wrap', marginTop: 2 },
  error: { color: C.danger, fontSize: 11 },
});
