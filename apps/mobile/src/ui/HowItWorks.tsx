import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HouseFace } from '../PixelFace';
import { C, MONO } from '../theme';
import { NeonButton } from './NeonButton';
import { PixelIcon, PixelText } from './PixelText';

/** A U-turn arrow: the stake comes back. */
const BACK_ARROW = ['..#....', '.##....', '#######', '.##...#', '..#...#', '......#', '.######'];

const styles = StyleSheet.create({
  modal: { flex: 1 },
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(5,3,12,0.72)' },
  sheet: {
    backgroundColor: C.bg,
    borderWidth: 2,
    borderColor: C.neonPurple,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 26,
    gap: 12,
    height: '86%',
    marginHorizontal: 12,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  close: { width: 30, height: 30, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: C.subtle, fontSize: 13, fontWeight: '900', fontFamily: MONO },
  list: { gap: 11 },
  rule: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 40, height: 40, borderWidth: 2, backgroundColor: C.panelDeep, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontWeight: '900', fontFamily: MONO, fontSize: 13 },
  ruleText: { color: C.text, fontSize: 14, lineHeight: 19, fontWeight: '700', flex: 1 },
  devnet: { color: C.dim, fontSize: 11, textAlign: 'center', fontFamily: MONO },
});

function Icon({ children, color }: { children: ReactNode; color: string }) {
  return <View style={[styles.icon, { borderColor: color, boxShadow: `0 0 8px ${color}66` }]}>{children}</View>;
}

function Glyph({ text, color, size = 15 }: { text: string; color: string; size?: number }) {
  return <Text style={[styles.glyph, { color, fontSize: size }]}>{text}</Text>;
}

const RULES: { icon: ReactNode; text: string }[] = [
  {
    icon: (
      <Icon color={C.neonGreen}>
        <Text style={styles.glyph}>
          <Text style={{ color: C.neonGreen }}>▲</Text>
          <Text style={{ color: C.neonRed }}>▼</Text>
        </Text>
      </Icon>
    ),
    text: 'Call UP or DOWN on the arena token.',
  },
  {
    icon: (
      <Icon color={C.neonYellow}>
        <Glyph text="30s" color={C.neonYellow} size={12} />
      </Icon>
    ),
    text: 'After entry closes, we average a reference price (the yellow line), then a final price. UP wins above that line; DOWN wins below. Equal prices mean a refund. Result in about 2 min.',
  },
  {
    icon: (
      <Icon color={C.neonYellow}>
        <Glyph text="x1.96" color={C.neonYellow} size={10} />
      </Icon>
    ),
    text: 'Matched 1:1 with the other side. A win pays 1.96x of the matched part; the rest comes back.',
  },
  {
    icon: (
      <Icon color={C.accentText}>
        <PixelIcon rows={BACK_ARROW} size={3} color={C.accentText} />
      </Icon>
    ),
    text: 'No match? Your stake comes back.',
  },
  {
    icon: (
      <Icon color={C.house}>
        <HouseFace size={24} tile={false} />
      </Icon>
    ),
    text: 'On devnet the house fills the short side.',
  },
  {
    icon: (
      <Icon color={C.neonPink}>
        <Glyph text="1" color={C.neonPink} size={16} />
      </Icon>
    ),
    text: 'One arena, one busy token. Everyone plays the same chart.',
  },
  {
    icon: (
      <Icon color={C.neonPurple}>
        <Glyph text="X" color={C.neonPurple} size={15} />
      </Icon>
    ),
    text: 'Bubbles are real posts from X about this token - not advice.',
  },
];

/** On-demand rules and the player's current phase, above the arena rather than inside its layout. */
export function HowItWorksSheet({ visible, onClose, context }: { visible: boolean; onClose: () => void; context?: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.modal}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close rules" />
        <View style={[styles.sheet, { marginTop: insets.top + 8 }]}>
          <View style={styles.titleRow}>
            <PixelText text="RULES" size={3} color={C.white} shadow={C.accent} />
            <Pressable onPress={onClose} hitSlop={10} style={styles.close} accessibilityRole="button" accessibilityLabel="Close">
              <Text style={styles.closeText}>X</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.list} bounces={false}>
            {context}
            {RULES.map((rule) => (
              <View key={rule.text} style={styles.rule}>
                {rule.icon}
                <Text style={styles.ruleText}>{rule.text}</Text>
              </View>
            ))}
          </ScrollView>
          <Text style={styles.devnet}>Test SOL only</Text>
          <NeonButton title="LET'S PLAY" kind="purple" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}
