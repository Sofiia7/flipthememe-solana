// Path math for the price chart, kept free of React Native so node:test covers it.

export type XY = { x: number; y: number };

const pt = (p: XY) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;

/** "M x y L x y ..." through the points. */
export function linePath(points: readonly XY[]): string {
  let d = '';
  points.forEach((p, i) => {
    d += `${i === 0 ? 'M' : 'L'}${pt(p)}`;
  });
  return d;
}

/** The area under a line down to `baseY` (the chart floor); empty below two points. */
export function areaPath(points: readonly XY[], baseY: number): string {
  if (points.length < 2) return '';
  const first = points[0];
  const last = points[points.length - 1];
  return `${linePath(points)}L${pt({ x: last.x, y: baseY })}L${pt({ x: first.x, y: baseY })}Z`;
}

/**
 * The price line split at a horizontal level (screen y of the strike): the parts above it and the
 * parts below it as two SVG paths, cut exactly where the line crosses. Drawing two coloured paths
 * replaces clip paths, which react-native-svg on Android kept at an old height after the chart
 * rescaled, so the line turned red above the strike.
 */
export function splitAtLevel(points: readonly XY[], level: number): { above: string; below: string } {
  const parts = { above: '', below: '' };
  // On the level counts as above: smaller y is a higher price.
  const sideOf = (p: XY) => (p.y <= level ? 'above' : 'below');
  let prev: XY | null = null;
  for (const p of points) {
    const side = sideOf(p);
    if (!prev) {
      parts[side] += `M${pt(p)}`;
    } else if (sideOf(prev) === side) {
      parts[side] += `L${pt(p)}`;
    } else {
      const t = (level - prev.y) / (p.y - prev.y);
      const cross = { x: prev.x + t * (p.x - prev.x), y: level };
      parts[sideOf(prev)] += `L${pt(cross)}`;
      parts[side] += `M${pt(cross)}L${pt(p)}`;
    }
    prev = p;
  }
  return parts;
}

/** `splitAtLevel` for a line broken into pieces (see `splitAtGaps`): each piece split on its own, the paths joined. */
export function splitLinesAtLevel(lines: readonly (readonly XY[])[], level: number): { above: string; below: string } {
  const parts = lines.map((line) => splitAtLevel(line, level));
  return { above: parts.map((p) => p.above).join(''), below: parts.map((p) => p.below).join('') };
}

/**
 * Splits a series (oldest first) wherever two neighbours lie more than `maxGap` apart, so a pause in
 * the data (app in the background, another tab open) shows as a gap instead of a straight line.
 */
export function splitAtGaps<T>(items: readonly T[], timeOf: (item: T) => number, maxGap: number): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let last = 0;
  for (const item of items) {
    const t = timeOf(item);
    if (current.length > 0 && t - last > maxGap) {
      out.push(current);
      current = [];
    }
    current.push(item);
    last = t;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Width of a monospace label: every glyph is about 0.6 em wide. Used to keep SVG labels inside the chart. */
export function monoTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.6;
}

type WindowView = { range: readonly [number, number]; label: string; strong?: boolean } | null | undefined;

/** The props of the price chart that change its drawing: a structural view, so this file stays free of React Native. */
export type ChartPropsView = {
  points: readonly unknown[];
  nowMs: number;
  strike?: bigint | null;
  strikeLabel?: string;
  pairLabel?: string;
  strikeWindow?: WindowView;
  exitWindow?: readonly [number, number] | null;
  cutoffMs?: number | null;
  stale?: boolean;
  height?: number;
  emptyText?: string;
};

const sameWindow = (a: WindowView, b: WindowView): boolean =>
  a === b || (!!a && !!b && a.range[0] === b.range[0] && a.range[1] === b.range[1] && a.label === b.label && (a.strong ?? true) === (b.strong ?? true));

const sameRange = (a: readonly [number, number] | null | undefined, b: readonly [number, number] | null | undefined): boolean =>
  a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);

/**
 * `React.memo` comparison for the price chart. The arena re-renders every 500 ms and builds fresh window
 * objects each time, so values are compared, not identities; the clock counts in whole seconds (the chart
 * slides about 3 px a second, so a half second step is not worth a redraw of the whole SVG).
 */
export function chartPropsEqual(a: ChartPropsView, b: ChartPropsView): boolean {
  return (
    a.points === b.points &&
    Math.floor(a.nowMs / 1000) === Math.floor(b.nowMs / 1000) &&
    a.strike === b.strike &&
    a.strikeLabel === b.strikeLabel &&
    a.pairLabel === b.pairLabel &&
    sameWindow(a.strikeWindow, b.strikeWindow) &&
    sameRange(a.exitWindow, b.exitWindow) &&
    (a.cutoffMs ?? null) === (b.cutoffMs ?? null) &&
    !!a.stale === !!b.stale &&
    a.height === b.height &&
    a.emptyText === b.emptyText
  );
}
