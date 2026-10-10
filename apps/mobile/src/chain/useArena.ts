import { useCallback, useEffect, useRef, useState } from 'react';
import { OFFSETS, RoundStatus, configAddress, decodeConfig, type ConfigAccount } from '@flipthememe/client';
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
import { shareRounds } from './roundStore';
import { needsPositionScan } from './positionCache';
import { rateLimitWaitMs, type SolanaRpc } from './rpc';

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

/**
 * Config, the newest rounds and their players: every 2 s while the arena is on screen (`active`),
 * every 5 s while no round is upcoming, open or in flight, every 8 s with config and rounds only
 * while another tab is open. Played final rounds and closed (empty) rounds are not read again, and
 * players only when a round's position count moves.
 */
export function useArena(rpc: SolanaRpc, active = true): ArenaData & { refresh: () => void } {
  const [data, setData] = useState<ArenaData>(EMPTY);
  const nextRef = useRef<bigint | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  // Players by round id. Only a new bet changes who is in a round; claims after the result change nothing the arena shows.
  const positionCache = useRef(new Map<bigint, PositionView[]>());
  const finalSynced = useRef(new Set<bigint>());
  // Played final rounds (kept as read) and closed empty ones (null), by id: neither is read again.
  const settledRef = useRef(new Map<bigint, RoundView | null>());

  const poll = useCallback(async (): Promise<number> => {
    const visible = activeRef.current;
    const pace = visible ? POLL.arenaMs : POLL.arenaHiddenMs;
    try {
      const settled = settledRef.current;
      const configAddr = await configAddress();
      let ids = nextRef.current === null ? [] : windowIds(nextRef.current);
      const tried = new Set(ids.filter((id) => !settled.has(id)));
      const addresses: Address[] = await Promise.all([...tried].map(roundAddressCached));
      const first = await fetchAccounts(rpc, [configAddr, ...addresses]);
      if (!first[0]) throw new Error('The FlipTheMeme program has no config on devnet yet.');
      const config = decodeConfig(first[0].data);
      const readAt = Date.now();
      const fresh = new Map<bigint, RoundView>();
      [...tried].forEach((id, i) => {
        const raw = first[i + 1] ?? null;
        const account = decodeRoundSafe(raw);
        if (account) fresh.set(id, { id, address: addresses[i], account });
        // Same snapshot as the config: a round below nextRoundId that is missing here was closed (nobody played).
        else if (!raw && id < config.nextRoundId) settled.set(id, null);
      });
      if (config.nextRoundId !== nextRef.current) {
        // A round was created since the last poll (or this is the first poll): read the rounds new to the window.
        nextRef.current = config.nextRoundId;
        ids = windowIds(config.nextRoundId);
        const missing = ids.filter((id) => !settled.has(id) && !tried.has(id));
        const more: Address[] = await Promise.all(missing.map(roundAddressCached));
        const raw = await fetchAccounts(rpc, more);
        missing.forEach((id, i) => {
          // A separate snapshot, maybe from a node a slot behind: a missing round here is not taken as closed.
          const account = decodeRoundSafe(raw[i] ?? null);
          if (account) fresh.set(id, { id, address: more[i], account });
        });
      }
      shareRounds([...fresh.values()], readAt);

      const inWindow = new Set(ids);
      const rounds: RoundView[] = [];
      for (const id of ids) {
        const view = fresh.get(id) ?? settled.get(id) ?? null;
        if (view) rounds.push(view);
      }
      rounds.sort(byIdDesc);
      // A played final round never changes again in a way the arena shows; an empty one is read on until the keeper closes it.
      for (const r of rounds) if (r.account.status === RoundStatus.Final && r.account.positionCount > 0) settled.set(r.id, r);
      for (const id of [...settled.keys()]) if (!inWindow.has(id)) settled.delete(id);

      const cache = positionCache.current;
      for (const id of [...cache.keys()]) if (!inWindow.has(id)) cache.delete(id);
      for (const id of [...finalSynced.current]) if (!inWindow.has(id)) finalSynced.current.delete(id);
      await Promise.all(
        rounds.map(async (r) => {
          const a = r.account;
          if (a.positionCount === 0) {
            cache.set(r.id, []);
            return;
          }
          const cached = cache.get(r.id);
          if (!needsPositionScan(cached?.length ?? null, a.positionCount, a.status === RoundStatus.Final, finalSynced.current.has(r.id))) return;
          // Another tab is open: the players wait until the arena is on screen again.
          if (!visible) return;
          const list = await fetchPositionsBy(rpc, OFFSETS.positionRound, r.address);
          list.sort((x, y) => (x.account.stake > y.account.stake ? -1 : x.account.stake < y.account.stake ? 1 : 0));
          cache.set(r.id, list);
          if (a.status === RoundStatus.Final && list.length >= a.positionCount) finalSynced.current.add(r.id);
        }),
      );
      const positions = new Map<bigint, PositionView[]>();
      for (const r of rounds) positions.set(r.id, cache.get(r.id) ?? []);
      setData({ config, rounds, positions, updatedAt: Date.now(), error: null });
      // Nothing upcoming, open or in flight: nothing changes until the keeper creates the next round.
      const quiet = rounds.every((r) => r.account.status === RoundStatus.Final);
      return visible && quiet ? POLL.arenaQuietMs : pace;
    } catch (error) {
      setData((prev) => ({ ...prev, error: describeNetworkError(error) }));
      return Math.max(pace, rateLimitWaitMs(error) ?? 0);
    }
  }, [rpc]);

  const refresh = usePolling(poll, POLL.arenaMs);
  // Back on the arena: read at once instead of waiting out the slower pace of the other tabs.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) refresh();
    wasActive.current = active;
  }, [active, refresh]);
  return { ...data, refresh };
}
