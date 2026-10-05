import { StyleSheet, Text, View } from 'react-native';
import type { TimerView } from '../chain/phase';
import { formatCountdown, type DeltaView } from '../lib/format';
import { C, MONO } from '../theme';

function timerLabel(timer: TimerView): string {
  switch (timer.kind) {
    case 'entry':
      return `#${timer.roundId} ENTRY CLOSES`;
    case 'result':
      return `#${timer.roundId} RESULT IN`;
    case 'confirming':
      return `#${timer.roundId} SETTLING`;
    case 'next':
      return `#${timer.roundId} OPENS IN`;
    default:
      return 'NEXT ROUND SOON';
  }
}

export type ClockSide =
  | { kind: 'delta'; delta: DeltaView; label: string; stale: boolean }
  | { kind: 'note'; text: string; label: string }
  | null;

/** The arena's one big timer, with the live move against the strike next to it. */
export function ArenaClock({ timer, side }: { timer: TimerView; side: ClockSide }) {
  const seconds = 'secondsLeft' in timer ? timer.secondsLeft : null;
  const color = timer.kind === 'result' ? C.neonPurple : timer.kind === 'confirming' ? C.neonGreen : C.neonYellow;
  const urgent = timer.kind === 'entry' && seconds !== null && seconds <= 5;
  const deltaColor =
    side?.kind === 'delta' ? (side.stale ? C.subtle : side.delta.tone === 'up' ? C.neonGreen : side.delta.tone === 'down' ? C.neonRed : C.neonYellow) : C.neonYellow;
  return (
    <View style={styles.row}>
      <View style={styles.block}>
        <Text style={[styles.label, { color }]} numberOfLines={1}>
          {timerLabel(timer)}
        </Text>
        <Text style={[styles.clock, { textShadowColor: urgent ? C.neonRed : color }, urgent && { color: C.neonRed }]}>
          {seconds !== null ? formatCountdown(seconds) : timer.kind === 'confirming' ? '...' : '--:--'}
        </Text>
      </View>
      {side ? (
        <View style={[styles.block, styles.right]}>
          <Text style={[styles.label, { color: C.label }]} numberOfLines={1}>
            {side.label}
          </Text>
          {side.kind === 'delta' ? (
            <Text style={[styles.delta, { color: deltaColor, textShadowColor: deltaColor }]} numberOfLines={1} adjustsFontSizeToFit>
              {side.delta.text} {side.delta.arrow}
            </Text>
          ) : (
            <Text style={[styles.note, { textShadowColor: C.neonYellow }]} numberOfLines={1} adjustsFontSizeToFit>
              {side.text}
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 },
  block: { gap: 0, flexShrink: 1 },
  right: { alignItems: 'flex-end', flex: 1 },
  label: { fontSize: 10, fontWeight: '900', letterSpacing: 0.8, fontFamily: MONO },
  clock: {
    color: C.white,
    fontSize: 40,
    lineHeight: 44,
    fontFamily: MONO,
    fontWeight: '900',
    textShadowRadius: 12,
    textShadowOffset: { width: 0, height: 0 },
  },
  delta: { fontSize: 32, lineHeight: 44, fontFamily: MONO, fontWeight: '900', textShadowRadius: 12, textShadowOffset: { width: 0, height: 0 } },
  note: {
    color: C.neonYellow,
    fontSize: 22,
    lineHeight: 44,
    fontFamily: MONO,
    fontWeight: '900',
    textShadowRadius: 10,
    textShadowOffset: { width: 0, height: 0 },
  },
});
