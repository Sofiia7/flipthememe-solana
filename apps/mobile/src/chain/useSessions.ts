import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import type { Address } from '@solana/kit';
import { describeNetworkError } from '../lib/errors';
import { fetchSessionsOf, type SessionView } from './fetch';
import type { SolanaRpc } from './rpc';

/** The list changes only when the owner starts or revokes a session; this phone's own row is fresher (useMyAccount). */
const SESSIONS_EVERY_MS = 15_000;

export type SessionsData = { list: SessionView[] | null; error: string | null; refresh: () => void };

/** Every session of `owner` (any device), read while the caller is mounted (the Wallet tab). */
export function useSessions(rpc: SolanaRpc, owner: Address | null): SessionsData {
  const [state, setState] = useState<{ owner: Address | null; list: SessionView[] | null; error: string | null }>({
    owner: null,
    list: null,
    error: null,
  });
  const [round, setRound] = useState(0);
  const refresh = useCallback(() => setRound((n) => n + 1), []);

  useEffect(() => {
    if (!owner) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      timer = null;
      if (AppState.currentState === 'active') {
        try {
          const list = await fetchSessionsOf(rpc, owner);
          if (alive) setState({ owner, list, error: null });
        } catch (error) {
          if (alive) setState((prev) => ({ owner, list: prev.owner === owner ? prev.list : null, error: describeNetworkError(error) }));
        }
      }
      if (alive) timer = setTimeout(read, SESSIONS_EVERY_MS);
    };
    void read();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [rpc, owner, round]);

  const mine = state.owner === owner && owner !== null;
  return { list: mine ? state.list : null, error: mine ? state.error : null, refresh };
}
