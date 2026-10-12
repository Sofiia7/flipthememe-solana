import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native';
import type { TimerView } from '../chain/phase';
import { formatCountdown, type DeltaView } from '../lib/format';
import { C, FONT_CAP, MONO } from '../theme';
import { PixelText } from './PixelText';

/** The system "remove animations" setting; the timer pulse stays off while it is on. */
export function useReduceMotion(): boolean {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => alive && setReduced(on))
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

/**
 * A heartbeat of the timer on every second of the last five: it jumps up and settles back, in step with the
 * tick sound and the haptic tick. Native driver only; nothing moves with reduced motion on.
 */
function useBeat(active: boolean, second: number | null): Animated.Value {
  const scale = useRef(new Animated.Value(1)).current;
  const reduced = useReduceMotion();
  useEffect(() => {
    if (!active || reduced || second === null) {
      scale.setValue(1);
      return;
    }
    scale.setValue(1.22);
    const settle = Animated.timing(scale, { toValue: 1, duration: 520, easing: Easing.out(Easing.quad), useNativeDriver: true });
    settle.start();
    return () => settle.stop();
  }, [active, reduced, second, scale]);
  return scale;
}

function timerLabel(timer: TimerView): string {
  switch (timer.kind) {
    case 'entry':
      return `#${timer.roundId} ${timer.mine ? 'BET SAVED · ENTRY CLOSES' : 'BET BY'}`;
    case 'result':
      return `#${timer.roundId} RESULT IN`;
    case 'confirming':
      return `#${timer.roundId} RESULT SOON`;
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
  // The same whole second the digits and the tick sound show (the timer itself counts in fractions).
  const beat = useBeat(urgent, seconds !== null ? Math.ceil(seconds) : null);
  const deltaColor =
    side?.kind === 'delta' ? (side.stale ? C.subtle : side.delta.tone === 'up' ? C.neonGreen : side.delta.tone === 'down' ? C.neonRed : C.neonYellow) : C.neonYellow;
  return (
    <View style={styles.row}>
      <View style={styles.block}>
        <Text style={[styles.label, { color }]} numberOfLines={1} maxFontSizeMultiplier={FONT_CAP}>
          {timerLabel(timer)}
        </Text>
        <Animated.View style={[styles.beat, { transform: [{ scale: beat }] }]}>
          <PixelText text={seconds !== null ? formatCountdown(seconds) : timer.kind === 'confirming' ? '...' : '--:--'} size={4} color={urgent ? C.neonRed : C.white} />
        </Animated.View>
      </View>
      {side ? (
        <View style={[styles.block, styles.right]}>
          <Text style={[styles.label, { color: C.label }]} numberOfLines={1} maxFontSizeMultiplier={FONT_CAP}>
            {side.label}
          </Text>
          {side.kind === 'delta' ? (
            <Text
              style={[styles.delta, { color: deltaColor, textShadowColor: deltaColor }]}
              numberOfLines={1}
              adjustsFontSizeToFit
              maxFontSizeMultiplier={FONT_CAP}
            >
              {side.delta.text} {side.delta.arrow}
            </Text>
          ) : (
            <Text style={[styles.note, { textShadowColor: C.neonYellow }]} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={FONT_CAP}>
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
  // The pulse grows from the left edge, so the digits never push into the screen margin.
  beat: { alignSelf: 'flex-start', transformOrigin: 'left center' },
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
