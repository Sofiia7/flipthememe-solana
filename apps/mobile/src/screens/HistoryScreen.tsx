import { FlatList, Share, StyleSheet, Text, View } from 'react-native';
import { RoundStatus, Side } from '@flipthememe/client';
import { CLAIM_FALLBACK_SECS, explorer, roundLink } from '../config';
import { positionResult, roundResultLabel } from '../chain/phase';
import { chainNowSec, chainToLocalMs } from '../chain/useChainClock';
import type { MyPosition } from '../chain/useMyAccount';
import { useTokenInfo } from '../chain/useTokenInfo';
import { changeMicroPct, formatDateTime, formatMicroPct, formatSol, shortAddress, sol } from '../lib/format';
import { useNow } from '../lib/usePolling';
import { useApp } from '../state/AppProvider';
import { C, MONO, T } from '../theme';
import { Banner, Btn, ExtLink } from '../ui/common';

const KIND_TEXT = { won: 'WON', lost: 'LOST', refund: 'REFUND', 'full-refund': 'FULL REFUND', pending: 'IN PLAY' } as const;

export function HistoryScreen() {
  const { wallet, my, myReady } = useApp();
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
      data={my.positions}
      keyExtractor={(p) => p.address}
      contentContainerStyle={styles.page}
      ListHeaderComponent={
        <View style={styles.headBox}>
          <Text style={T.h1}>History</Text>
          <Text style={T.subtle}>All your positions on devnet, newest first. Payouts go to your game balance.</Text>
          {my.error ? <Banner tone="warn" text={`Could not refresh: ${my.error}`} /> : null}
        </View>
      }
      ListEmptyComponent={<Text style={T.subtle}>{myReady ? 'No bets yet. Pick UP or DOWN in the arena.' : 'Loading your positions...'}</Text>}
      extraData={nowMs}
      renderItem={({ item }) => <HistoryRow item={item} nowMs={nowMs} />}
    />
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
  const result = positionResult(p, a, nowSec);
  const label = roundResultLabel(a);
  const symbol = info?.symbol ? `$${info.symbol}` : shortAddress(a.tokenMint);
  const color = result.kind === 'won' ? C.up : result.kind === 'lost' ? C.down : result.kind === 'pending' ? C.accentText : C.gold;
  const move =
    a.strikePrice > 0n && a.exitPrice > 0n
      ? `${formatMicroPct(changeMicroPct(a.strikePrice, a.exitPrice))} (strike -> exit)`
      : a.strikePrice > 0n
        ? 'strike fixed, exit pending'
        : a.status === RoundStatus.Final
          ? 'no strike (round not played)'
          : 'strike pending';
  const seenFinal = finalSeenAt(round.address);
  const exitEndLocal = chainToLocalMs(a.exitEnd, offsetSec);
  const canClaim =
    a.status === RoundStatus.Final &&
    !p.claimed &&
    seenFinal !== null &&
    nowMs - Math.max(seenFinal, exitEndLocal) >= CLAIM_FALLBACK_SECS * 1000;
  const expired = a.status !== RoundStatus.Final && nowSec > Number(a.settleDeadline);
  const claimingThis = betting.claiming === item.address;
  const claimError = betting.claimError?.position === item.address ? betting.claimError.message : null;
  const share = () => {
    const text =
      result.kind === 'won'
        ? `I called ${side} on ${symbol} in FlipTheMeme round #${round.id} and won ${sol(result.payout ?? 0n)} (Solana devnet test SOL). ${roundLink(round.id)}`
        : `Round #${round.id} on ${symbol} went ${label} in FlipTheMeme (Solana devnet). ${roundLink(round.id)}`;
    void Share.share({ message: text }).catch(() => undefined);
  };
  return (
    <View style={styles.card}>
      <View style={styles.rowBetween}>
        <Text style={styles.title}>
          {symbol} • #{round.id.toString()}
        </Text>
        <Text style={styles.time}>{formatDateTime(Number(a.opensAt))}</Text>
      </View>
      <View style={styles.rowBetween}>
        <Text style={[styles.side, { color: p.side === Side.Up ? C.up : C.down }]}>
          {side} {sol(p.stake)}
        </Text>
        <Text style={styles.meta}>{result.accepted !== null ? `matched ${formatSol(result.accepted)}` : 'book open'}</Text>
      </View>
      <Text style={styles.meta}>Move: {move}</Text>
      <View style={styles.rowBetween}>
        <Text style={[styles.outcome, { color }]}>
          {KIND_TEXT[result.kind]}
          {a.status === RoundStatus.Final ? ` • ${label}` : ''}
        </Text>
        <Text style={[styles.payout, { color }]}>{result.payout !== null ? `+${sol(result.payout)}` : '-'}</Text>
      </View>
      {a.status === RoundStatus.Final ? (
        <Text style={styles.meta}>{p.claimed ? 'Paid to your game balance' : 'Not claimed yet - the keeper usually pays within seconds'}</Text>
      ) : null}
      <View style={styles.links}>
        <ExtLink label="Position on Explorer" url={explorer.address(item.address)} />
        <ExtLink label="Round" url={explorer.address(round.address)} />
        {a.status === RoundStatus.Final ? (
          <Text style={T.link} onPress={share}>
            Share
          </Text>
        ) : null}
      </View>
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
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 10, paddingBottom: 28 },
  headBox: { gap: 6, marginBottom: 4 },
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
