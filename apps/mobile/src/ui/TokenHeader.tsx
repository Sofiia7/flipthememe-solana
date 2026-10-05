import { useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Address } from '@solana/kit';
import { explorer } from '../config';
import { useTokenInfo } from '../chain/useTokenInfo';
import { formatUsdCompact, poolAgeLabel, shortAddress } from '../lib/format';
import { C, MONO } from '../theme';

/** The arena token: logo, ticker and one line of signals. Tap opens the price source (the mainnet pool). */
export function TokenHeader({ mint, pool, nowMs }: { mint: Address | null; pool: Address | null; nowMs: number }) {
  const info = useTokenInfo(mint, pool);
  const [imageFailed, setImageFailed] = useState(false);
  if (!mint) {
    return (
      <View style={styles.row}>
        <View style={[styles.logo, styles.logoEmpty]}>
          <Text style={styles.logoLetter}>?</Text>
        </View>
        <Text style={styles.waiting}>Picking the hottest fresh coin...</Text>
      </View>
    );
  }
  const symbol = info?.symbol ?? shortAddress(mint);
  const poolAge = poolAgeLabel(info?.pairCreatedAt, nowMs);
  const signals = [poolAge, info?.liquidityUsd != null ? `liq ${formatUsdCompact(info.liquidityUsd)}` : null, info?.txnsM5 != null ? `${info.txnsM5} tx/5m` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      style={styles.row}
      onPress={() => pool && void Linking.openURL(explorer.dexscreener(pool)).catch(() => undefined)}
      accessibilityRole="link"
      accessibilityLabel={`$${symbol}, price source on Solana mainnet`}
    >
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
          {signals || 'fresh from pump.fun'}
        </Text>
      </View>
      <Text style={styles.badge}>ARENA{'\n'}TOKEN</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { width: 40, height: 40, backgroundColor: C.panel, borderWidth: 2, borderColor: C.neonPurple },
  logoEmpty: { alignItems: 'center', justifyContent: 'center' },
  logoLetter: { color: C.accentText, fontSize: 18, fontWeight: '900' },
  waiting: { color: C.subtle, fontSize: 13, fontWeight: '800' },
  texts: { flex: 1, gap: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  symbol: { color: C.white, fontSize: 24, fontWeight: '900', flexShrink: 1 },
  name: { color: C.subtle, fontSize: 11, flexShrink: 1 },
  meta: { color: C.neonYellow, fontSize: 11, fontWeight: '800', fontFamily: MONO },
  badge: {
    color: C.neonPink,
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '900',
    textAlign: 'center',
    borderWidth: 1,
    borderColor: C.neonPink,
    paddingHorizontal: 5,
    paddingVertical: 3,
    fontFamily: MONO,
  },
});
