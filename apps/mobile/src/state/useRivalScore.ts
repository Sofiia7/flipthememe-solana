import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useMemo, useRef, useState } from 'react';
import { decodeLedger, duelStorageKey, encodeLedger, scoreOf, updateLedger, type DuelLedger } from './rivalScore';

export function useRivalScore(me: string | null, rival: string | null, rounds: Parameters<typeof updateLedger>[1], positions: Parameters<typeof updateLedger>[2]) {
  const key = me && rival && me !== rival ? duelStorageKey(me, rival) : null;
  const [loaded, setLoaded] = useState<{ key: string; ledger: DuelLedger } | null>(null);
  const writes = useRef(Promise.resolve());
  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    if (key) {
      // Finish previous writes before reloading a pair after a quick wallet switch.
      void writes.current.then(() => AsyncStorage.getItem(key)).then((raw) => {
        if (!cancelled) setLoaded({ key, ledger: decodeLedger(raw) });
      }).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [key]);
  const ledger = useMemo(() => loaded && loaded.key === key && me && rival ? updateLedger(loaded.ledger, rounds, positions, me, rival) : null, [loaded, key, me, rival, rounds, positions]);
  useEffect(() => {
    if (!key || !loaded || loaded.key !== key || !ledger || ledger === loaded.ledger) return;
    setLoaded({ key, ledger });
    const raw = encodeLedger(ledger);
    writes.current = writes.current.then(() => AsyncStorage.setItem(key, raw)).catch(() => undefined);
  }, [key, loaded, ledger]);
  return useMemo(() => ledger ? scoreOf(ledger) : null, [ledger]);
}
