import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { C, FONT_CAP, GRAD, MONO } from '../theme';
import { Gradient } from './Gradient';

export type NeonKind = 'up' | 'down' | 'gold' | 'purple';

const INK: Record<NeonKind, string> = { up: '#062b12', down: '#33040f', gold: '#2a1a00', purple: C.white };
const GLOW: Record<NeonKind, string> = { up: C.neonGreen, down: C.neonRed, gold: C.neonYellow, purple: C.neonPurple };

/** Chunky gradient button with a neon glow; `badge` sits in the top right corner (the "x1.96" on UP / DOWN). */
export function NeonButton({
  title,
  subtitle,
  kind,
  onPress,
  disabled = false,
  busy = false,
  badge,
  big = false,
  style,
}: {
  title: string;
  subtitle?: string;
  kind: NeonKind;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  badge?: string;
  big?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const off = disabled || busy;
  const ink = INK[kind];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityState={{ disabled: off, busy }}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [
        styles.wrap,
        !off && { boxShadow: `0 0 14px ${GLOW[kind]}88` },
        off && styles.off,
        pressed && !off && styles.pressed,
        style,
      ]}
    >
      <Gradient colors={GRAD[kind]} style={[styles.fill, big && styles.fillBig]}>
        <View style={styles.row}>
          {busy ? <ActivityIndicator size="small" color={ink} /> : null}
          <Text
            style={[styles.title, big && styles.titleBig, big && title.length > 8 && styles.titleLong, { color: ink }]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.6}
            maxFontSizeMultiplier={FONT_CAP}
          >
            {title}
          </Text>
        </View>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: ink }]} numberOfLines={1} maxFontSizeMultiplier={FONT_CAP}>
            {subtitle}
          </Text>
        ) : null}
      </Gradient>
      {badge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText} maxFontSizeMultiplier={FONT_CAP}>
            {badge}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { borderWidth: 2, borderColor: 'rgba(255,255,255,0.55)' },
  off: { opacity: 0.38 },
  pressed: { transform: [{ scale: 0.97 }] },
  fill: { minHeight: 50, paddingVertical: 9, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  fillBig: { minHeight: 56, paddingVertical: 5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: '100%' },
  title: { fontSize: 16, fontWeight: '900', letterSpacing: 0.8 },
  titleBig: { fontSize: 24, letterSpacing: 0.5 },
  titleLong: { fontSize: 20 },
  subtitle: { fontSize: 11, fontWeight: '900', fontFamily: MONO, marginTop: 1, opacity: 0.85 },
  badge: { position: 'absolute', top: -2, right: -2, backgroundColor: C.bg, borderWidth: 1, borderColor: C.neonYellow, paddingHorizontal: 5, paddingVertical: 1 },
  badgeText: { color: C.neonYellow, fontSize: 11, fontWeight: '900', fontFamily: MONO },
});
