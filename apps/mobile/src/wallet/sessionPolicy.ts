import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { SESSION_RULES } from '../config';
export const SESSION_PRESETS = {
  short: { label: '1 hour · 1× turnover', durationSecs: 3600, capTurnoverFactor: 1n },
  day: { label: '1 day · 10× turnover', durationSecs: 86400, capTurnoverFactor: 10n },
  week: { label: '7 days · 100× turnover', durationSecs: SESSION_RULES.durationSecs, capTurnoverFactor: 100n },
} as const;
export type SessionPreset = keyof typeof SESSION_PRESETS;
let preset: SessionPreset = 'short';
let maxPerBet = 20_000_000n;
let choice: { preset: SessionPreset; maxPerBet: bigint; ready: boolean } = { preset, maxPerBet, ready: false };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let writes = Promise.resolve();
function publish() { choice = { preset, maxPerBet, ready: true }; for (const listener of listeners) listener(); }
const KEY = 'ftm.session-policy.v1';
export function sessionRules() { return { ...SESSION_RULES, ...SESSION_PRESETS[preset], maxPerBet }; }
export function sessionChoice() { return choice; }
export function useSessionChoice() { return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, sessionChoice); }
export async function loadSessionPolicy() {
  if (choice.ready) return;
  loading ??= (async () => { try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) { const s = JSON.parse(raw);
    if (s && Object.hasOwn(SESSION_PRESETS, s.preset) && ['20000000', '50000000', '100000000'].includes(s.maxPerBet)) { preset = s.preset; maxPerBet = BigInt(s.maxPerBet); } }
  } catch { /* a broken preference grants the conservative default */ }
  finally { publish(); } })();
  await loading;
}
export async function setSessionPolicy(next: SessionPreset, maximum: bigint) {
  if (!Object.hasOwn(SESSION_PRESETS, next) || ![20_000_000n, 50_000_000n, 100_000_000n].includes(maximum)) throw new Error('Invalid session preference');
  const write = writes.then(async () => {
    await loadSessionPolicy();
    await AsyncStorage.setItem(KEY, JSON.stringify({ preset: next, maxPerBet: String(maximum) }));
    preset = next; maxPerBet = maximum; publish();
  });
  writes = write.catch(() => undefined);
  await write;
}
