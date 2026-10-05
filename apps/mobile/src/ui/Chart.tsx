import { useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import type { PricePoint } from '../chain/usePoolPrice';
import { C, MONO } from '../theme';

export type ChartWindows = {
  /** Local ms ranges of the relevant round's strike and exit windows. */
  strike?: readonly [number, number];
  exit?: readonly [number, number];
};

type Props = {
  points: readonly PricePoint[];
  nowMs: number;
  /** Strike price of the most relevant in-flight round (same pool). */
  strike?: bigint | null;
  windows?: ChartWindows;
  /** Local ms when the open round's entry closes. */
  cutoffMs?: number | null;
  stale?: boolean;
  height?: number;
  emptyText?: string;
};

const PAST_MS = 120_000;
const PAD_TOP = 14;
const PAD_BOTTOM = 16;

/** Live mainnet price with the strike line and the strike / exit windows. */
export function PriceChart({ points, nowMs, strike, windows, cutoffMs, stale, height = 168, emptyText }: Props) {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));

  const start = nowMs - PAST_MS;
  let end = nowMs + 20_000;
  if (windows?.exit && windows.exit[1] > nowMs) end = Math.max(end, Math.min(windows.exit[1] + 5_000, nowMs + 110_000));
  if (cutoffMs && cutoffMs > nowMs) end = Math.max(end, Math.min(cutoffMs + 5_000, nowMs + 110_000));

  const visible = points.filter((p) => p.atMs >= start - 3_000 && p.atMs <= nowMs + 1_000);
  const values = visible.map((p) => Number(p.price));
  const strikeValue = strike != null && strike > 0n ? Number(strike) : null;
  if (strikeValue !== null) values.push(strikeValue);
  let min = values.length ? Math.min(...values) : 0;
  let max = values.length ? Math.max(...values) : 1;
  const span = max - min;
  const pad = span > 0 ? span * 0.18 : Math.max(Math.abs(max) * 0.0005, 1);
  min -= pad;
  max += pad;

  const plotH = height - PAD_TOP - PAD_BOTTOM;
  const x = (ms: number) => ((ms - start) / (end - start)) * width;
  const y = (v: number) => PAD_TOP + (1 - (v - min) / (max - min)) * plotH;

  const last = visible[visible.length - 1];
  const reference = strikeValue ?? (visible.length ? Number(visible[0].price) : null);
  const rising = last && reference !== null ? Number(last.price) >= reference : true;
  const lineColor = stale ? C.dim : rising ? C.up : C.down;

  let d = '';
  visible.forEach((p, i) => {
    d += `${i === 0 ? 'M' : 'L'}${x(p.atMs).toFixed(1)} ${y(Number(p.price)).toFixed(1)}`;
  });

  const band = (range: readonly [number, number] | undefined, color: string, label: string) => {
    if (!range || width === 0) return null;
    const x0 = Math.max(0, x(range[0]));
    const x1 = Math.min(width, x(range[1]));
    if (x1 <= 0 || x0 >= width || x1 <= x0) return null;
    return (
      <>
        <Rect x={x0} y={PAD_TOP} width={x1 - x0} height={plotH} fill={color} opacity={0.22} />
        <SvgText x={x0 + 2} y={PAD_TOP - 4} fill={color} fontSize={8} fontWeight="bold" fontFamily={MONO}>
          {label}
        </SvgText>
      </>
    );
  };

  const ticks = [-120_000, -60_000, 0].map((offset) => ({ ms: nowMs + offset, label: offset === 0 ? 'now' : `${offset / 60_000}m` }));

  return (
    <View style={[styles.box, { height }]} onLayout={onLayout}>
      {width > 0 ? (
        <Svg width={width} height={height}>
          {[0.25, 0.5, 0.75].map((f) => (
            <Line key={f} x1={0} x2={width} y1={PAD_TOP + plotH * f} y2={PAD_TOP + plotH * f} stroke={C.borderSoft} strokeWidth={1} />
          ))}
          {band(windows?.strike, C.gold, 'STRIKE')}
          {band(windows?.exit, C.accentSoft, 'EXIT')}
          {cutoffMs && cutoffMs > start && cutoffMs < end ? (
            <>
              <Line x1={x(cutoffMs)} x2={x(cutoffMs)} y1={PAD_TOP} y2={PAD_TOP + plotH} stroke={C.gold} strokeWidth={1} strokeDasharray="3 3" />
              <SvgText x={x(cutoffMs) - 2} y={height - 4} fill={C.gold} fontSize={8} fontWeight="bold" fontFamily={MONO} textAnchor="end">
                ENTRY CLOSES
              </SvgText>
            </>
          ) : null}
          <Line x1={x(nowMs)} x2={x(nowMs)} y1={PAD_TOP} y2={PAD_TOP + plotH} stroke={C.border} strokeWidth={1} />
          {strikeValue !== null ? (
            <>
              <Line x1={0} x2={width} y1={y(strikeValue)} y2={y(strikeValue)} stroke={C.white} strokeWidth={1} strokeDasharray="5 3" opacity={0.8} />
              <SvgText x={4} y={y(strikeValue) - 3} fill={C.white} fontSize={8} fontWeight="bold" fontFamily={MONO}>
                STRIKE
              </SvgText>
            </>
          ) : null}
          {d ? <Path d={d} stroke={lineColor} strokeWidth={2} fill="none" strokeLinejoin="round" /> : null}
          {last ? <Circle cx={x(last.atMs)} cy={y(Number(last.price))} r={3} fill={lineColor} /> : null}
          {ticks.map((t) =>
            t.ms >= start && t.ms <= end ? (
              <SvgText key={t.label} x={Math.min(width - 2, Math.max(2, x(t.ms)))} y={height - 4} fill={C.dim} fontSize={8} fontFamily={MONO} textAnchor={t.label === 'now' ? 'middle' : 'start'}>
                {t.label}
              </SvgText>
            ) : null,
          )}
        </Svg>
      ) : null}
      {visible.length < 2 ? (
        <View style={styles.empty} pointerEvents="none">
          <Text style={styles.emptyText}>{emptyText ?? 'Reading the live price...'}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: C.chart, borderWidth: 1, borderColor: '#3a3350', overflow: 'hidden' },
  empty: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: C.subtle, fontSize: 11, fontWeight: '700' },
});
