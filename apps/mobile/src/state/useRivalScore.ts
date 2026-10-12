import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useMemo, useRef, useState } from 'react';
import { decodeLedger, duelStorageKey, encodeLedger, scoreOf, updateLedger, type DuelLedger } from './rivalScore';
import { fetchRemoteHistory } from './remoteHistory';

export function useRivalScore(me: string | null, rival: string | null, rounds: Parameters<typeof updateLedger>[1], positions: Parameters<typeof updateLedger>[2]) {
  const key = me && rival && me !== rival ? duelStorageKey(me, rival) : null;
  const [loaded, setLoaded] = useState<{ key: string; ledger: DuelLedger } | null>(null);
  const writes = useRef(Promise.resolve());
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoaded(null);
    if (key) {
      // Finish previous writes before reloading a pair after a quick wallet switch.
      void writes.current.then(() => AsyncStorage.getItem(key)).then(async (raw) => {
        const ledger = new Map(decodeLedger(raw));
        if (!cancelled) setLoaded({ key, ledger });
        const [mine, theirs] = await Promise.all([fetchRemoteHistory(me!, controller.signal), fetchRemoteHistory(rival!, controller.signal)]).catch(() => [[], []]);
        const byRound = new Map(theirs.map(r => [r.roundId, r]));
        for (const r of mine) {
          const other = byRound.get(r.roundId);
          if (other && other.side !== r.side && (r.kind === 'won' || r.kind === 'lost') && (other.kind === 'won' || other.kind === 'lost')) ledger.set(r.roundId, r.kind === 'won' ? 'you' : 'them');
        }
        const bounded = new Map([...ledger].sort((a, b) => a[0] > b[0] ? -1 : 1).slice(0, 200));
        if (!cancelled) setLoaded(current => {
          if (!current || current.key !== key) return current;
          for (const [round, result] of current.ledger) bounded.set(round, result);
          return { key, ledger: new Map([...bounded].sort((a, b) => a[0] > b[0] ? -1 : a[0] < b[0] ? 1 : 0).slice(0, 200)) };
        });
      }).catch(() => undefined);
    }
    return () => { cancelled = true; controller.abort(); };
  }, [key]);
  const ledger = useMemo(() => loaded && loaded.key === key && me && rival ? updateLedger(loaded.ledger, rounds, positions, me, rival) : null, [loaded, key, me, rival, rounds, positions]);
  useEffect(() => {
    if (!key || !loaded || loaded.key !== key || !ledger || ledger === loaded.ledger) return;
    setLoaded({ key, ledger });
  }, [key, loaded, ledger]);
  useEffect(() => {
    if (!key || !ledger) return;
    const raw = encodeLedger(ledger);
    writes.current = writes.current.then(() => AsyncStorage.setItem(key, raw)).catch(() => undefined);
  }, [key, ledger]);
  return useMemo(() => ledger ? scoreOf(ledger) : null, [ledger]);
}
