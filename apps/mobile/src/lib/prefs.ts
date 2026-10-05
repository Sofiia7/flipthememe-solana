import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createBoolStore, type BoolStore } from './boolStore';

/** Sound effects off (Profile). */
export const soundMuted = createBoolStore(AsyncStorage, 'ftm.sound.muted.v1', false);
/** Live X chatter raining over the arena (Profile), on by default. */
export const chatterOn = createBoolStore(AsyncStorage, 'ftm.chatter.on.v1', true);
/** The "How it works" sheet opens by itself once, on the first launch. */
export const howItWorksSeen = createBoolStore(AsyncStorage, 'ftm.howitworks.seen.v1', false);

/** Reads the stored values once at start. */
export function loadPrefs(): void {
  void soundMuted.load();
  void chatterOn.load();
  void howItWorksSeen.load();
}

/** The current value and whether the stored one has been read yet. */
export function useBoolStore(store: BoolStore): { value: boolean; loaded: boolean } {
  const snap = useSyncExternalStore(store.subscribe, store.snapshot);
  return { value: (snap & 1) === 1, loaded: (snap & 2) === 2 };
}
