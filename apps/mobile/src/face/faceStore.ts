import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizeFace, parseStoredFace, randomFace, type Face } from './faceModel';

const STORE_KEY = 'ftm.face.v1';

/** The saved face, or a random one created (and saved) on first launch. */
export async function loadOrCreateFace(): Promise<Face> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    const parsed = raw ? parseStoredFace(JSON.parse(raw)) : null;
    if (parsed) return parsed;
  } catch {
    // Fall through to a new face.
  }
  const face = randomFace();
  await saveFace(face).catch(() => undefined);
  return face;
}

export async function saveFace(face: Face): Promise<void> {
  await AsyncStorage.setItem(STORE_KEY, JSON.stringify(normalizeFace(face)));
}
