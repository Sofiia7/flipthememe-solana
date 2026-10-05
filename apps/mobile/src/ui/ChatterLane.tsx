// Real tweets about the arena token slide into a lane under the app header like notifications:
// green for moon talk, red for scam talk. Tap one to open it on X. The lane keeps one height, so
// the token name, the chart and the buttons below it never move or hide behind a tweet.
import { useEffect, useRef, useState } from 'react';
import { Animated, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { ago, useChatter, type ChatterItem } from '../chain/useChatter';
import { C, MONO } from '../theme';

export const CHATTER_LANE_HEIGHT = 50;
/** Each tweet is on screen at least this long before the next one pushes it out. */
const MIN_SHOW_MS = 4_500;
/** Then it dims, and stays until the next one comes. */
const BRIGHT_MS = 6_000;

const MOOD = {
  moon: { border: '#35df6c', bg: 'rgba(16, 48, 28, 0.96)', tag: 'MOON' },
  scam: { border: '#fb607c', bg: 'rgba(58, 14, 26, 0.96)', tag: 'SCAM' },
  neutral: { border: '#a459ff', bg: 'rgba(32, 24, 58, 0.96)', tag: 'X' },
} as const;

// Animation value of a bubble: 0 above the lane, 1 in place, 2 in place dimmed, 3 gone below.
const STEPS = [0, 1, 2, 3];

type Shown = { item: ChatterItem; key: number; anim: Animated.Value };

export function ChatterLane({ symbol, mint }: { symbol: string | null; mint: string | null }) {
  const { next, drop } = useChatter(symbol, mint, true);
  const [shown, setShown] = useState<Shown[]>([]);
  const current = useRef<Shown | null>(null);
  const lastAt = useRef(0);
  const counter = useRef(0);
  const pulse = useRef(new Animated.Value(0.35)).current;

  // A new arena token: the old token's tweets leave with it.
  useEffect(() => {
    current.current = null;
    lastAt.current = 0;
    setShown([]);
  }, [symbol, mint]);

  useEffect(() => {
    if (!next) return;
    const item = next;
    const wait = Math.max(400, lastAt.current + MIN_SHOW_MS - Date.now());
    const timer = setTimeout(() => {
      drop();
      lastAt.current = Date.now();
      const entry: Shown = { item, key: counter.current++, anim: new Animated.Value(0) };
      const prev = current.current;
      current.current = entry;
      setShown(prev ? [entry, prev] : [entry]);
      if (prev) {
        prev.anim.stopAnimation();
        Animated.timing(prev.anim, { toValue: 3, duration: 280, useNativeDriver: true }).start(() =>
          setShown((s) => s.filter((x) => x.key !== prev.key)),
        );
      }
      Animated.sequence([
        Animated.spring(entry.anim, { toValue: 1, useNativeDriver: true, friction: 7 }),
        Animated.delay(BRIGHT_MS),
        Animated.timing(entry.anim, { toValue: 2, duration: 500, useNativeDriver: true }),
      ]).start();
    }, wait);
    return () => clearTimeout(timer);
    // drop is recreated each render; the item identity is what matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next?.id]);

  // The waiting dot breathes while no tweet is on screen.
  const idle = shown.length === 0;
  useEffect(() => {
    if (!idle) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.35, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [idle, pulse]);

  const now = Date.now();
  return (
    <View style={styles.lane}>
      {idle ? (
        <View style={styles.idle}>
          <Animated.View style={[styles.dot, { opacity: pulse }]} />
          <Text style={styles.idleText} numberOfLines={1}>
            X LIVE{symbol ? `  $${symbol.toUpperCase()}` : ''}
          </Text>
        </View>
      ) : null}
      {shown.map(({ item, key, anim }) => {
        const mood = MOOD[item.mood];
        const translateY = anim.interpolate({ inputRange: STEPS, outputRange: [-CHATTER_LANE_HEIGHT, 0, 0, CHATTER_LANE_HEIGHT / 2] });
        const opacity = anim.interpolate({ inputRange: STEPS, outputRange: [0, 1, 0.55, 0] });
        return (
          <Animated.View key={key} style={[styles.slot, { transform: [{ translateY }], opacity }]}>
            <Pressable
              onPress={() => void Linking.openURL(item.url).catch(() => undefined)}
              style={[styles.bubble, { borderColor: mood.border, backgroundColor: mood.bg }]}
            >
              <View style={styles.head}>
                <Text style={[styles.tag, { color: mood.border, borderColor: mood.border }]}>{mood.tag}</Text>
                <Text style={styles.author} numberOfLines={1}>
                  @{item.author}
                </Text>
                <Text style={styles.time}>{ago(item.createdAt, now)} · X</Text>
              </View>
              <Text style={styles.text} numberOfLines={1}>
                {item.text}
              </Text>
            </Pressable>
          </Animated.View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  lane: {
    height: CHATTER_LANE_HEIGHT,
    overflow: 'hidden',
    backgroundColor: '#0c0918',
    borderBottomWidth: 1,
    borderBottomColor: C.borderSoft,
  },
  idle: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.neonGreen },
  idleText: { color: C.dim, fontSize: 10, fontWeight: '900', fontFamily: MONO, letterSpacing: 1 },
  slot: { position: 'absolute', left: 10, right: 10, top: 4, bottom: 4 },
  bubble: { flex: 1, borderWidth: 2, paddingHorizontal: 9, paddingVertical: 2, justifyContent: 'center', gap: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tag: { fontSize: 9, fontWeight: '900', borderWidth: 1, paddingHorizontal: 4 },
  author: { color: C.white, fontSize: 12, lineHeight: 15, fontWeight: '800', flexShrink: 1 },
  time: { color: '#b9b1cc', fontSize: 10, marginLeft: 'auto' },
  text: { color: '#f1ecfa', fontSize: 12, lineHeight: 16 },
});
