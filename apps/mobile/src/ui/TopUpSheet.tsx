import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { FAUCET_URL, SESSION_RULES, TOP_UP_AMOUNTS } from '../config';
import { chainNowSec } from '../chain/useChainClock';
import { formatSol } from '../lib/format';
import { sessionStatusOf, useApp } from '../state/AppProvider';
import { C, MONO } from '../theme';
import { ACCOUNT_SPACE, topUpPlan } from '../wallet/topUpPlan';
import { ExtLink } from './common';
import { NeonButton } from './NeonButton';
import { PixelText } from './PixelText';

type Rent = { vault: bigint; session: bigint };

/** Totals round up to 0.0001 SOL, so the button never shows less than leaves the wallet. */
const solUp = (lamports: bigint) => formatSol(((lamports + 99_999n) / 100_000n) * 100_000n);
/** Rent-exempt minimums barely change; one read per app run is enough. */
let rentCache: Rent | null = null;

/**
 * "Top up & play": one wallet approval for vault, deposit, 24 h session and key fees, with every
 * part of the amount listed before the wallet opens. With money already in the game balance the
 * sheet first offers to renew fast bets without a deposit.
 */
export function TopUpSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { wallet, my, myReady, rpc, arena, offsetSec } = useApp();
  const [amount, setAmount] = useState<bigint>(TOP_UP_AMOUNTS[0]);
  const [started, setStarted] = useState(false);
  const [rent, setRent] = useState<Rent | null>(rentCache);

  const { clearResult } = wallet;
  useEffect(() => {
    if (visible) {
      setStarted(false);
      clearResult();
    }
  }, [visible, clearResult]);

  useEffect(() => {
    if (!visible || rentCache) return;
    let alive = true;
    Promise.all([
      rpc.getMinimumBalanceForRentExemption(BigInt(ACCOUNT_SPACE.vault)).send(),
      rpc.getMinimumBalanceForRentExemption(BigInt(ACCOUNT_SPACE.session)).send(),
    ])
      .then(([vault, session]) => {
        rentCache = { vault: BigInt(vault), session: BigInt(session) };
        if (alive) setRent(rentCache);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [visible, rpc]);

  const result = started ? wallet.result : null;
  useEffect(() => {
    if (result?.ok && (result.action === 'topup' || result.action === 'renew')) {
      const id = setTimeout(onClose, 1_200);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [result, onClose]);

  const walletLamports = myReady ? my.walletLamports : null;
  const busy = wallet.busy !== null;
  const available = my.vault?.available ?? 0n;
  const minStake = arena.config?.minStake ?? 10_000_000n;
  const status = sessionStatusOf(my.session, chainNowSec(offsetSec, Date.now()), minStake);
  const keyLow = (my.keyLamports ?? 0n) < SESSION_RULES.gasPerBet;
  const canRenew = myReady && available >= minStake && (status !== 'active' || keyLow);

  const plan = topUpPlan({
    deposit: amount,
    vaultExists: my.vault !== null,
    sessionExists: my.session !== null,
    keyLamports: my.keyLamports,
    rent,
    gasMin: SESSION_RULES.gasMin,
    gasTopUp: SESSION_RULES.gasTopUp,
  });
  const renewPlan = topUpPlan({
    deposit: 0n,
    vaultExists: true,
    sessionExists: my.session !== null,
    keyLamports: my.keyLamports,
    rent,
    gasMin: SESSION_RULES.gasMin,
    gasTopUp: SESSION_RULES.gasTopUp,
  });
  const lines: [string, bigint][] = [
    ['Game balance', plan.deposit],
    ...(plan.keyFees > 0n ? ([['Bet fees (device key)', plan.keyFees]] as [string, bigint][]) : []),
    ...(plan.setup > 0n ? ([['New accounts (rent)', plan.setup]] as [string, bigint][]) : []),
    ['Network fee', plan.networkFee],
  ];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={busy ? () => undefined : onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={busy ? undefined : onClose} />
      <View style={styles.sheet}>
        <View style={styles.titleRow}>
          <PixelText text={canRenew ? 'PLAY AGAIN' : 'TOP UP & PLAY'} size={3} color={C.neonYellow} shadow="#6a3d00" />
          <Pressable onPress={busy ? undefined : onClose} hitSlop={10} style={styles.close} accessibilityRole="button" accessibilityLabel="Close">
            <Text style={styles.closeText}>X</Text>
          </Pressable>
        </View>

        {canRenew ? (
          <>
            <NeonButton
              title={`PLAY WITH MY ${formatSol(available)} SOL`}
              subtitle={`no deposit${renewPlan.total > renewPlan.networkFee ? ` · ${solUp(renewPlan.total)} SOL for fees` : ''}`}
              kind="gold"
              big
              busy={wallet.busy === 'renew'}
              disabled={busy}
              onPress={() => {
                setStarted(true);
                void wallet.renewSession(available);
              }}
            />
            <Text style={styles.terms}>24 h of one-tap bets · up to {formatSol(SESSION_RULES.maxPerBet)} per bet · budget {formatSol(available)} · the device key cannot withdraw</Text>
            <Text style={styles.or}>OR ADD MORE</Text>
          </>
        ) : null}

        <View style={styles.amounts}>
          {TOP_UP_AMOUNTS.map((a) => (
            <Pressable key={a.toString()} onPress={() => setAmount(a)} style={[styles.chip, amount === a && styles.chipActive]}>
              <Text style={[styles.chipText, amount === a && styles.chipTextActive]}>{formatSol(a)}</Text>
              <Text style={[styles.chipUnit, amount === a && styles.chipTextActive]}>SOL</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.bill}>
          {lines.map(([label, value]) => (
            <View key={label} style={styles.billRow}>
              <Text style={styles.billLabel}>{label}</Text>
              <Text style={styles.billValue}>{formatSol(value, { maxDecimals: 6 })}</Text>
            </View>
          ))}
          <View style={[styles.billRow, styles.billTotal]}>
            <Text style={[styles.billLabel, styles.billStrong]}>From your wallet</Text>
            <Text style={[styles.billValue, styles.billStrong]}>{solUp(plan.total)} SOL</Text>
          </View>
        </View>
        {!canRenew ? (
          <Text style={styles.terms}>24 h of one-tap bets · up to {formatSol(SESSION_RULES.maxPerBet)} per bet · budget {formatSol(amount)} · the device key cannot withdraw</Text>
        ) : null}

        <Text style={styles.balance}>
          Wallet: {walletLamports !== null ? `${formatSol(walletLamports)} SOL` : '...'} <Text style={styles.devnet}>devnet</Text>
        </Text>
        <NeonButton
          title={`APPROVE ${solUp(plan.total)} SOL`}
          kind={canRenew ? 'purple' : 'gold'}
          big={!canRenew}
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
  sheet: { backgroundColor: C.bg, borderTopWidth: 2, borderColor: C.neonYellow, padding: 16, gap: 12, paddingBottom: 28 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  close: { width: 30, height: 30, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: C.subtle, fontSize: 13, fontWeight: '900', fontFamily: MONO },
  or: { color: C.dim, fontSize: 10, fontWeight: '900', fontFamily: MONO, textAlign: 'center', letterSpacing: 2 },
  amounts: { flexDirection: 'row', gap: 8 },
  chip: { flex: 1, borderWidth: 2, borderColor: '#48405c', paddingVertical: 10, alignItems: 'center' },
  chipActive: { backgroundColor: C.neonYellow, borderColor: '#fff3b0' },
  chipText: { color: C.white, fontSize: 20, fontWeight: '900', fontFamily: MONO },
  chipUnit: { color: C.subtle, fontSize: 10, fontWeight: '900' },
  chipTextActive: { color: '#2a1a00' },
  bill: { borderWidth: 1, borderColor: C.borderSoft, paddingHorizontal: 10, paddingVertical: 6, gap: 2 },
  billRow: { flexDirection: 'row', justifyContent: 'space-between' },
  billTotal: { borderTopWidth: 1, borderTopColor: C.borderSoft, paddingTop: 4, marginTop: 2 },
  billLabel: { color: C.subtle, fontSize: 11, fontFamily: MONO },
  billValue: { color: C.text, fontSize: 11, fontFamily: MONO },
  billStrong: { color: C.white, fontWeight: '900' },
  terms: { color: C.subtle, fontSize: 11, lineHeight: 15 },
  balance: { color: C.text, fontSize: 13, fontWeight: '800', fontFamily: MONO },
  devnet: { color: C.dim, fontSize: 11 },
  links: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  link: { color: C.accentText, fontSize: 12, fontWeight: '900', textDecorationLine: 'underline' },
  linkOff: { opacity: 0.4 },
  result: { fontSize: 12, fontWeight: '800', lineHeight: 17 },
});
