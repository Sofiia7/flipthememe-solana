import { faceGrid, type Face } from '../face/faceModel.ts';

/** Native Android renders this persisted pixel grid without a network request or a running JS process. */
export function notificationFace(face: Face): string {
  return faceGrid(face).map(color => color ? `ff${color.slice(1)}` : '00000000').join(',');
}
