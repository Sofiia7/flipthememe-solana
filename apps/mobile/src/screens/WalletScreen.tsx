import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { PROGRAM_ID } from '@flipthememe/client';
import { FAUCET_URL, SESSION_RULES, TOP_UP_AMOUNTS, explorer } from '../config';
import { chainNowSec } from '../chain/useChainClock';
import { useSessions } from '../chain/useSessions';
import { formatDateTime, formatDuration, formatSol, shortAddress, sol } from '../lib/format';
import { useNow } from '../lib/usePolling';
import { useApp } from '../state/AppProvider';
import { C, MONO, T } from '../theme';
import { Banner, Btn, ExtLink, KV, Pill } from '../ui/common';
import { isChecking, type GuardedAction } from '../wallet/pendingTx';
import { canRenewSession, minStakeOf } from '../wallet/playState';
import { closeOffer, isClosable } from '../wallet/sessionClose';
import {
  revocableSigners,
  sessionLimitedBelow,
  sessionRows,
  sessionStatusOf,
  sessionUsageText,
  withDeviceSession,
  type SessionRow,
} from '../wallet/sessionList';
import { NETWORK_FEE } from '../wallet/topUpPlan';

const STATUS_PILL: Record<SessionRow['status'], { text: string; color: string }> = {
  active: { text: 'ACTIVE', color: C.up },
  'used-up': { text: 'LIMIT USED', color: C.gold },
  expired: { text: 'EXPIRED', color: C.dim },
  revoked: { text: 'REVOKED', color: C.danger },
};

/** Old sessions stay on chain for good; the list shows the most relevant ones. */
const MAX_SESSION_ROWS = 8;

