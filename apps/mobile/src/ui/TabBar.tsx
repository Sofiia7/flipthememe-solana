import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Tab } from '../state/AppProvider';
import { C } from '../theme';

const TABS: { id: Tab; label: string }[] = [
  { id: 'arena', label: 'ARENA' },
  { id: 'wallet', label: 'WALLET' },
  { id: 'history', label: 'HISTORY' },
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
            accessibilityState={{ selected: active }}
            onPress={() => onChange(t.id)}
            style={styles.item}
          >
            <View style={[styles.marker, active && styles.markerActive]} />
            <Text style={[styles.label, active && styles.labelActive]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', backgroundColor: '#0c0a18', borderTopWidth: 1, borderTopColor: C.borderSoft },
  item: { flex: 1, alignItems: 'center', paddingTop: 6, paddingBottom: 6, gap: 5 },
  marker: { width: 22, height: 3, backgroundColor: 'transparent' },
  markerActive: { backgroundColor: C.accent },
  label: { color: C.dim, fontSize: 11, fontWeight: '900', letterSpacing: 0.6 },
  labelActive: { color: C.white },
});
