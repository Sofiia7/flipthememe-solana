import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { FAUCET_URL, TOP_UP_AMOUNTS } from '../config';
import { formatSol } from '../lib/format';
import { useApp } from '../state/AppProvider';
import { C, MONO } from '../theme';
import { ExtLink } from './common';
import { NeonButton } from './NeonButton';
import { PixelText } from './PixelText';

/** "Top up & play": one wallet approval for vault, deposit, 24 h session and key fees. */
export function TopUpSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { wallet, my, myReady } = useApp();
  const [amount, setAmount] = useState<bigint>(TOP_UP_AMOUNTS[0]);
  const [started, setStarted] = useState(false);

  const { clearResult } = wallet;
  useEffect(() => {
    if (visible) {
      setStarted(false);
      clearResult();
    }
  }, [visible, clearResult]);

  const result = started ? wallet.result : null;
  useEffect(() => {
    if (result?.ok && result.action === 'topup') {
      const id = setTimeout(onClose, 1_200);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [result, onClose]);

  const walletLamports = myReady ? my.walletLamports : null;
  const busy = wallet.busy !== null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={busy ? () => undefined : onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={busy ? undefined : onClose} />
      <View style={styles.sheet}>
        <View style={styles.titleRow}>
          <PixelText text="TOP UP & PLAY" size={3} color={C.neonYellow} shadow="#6a3d00" />
          <Pressable onPress={busy ? undefined : onClose} hitSlop={10} style={styles.close} accessibilityRole="button" accessibilityLabel="Close">
            <Text style={styles.closeText}>X</Text>
          </Pressable>
        </View>
        <View style={styles.amounts}>
          {TOP_UP_AMOUNTS.map((a) => (
            <Pressable key={a.toString()} onPress={() => setAmount(a)} style={[styles.chip, amount === a && styles.chipActive]}>
              <Text style={[styles.chipText, amount === a && styles.chipTextActive]}>{formatSol(a)}</Text>
              <Text style={[styles.chipUnit, amount === a && styles.chipTextActive]}>SOL</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.balance}>
          Wallet: {walletLamports !== null ? `${formatSol(walletLamports)} SOL` : '...'} <Text style={styles.devnet}>devnet</Text>
        </Text>
        <NeonButton
          title={`APPROVE ${formatSol(amount)} SOL`}
          kind="gold"
          big
          busy={wallet.busy === 'topup'}
          disabled={busy}
          onPress={() => {
            setStarted(true);
            void wallet.topUpAndPlay(amount);
          }}
        />
        <View style={styles.links}>
          <Pressable
            disabled={busy}
            hitSlop={8}
            onPress={() => {
              setStarted(true);
              void wallet.airdrop();
            }}
          >
            <Text style={[styles.link, busy && styles.linkOff]}>{wallet.busy === 'airdrop' ? 'AIRDROPPING...' : 'AIRDROP 1 SOL'}</Text>
          </Pressable>
          <ExtLink label="faucet.solana.com" url={FAUCET_URL} />
        </View>
        {result ? <Text style={[styles.result, { color: result.ok ? C.neonGreen : C.danger }]}>{result.message}</Text> : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(5,3,12,0.72)' },
  sheet: { backgroundColor: C.bg, borderTopWidth: 2, borderColor: C.neonYellow, padding: 16, gap: 14, paddingBottom: 28 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  close: { width: 30, height: 30, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: C.subtle, fontSize: 13, fontWeight: '900', fontFamily: MONO },
  amounts: { flexDirection: 'row', gap: 8 },
  chip: { flex: 1, borderWidth: 2, borderColor: '#48405c', paddingVertical: 10, alignItems: 'center' },
  chipActive: { backgroundColor: C.neonYellow, borderColor: '#fff3b0' },
  chipText: { color: C.white, fontSize: 20, fontWeight: '900', fontFamily: MONO },
  chipUnit: { color: C.subtle, fontSize: 10, fontWeight: '900' },
  chipTextActive: { color: '#2a1a00' },
  balance: { color: C.text, fontSize: 13, fontWeight: '800', fontFamily: MONO },
  devnet: { color: C.dim, fontSize: 11 },
  links: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  link: { color: C.accentText, fontSize: 12, fontWeight: '900', textDecorationLine: 'underline' },
  linkOff: { opacity: 0.4 },
  result: { fontSize: 12, fontWeight: '800', lineHeight: 17 },
});
