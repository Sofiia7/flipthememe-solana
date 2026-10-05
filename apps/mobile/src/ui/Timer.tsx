import { StyleSheet, Text, View } from 'react-native';
import type { TimerView } from '../chain/phase';
import { formatCountdown } from '../lib/format';
import { C, MONO } from '../theme';

function caption(timer: TimerView): string {
  switch (timer.kind) {
    case 'entry':
      return timer.mine ? `Round #${timer.roundId} • you are in` : `Round #${timer.roundId} • pick UP or DOWN`;
    case 'result':
      return timer.stage === 'pause'
        ? `Your round #${timer.roundId} • strike is fixed 30 s after entry closes`
        : timer.stage === 'strike'
          ? `Your round #${timer.roundId} • fixing the strike now`
          : `Your round #${timer.roundId} • measuring the move from the strike`;
    case 'confirming':
      return `Round #${timer.roundId} • the keeper posts the exit price, then pays out`;
    case 'next':
      return `Round #${timer.roundId} opens on the minute`;
    default:
      return 'A new round opens every minute while the keeper runs';
  }
}

/** The one labelled timer of the arena. */
export function TimerBox({ timer }: { timer: TimerView }) {
  const seconds = 'secondsLeft' in timer ? timer.secondsLeft : null;
  const color = timer.kind === 'result' ? C.accentSoft : timer.kind === 'confirming' ? C.up : C.gold;
  return (
    <View style={styles.box}>
      <View style={styles.left}>
        <Text style={[styles.label, { color }]}>{timer.label}</Text>
        <Text style={styles.caption} numberOfLines={2}>
          {caption(timer)}
        </Text>
      </View>
      {seconds !== null ? (
        <Text style={[styles.clock, { borderColor: color }]}>{formatCountdown(seconds)}</Text>
      ) : timer.kind === 'confirming' ? (
        <Text style={[styles.clock, styles.dots, { borderColor: color }]}>...</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  left: { flex: 1, gap: 2 },
  label: { fontSize: 12, fontWeight: '900', letterSpacing: 0.6 },
  caption: { color: C.subtle, fontSize: 10, lineHeight: 14 },
  clock: {
    borderWidth: 2,
    paddingHorizontal: 8,
    paddingVertical: 1,
    color: C.white,
    fontSize: 26,
    fontFamily: MONO,
    fontWeight: '900',
    minWidth: 92,
    textAlign: 'center',
  },
  dots: { color: C.up },
});
