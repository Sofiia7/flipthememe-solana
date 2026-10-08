import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { C, FONT_CAP, MONO } from '../theme';
import { PixelText } from './PixelText';

export type NeonKind = 'up' | 'down' | 'gold' | 'purple';

const INK: Record<NeonKind, string> = { up: '#062b12', down: '#33040f', gold: '#2a1a00', purple: C.white };
const GLOW: Record<NeonKind, string> = { up: C.neonGreen, down: C.neonRed, gold: C.neonYellow, purple: C.neonPurple };
const FILL: Record<NeonKind, string> = { up: C.up, down: C.down, gold: C.gold, purple: '#7434c8' };

/** Flat arcade button with pixel lettering and a stepped bevel; badge shows the payout multiplier. */
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
        { borderColor: GLOW[kind] },
        off && styles.off,
        pressed && !off && styles.pressed,
        style,
      ]}
    >
      <View style={[styles.fill, { backgroundColor: FILL[kind] }, big && styles.fillBig]}>
        <View style={[styles.row, { width: '100%' }]}>
          {busy ? <ActivityIndicator size="small" color={ink} /> : null}
          <View style={{ flex: 1 }}><PixelText text={title} size={big && title.length < 9 ? 3 : 2} color={ink} fit /></View>
        </View>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: ink }]} numberOfLines={1} maxFontSizeMultiplier={FONT_CAP}>
            {subtitle}
          </Text>
        ) : null}
      </View>
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
  pressed: { transform: [{ translateY: 2 }] },
  fill: { minHeight: 50, borderTopWidth: 3, borderLeftWidth: 3, borderRightWidth: 3, borderBottomWidth: 4, borderTopColor: '#ffffff55', borderLeftColor: '#ffffff33', borderRightColor: '#00000033', borderBottomColor: '#00000066', paddingVertical: 9, paddingHorizontal: 7, alignItems: 'center', justifyContent: 'center' },
  fillBig: { minHeight: 56, paddingVertical: 5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: '100%' },
  subtitle: { fontSize: 12, fontWeight: '700', fontFamily: MONO, marginTop: 2 },
  badge: { position: 'absolute', top: -2, right: -2, backgroundColor: C.bg, borderWidth: 1, borderColor: C.neonYellow, paddingHorizontal: 5, paddingVertical: 1 },
  badgeText: { color: C.neonYellow, fontSize: 11, fontWeight: '900', fontFamily: MONO },
});
