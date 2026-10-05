import { memo } from 'react';
import { PixelRatio, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { GRID, faceGrid, faceKey, gridToPaths, houseGrid, type Expression, type Face } from './face/faceModel';

export {
  FACE_OPTIONS,
  faceFromBytes,
  faceToBytes,
  normalizeFace,
  randomFace,
  type Expression,
  type Face,
} from './face/faceModel';

type Paths = { color: string; d: string }[];
const pathCache = new Map<string, Paths>();
let housePaths: Paths | null = null;

/**
 * Snaps the drawn size so one logical pixel is a whole number of device pixels:
 * react-native-svg always anti-aliases, so aligned edges are what keeps the pixels crisp.
 */
function snappedSize(size: number): number {
  const ratio = PixelRatio.get();
  const k = Math.max(1, Math.round((size * ratio) / GRID));
  return (k * GRID) / ratio;
}

function facePaths(face: Face, expression: Expression | undefined): Paths {
  const key = `${faceKey(face)}${expression ?? ''}`;
  let paths = pathCache.get(key);
  if (!paths) {
    paths = gridToPaths(faceGrid(face, expression));
    pathCache.set(key, paths);
  }
  return paths;
}

function PixelCanvas({ paths, size, tile }: { paths: Paths; size: number; tile: boolean }) {
  const px = snappedSize(size);
  return (
    <View style={[{ width: px, height: px }, tile && styles.tile]}>
      <Svg width={px} height={px} viewBox={`0 0 ${GRID} ${GRID}`}>
        {paths.map(({ color, d }) => (
          <Path key={color} d={d} fill={color} />
        ))}
      </Svg>
    </View>
  );
}

/**
 * A compact pixel head (16x16 logical pixels): hair, face, accessory. Never a body.
 * `expression` (happy / sad) swaps the mouth for results; it is not part of the saved face.
 */
export const PixelFace = memo(function PixelFace({
  face,
  size = 32,
  tile = true,
  expression,
}: {
  face: Face;
  size?: number;
  tile?: boolean;
  expression?: Expression;
}) {
  // Paths are cached per face key and expression, so re-renders cost a map lookup.
  return <PixelCanvas paths={facePaths(face, expression)} size={size} tile={tile} />;
});

/** The house's marker in player lists: a pixel house, so it never reads as a person. */
export const HouseFace = memo(function HouseFace({ size = 32, tile = true }: { size?: number; tile?: boolean }) {
  if (!housePaths) housePaths = gridToPaths(houseGrid());
  return <PixelCanvas paths={housePaths} size={size} tile={tile} />;
});

const styles = StyleSheet.create({
  tile: { backgroundColor: '#29233c', overflow: 'hidden' },
});
