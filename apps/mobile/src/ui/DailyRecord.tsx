import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { C, MONO } from '../theme';

/** Twelve square segments show today's won/finished ratio, without inventing a daily target. */
const CELLS = [[6, 0], [12, 0], [18, 0], [24, 6], [24, 12], [24, 18], [18, 24], [12, 24], [6, 24], [0, 18], [0, 12], [0, 6]];
export const DailyRecord = memo(function DailyRecord({ text, won, finished, color }: { text: string; won: number; finished: number; color: string }) {
  const lit = finished > 0 ? Math.round(12 * won / finished) : 0;
  return <View style={styles.row} accessible accessibilityLabel={`${text}. ${won} wins in ${finished} finished rounds today.`}>
    <Svg width={30} height={30} viewBox="0 0 30 30">
      {CELLS.map(([x, y], i) => <Rect key={i} x={x} y={y} width={5} height={5} fill={i < lit ? C.neonGreen : C.border} />)}
      <Rect x={10} y={10} width={9} height={9} fill={color} />
    </Svg>
    <View style={styles.copy}><Text style={[styles.text, { color }]} numberOfLines={1}>{text}</Text>
      <Text style={styles.detail}>{finished > 0 ? `${won}/${finished} won today` : 'Your day starts with a call'}</Text></View>
  </View>;
});
const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 14, marginBottom: 6 }, copy: { flexShrink: 1 }, text: { fontSize: 11, fontWeight: '900', fontFamily: MONO }, detail: { fontSize: 10, color: C.subtle, fontFamily: MONO } });
