import { useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Address } from '@solana/kit';
import { explorer } from '../config';
import { useTokenInfo } from '../chain/useTokenInfo';
import { formatAge, formatUsdCompact, shortAddress } from '../lib/format';
import { C } from '../theme';

const FRESH_MS = 7 * 24 * 60 * 60 * 1000;

export function TokenHeader({ mint, pool, nowMs }: { mint: Address | null; pool: Address | null; nowMs: number }) {
  const info = useTokenInfo(mint, pool);
  const [imageFailed, setImageFailed] = useState(false);
  const [explained, setExplained] = useState(false);
  if (!mint) {
    return (
      <View style={styles.row}>
        <View style={[styles.logo, styles.logoEmpty]} />
        <View style={styles.texts}>
          <Text style={styles.symbol}>Waiting for a token</Text>
          <Text style={styles.meta}>The keeper picks the most active fresh PumpSwap pool.</Text>
        </View>
      </View>
    );
  }
  const age = info?.pairCreatedAt ? nowMs - info.pairCreatedAt : null;
  const symbol = info?.symbol ?? shortAddress(mint);
  return (
    <View style={styles.block}>
    <View style={styles.row}>
      {info?.imageUrl && !imageFailed ? (
        <Image source={{ uri: info.imageUrl }} style={styles.logo} onError={() => setImageFailed(true)} />
      ) : (
        <View style={[styles.logo, styles.logoEmpty]}>
          <Text style={styles.logoLetter}>{symbol.slice(0, 1).toUpperCase()}</Text>
        </View>
      )}
      <View style={styles.texts}>
        <View style={styles.titleRow}>
          <Text style={styles.symbol} numberOfLines={1}>
            ${symbol}
          </Text>
          {info?.name ? (
            <Text style={styles.name} numberOfLines={1}>
              {info.name}
            </Text>
          ) : null}
        </View>
        <Text style={styles.meta} numberOfLines={1}>
          age {age !== null ? formatAge(age) : '-'} • liq {formatUsdCompact(info?.liquidityUsd)} • {info?.txnsM5 ?? '-'} trades / 5 min
        </Text>
        <Pressable onPress={() => pool && void Linking.openURL(explorer.mainnetAddress(pool)).catch(() => undefined)} hitSlop={4}>
          <Text style={styles.source} numberOfLines={1}>
            price: PumpSwap pool on Solana mainnet
            {age !== null && age > FRESH_MS ? ' • older pool (no fresh pool passed the filter)' : ''}
          </Text>
        </Pressable>
      </View>
      <Pressable onPress={() => setExplained((v) => !v)} hitSlop={8} style={styles.badge}>
        <Text style={styles.badgeText}>ARENA TOKEN</Text>
        <Text style={styles.badgeHelp}>{explained ? 'hide' : 'why this one?'}</Text>
      </Pressable>
    </View>
    {explained ? (
      <View style={styles.explain}>
        <Text style={styles.explainText}>
          One arena, one token: everyone calls the same coin, so there is always someone on the other side.
        </Text>
        <Text style={styles.explainText}>
          The keeper picks the most active fresh memecoin that graduated from pump.fun to a PumpSwap pool: under 7 days old,
          20+ trades in 5 minutes, at least 50 SOL in the pool. It stays at least 15 minutes, then the hottest coin takes over.
        </Text>
        <Text style={styles.explainText}>
          You never buy the token. You only call whether its pool price is UP or DOWN one minute after the strike.
        </Text>
      </View>
    ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  badge: { alignItems: 'flex-end', gap: 2 },
  badgeText: { color: C.accentText, fontSize: 10, fontWeight: '900', borderWidth: 1, borderColor: C.accentText, paddingHorizontal: 6, paddingVertical: 2 },
  badgeHelp: { color: C.dim, fontSize: 10, textDecorationLine: 'underline' },
  explain: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, padding: 10, gap: 6 },
  explainText: { color: C.text, fontSize: 12, lineHeight: 17 },
  logo: { width: 42, height: 42, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border },
  logoEmpty: { alignItems: 'center', justifyContent: 'center' },
  logoLetter: { color: C.accentText, fontSize: 18, fontWeight: '900' },
  texts: { flex: 1, gap: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  symbol: { color: C.white, fontSize: 22, fontWeight: '900', flexShrink: 1 },
  name: { color: C.subtle, fontSize: 11, flexShrink: 1 },
  meta: { color: C.text, fontSize: 11, fontWeight: '600' },
  source: { color: C.dim, fontSize: 10, textDecorationLine: 'underline' },
});