export function WalletScreen() {
  const { wallet, my, myReady, sessionKey, sessionKeyError, offsetSec, arena, rpc, pending, betting } = useApp();
  const nowMs = useNow(1_000);
  const nowSec = chainNowSec(offsetSec, nowMs);
  const owner = wallet.owner;
  const busy = wallet.busy !== null;
  const [copied, setCopied] = useState(false);
  // Everything about the device key, the sessions and test SOL lives behind one closed header.
  const [advanced, setAdvanced] = useState(false);
  /** Signers the revoke in flight covers (its buttons spin). */
  const [revoking, setRevoking] = useState<readonly string[]>([]);
  /** Signers the close in flight covers. */
  const [closing, setClosing] = useState<readonly string[]>([]);

  const sessions = useSessions(rpc, owner);
  const result = wallet.result;
  const refreshSessions = sessions.refresh;
  const scroll = useRef<ScrollView>(null);
  // A finished or settled action may have started or revoked sessions, and its banner sits at the top.
  useEffect(() => {
    if (!result) return;
    refreshSessions();
    scroll.current?.scrollTo({ y: 0, animated: true });
  }, [result, refreshSessions]);

  const minStake = minStakeOf(arena.config?.minStake);
  // Money already in the game balance: this phone gets a session over it with one approval, no deposit.
  const myStatus = sessionStatusOf(my.session, nowSec, minStake);
  const available = my.vault?.available ?? 0n;
  const canRenew = canRenewSession({ myReady, available, minStake, status: myStatus, keyLamports: my.keyLamports });
  const locked = my.vault?.locked ?? 0n;
  const checking = (action: GuardedAction, target?: string) => isChecking(wallet.pendingTx, action, target);

  const deviceKey = sessionKey?.address ?? null;
  const rows = useMemo(() => {
    // This phone's own session is read every few seconds; the full list less often.
    const fresh = my.sessionAddress && my.session ? { address: my.sessionAddress, account: my.session } : null;
    return sessionRows(withDeviceSession(sessions.list ?? [], fresh), { deviceKey, nowSec, minStake });
  }, [sessions.list, my.sessionAddress, my.session, deviceKey, nowSec, minStake]);
  const shownRows = rows.slice(0, MAX_SESSION_ROWS);
  const allSigners = revocableSigners(rows);
  const revokeChecking = checking('revoke');
  const revoke = (signers: readonly string[]) => {
    setRevoking(signers);
    void wallet.revokeSessions(signers);
  };
  // Finished sessions (revoked or expired) still hold their rent; the owner can take it back. This
  // phone's own session is closable only once it is revoked or expired too, never while it can bet.
  const offer = closeOffer(rows, nowSec);
  const closeChecking = checking('close');
  // A top up or renew of unknown outcome may be about to grant this phone a session again.
  const closeBlocked = busy || closeChecking || checking('topup') || checking('renew');
  const close = (targets: typeof offer.batch) => {
    setClosing(targets.map((t) => t.signer));
    void wallet.closeSessions(targets);
  };

  const keyLamports = my.keyLamports;
  const betBusy =
    pending !== null ||
    betting.bet.phase === 'signing' ||
    betting.bet.phase === 'sending' ||
    betting.bet.phase === 'confirming' ||
    betting.claiming !== null;
  const sweepChecking = checking('sweep');
  const canSweep = keyLamports !== null && keyLamports > NETWORK_FEE;

  return (
    <ScrollView ref={scroll} contentContainerStyle={styles.page}>
      <Text style={T.h1}>Wallet</Text>
      {/* What the last action did, right under the title: visible without scrolling. */}
      {result && (result.action !== 'connect' || !result.ok) ? (
        <View style={styles.result}>
          <Banner tone={result.ok ? 'ok' : result.checking ? 'info' : 'error'} text={result.message} />
          {result.signature ? <ExtLink label="View transaction on Explorer" url={explorer.tx(result.signature)} /> : null}
        </View>
      ) : null}
      {owner && my.error ? <Banner tone="warn" text={`Could not refresh: ${my.error}. Showing the last data.`} /> : null}
      <Banner tone="info" text="Test SOL only - nothing here is real money." />

      <View style={T.panel}>
        <Text style={T.label}>CONNECTED WALLET</Text>
        {owner ? (
          <>
            <Text
              style={styles.address}
              onPress={() => {
                void Clipboard.setStringAsync(owner).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1_500);
                });
              }}
            >
              {shortAddress(owner, 6)} {copied ? '(copied)' : '(tap to copy)'}
            </Text>
            <KV k="Wallet balance (devnet)" v={myReady && my.walletLamports !== null ? sol(my.walletLamports) : '...'} />
            <View style={styles.row}>
              <ExtLink label="Wallet on Explorer" url={explorer.address(owner)} />
              {my.vaultAddress ? <ExtLink label="Game vault on Explorer" url={explorer.address(my.vaultAddress)} /> : null}
            </View>
            <Btn small kind="ghost" title="DISCONNECT" disabled={busy} onPress={() => void wallet.disconnect()} />
          </>
        ) : (
          <>
            <Text style={T.subtle}>Connect a Mobile Wallet Adapter wallet. Transactions are signed in the wallet and sent to Solana devnet by the app.</Text>
            <Btn title="CONNECT WALLET" busy={wallet.busy === 'connect'} disabled={busy} onPress={() => void wallet.connect()} />
          </>
        )}
      </View>

      {owner ? (
        <>
          <View style={T.panel}>
            <Text style={T.label}>GAME BALANCE</Text>
            <KV k="Available" v={myReady ? sol(available) : '...'} tone="up" />
            <KV k="Locked in rounds" v={myReady ? sol(locked) : '...'} tone="gold" />
            <Text style={T.dim}>Winnings land here. Only available SOL can be withdrawn.</Text>
            {canRenew ? (
              <Btn
                title={checking('renew') ? 'CHECKING...' : `PLAY WITH MY ${formatSol(available)} SOL`}
                busy={wallet.busy === 'renew' || checking('renew')}
                disabled={busy || !sessionKey}
                onPress={() => void wallet.renewSession(available)}
              />
            ) : null}
            <Text style={styles.sub}>{canRenew ? 'OR ADD SOL' : 'TOP UP & PLAY'}</Text>
            {checking('topup') ? (
              <Btn small title="CHECKING TOP UP" busy onPress={() => undefined} />
            ) : (
              <View style={styles.row}>
                {TOP_UP_AMOUNTS.map((a) => (
                  <Btn
                    key={a.toString()}
                    small
                    title={`${formatSol(a)} SOL`}
                    busy={wallet.busy === 'topup'}
                    disabled={busy || !sessionKey}
                    onPress={() => void wallet.topUpAndPlay(a)}
                    style={styles.flex}
                  />
                ))}
              </View>
            )}
            <Btn
              kind="ghost"
              title={checking('withdraw') ? 'CHECKING WITHDRAW' : `WITHDRAW ALL AVAILABLE (${formatSol(available)} SOL)`}
              busy={wallet.busy === 'withdraw' || checking('withdraw')}
              disabled={busy || available <= 0n}
              onPress={() => void wallet.withdrawAll(available)}
            />
          </View>

          <Pressable
            onPress={() => setAdvanced((open) => !open)}
            style={styles.advancedHead}
            accessibilityRole="button"
            accessibilityState={{ expanded: advanced }}
            accessibilityLabel="Advanced"
          >
            <Text style={T.label}>ADVANCED</Text>
            <View style={[styles.chevron, advanced && styles.chevronOpen]} />
          </Pressable>

          {advanced ? (
            <>
              <View style={T.panel}>
                <Text style={T.label}>PLAY SESSIONS</Text>
                {shownRows.map((row) => (
                  <SessionLine
                    key={row.address}
                    row={row}
                    checking={isChecking(wallet.pendingTx, 'revoke', row.signer)}
                    spinning={wallet.busy === 'revoke' && revoking.includes(row.signer)}
                    disabled={busy || revokeChecking}
                    onRevoke={() => revoke([row.signer])}
                    closable={isClosable(row, nowSec)}
                    closeChecking={isChecking(wallet.pendingTx, 'close', row.signer)}
                    closeSpinning={wallet.busy === 'close' && closing.includes(row.signer)}
                    closeDisabled={closeBlocked}
                    onClose={() => close([{ signer: row.signer, address: row.address }])}
                  />
                ))}
                {rows.length === 0 ? (
                  <Text style={T.subtle}>{sessions.list === null && !sessions.error ? 'Loading sessions...' : 'No sessions yet.'}</Text>
                ) : null}
                {rows.length > shownRows.length ? <Text style={T.dim}>+{rows.length - shownRows.length} older</Text> : null}
                {sessions.error ? <Text style={styles.warn}>Session list: {sessions.error}</Text> : null}
                {allSigners.length > 1 ? (
                  <Btn
                    kind="danger"
                    small
                    title={revokeChecking ? 'CHECKING' : `REVOKE ALL (${allSigners.length})`}
                    busy={revokeChecking || (wallet.busy === 'revoke' && revoking.length > 1)}
                    disabled={busy}
                    onPress={() => revoke(allSigners)}
                  />
                ) : null}
                {offer.targets.length > 1 ? (
                  <>
                    <Btn
                      kind="ghost"
                      small
                      title={closeChecking ? 'CHECKING' : `CLOSE FINISHED (${offer.batch.length})`}
                      busy={closeChecking || (wallet.busy === 'close' && closing.length > 1)}
                      disabled={closeBlocked}
                      onPress={() => close(offer.batch)}
                    />
                    {offer.later > 0 ? <Text style={T.dim}>{offer.later} more after this batch.</Text> : null}
                  </>
                ) : null}
                {offer.targets.length > 0 ? <Text style={T.dim}>A finished session can be closed to get its rent deposit back in your wallet.</Text> : null}
                {rows.length > 0 && !rows.some((r) => r.mine) ? <Text style={T.dim}>No session on this phone yet.</Text> : null}
                <Text style={T.dim}>A session lets one phone place one-tap bets from your game balance. It can never withdraw.</Text>
              </View>

              <View style={T.panel}>
                <Text style={T.label}>DEVICE KEY (THIS PHONE)</Text>
                <KV k="SOL on the key" v={keyLamports !== null ? sol(keyLamports, { maxDecimals: 5 }) : '...'} />
                <Text style={T.dim}>Pays the network fee of each bet (0.000005 SOL). Not part of the game balance.</Text>
                <Btn
                  kind="ghost"
                  small
                  title={sweepChecking ? 'CHECKING' : 'RETURN TO WALLET'}
                  busy={wallet.busy === 'sweep' || sweepChecking}
                  disabled={busy || betBusy || !canSweep || !sessionKey}
                  onPress={() => void wallet.returnKeyFunds()}
                />
                {betBusy && canSweep ? <Text style={T.dim}>Waiting for your bet to land.</Text> : null}
                {sessionKey ? (
                  <View style={styles.row}>
                    <Text style={T.dim}>Key {shortAddress(sessionKey.address)}</Text>
                    <ExtLink label="Key on Explorer" url={explorer.address(sessionKey.address)} />
                  </View>
                ) : (
                  <Text style={[T.dim, sessionKeyError ? { color: C.danger } : null]}>
                    {sessionKeyError ? `Device key unavailable: ${sessionKeyError}` : 'Loading the device key...'}
                  </Text>
                )}
              </View>

              <View style={T.panel}>
                <Text style={T.label}>TEST SOL</Text>
                <Btn kind="ghost" title="AIRDROP 1 TEST SOL" busy={wallet.busy === 'airdrop'} disabled={busy} onPress={() => void wallet.airdrop()} />
                <Text style={T.dim}>The public devnet faucet is rate limited. If the airdrop fails, use the web faucet with your wallet address.</Text>
                <ExtLink label="faucet.solana.com" url={FAUCET_URL} />
              </View>
            </>
          ) : null}
        </>
      ) : null}

      <View style={styles.row}>
        <ExtLink label="Program on Explorer" url={explorer.address(PROGRAM_ID)} />
      </View>
    </ScrollView>
  );
}

