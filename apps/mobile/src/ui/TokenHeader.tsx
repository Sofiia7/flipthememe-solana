import { useEffect, useState } from 'react';
import { Image, Linking, PixelRatio, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import type { Address } from '@solana/kit';
import { explorer } from '../config';
import { useTokenInfo } from '../chain/useTokenInfo';
import { formatUsdCompact, poolAgeLabel, shortAddress } from '../lib/format';
import { C, FONT_CAP, MONO } from '../theme';
import { PixelText } from './PixelText';

/** Width of one character of the 11sp monospace meta line, in dp at the default font size. */
const META_CHAR_W = 6.7;

/** "1 trade in 5 min", "23 trades in 5 min". */
function tradesText(count: number): string {
  return `${count} ${count === 1 ? 'trade' : 'trades'} in 5 min`;
}

/**
 * The arena token: logo, ticker and one quiet line of signals (pool age, trades in 5 min, liquidity when
 * there is room). Tap opens the price source (the mainnet pool).
 */
export function TokenHeader({ mint, pool, nowMs }: { mint: Address | null; pool: Address | null; nowMs: number }) {
  const info = useTokenInfo(mint, pool);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [mint, info?.imageUrl]);
  const [metaWidth, setMetaWidth] = useState(0);
  const onTextsLayout = (e: LayoutChangeEvent) => setMetaWidth(Math.round(e.nativeEvent.layout.width));
  if (!mint) {
    return (
      <View style={styles.row}>
        <View style={[styles.logo, styles.logoEmpty]}>
          <Text style={styles.logoLetter}>?</Text>
        </View>
        <Text style={styles.waiting} maxFontSizeMultiplier={FONT_CAP}>
          Checking markets...
        </Text>
      </View>
    );
  }
  const symbol = info?.symbol ?? shortAddress(mint);
  const poolAge = poolAgeLabel(info?.pairCreatedAt, nowMs);
  const trades = info?.txnsM5 != null ? tradesText(info.txnsM5) : null;
  const signals = [poolAge, trades].filter(Boolean).join(' · ');
  // Liquidity is the first signal to go: it is added only when the whole line fits at this font size.
  const withLiquidity = info?.liquidityUsd != null ? `${signals}${signals ? ' · ' : ''}liq ${formatUsdCompact(info.liquidityUsd)}` : signals;
  const room = metaWidth >= withLiquidity.length * META_CHAR_W * Math.max(1, Math.min(FONT_CAP, PixelRatio.getFontScale()));
  const meta = room ? withLiquidity : signals;
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
      <View style={styles.texts} onLayout={onTextsLayout}>
        <View style={styles.titleRow}>
          <View style={{ flexShrink: 1, maxWidth: '100%', flex: 1 }}><PixelText text={`$${symbol}`} size={2.6} color={C.white} fit style={{ alignItems: 'flex-start' }} /></View>
        </View>
        <Text style={styles.meta} numberOfLines={1} maxFontSizeMultiplier={FONT_CAP}>
          {meta || 'busy pump.fun coin'}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { width: 40, height: 40, backgroundColor: C.panel, borderWidth: 2, borderColor: C.neonPurple },
  logoEmpty: { alignItems: 'center', justifyContent: 'center' },
  logoLetter: { color: C.accentText, fontSize: 18, fontWeight: '900' },
  waiting: { color: C.subtle, fontSize: 13, fontWeight: '800' },
  texts: { flex: 1, gap: 1 },
  titleRow: { minHeight: 28, justifyContent: 'center' },
  symbol: { color: C.white, fontSize: 24, fontWeight: '900', flexShrink: 1 },
  name: { color: C.subtle, fontSize: 12, flexShrink: 1 },
  // Context, not an action: quiet next to the money and the round stage.
  meta: { color: C.subtle, fontSize: 11, fontWeight: '700', fontFamily: MONO },
});
