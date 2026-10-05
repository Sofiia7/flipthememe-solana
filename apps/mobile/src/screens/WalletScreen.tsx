import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { PROGRAM_ID } from '@flipthememe/client';
import { FAUCET_URL, SESSION_RULES, TOP_UP_AMOUNTS, explorer } from '../config';
import { chainNowSec } from '../chain/useChainClock';
import { formatDuration, formatSol, shortAddress, sol } from '../lib/format';
import { useNow } from '../lib/usePolling';
import { sessionStatusOf, useApp } from '../state/AppProvider';
import { C, T } from '../theme';
import { Banner, Btn, ExtLink, KV, Pill } from '../ui/common';

const STATUS_TEXT = {
  none: 'No session yet',
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
  'used-up': 'Limit used up',
} as const;

export function WalletScreen() {
  const { wallet, my, myReady, sessionKey, sessionKeyError, offsetSec, arena } = useApp();
  const nowMs = useNow(1_000);
  const nowSec = chainNowSec(offsetSec, nowMs);
  const owner = wallet.owner;
  const busy = wallet.busy !== null;
  const [copied, setCopied] = useState(false);

  const minStake = arena.config?.minStake ?? 10_000_000n;
  const status = sessionStatusOf(my.session, nowSec, minStake);
  const available = my.vault?.available ?? 0n;
  const locked = my.vault?.locked ?? 0n;
  const result = wallet.result;

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
            <Text style={T.dim}>
              One approval: deposit, a 24 h session for this phone with a limit equal to the top up (max 0.1 SOL per bet), and{' '}
              {formatSol(SESSION_RULES.gasTopUp)} SOL for the session key's fees when it is low.
            </Text>
            <Btn
              kind="ghost"
              title={`WITHDRAW ALL AVAILABLE (${formatSol(available)} SOL)`}
              busy={wallet.busy === 'withdraw'}
              disabled={busy || available <= 0n}
              onPress={() => void wallet.withdrawAll(available)}
            />
          </View>

          <View style={T.panel}>
            <Text style={T.label}>PLAY SESSION ON THIS PHONE</Text>
            <KV k="Status" v={myReady ? STATUS_TEXT[status] : '...'} tone={status === 'active' ? 'up' : 'gold'} />
            {my.session ? (
              <>
                <KV
                  k="Expires in"
                  v={status === 'active' || status === 'used-up' ? formatDuration(Number(my.session.expiry) - nowSec) : '-'}
                />
                <KV k="Spent of limit" v={`${formatSol(my.session.spent)} / ${formatSol(my.session.sessionCap)} SOL`} />
                <KV k="Max per bet" v={sol(my.session.maxPerBet)} />
              </>
            ) : null}
            <KV k="Session key fees (gas)" v={my.keyLamports !== null ? sol(my.keyLamports, { maxDecimals: 5 }) : '...'} />
            {sessionKey ? (
              <View style={styles.row}>
                <Text style={T.dim}>Key {shortAddress(sessionKey.address)}</Text>
                <ExtLink label="Key on Explorer" url={explorer.address(sessionKey.address)} />
                {my.sessionAddress && my.session ? <ExtLink label="Session account" url={explorer.address(my.sessionAddress)} /> : null}
              </View>
            ) : (
              <Text style={[T.dim, sessionKeyError ? { color: C.danger } : null]}>
                {sessionKeyError ? `Session key unavailable: ${sessionKeyError}` : 'Loading the session key...'}
              </Text>
            )}
            <Text style={T.dim}>
              The session key lives in this phone's secure storage. It can only place bets within the limit; it cannot withdraw or change
              limits.
            </Text>
            <Btn
              kind="danger"
              small
              title="REVOKE SESSION"
              busy={wallet.busy === 'revoke'}
              disabled={busy || !my.session || my.session.revoked}
              onPress={() => void wallet.revoke()}
            />
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
          <Banner tone={result.ok ? 'ok' : 'error'} text={result.message} />
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

const styles = StyleSheet.create({
  page: { padding: 16, gap: 12, paddingBottom: 28 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  address: { color: C.white, fontFamily: 'monospace', fontSize: 14, fontWeight: '800' },
  row: { flexDirection: 'row', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  flex: { flex: 1 },
  sub: { color: C.label, fontSize: 10, fontWeight: '900', marginTop: 6 },
  result: { gap: 6 },
});