/** One session: which device, how long, what it can do; REVOKE while it can still bet, CLOSE once it is finished. */
function SessionLine({
  row,
  checking,
  spinning,
  disabled,
  onRevoke,
  closable,
  closeChecking,
  closeSpinning,
  closeDisabled,
  onClose,
}: {
  row: SessionRow;
  checking: boolean;
  spinning: boolean;
  disabled: boolean;
  onRevoke: () => void;
  closable: boolean;
  closeChecking: boolean;
  closeSpinning: boolean;
  closeDisabled: boolean;
  onClose: () => void;
}) {
  const pill = STATUS_PILL[row.status];
  const when = row.revocable
    ? `${formatDuration(row.secondsLeft)} left`
    : `${row.secondsLeft > 0 ? 'until' : 'expired'} ${formatDateTime(row.expiry)}`;
  return (
    <View style={[styles.session, row.mine && styles.sessionMine]}>
      <View style={styles.between}>
        <Text style={styles.device} numberOfLines={1}>
          {row.mine ? 'THIS PHONE' : `OTHER DEVICE ${shortAddress(row.signer)}`}
        </Text>
        <Pill text={pill.text} color={pill.color} />
      </View>
      <Text style={styles.meta}>
        {when} · one-tap bets up to {formatSol(row.maxPerBet)} each
      </Text>
      <View style={styles.between}>
        <Text style={styles.meta}>{sessionUsageText(row, sessionLimitedBelow(SESSION_RULES), formatSol)}</Text>
        {row.revocable ? (
          <Btn kind="danger" small title={checking ? 'CHECKING' : 'REVOKE'} busy={checking || spinning} disabled={disabled} onPress={onRevoke} />
        ) : closable ? (
          <Btn kind="ghost" small title={closeChecking ? 'CHECKING' : 'CLOSE'} busy={closeChecking || closeSpinning} disabled={closeDisabled} onPress={onClose} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 12, paddingBottom: 28 },
  address: { color: C.white, fontFamily: 'monospace', fontSize: 14, fontWeight: '800' },
  row: { flexDirection: 'row', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  flex: { flex: 1 },
  sub: { color: C.label, fontSize: 10, fontWeight: '900', marginTop: 6 },
  result: { gap: 6 },
  advancedHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.panel,
    paddingHorizontal: 10,
    paddingVertical: 12,
  },
  // A chevron drawn with two borders: it points down when closed and up when open.
  chevron: { width: 9, height: 9, borderRightWidth: 2, borderBottomWidth: 2, borderColor: C.accentText, transform: [{ rotate: '45deg' }], marginBottom: 3 },
  chevronOpen: { transform: [{ rotate: '-135deg' }], marginBottom: 0, marginTop: 3 },
  session: { borderWidth: 1, borderColor: C.borderSoft, backgroundColor: C.panelDeep, padding: 8, gap: 3 },
  sessionMine: { borderColor: C.accent },
  device: { color: C.white, fontSize: 12, fontWeight: '900', fontFamily: MONO, flexShrink: 1 },
  meta: { color: C.subtle, fontSize: 11, fontFamily: MONO },
  warn: { color: C.warn, fontSize: 10 },
});
