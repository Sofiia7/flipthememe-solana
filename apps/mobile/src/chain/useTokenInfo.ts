import { useEffect, useState } from 'react';
import type { Address } from '@solana/kit';

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
const listeners = new Set<() => void>();

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
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
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

function ensure(mint: Address, pool: string | null): void {
  const entry = cache.get(mint);
  const now = Date.now();
  if (entry && (entry.pending || now - entry.at < REFRESH_MS)) return;
  const pending = fetchTokenInfo(mint, pool).then((info) => {
    // Keep the last good answer when a refresh fails.
    const previous = cache.get(mint)?.info ?? null;
    cache.set(mint, { at: Date.now(), info: info ?? previous });
    listeners.forEach((l) => l());
    return info;
  });
  cache.set(mint, { at: entry?.at ?? 0, info: entry?.info ?? null, pending });
}

/** Cached info without subscribing (for share texts and toasts). */
export function peekTokenInfo(mint: string | null | undefined): TokenInfo | null {
  return mint ? (cache.get(mint)?.info ?? null) : null;
}

/** Token name, image and market signals from DexScreener, cached per mint for 60 s. */
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
    ensure(mint, pool);
    const id = setInterval(() => ensure(mint, pool), REFRESH_MS);
    return () => clearInterval(id);
  }, [mint, pool]);
  return mint ? (cache.get(mint)?.info ?? null) : null;
}
