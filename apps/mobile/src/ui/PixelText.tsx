import { memo, useMemo, useState } from 'react';
import { PixelRatio, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { cellsToPath, textCells } from '../lib/pixelFont';

/**
 * Headline text in the 5x7 pixel font. `size` is dp per font pixel (snapped to whole device
 * pixels so edges stay crisp); `glow` draws a neon halo, `shadow` an arcade drop shadow.
 */
export const PixelText = memo(function PixelText({
  text,
  size = 3,
  color,
  glow,
  shadow,
  style,
  fit = false,
}: {
  text: string;
  size?: number;
  color: string;
  glow?: string;
  shadow?: string;
  style?: StyleProp<ViewStyle>;
  fit?: boolean;
}) {
  const [available, setAvailable] = useState(0);
  const ratio = PixelRatio.get();
  const px = Math.max(1, Math.round(size * ratio)) / ratio;
  const { width, height, d, shadowD } = useMemo(() => {
    const t = textCells(text);
    return { width: t.width, height: t.height, d: cellsToPath(t.cells, 1, 1), shadowD: cellsToPath(t.cells, 2, 2) };
  }, [text]);
  if (width === 0) return null;
  // SVG lettering cannot wrap. At enlarged system text sizes use native accessible text.
  if (PixelRatio.getFontScale() > 1.15) return <View style={style}><Text style={{ color, fontWeight: '900', fontSize: size * 7 }}>{text}</Text></View>;
  // One font pixel of padding on every side (two on the right and bottom for the shadow) keeps the glow unclipped.
  const vw = width + 3;
  const vh = height + 3;
  const scale = fit && available > 0 ? Math.min(px, Math.floor(available / vw * ratio) / ratio) : px;
  return (
    <View style={[fit ? { width: '100%', height: vh * scale, alignItems: 'center' } : { width: vw * px, height: vh * px }, style]} onLayout={fit ? (e) => setAvailable(e.nativeEvent.layout.width) : undefined} accessible accessibilityLabel={text}>
      <Svg width={vw * scale} height={vh * scale} viewBox={`0 0 ${vw} ${vh}`}>
        {glow ? <Path d={d} fill="none" stroke={glow} strokeWidth={1.6} strokeOpacity={0.16} strokeLinejoin="round" /> : null}
        {glow ? <Path d={d} fill="none" stroke={glow} strokeWidth={0.8} strokeOpacity={0.32} strokeLinejoin="round" /> : null}
        {shadow ? <Path d={shadowD} fill={shadow} /> : null}
        <Path d={d} fill={color} />
      </Svg>
    </View>
  );
});

/** A small pixel icon from rows of '#' and '.' (same crisp snapping as the font). */
export const PixelIcon = memo(function PixelIcon({ rows, size = 3, color }: { rows: readonly string[]; size?: number; color: string }) {
  const ratio = PixelRatio.get();
  const px = Math.max(1, Math.round(size * ratio)) / ratio;
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const d = useMemo(() => {
    const cells: [number, number][] = [];
    rows.forEach((row, y) => [...row].forEach((ch, x) => ch === '#' && cells.push([x, y])));
    return cellsToPath(cells);
  }, [rows]);
  return (
    <Svg width={w * px} height={h * px} viewBox={`0 0 ${w} ${h}`}>
      <Path d={d} fill={color} />
    </Svg>
  );
});
