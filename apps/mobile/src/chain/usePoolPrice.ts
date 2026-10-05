import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from '@solana/kit';
import { loadPool, observePrice, type PoolRef } from '@flipthememe/client';
import { POLL, PRICE_HISTORY_MS } from '../config';
import { describeNetworkError } from '../lib/errors';
import { usePolling } from '../lib/usePolling';
import { withMainnet } from './rpc';

export type PricePoint = { atMs: number; slot: bigint; price: bigint };

export type PoolFeed = {
  pool: Address | null;
  ref: PoolRef | null;
  /** Oldest first, last 10 minutes. */
  points: PricePoint[];
  latest: PricePoint | null;
  error: string | null;
};

// Survive tab switches and pool flips (the open round and my round can use different pools).
const refCache = new Map<Address, PoolRef>();
const pointCache = new Map<Address, PricePoint[]>();

function trim(points: PricePoint[], nowMs: number): PricePoint[] {
  const cutoff = nowMs - PRICE_HISTORY_MS;
  let i = 0;
  while (i < points.length && points[i].atMs < cutoff) i++;
  return i === 0 ? points : points.slice(i);
}

/** Live mainnet price of a PumpSwap pool: loadPool once, then observePrice every 1.5 s. */
export function usePoolPrice(pool: Address | null): PoolFeed {
  const [feed, setFeed] = useState<PoolFeed>(() => initial(pool));
  const poolRef = useRef(pool);
  poolRef.current = pool;

  useEffect(() => {
    setFeed(initial(pool));
  }, [pool]);

  const poll = useCallback(async () => {
    if (!pool) return;
    try {
      let ref = refCache.get(pool) ?? null;
      if (!ref) {
        ref = await withMainnet((rpc) => loadPool(rpc, pool));
        refCache.set(pool, ref);
      }
      const poolRefValue = ref;
      const o = await withMainnet((rpc) => observePrice(rpc, poolRefValue));
      const point: PricePoint = { atMs: o.atMs, slot: o.slot, price: o.price };
      const previous = pointCache.get(pool) ?? [];
      const last = previous[previous.length - 1];
      // A response from an older slot (failover to a lagging node) would draw a step backwards.
      const next = last && point.slot <= last.slot ? previous : trim([...previous, point], point.atMs);
      pointCache.set(pool, next);
      if (poolRef.current !== pool) return;
      setFeed({ pool, ref, points: next, latest: next[next.length - 1] ?? null, error: null });
    } catch (error) {
      if (poolRef.current !== pool) return;
      setFeed((prev) => ({ ...prev, error: describeNetworkError(error) }));
    }
  }, [pool]);

  usePolling(poll, POLL.priceMs, pool !== null, pool);
  return feed;
}

function initial(pool: Address | null): PoolFeed {
  if (!pool) return { pool: null, ref: null, points: [], latest: null, error: null };
  const points = pointCache.get(pool) ?? [];
  return { pool, ref: refCache.get(pool) ?? null, points, latest: points[points.length - 1] ?? null, error: null };
}

/** The feed is stale when the last point is older than `staleMs`. */
export function isFeedStale(feed: PoolFeed, nowMs: number, staleMs = POLL.staleMs): boolean {
  return !feed.latest || nowMs - feed.latest.atMs > staleMs;
}
