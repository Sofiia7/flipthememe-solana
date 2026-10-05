import { memo, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, useWindowDimensions } from 'react-native';
import { C } from '../theme';

const COLORS = [C.neonGreen, C.neonYellow, C.neonPink, C.neonPurple, '#4df3ff', C.white];

/** Deterministic pseudo random numbers, so a burst looks the same on every render. */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A burst of square pixel confetti from `origin` (fraction of the screen), driven by one native animation.
 * Memoized with its interpolations, so a parent re-rendering every frame never rebuilds the native graph.
 */
export const PixelConfetti = memo(function PixelConfetti({
  count = 44,
  durationMs = 1_500,
  origin = { x: 0.5, y: 0.32 },
  seed = 7,
}: {
  count?: number;
  durationMs?: number;
  origin?: { x: number; y: number };
  seed?: number;
}) {
  const { width, height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;

  const pieces = useMemo(() => {
    const rand = rng(seed);
    const steps = [0, 0.2, 0.4, 0.6, 0.8, 1];
    const fade = progress.interpolate({ inputRange: [0, 0.75, 1], outputRange: [1, 1, 0] });
    return Array.from({ length: count }, (_, i) => {
      const angle = -Math.PI / 2 + (rand() - 0.5) * Math.PI * 1.3;
      const speed = 0.55 + rand() * 0.75;
      const vx = Math.cos(angle) * speed * width * 0.75;
      const vy = Math.sin(angle) * speed * height * 0.6;
      const gravity = height * (1.1 + rand() * 0.5);
      const size = [6, 8, 10][i % 3];
      return {
        key: i,
        style: {
          position: 'absolute' as const,
          left: width * origin.x - size / 2,
          top: height * origin.y - size / 2,
          width: size,
          height: size,
          backgroundColor: COLORS[i % COLORS.length],
          opacity: fade,
          transform: [
            { translateX: progress.interpolate({ inputRange: steps, outputRange: steps.map((t) => vx * t) }) },
            { translateY: progress.interpolate({ inputRange: steps, outputRange: steps.map((t) => vy * t + gravity * t * t) }) },
            { rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${Math.round((rand() - 0.5) * 4) * 180}deg`] }) },
          ],
        },
      };
    });
  }, [count, seed, width, height, origin.x, origin.y, progress]);

  useEffect(() => {
    progress.setValue(0);
    const anim = Animated.timing(progress, { toValue: 1, duration: durationMs, easing: Easing.linear, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [progress, durationMs]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {pieces.map((p) => (
        <Animated.View key={p.key} style={p.style} />
      ))}
    </View>
  );
});
