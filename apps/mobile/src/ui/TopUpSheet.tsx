import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { FAUCET_URL, SESSION_RULES, TOP_UP_AMOUNTS } from '../config';
import { useRents } from '../chain/rent';
import { chainNowSec } from '../chain/useChainClock';
import { formatSol } from '../lib/format';
import { sessionStatusOf, useApp } from '../state/AppProvider';
import { C, MONO } from '../theme';
import { isChecking } from '../wallet/pendingTx';
import { canRenewSession, minStakeOf } from '../wallet/playState';
import { playRoute, topUpBill } from '../wallet/topUpFlow';
import { RENT_FALLBACK, topUpPlan } from '../wallet/topUpPlan';
import { ExtLink } from './common';
import { NeonButton } from './NeonButton';
import { PixelText } from './PixelText';

/** Totals round up to 0.0001 SOL, so the button never shows less than leaves the wallet. */
const solUp = (lamports: bigint) => formatSol(((lamports + 99_999n) / 100_000n) * 100_000n);

/**
 * "Top up & play": one wallet approval for vault, deposit, 7-day session and key fees, with every
 * part of the amount listed before the wallet opens. With money already in the game balance the
 * sheet first offers to renew one-tap bets without a deposit. For a visitor (no wallet connected yet)
 * the same sheet connects and approves in one wallet session: the bill then assumes the worst case
 * (new vault, new session, empty device key) and its total says "up to".
 */
export function TopUpSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { wallet, my, myReady, rpc, arena, offsetSec } = useApp();
  const [amount, setAmount] = useState<bigint>(TOP_UP_AMOUNTS[0]);
  const [started, setStarted] = useState(false);
  const rent = useRents(rpc, visible);

  const { clearResult } = wallet;
  useEffect(() => {
    if (visible) {
      setStarted(false);
      clearResult();
    }
  }, [visible, clearResult]);

  const result = started ? wallet.result : null;
  useEffect(() => {
    if (result?.ok && (result.action === 'topup' || result.action === 'renew')) {
      const id = setTimeout(onClose, 1_200);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [result, onClose]);

  const route = playRoute(wallet.owner);
  const connected = route.kind === 'top-up';
  const walletLamports = myReady ? my.walletLamports : null;
  const busy = wallet.busy !== null;
  // A sent top up or renew with no answer yet: its button waits for the chain instead of paying again.
  const topUpChecking = isChecking(wallet.pendingTx, 'topup');
  const renewChecking = isChecking(wallet.pendingTx, 'renew');
  const available = my.vault?.available ?? 0n;
  const minStake = minStakeOf(arena.config?.minStake);
  const status = sessionStatusOf(my.session, chainNowSec(offsetSec, Date.now()), minStake);
  const canRenew = canRenewSession({ myReady, available, minStake, status, keyLamports: my.keyLamports });

  const rents = rent ?? RENT_FALLBACK;
  const { plan, upTo } = topUpBill({
    known: connected && myReady,
    deposit: amount,
    vaultExists: my.vault !== null,
    sessionExists: my.session !== null,
    keyLamports: my.keyLamports,
    rent: rents,
    rules: SESSION_RULES,
  });
  const renewPlan = topUpPlan({
    deposit: 0n,
    vaultExists: true,
    sessionExists: my.session !== null,
    keyLamports: my.keyLamports,
    rent: rents,
    gasMin: SESSION_RULES.gasMin,
    gasTopUp: SESSION_RULES.gasTopUp,
  });
  const lines: [string, bigint][] = [
    ['Game balance', plan.deposit],
    ...(plan.keyFees > 0n ? ([['Bet fees (device key)', plan.keyFees]] as [string, bigint][]) : []),
    ...(plan.setup > 0n ? ([['New accounts (rent)', plan.setup]] as [string, bigint][]) : []),
    ['Network fee', plan.networkFee],
  ];
  const terms = `One-tap bets up to ${formatSol(SESSION_RULES.maxPerBet)} SOL per bet for 7 days. The device key can never withdraw.`;

  const approve = () => {
    setStarted(true);
    void (route.kind === 'top-up' ? wallet.topUpAndPlay(amount) : wallet.connectAndPlay(amount));
  };

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
              title={renewChecking ? 'CHECKING...' : `PLAY WITH MY ${formatSol(available)} SOL`}
              subtitle={
                renewChecking
                  ? 'waiting for devnet'
                  : `no deposit${renewPlan.total > renewPlan.networkFee ? ` · ${solUp(renewPlan.total)} SOL for fees` : ''}`
              }
              kind="gold"
              big
              busy={wallet.busy === 'renew' || renewChecking}
              disabled={busy}
              onPress={() => {
                setStarted(true);
                void wallet.renewSession(available);
              }}
            />
            <Text style={styles.terms}>{terms}</Text>
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
            <Text style={[styles.billLabel, styles.billStrong]}>{upTo ? 'From your wallet (up to)' : 'From your wallet'}</Text>
            <Text style={[styles.billValue, styles.billStrong]}>{solUp(plan.total)} SOL</Text>
          </View>
        </View>
        {!canRenew ? <Text style={styles.terms}>{terms}</Text> : null}

        {connected ? (
          <Text style={styles.balance}>
            Wallet: {walletLamports !== null ? `${formatSol(walletLamports)} SOL` : '...'} <Text style={styles.devnet}>devnet</Text>
          </Text>
        ) : (
          <Text style={styles.terms}>Your wallet opens once: it connects and approves in one step. Test SOL only.</Text>
        )}
        <NeonButton
          title={connected ? (topUpChecking ? 'CHECKING...' : `APPROVE ${solUp(plan.total)} SOL`) : 'CONNECT & APPROVE'}
          subtitle={connected ? (topUpChecking ? 'waiting for devnet' : undefined) : `up to ${solUp(plan.total)} SOL`}
          kind={canRenew ? 'purple' : 'gold'}
          big={!canRenew}
          busy={wallet.busy === 'topup' || topUpChecking}
          disabled={busy}
          onPress={approve}
        />
        <View style={styles.links}>
          {connected ? (
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
          ) : null}
          <ExtLink label="faucet.solana.com" url={FAUCET_URL} />
        </View>
        {result ? (
          <Text style={[styles.result, { color: result.ok ? C.neonGreen : result.checking ? C.neonYellow : C.danger }]}>{result.message}</Text>
        ) : null}
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
