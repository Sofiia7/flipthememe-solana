import AsyncStorage from '@react-native-async-storage/async-storage';
import { requestReport } from './requestLog';
/** Local only. No wallets, signatures, keys, URLs or error payloads are recorded. */
export type DiagnosticEvent = 'first_open' | 'app_open' | 'intent' | 'wallet_prepared' | 'bet_sent' | 'bet_confirmed' | 'bet_failed' | 'result' | 'invite_opened' | 'invite_shared' | 'storage_failed'
  // What became of a remembered first call (state/intent.ts): placed in its round, carried to the next round of the same coin, or why it was dropped.
  | 'intent_placed' | 'intent_carried' | 'intent_expired' | 'intent_token-changed' | 'intent_already-in' | 'intent_no-wallet' | 'intent_refused';
const KEY = 'ftm.diagnostics.v1';
let queue = Promise.resolve();
export function recordEvent(event: DiagnosticEvent): void {
  queue = queue.then(async () => {
    const raw = await AsyncStorage.getItem(KEY);
    const rows = raw ? JSON.parse(raw) : [];
    const data = Array.isArray(rows) ? rows : [];
    if (event === 'app_open' && data.length === 0) data.push({ event: 'first_open', at: new Date().toISOString(), network: 'devnet' });
    data.push({ event, at: new Date().toISOString(), network: 'devnet' });
    await AsyncStorage.setItem(KEY, JSON.stringify(data.slice(-2000)));
  }).catch(() => { /* diagnostics never block recovery or a money action */ });
}
export async function diagnosticReport(): Promise<string> {
  await queue;
  const raw = await AsyncStorage.getItem(KEY);
  return JSON.stringify({ schema: 2, events: raw ? JSON.parse(raw) : [], performance: requestReport() }, null, 2);
}
