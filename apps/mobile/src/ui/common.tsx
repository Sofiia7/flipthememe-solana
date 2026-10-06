import type { ReactNode } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { C, MONO, T } from '../theme';

type BtnKind = 'primary' | 'ghost' | 'up' | 'down' | 'danger' | 'gold' | 'friend';

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
        <Text style={[styles.btnText, small && styles.btnTextSmall, { color: palette.ink }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.btnSub, { color: palette.ink }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
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
  friend: { bg: 'rgba(255,79,216,0.08)', border: C.neonPink, ink: C.neonPink },
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

export function Section({ title, right, children, style }: { title: string; right?: ReactNode; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.section, style]}>
      <View style={styles.sectionHead}>
        <Text style={T.label}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
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
  btnTexts: { alignItems: 'center' },
  btnText: { fontSize: 14, fontWeight: '900', letterSpacing: 0.5 },
  btnTextSmall: { fontSize: 11 },
  btnSub: { fontSize: 10, fontWeight: '700', marginTop: 1, opacity: 0.85 },
  // The action sits on the right, so a short note takes one line.
  banner: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, backgroundColor: C.panelDeep, paddingHorizontal: 8, paddingVertical: 6, gap: 10 },
  bannerText: { flex: 1, fontSize: 11, fontWeight: '700', lineHeight: 15 },
  bannerAction: { fontSize: 11, fontWeight: '900', textDecorationLine: 'underline' },
  section: { gap: 6 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingVertical: 2 },
  kvKey: { color: C.subtle, fontSize: 12, flexShrink: 0 },
  kvValue: { fontFamily: MONO, fontWeight: '800', fontSize: 12, flexShrink: 1, textAlign: 'right' },
  pill: { borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  pillText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
});
