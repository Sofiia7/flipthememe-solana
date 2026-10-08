import { StyleSheet, Text, View } from 'react-native';
import type { PositionView, RoundView } from '../chain/fetch';
import { roundProgress } from '../chain/roundProgress';
import { formatSol } from '../lib/format';
import { C, MONO } from '../theme';
import { PixelText } from './PixelText';

/** Detailed phase explanation shown only inside the rules overlay. */
export function RoundProgress({ round, position, nowSec }: { round: RoundView; position: PositionView; nowSec: number }) {
  const progress = roundProgress(round.account, position.account.side, nowSec);
  return (
    <View style={styles.card}>
      <Text style={styles.bet}>YOUR BET #{round.id.toString()} · {progress.side} · {formatSol(position.account.stake)} SOL</Text>
      <PixelText text={progress.title} size={1.8} color={C.neonYellow} fit />
      <Text style={styles.body}>{progress.detail}</Text>
      <Text style={styles.rule}>{progress.rule}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderLeftWidth: 4, borderColor: C.neonYellow, backgroundColor: C.panelDeep, padding: 10, gap: 5 },
  bet: { color: C.white, fontFamily: MONO, fontSize: 12, fontWeight: '700' },
  body: { color: C.text, fontSize: 13, lineHeight: 18 },
  rule: { color: C.accentText, fontSize: 12, lineHeight: 17 },
});
