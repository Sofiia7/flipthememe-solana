// Limits on what the app asks for and keeps: back-off for rate-limited sources (HTTP 429 from the
// RPC endpoints, GeckoTerminal, DexScreener) and bounded in-memory caches. Free of React Native so
// node:test covers it.

/** The delay a Retry-After header asks for (seconds or an HTTP date), or null when absent or unreadable. */
export function retryAfterMs(value: string | null | undefined, nowMs: number): number | null {
  if (!value) return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/**
 * How long to leave a source alone after its `strikes`-th 429 in a row: `baseMs` doubling per strike,
 * or longer when the server's Retry-After asks for it, never more than `maxMs`.
 */
export function coolDownMs(strikes: number, retryAfter: number | null, baseMs: number, maxMs: number): number {
  const doubling = baseMs * 2 ** Math.min(20, Math.max(0, strikes - 1));
  return Math.min(maxMs, Math.max(doubling, retryAfter ?? 0));
}

export type CoolDown = {
  /** Ms until the source may be asked again; 0 when it is free. */
  left(nowMs: number): number;
  /** Records a 429 and returns the new wait. */
  hit(nowMs: number, retryAfter?: number | null): number;
  /** Records an answer: the next 429 starts the schedule over. */
  ok(): void;
};

export function createCoolDown(baseMs: number, maxMs: number): CoolDown {
  let until = 0;
  let strikes = 0;
  return {
    left: (nowMs) => Math.max(0, until - nowMs),
    hit: (nowMs, retryAfter = null) => {
      strikes++;
      const wait = coolDownMs(strikes, retryAfter, baseMs, maxMs);
      until = nowMs + wait;
      return wait;
    },
    ok: () => {
      strikes = 0;
    },
  };
}

/** Map.set that keeps at most `max` keys: `key` becomes the newest, the oldest go first; `keep` protects keys still in use. */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number, keep?: (key: K) => boolean): void {
  map.delete(key);
  map.set(key, value);
  for (const k of map.keys()) {
    if (map.size <= max) break;
    if (k !== key && !keep?.(k)) map.delete(k);
  }
}
