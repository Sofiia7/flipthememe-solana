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
