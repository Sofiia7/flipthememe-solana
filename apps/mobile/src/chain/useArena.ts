import { useCallback, useRef, useState } from 'react';
import { OFFSETS, configAddress, decodeConfig, type ConfigAccount } from '@flipthememe/client';
import type { Address } from '@solana/kit';
import { POLL } from '../config';
import { describeNetworkError } from '../lib/errors';
import { usePolling } from '../lib/usePolling';
import {
  byIdDesc,
  decodeRoundSafe,
  fetchAccounts,
  fetchPositionsBy,
  roundAddressCached,
  type PositionView,
  type RoundView,
} from './fetch';
import type { SolanaRpc } from './rpc';

/** Rounds read per poll: the upcoming / open one, two in flight and the latest finals. */
const WINDOW = 6n;

export type ArenaData = {
  config: ConfigAccount | null;
  /** Newest first. Closed (empty) rounds are simply absent. */
  rounds: RoundView[];
  /** Positions of the rounds above, by round id. */
  positions: ReadonlyMap<bigint, PositionView[]>;
  /** Local ms of the last successful poll. */
  updatedAt: number | null;
  error: string | null;
};

const EMPTY: ArenaData = { config: null, rounds: [], positions: new Map(), updatedAt: null, error: null };

function windowIds(next: bigint): bigint[] {
  const ids: bigint[] = [];
  for (let i = 1n; i <= WINDOW; i++) if (next - i >= 0n) ids.push(next - i);
  return ids;
}

export function useArena(rpc: SolanaRpc): ArenaData & { refresh: () => void } {
  const [data, setData] = useState<ArenaData>(EMPTY);
  const nextRef = useRef<bigint | null>(null);
  const positionCache = useRef(new Map<bigint, { version: string; list: PositionView[] }>());

  const poll = useCallback(async () => {
    try {
      const configAddr = await configAddress();
      let ids = nextRef.current === null ? [] : windowIds(nextRef.current);
      let addresses: Address[] = await Promise.all(ids.map(roundAddressCached));
      const first = await fetchAccounts(rpc, [configAddr, ...addresses]);
      if (!first[0]) throw new Error('The FlipTheMeme program has no config on devnet yet.');
      const config = decodeConfig(first[0].data);
      let raw = first.slice(1);
      if (config.nextRoundId !== nextRef.current) {
        // A round was created since the last poll (or this is the first poll).
        nextRef.current = config.nextRoundId;
        ids = windowIds(config.nextRoundId);
        addresses = await Promise.all(ids.map(roundAddressCached));
        raw = await fetchAccounts(rpc, addresses);
      }

      const rounds: RoundView[] = [];
      ids.forEach((id, i) => {
        const account = decodeRoundSafe(raw[i] ?? null);
        if (account) rounds.push({ id, address: addresses[i], account });
      });
      rounds.sort(byIdDesc);

      const cache = positionCache.current;
      const keep = new Set(rounds.map((r) => r.id));
      for (const id of [...cache.keys()]) if (!keep.has(id)) cache.delete(id);
      await Promise.all(
        rounds.map(async (r) => {
          const a = r.account;
          if (a.positionCount === 0) {
            cache.set(r.id, { version: '0', list: [] });
            return;
          }
          const version = `${a.positionCount}:${a.claimedCount}:${a.status}`;
          if (cache.get(r.id)?.version === version) return;
          const list = await fetchPositionsBy(rpc, OFFSETS.positionRound, r.address);
          list.sort((x, y) => (x.account.stake > y.account.stake ? -1 : x.account.stake < y.account.stake ? 1 : 0));
          cache.set(r.id, { version, list });
        }),
      );
      const positions = new Map<bigint, PositionView[]>();
      for (const r of rounds) positions.set(r.id, cache.get(r.id)?.list ?? []);
      setData({ config, rounds, positions, updatedAt: Date.now(), error: null });
    } catch (error) {
      setData((prev) => ({ ...prev, error: describeNetworkError(error) }));
    }
  }, [rpc]);

  const refresh = usePolling(poll, POLL.arenaMs);
  return { ...data, refresh };
}
