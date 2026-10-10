// Rent-exempt minimums of the accounts the app creates or pays for, read once per app run.
import { useEffect, useState } from 'react';
import { ACCOUNT_SPACE } from '../wallet/topUpPlan';
import type { SolanaRpc } from './rpc';

export type Rents = { vault: bigint; session: bigint; position: bigint };

let cache: Rents | null = null;
let loading: Promise<Rents> | null = null;

function load(rpc: SolanaRpc): Promise<Rents> {
  loading ??= Promise.all([
    rpc.getMinimumBalanceForRentExemption(BigInt(ACCOUNT_SPACE.vault)).send(),
    rpc.getMinimumBalanceForRentExemption(BigInt(ACCOUNT_SPACE.session)).send(),
    rpc.getMinimumBalanceForRentExemption(BigInt(ACCOUNT_SPACE.position)).send(),
  ])
    .then(([vault, session, position]) => {
      cache = { vault: BigInt(vault), session: BigInt(session), position: BigInt(position) };
      return cache;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** The rents, or null until the first read answers (a failed read is tried again on the next mount). */
export function useRents(rpc: SolanaRpc, enabled = true): Rents | null {
  const [rents, setRents] = useState<Rents | null>(cache);
  useEffect(() => {
    if (!enabled || cache) {
      if (cache) setRents(cache);
      return undefined;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 2_000;
    const attempt = () => {
      void load(rpc).then((r) => { if (alive) setRents(r); }).catch(() => {
        if (alive) { timer = setTimeout(attempt, delay); delay = Math.min(delay * 2, 30_000); }
      });
    };
    attempt();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [rpc, enabled]);
  return rents;
}
