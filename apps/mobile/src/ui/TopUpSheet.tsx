import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { FAUCET_URL, SESSION_RULES, TOP_UP_AMOUNTS } from '../config';
import { formatSol, sol } from '../lib/format';
import { useApp } from '../state/AppProvider';
import { C, T } from '../theme';
import { Banner, Btn, ExtLink } from './common';

/** "Top up & play": one wallet approval for vault, deposit, 24 h session and key fees. */
export function TopUpSheet({ visible, onClose, reason }: { visible: boolean; onClose: () => void; reason?: string | null }) {
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
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={busy ? undefined : onClose} />
      <View style={styles.sheet}>
        <Text style={T.h2}>TOP UP & PLAY</Text>
        {reason ? <Text style={styles.reason}>{reason}</Text> : null}
        <Text style={T.subtle}>
          One wallet approval: deposit into your game balance, let this phone bet up to that amount for 24 h
          (max 0.1 SOL per bet), and send the phone's session key {formatSol(SESSION_RULES.gasTopUp)} SOL for fees if it runs low.
          The session key can only bet; it can never withdraw.
        </Text>
        <View style={styles.amounts}>
          {TOP_UP_AMOUNTS.map((a) => (
            <Pressable key={a.toString()} onPress={() => setAmount(a)} style={[styles.chip, amount === a && styles.chipActive]}>
              <Text style={styles.chipText}>{formatSol(a)} SOL</Text>
            </Pressable>
          ))}
        </View>
        <Text style={T.dim}>
          Wallet on devnet: {walletLamports !== null ? sol(walletLamports) : '-'} • devnet test SOL only, no real money
        </Text>
        <Btn
          title={`APPROVE ${formatSol(amount)} SOL IN WALLET`}
          busy={wallet.busy === 'topup'}
          disabled={busy}
          onPress={() => {
            setStarted(true);
            void wallet.topUpAndPlay(amount);
          }}
        />
        <View style={styles.row}>
          <Btn
            small
            kind="ghost"
            title="AIRDROP 1 DEVNET SOL"
            busy={wallet.busy === 'airdrop'}
            disabled={busy}
            onPress={() => {
              setStarted(true);
              void wallet.airdrop();
            }}
            style={styles.flex}
          />
          <Btn small kind="ghost" title="CLOSE" onPress={onClose} disabled={busy} style={styles.flex} />
        </View>
        <ExtLink label="Faucet: faucet.solana.com" url={FAUCET_URL} />
        {result ? <Banner tone={result.ok ? 'ok' : 'error'} text={result.message} /> : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(5,3,12,0.7)' },
  sheet: { backgroundColor: C.bg, borderTopWidth: 2, borderColor: C.accent, padding: 16, gap: 10, paddingBottom: 28 },
  reason: { color: C.gold, fontSize: 12, fontWeight: '800' },
  amounts: { flexDirection: 'row', gap: 8 },
  chip: { flex: 1, borderWidth: 1, borderColor: '#48405c', paddingVertical: 12, alignItems: 'center' },
  chipActive: { backgroundColor: C.accent, borderColor: '#b982ff' },
  chipText: { color: C.white, fontSize: 12, fontWeight: '900', fontFamily: 'monospace' },
  row: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1 },
});
