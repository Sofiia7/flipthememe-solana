import { useEffect, useState } from 'react';
import type { Address } from '@solana/kit';
import { createCoolDown, retryAfterMs, setBounded } from '../lib/limits';
import { countRequest } from '../lib/requestLog';
import { appInForeground } from '../lib/usePolling';

export type TokenInfo = {
  mint: Address;
  symbol: string;
  name: string;
  imageUrl: string | null;
  /** Pair creation time, ms. */
  pairCreatedAt: number | null;
  liquidityUsd: number | null;
  /** Buys + sells over the last 5 minutes. */
  txnsM5: number | null;
  pairAddress: string | null;
  dexId: string | null;
};

type CacheEntry = { at: number; info: TokenInfo | null; pending?: Promise<TokenInfo | null> };

const cache = new Map<string, CacheEntry>();
const REFRESH_MS = 60_000;
/** Token infos kept in memory; the ones on screen are never dropped. */
const MAX_TOKENS = 48;
/** Refreshes per minute shared by every token on screen: History can show dozens of them. */
const REFRESHES_PER_MIN = 6;
const listeners = new Set<() => void>();
/** Tokens on screen: how many components show each one, and the pool they asked for. */
const watched = new Map<string, { count: number; pool: string | null }>();
/** A 429 from DexScreener pauses every request: 1 min, doubling up to 10. */
const coolDown = createCoolDown(60_000, 10 * 60_000);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pickPair(pairs: unknown[], pool: string | null): Record<string, unknown> | null {
  const rows = pairs.filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null);
  return (
    (pool ? rows.find((p) => p.pairAddress === pool) : undefined) ??
    rows.find((p) => p.dexId === 'pumpswap') ??
    rows[0] ??
    null
  );
}

async function fetchTokenInfo(mint: Address, pool: string | null): Promise<TokenInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    countRequest('http', 'dexscreener');
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (res.status === 429) coolDown.hit(Date.now(), retryAfterMs(res.headers.get('retry-after'), Date.now()));
    if (!res.ok) return null;
    coolDown.ok();
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return null;
    const pair = pickPair(body, pool);
    if (!pair) return null;
    const base = (pair.baseToken ?? {}) as Record<string, unknown>;
    const info = (pair.info ?? {}) as Record<string, unknown>;
    const liquidity = (pair.liquidity ?? {}) as Record<string, unknown>;
    const m5 = (((pair.txns ?? {}) as Record<string, unknown>).m5 ?? {}) as Record<string, unknown>;
    const buys = num(m5.buys);
    const sells = num(m5.sells);
    return {
      mint,
      symbol: typeof base.symbol === 'string' && base.symbol ? base.symbol : mint.slice(0, 4),
      name: typeof base.name === 'string' ? base.name : '',
      imageUrl: typeof info.imageUrl === 'string' ? info.imageUrl : null,
      pairCreatedAt: num(pair.pairCreatedAt),
      liquidityUsd: num(liquidity.usd),
      txnsM5: buys !== null && sells !== null ? buys + sells : null,
      pairAddress: typeof pair.pairAddress === 'string' ? pair.pairAddress : null,
      dexId: typeof pair.dexId === 'string' ? pair.dexId : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const remember = (mint: string, entry: CacheEntry) => setBounded(cache, mint, entry, MAX_TOKENS, (m) => watched.has(m));

function ensure(mint: Address, pool: string | null, maxAgeMs: number): void {
  const entry = cache.get(mint);
  const now = Date.now();
  if (entry && (entry.pending || now - entry.at < maxAgeMs)) return;
  if (coolDown.left(now) > 0) return;
  const pending = fetchTokenInfo(mint, pool).then((info) => {
    // Keep the last good answer when a refresh fails.
    const previous = cache.get(mint)?.info ?? null;
    remember(mint, { at: Date.now(), info: info ?? previous });
    listeners.forEach((l) => l());
    return info;
  });
  remember(mint, { at: entry?.at ?? 0, info: entry?.info ?? null, pending });
}

/** One token on screen refreshes every minute; more share six refreshes a minute (thirty tokens: each every 5 min). */
function refreshAgeMs(): number {
  return Math.max(REFRESH_MS, (watched.size * 60_000) / REFRESHES_PER_MIN);
}

function refreshWatched(): void {
  if (!appInForeground()) return;
  const maxAgeMs = refreshAgeMs();
  for (const [mint, w] of watched) ensure(mint as Address, w.pool, maxAgeMs);
}

function watch(mint: string, pool: string | null): () => void {
  const w = watched.get(mint);
  watched.set(mint, { count: (w?.count ?? 0) + 1, pool: pool ?? w?.pool ?? null });
  if (!refreshTimer) refreshTimer = setInterval(refreshWatched, 15_000);
  return () => {
    const current = watched.get(mint);
    if (current && current.count > 1) watched.set(mint, { ...current, count: current.count - 1 });
    else watched.delete(mint);
    if (watched.size === 0 && refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };
}

/** Cached info without subscribing (for share texts and toasts). */
export function peekTokenInfo(mint: string | null | undefined): TokenInfo | null {
  return mint ? (cache.get(mint)?.info ?? null) : null;
}

/** Token name, image and market signals from DexScreener, cached per mint and refreshed while on screen (not in the background). */
export function useTokenInfo(mint: Address | null, pool: Address | null = null): TokenInfo | null {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (!mint) return undefined;
    const unwatch = watch(mint, pool);
    ensure(mint, pool, refreshAgeMs());
    return unwatch;
  }, [mint, pool]);
  return mint ? (cache.get(mint)?.info ?? null) : null;
}
