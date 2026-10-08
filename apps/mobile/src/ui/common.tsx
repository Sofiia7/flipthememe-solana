import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { C, FONT_CAP, MONO, T } from '../theme';
import { PixelText } from './PixelText';

type BtnKind = 'primary' | 'ghost' | 'up' | 'down' | 'danger' | 'gold';

export function Btn({
  title,
  subtitle,
  onPress,
  kind = 'primary',
  disabled = false,
  busy = false,
  small = false,
  style,
}: {
  title: string;
  subtitle?: string;
  onPress: () => void;
  kind?: BtnKind;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = BTN[kind];
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityState={{ disabled: off, busy }}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [
        styles.btn,
        small && styles.btnSmall,
        { backgroundColor: palette.bg, borderColor: palette.border },
        off && styles.btnOff,
        pressed && !off && styles.btnPressed,
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={palette.ink} /> : null}
      <View style={styles.btnTexts}>
        <PixelText text={title} size={small ? 1.5 : 2} color={palette.ink} fit />
        {subtitle ? (
          <Text style={[styles.btnSub, { color: palette.ink }]} numberOfLines={1} maxFontSizeMultiplier={FONT_CAP}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** The headline of the Wallet, History and Profile tabs: the same pixel lettering as the arena brand. */
export function ScreenTitle({ text }: { text: string }) {
  return (
    <View accessibilityRole="header" style={styles.screenTitle}>
      <PixelText text={text} size={3} color={C.white} shadow={C.accent} />
    </View>
  );
}

const BTN: Record<BtnKind, { bg: string; border: string; ink: string }> = {
  primary: { bg: C.accent, border: '#b982ff', ink: C.white },
  ghost: { bg: 'transparent', border: '#5b4f78', ink: C.accentText },
  up: { bg: C.up, border: C.upBorder, ink: C.upInk },
  down: { bg: C.down, border: C.downBorder, ink: C.downInk },
  danger: { bg: 'transparent', border: C.danger, ink: C.danger },
  gold: { bg: C.gold, border: '#ffd978', ink: '#2a1d00' },
  // Challenges and invites: the pink of the RIVAL tag.
};

export function Banner({ tone, text, action }: { tone: 'warn' | 'error' | 'info' | 'ok'; text: string; action?: { label: string; onPress: () => void } }) {
  const color = tone === 'error' ? C.danger : tone === 'warn' ? C.warn : tone === 'ok' ? C.up : C.accentText;
  return (
    <View style={[styles.banner, { borderColor: color }]}>
      <Text style={[styles.bannerText, { color }]}>{text}</Text>
      {action ? (
        <Pressable onPress={action.onPress} hitSlop={8}>
          <Text style={[styles.bannerAction, { color }]}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ExtLink({ label, url, style }: { label: string; url: string; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable onPress={() => void Linking.openURL(url).catch(() => undefined)} hitSlop={6} style={style}>
      <Text style={T.link}>{label}</Text>
    </Pressable>
  );
}

export function KV({ k, v, tone }: { k: string; v: string; tone?: 'up' | 'down' | 'gold' | 'dim' }) {
  const color = tone === 'up' ? C.up : tone === 'down' ? C.down : tone === 'gold' ? C.gold : tone === 'dim' ? C.subtle : C.white;
  return (
    <View style={styles.kv}>
      <Text style={styles.kvKey}>{k}</Text>
      <Text style={[styles.kvValue, { color }]} numberOfLines={1}>
        {v}
      </Text>
    </View>
  );
}

export function Pill({ text, color = C.accentText, filled = false }: { text: string; color?: string; filled?: boolean }) {
  return (
    <View style={[styles.pill, { borderColor: color }, filled && { backgroundColor: color }]}>
      <Text style={[styles.pillText, { color: filled ? C.bg : color }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screenTitle: { alignSelf: 'flex-start' },
  btn: {
    borderWidth: 2,
    paddingVertical: 13,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    minHeight: 48,
  },
  btnSmall: { paddingVertical: 8, paddingHorizontal: 10, minHeight: 36, borderWidth: 1 },
  btnOff: { opacity: 0.4 },
  btnPressed: { transform: [{ translateY: 1 }], opacity: 0.85 },
  btnTexts: { alignItems: 'center', flex: 1 },
  btnText: { fontSize: 14, fontWeight: '900', letterSpacing: 0.5 },
  btnTextSmall: { fontSize: 11 },
  btnSub: { fontSize: 11, fontWeight: '700', marginTop: 1, opacity: 0.85 },
  // The action sits on the right, so a short note takes one line.
  banner: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, backgroundColor: C.panelDeep, paddingHorizontal: 8, paddingVertical: 6, gap: 10 },
  bannerText: { flex: 1, fontSize: 12, fontWeight: '700', lineHeight: 16 },
  bannerAction: { fontSize: 12, fontWeight: '900', textDecorationLine: 'underline' },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingVertical: 2 },
  kvKey: { color: C.subtle, fontSize: 12, flexShrink: 0 },
  kvValue: { fontFamily: MONO, fontWeight: '800', fontSize: 12, flexShrink: 1, textAlign: 'right' },
  pill: { borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  pillText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.5 },
});
