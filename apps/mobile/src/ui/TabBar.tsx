import { Pressable, StyleSheet, View } from 'react-native';
import type { Tab } from '../state/AppProvider';
import { C } from '../theme';
import { PixelText } from './PixelText';

const TABS: { id: Tab; label: string }[] = [
  { id: 'arena', label: 'ARENA' },
  { id: 'wallet', label: 'WALLET' },
  { id: 'history', label: 'HISTORY' },
  { id: 'leaders', label: 'LEADERS' },
  { id: 'profile', label: 'PROFILE' },
];

export function TabBar({ tab, onChange, bottomInset }: { tab: Tab; onChange: (tab: Tab) => void; bottomInset: number }) {
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(bottomInset, 6) }]}>
      {TABS.map((t) => {
        const active = t.id === tab;
        return (
          <Pressable
            key={t.id}
            accessibilityRole="tab"
            accessibilityLabel={t.label}
            accessibilityState={{ selected: active }}
            onPress={() => onChange(t.id)}
            style={styles.item}
          >
            <View style={[styles.marker, active && styles.markerActive]} />
            <PixelText text={t.label} size={1.5} color={active ? C.white : C.dim} fit />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', backgroundColor: '#0c0a18', borderTopWidth: 1, borderTopColor: C.borderSoft },
  item: { flex: 1, minHeight: 48, alignItems: 'center', paddingTop: 6, paddingBottom: 6, gap: 5 },
  marker: { width: 22, height: 3, backgroundColor: 'transparent' },
  markerActive: { backgroundColor: C.accent },
  // C.dim is 5.8:1 on this bar, above the 4.5:1 AA line for small text.
  label: { color: C.dim, fontSize: 11, fontWeight: '900', letterSpacing: 0.6 },
  labelActive: { color: C.white },
});
