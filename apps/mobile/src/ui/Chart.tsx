import { useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import type { PricePoint } from '../chain/usePoolPrice';
import { C, MONO } from '../theme';
import { splitAtLevel } from './chartPath';

type Props = {
  points: readonly PricePoint[];
  nowMs: number;
  /** Fixed strike of the round the chart follows (same units as the pool price). */
  strike?: bigint | null;
  /** "STRIKE #101" */
  strikeLabel?: string;
  /**
   * The strike window with its label ("STRIKE IN 0:12"): strong while the strike is being fixed,
   * faint afterwards to show where the strike line comes from.
   */
  strikeWindow?: { range: readonly [number, number]; label: string; strong?: boolean } | null;
  /** Exit window of the followed round (local ms): the price there decides the result. */
  exitWindow?: readonly [number, number] | null;
  /** Local ms when the open round's entry closes. */
  cutoffMs?: number | null;
  stale?: boolean;
  height?: number;
  emptyText?: string;
};

const PAST_MS = 90_000;
const PAD_TOP = 16;
const PAD_BOTTOM = 16;
const AHEAD_MAX_MS = 110_000;

/** Live mainnet price: the strike as a dashed line with green above and red below, plus the round's windows. */
export function PriceChart({ points, nowMs, strike, strikeLabel, strikeWindow, exitWindow, cutoffMs, stale, height = 150, emptyText }: Props) {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));

  const start = nowMs - PAST_MS;
  let end = nowMs + 20_000;
  const reach = (ms: number | null | undefined) => {
    if (ms && ms > nowMs) end = Math.max(end, Math.min(ms + 5_000, nowMs + AHEAD_MAX_MS));
  };
  reach(exitWindow?.[1]);
  reach(strikeWindow?.range[1]);
  reach(cutoffMs);

  const visible = points.filter((p) => p.atMs >= start - 3_000 && p.atMs <= nowMs + 1_000);
  const values = visible.map((p) => Number(p.price));
  const strikeValue = strike != null && strike > 0n ? Number(strike) : null;
  // The strike is part of the range, so its line is always on the chart.
  if (strikeValue !== null) values.push(strikeValue);
  let min = values.length ? Math.min(...values) : 0;
  let max = values.length ? Math.max(...values) : 1;
  const span = max - min;
  const pad = span > 0 ? span * 0.2 : Math.max(Math.abs(max) * 0.0005, 1);
  min -= pad;
  max += pad;

  const plotH = height - PAD_TOP - PAD_BOTTOM;
  const x = (ms: number) => ((ms - start) / (end - start)) * width;
  const y = (v: number) => PAD_TOP + (1 - (v - min) / (max - min)) * plotH;

  const last = visible[visible.length - 1];
  const lastValue = last ? Number(last.price) : null;
  const above = strikeValue !== null && lastValue !== null ? (lastValue > strikeValue ? true : lastValue < strikeValue ? false : null) : null;
  const dotColor = stale ? C.dim : above === true ? C.neonGreen : above === false ? C.neonRed : strikeValue !== null ? C.neonYellow : C.accentText;

  const xy = visible.map((p) => ({ x: x(p.atMs), y: y(Number(p.price)) }));
  let d = '';
  xy.forEach((p, i) => {
    d += `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  });
  const first = visible[0];
  const area = d && first && last ? `${d}L${x(last.atMs).toFixed(1)} ${PAD_TOP + plotH}L${x(first.atMs).toFixed(1)} ${PAD_TOP + plotH}Z` : '';

  const band = (range: readonly [number, number] | null | undefined, color: string, label: string, strong: boolean) => {
    if (!range || width === 0) return null;
    const x0 = Math.max(0, x(range[0]));
    const x1 = Math.min(width, x(range[1]));
    if (x1 <= 0 || x0 >= width || x1 <= x0) return null;
    const labelRight = x0 + 2 + label.length * 5.6 > width;
    return (
      <G>
        <Rect x={x0} y={PAD_TOP} width={x1 - x0} height={plotH} fill={color} opacity={strong ? 0.26 : 0.16} />
        {strong ? (
          <>
            <Line x1={x0} x2={x0} y1={PAD_TOP} y2={PAD_TOP + plotH} stroke={color} strokeWidth={1} />
            <Line x1={x1} x2={x1} y1={PAD_TOP} y2={PAD_TOP + plotH} stroke={color} strokeWidth={1} />
          </>
        ) : null}
        <SvgText
          x={labelRight ? x1 - 2 : x0 + 2}
          y={PAD_TOP - 5}
          fill={color}
          fontSize={strong ? 10 : 8}
          fontWeight="bold"
          fontFamily={MONO}
          textAnchor={labelRight ? 'end' : 'start'}
        >
          {label}
        </SvgText>
      </G>
    );
  };

  const sy = strikeValue !== null ? y(strikeValue) : null;
  const split = sy !== null ? splitAtLevel(xy, sy) : null;
  const ticks = [-60_000, 0].map((offset) => ({ ms: nowMs + offset, label: offset === 0 ? 'now' : '-1m' }));
  const strikeTag = strikeLabel ?? 'STRIKE';
  const tagW = strikeTag.length * 6 + 8;
  const tagY = sy !== null ? (sy - 16 < 2 ? sy + 3 : sy - 16) : 0;

  return (
    <View style={[styles.box, { height }]} onLayout={onLayout}>
      {width > 0 ? (
        <Svg width={width} height={height}>
          <Defs>
            <LinearGradient id="ftmArea" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={C.neonPurple} stopOpacity={0.35} />
              <Stop offset="1" stopColor={C.neonPurple} stopOpacity={0} />
            </LinearGradient>
          </Defs>

          {sy !== null ? (
            <>
              <Rect x={0} y={PAD_TOP} width={width} height={Math.max(0, sy - PAD_TOP)} fill={C.up} opacity={0.1} />
              <Rect x={0} y={sy} width={width} height={Math.max(0, PAD_TOP + plotH - sy)} fill={C.down} opacity={0.1} />
            </>
          ) : null}
          {[0.25, 0.5, 0.75].map((f) => (
            <Line key={f} x1={0} x2={width} y1={PAD_TOP + plotH * f} y2={PAD_TOP + plotH * f} stroke={C.borderSoft} strokeWidth={1} opacity={0.6} />
          ))}

          {band(strikeWindow?.range, C.neonYellow, strikeWindow?.label ?? '', strikeWindow?.strong ?? true)}
          {band(exitWindow, C.neonPurple, 'RESULT', false)}
          {cutoffMs && cutoffMs > start && cutoffMs < end ? (
            <>
              <Line x1={x(cutoffMs)} x2={x(cutoffMs)} y1={PAD_TOP} y2={PAD_TOP + plotH} stroke={C.gold} strokeWidth={1} strokeDasharray="3 3" />
              <SvgText x={x(cutoffMs) - 3} y={height - 4} fill={C.gold} fontSize={8} fontWeight="bold" fontFamily={MONO} textAnchor="end">
                ENTRY CLOSES
              </SvgText>
            </>
          ) : null}
          <Line x1={x(nowMs)} x2={x(nowMs)} y1={PAD_TOP} y2={PAD_TOP + plotH} stroke={C.border} strokeWidth={1} />

          {d && split ? (
            <>
              {split.above ? <Path d={split.above} stroke={stale ? C.dim : C.neonGreen} strokeWidth={2.5} fill="none" strokeLinejoin="round" /> : null}
              {split.below ? <Path d={split.below} stroke={stale ? C.dim : C.neonRed} strokeWidth={2.5} fill="none" strokeLinejoin="round" /> : null}
            </>
          ) : d ? (
            <>
              <Path d={area} fill="url(#ftmArea)" />
              <Path d={d} stroke={stale ? C.dim : C.accentText} strokeWidth={2.5} fill="none" strokeLinejoin="round" />
            </>
          ) : null}

          {sy !== null ? (
            <>
              <Line x1={0} x2={width} y1={sy} y2={sy} stroke={C.white} strokeWidth={1.5} strokeDasharray="6 4" opacity={0.9} />
              <Rect x={2} y={tagY} width={tagW} height={13} fill={C.bg} opacity={0.85} />
              <SvgText x={6} y={tagY + 10} fill={C.white} fontSize={9} fontWeight="bold" fontFamily={MONO}>
                {strikeTag}
              </SvgText>
            </>
          ) : null}

          {last ? (
            <>
              <Circle cx={x(last.atMs)} cy={y(Number(last.price))} r={8} fill={dotColor} opacity={0.25} />
              <Circle cx={x(last.atMs)} cy={y(Number(last.price))} r={4} fill={dotColor} />
            </>
          ) : null}
          {ticks.map((t) =>
            t.ms >= start && t.ms <= end ? (
              <SvgText
                key={t.label}
                x={Math.min(width - 2, Math.max(2, x(t.ms)))}
                y={height - 4}
                fill={C.dim}
                fontSize={8}
                fontFamily={MONO}
                textAnchor="middle"
              >
                {t.label}
              </SvgText>
            ) : null,
          )}
        </Svg>
      ) : null}
      {stale && visible.length >= 2 ? <Text style={styles.stale}>PRICE STALE</Text> : null}
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
  stale: { position: 'absolute', top: 3, right: 6, color: C.warn, fontSize: 9, fontWeight: '900', fontFamily: MONO },
});
