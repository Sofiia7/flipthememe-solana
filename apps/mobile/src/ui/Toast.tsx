import { useEffect } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import type { Toast } from '../state/AppProvider';
import { C } from '../theme';

/** Result card for one of my rounds turning final; auto-hides after 10 s. */
export function ResultToast({ toast, onClose, top }: { toast: Toast; onClose: () => void; top: number }) {
  useEffect(() => {
    const id = setTimeout(onClose, 10_000);
    return () => clearTimeout(id);
  }, [toast.id, onClose]);
  const color = toast.tone === 'win' ? C.up : toast.tone === 'loss' ? C.down : C.gold;
  return (
    <View style={[styles.wrap, { top }]} pointerEvents="box-none">
      <View style={[styles.card, { borderColor: color }]}>
        <Text style={[styles.title, { color }]}>{toast.title}</Text>
        <Text style={styles.body}>{toast.body}</Text>
        <View style={styles.actions}>
          <Pressable hitSlop={8} onPress={() => void Share.share({ message: toast.shareText }).catch(() => undefined)}>
            <Text style={styles.action}>SHARE RESULT</Text>
          </Pressable>
          <Pressable hitSlop={8} onPress={onClose}>
            <Text style={styles.action}>CLOSE</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12, zIndex: 20, elevation: 20 },
  card: { backgroundColor: '#1d1733', borderWidth: 2, padding: 12, gap: 6 },
  title: { fontSize: 15, fontWeight: '900' },
  body: { color: C.text, fontSize: 12, lineHeight: 17 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 18, marginTop: 2 },
  action: { color: C.accentText, fontSize: 11, fontWeight: '900' },
});
