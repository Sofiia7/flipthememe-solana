import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from '@solana/kit';
import { loadPool, observePrice, type PoolRef } from '@flipthememe/client';
import { POLL, PRICE_HISTORY_MS } from '../config';
import { describeNetworkError } from '../lib/errors';
import { setBounded } from '../lib/limits';
import { usePolling } from '../lib/usePolling';
import { rateLimitWaitMs, withMainnet } from './rpc';

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
// Bounded: pools rotate all day, and only the charted pool and my round's pool are read.
const MAX_POOL_REFS = 16;
const MAX_POOL_POINTS = 4;
const refCache = new Map<Address, PoolRef>();
const refLoads = new Map<Address, Promise<PoolRef>>();
const pointCache = new Map<Address, PricePoint[]>();
const priceLoads = new Map<Address, Promise<PricePoint>>();

/** Coalesce simultaneous consumers of one pool; never invent or interpolate samples. */
function priceFor(pool: Address, ref: PoolRef): Promise<PricePoint> {
  const points = pointCache.get(pool);
  const latest = points?.[points.length - 1];
  if (latest && Date.now() - latest.atMs >= 0 && Date.now() - latest.atMs < 500) return Promise.resolve(latest);
  let pending = priceLoads.get(pool);
  if (!pending) {
    pending = withMainnet(rpc => observePrice(rpc, ref)).then(o => ({ atMs: o.atMs, slot: o.slot, price: o.price })).finally(() => priceLoads.delete(pool));
    priceLoads.set(pool, pending);
  }
  return pending;
}

function trim(points: PricePoint[], nowMs: number): PricePoint[] {
  const cutoff = nowMs - PRICE_HISTORY_MS;
  let i = 0;
  while (i < points.length && points[i].atMs < cutoff) i++;
  return i === 0 ? points : points.slice(i);
}

/** The pool's vaults and mints: read once per pool (one mainnet getAccountInfo), shared by the live price and the chart history. */
export function poolRefFor(pool: Address): Promise<PoolRef> {
  const cached = refCache.get(pool);
  if (cached) return Promise.resolve(cached);
  let load = refLoads.get(pool);
  if (!load) {
    load = withMainnet((rpc) => loadPool(rpc, pool))
      .then((ref) => {
        setBounded(refCache, pool, ref, MAX_POOL_REFS);
        return ref;
      })
      .finally(() => refLoads.delete(pool));
    refLoads.set(pool, load);
  }
  return load;
}

/**
 * Live mainnet price of a PumpSwap pool: the pool once, then observePrice every 1.5 s while
 * `active` (the arena is on screen); stopped otherwise.
 */
export function usePoolPrice(pool: Address | null, active = true): PoolFeed {
  const [feed, setFeed] = useState<PoolFeed>(() => initial(pool));
  const poolRef = useRef(pool);
  poolRef.current = pool;

  useEffect(() => {
    setFeed(initial(pool));
  }, [pool]);

  const poll = useCallback(async (): Promise<number | void> => {
    if (!pool) return;
    try {
      const ref = await poolRefFor(pool);
      const point = await priceFor(pool, ref);
      const previous = pointCache.get(pool) ?? [];
      const last = previous[previous.length - 1];
      // A response from an older slot (failover to a lagging node) would draw a step backwards.
      const next = last && point.slot <= last.slot ? previous : trim([...previous, point], point.atMs);
      setBounded(pointCache, pool, next, MAX_POOL_POINTS);
      if (poolRef.current !== pool) return;
      setFeed({ pool, ref, points: next, latest: next[next.length - 1] ?? null, error: null });
    } catch (error) {
      if (poolRef.current === pool) setFeed((prev) => ({ ...prev, error: describeNetworkError(error) }));
      const wait = rateLimitWaitMs(error);
      if (wait !== null) return Math.max(POLL.priceMs, wait);
    }
  }, [pool]);

  usePolling(poll, POLL.priceMs, pool !== null && active, pool);
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
