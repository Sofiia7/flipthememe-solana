// Native modules added after the first dev client build (audio, sharing, view-shot, gradients).
// The JS bundle must keep running on a client built without them, so each one is required
// only after checking that its native side is present, and every caller has a fallback.
import { requireOptionalNativeModule } from 'expo';
import { TurboModuleRegistry } from 'react-native';

function expoModule(name: string): boolean {
  try {
    return requireOptionalNativeModule(name) != null;
  } catch {
    return false;
  }
}

function turboModule(name: string): boolean {
  try {
    return TurboModuleRegistry.get(name) != null;
  } catch {
    return false;
  }
}

function load<T>(present: () => boolean, get: () => T): () => T | null {
  let cached: T | null | undefined;
  return () => {
    if (cached === undefined) {
      cached = null;
      if (present()) {
        try {
          cached = get();
        } catch {
          cached = null;
        }
      }
    }
    return cached;
  };
}

export const audioModule = load(
  () => expoModule('ExpoAudio'),
  () => require('expo-audio') as typeof import('expo-audio'),
);

export const sharingModule = load(
  () => expoModule('ExpoSharing'),
  () => require('expo-sharing') as typeof import('expo-sharing'),
);

export const viewShotModule = load(
  () => turboModule('RNViewShot'),
  () => require('react-native-view-shot') as typeof import('react-native-view-shot'),
);

export const gradientModule = load(
  () => expoModule('ExpoLinearGradient'),
  () => require('expo-linear-gradient') as typeof import('expo-linear-gradient'),
);
