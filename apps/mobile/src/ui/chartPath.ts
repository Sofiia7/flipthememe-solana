// Path math for the price chart, kept free of React Native so node:test covers it.

export type XY = { x: number; y: number };

const pt = (p: XY) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;

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
