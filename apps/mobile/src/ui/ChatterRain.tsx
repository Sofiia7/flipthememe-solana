// Real tweets about the arena token drop in from the top like notifications:
// green for moon talk, red for scam talk. Tap one to open it on X.
import { useEffect, useRef, useState } from 'react';
import { Animated, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { ago, useChatter, type ChatterItem } from '../chain/useChatter';

const SHOW_MS = 5_500;
const GAP_MS = 2_200;
const MAX_ON_SCREEN = 2;

const MOOD = {
  moon: { border: '#35df6c', bg: 'rgba(16, 48, 28, 0.94)', tag: 'MOON' },
  scam: { border: '#fb607c', bg: 'rgba(58, 14, 26, 0.94)', tag: 'SCAM' },
  neutral: { border: '#a459ff', bg: 'rgba(32, 24, 58, 0.94)', tag: 'X' },
} as const;

type Shown = { item: ChatterItem; key: number; anim: Animated.Value };

/** `top` keeps the bubbles below the token header, over the chart only. */
export function ChatterRain({ symbol, mint, enabled, top = 76 }: { symbol: string | null; mint: string | null; enabled: boolean; top?: number }) {
  const { next, drop } = useChatter(symbol, mint, enabled);
  const [shown, setShown] = useState<Shown[]>([]);
  const counter = useRef(0);

  useEffect(() => {
    if (!enabled || !next) return;
    const item = next;
    const timer = setTimeout(() => {
      drop();
      const anim = new Animated.Value(0);
      const entry: Shown = { item, key: counter.current++, anim };
      setShown((s) => [entry, ...s].slice(0, MAX_ON_SCREEN));
      Animated.sequence([
        Animated.spring(anim, { toValue: 1, useNativeDriver: true, friction: 7 }),
        Animated.delay(SHOW_MS),
        Animated.timing(anim, { toValue: 2, duration: 350, useNativeDriver: true }),
      ]).start(() => setShown((s) => s.filter((x) => x.key !== entry.key)));
    }, GAP_MS);
    return () => clearTimeout(timer);
    // drop is recreated each render; the item identity is what matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next?.id, enabled]);

  if (!enabled || shown.length === 0) return null;
  const now = Date.now();
  return (
    <View pointerEvents="box-none" style={[styles.layer, { top }]}>
      {shown.map(({ item, key, anim }) => {
        const mood = MOOD[item.mood];
        const translateY = anim.interpolate({ inputRange: [0, 1, 2], outputRange: [-90, 0, -20] });
        const opacity = anim.interpolate({ inputRange: [0, 1, 2], outputRange: [0, 1, 0] });
        return (
          <Animated.View key={key} style={{ transform: [{ translateY }], opacity }}>
            <Pressable
              onPress={() => void Linking.openURL(item.url).catch(() => undefined)}
              style={[styles.bubble, { borderColor: mood.border, backgroundColor: mood.bg }]}
            >
              <View style={styles.head}>
                <Text style={[styles.tag, { color: mood.border, borderColor: mood.border }]}>{mood.tag}</Text>
                <Text style={styles.author} numberOfLines={1}>
                  @{item.author}
                </Text>
                <Text style={styles.time}>{ago(item.createdAt, now)} · live on X</Text>
              </View>
              <Text style={styles.text} numberOfLines={2}>
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
  layer: { position: 'absolute', left: 10, right: 10, gap: 6, zIndex: 50 },
  bubble: { borderWidth: 2, paddingHorizontal: 10, paddingVertical: 7, gap: 3 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tag: { fontSize: 9, fontWeight: '900', borderWidth: 1, paddingHorizontal: 4 },
  author: { color: '#ffffff', fontSize: 12, fontWeight: '800', flexShrink: 1 },
  time: { color: '#b9b1cc', fontSize: 10, marginLeft: 'auto' },
  text: { color: '#f1ecfa', fontSize: 12, lineHeight: 16 },
});
