import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
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
import { revocableSigners, sessionRows, withDeviceSession, type SessionRow } from '../wallet/sessionList';
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
  /** Signers the revoke in flight covers (its buttons spin). */
  const [revoking, setRevoking] = useState<readonly string[]>([]);

  const sessions = useSessions(rpc, owner);
  const result = wallet.result;
  const refreshSessions = sessions.refresh;
  // A finished or settled action may have started or revoked sessions.
  useEffect(() => {
    if (result) refreshSessions();
  }, [result, refreshSessions]);

  const minStake = arena.config?.minStake ?? 10_000_000n;
  const available = my.vault?.available ?? 0n;
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
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.head}>
        <Text style={T.h1}>Wallet</Text>
        <Pill text="DEVNET" color={C.gold} />
      </View>
      <Banner tone="info" text="Devnet test SOL only - nothing here is real money. Get test SOL with Airdrop or the faucet." />
      {owner && my.error ? <Banner tone="warn" text={`Could not refresh: ${my.error}. Showing the last data.`} /> : null}

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
            <Text style={T.dim}>Winnings and refunds land here after each round. Only available SOL can be withdrawn.</Text>
            <Text style={styles.sub}>TOP UP & PLAY</Text>
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
            <Text style={T.dim}>
              One approval: deposit, a 24 h session for this phone with a limit equal to the top up (max 0.1 SOL per bet), and{' '}
              {formatSol(SESSION_RULES.gasTopUp)} SOL for the session key's fees when it is low.
            </Text>
            <Btn
              kind="ghost"
              title={checking('withdraw') ? 'CHECKING WITHDRAW' : `WITHDRAW ALL AVAILABLE (${formatSol(available)} SOL)`}
              busy={wallet.busy === 'withdraw' || checking('withdraw')}
              disabled={busy || available <= 0n}
              onPress={() => void wallet.withdrawAll(available)}
            />
          </View>

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
            {rows.length > 0 && !rows.some((r) => r.mine) ? <Text style={T.dim}>No session on this phone yet.</Text> : null}
            <Text style={T.dim}>A session lets one phone bet from your game balance. It can never withdraw.</Text>
          </View>

          <View style={T.panel}>
            <Text style={T.label}>DEVICE KEY (THIS PHONE)</Text>
            <KV k="SOL on the key" v={keyLamports !== null ? sol(keyLamports, { maxDecimals: 5 }) : '...'} />
            <Text style={T.dim}>Pays bet fees and position rent. Not part of the game balance.</Text>
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
                {sessionKeyError ? `Session key unavailable: ${sessionKeyError}` : 'Loading the session key...'}
              </Text>
            )}
          </View>

          <View style={T.panel}>
            <Text style={T.label}>DEVNET TEST SOL</Text>
            <Btn kind="ghost" title="AIRDROP 1 DEVNET SOL" busy={wallet.busy === 'airdrop'} disabled={busy} onPress={() => void wallet.airdrop()} />
            <Text style={T.dim}>The public devnet faucet is rate limited. If the airdrop fails, use the web faucet with your wallet address.</Text>
            <ExtLink label="faucet.solana.com" url={FAUCET_URL} />
          </View>
        </>
      ) : null}

      {result && result.action !== 'connect' ? (
        <View style={styles.result}>
          <Banner tone={result.ok ? 'ok' : result.checking ? 'info' : 'error'} text={result.message} />
          {result.signature ? <ExtLink label="View transaction on Explorer" url={explorer.tx(result.signature)} /> : null}
        </View>
      ) : null}
      {result && result.action === 'connect' && !result.ok ? <Banner tone="error" text={result.message} /> : null}

      <View style={styles.row}>
        <ExtLink label="Program on Explorer" url={explorer.address(PROGRAM_ID)} />
      </View>
    </ScrollView>
  );
}

/** One session: which device, how long, how much; REVOKE while it can still bet. */
function SessionLine({
  row,
  checking,
  spinning,
  disabled,
  onRevoke,
}: {
  row: SessionRow;
  checking: boolean;
  spinning: boolean;
  disabled: boolean;
  onRevoke: () => void;
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
        {when} · max {formatSol(row.maxPerBet)} per bet
      </Text>
      <View style={styles.between}>
        <Text style={styles.meta}>
          spent {formatSol(row.spent)} / {formatSol(row.budget)} SOL
        </Text>
        {row.revocable ? (
          <Btn kind="danger" small title={checking ? 'CHECKING' : 'REVOKE'} busy={checking || spinning} disabled={disabled} onPress={onRevoke} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 12, paddingBottom: 28 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  address: { color: C.white, fontFamily: 'monospace', fontSize: 14, fontWeight: '800' },
  row: { flexDirection: 'row', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  flex: { flex: 1 },
  sub: { color: C.label, fontSize: 10, fontWeight: '900', marginTop: 6 },
  result: { gap: 6 },
  session: { borderWidth: 1, borderColor: C.borderSoft, backgroundColor: C.panelDeep, padding: 8, gap: 3 },
  sessionMine: { borderColor: C.accent },
  device: { color: C.white, fontSize: 12, fontWeight: '900', fontFamily: MONO, flexShrink: 1 },
  meta: { color: C.subtle, fontSize: 11, fontFamily: MONO },
  warn: { color: C.warn, fontSize: 10 },
});
