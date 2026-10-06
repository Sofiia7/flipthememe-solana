// The chart's reference history: the charted pool's last minutes from GeckoTerminal, drawn faintly
// before the live line so the chart is useful the moment it opens. Picture only: nothing here
// reaches a strike, a standing or anything else that decides money.
//
// One request per pool (plus a refresh when the chart comes back after 2 minutes), kept in memory.
// The free API allows about 30 requests a minute per IP: a 429 pauses every history request (60 s,
// doubling up to 10 min), and a failure never holds up the chart, which simply draws the live line.
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { getBase64Encoder, type Address } from '@solana/kit';
import { CHART_HISTORY_MAX_AGE_MS } from '../config';
import { createCoolDown, retryAfterMs, setBounded } from '../lib/limits';
import { countRequest } from '../lib/requestLog';
import { appInForeground } from '../lib/usePolling';
import { GECKO_ACCEPT, ohlcvUrl, parseOhlcv, type RefPoint } from './poolHistory';
import { poolRefFor } from './usePoolPrice';
import { withMainnet } from './rpc';

const MAX_POOLS = 8;
const MAX_MINTS = 32;
/** After a failure other than 429 (offline, 5xx, unknown pool) the pool waits this long. */
const RETRY_MS = 60_000;
/** SPL Token and Token-2022 mints keep `decimals` at byte 44. */
const MINT_DECIMALS_OFFSET = 44;

type Entry = { atMs: number; points: RefPoint[] };

const NONE: readonly RefPoint[] = [];
const histories = new Map<Address, Entry>();
const loading = new Set<Address>();
const failedAt = new Map<Address, number>();
const decimalsByMint = new Map<Address, number>();
const coolDown = createCoolDown(60_000, 10 * 60_000);
const listeners = new Set<() => void>();
const base64 = getBase64Encoder();

async function mintDecimals(mint: Address): Promise<number> {
  const known = decimalsByMint.get(mint);
  if (known !== undefined) return known;
  const { value } = await withMainnet((rpc) =>
    rpc.getAccountInfo(mint, { encoding: 'base64', dataSlice: { offset: MINT_DECIMALS_OFFSET, length: 1 } }).send(),
  );
  const bytes = value ? base64.encode(value.data[0]) : null;
  if (!bytes || bytes.length !== 1) throw new Error(`mint ${mint} has no decimals`);
  setBounded(decimalsByMint, mint, bytes[0], MAX_MINTS);
  return bytes[0];
}

/** Ms until a history read of `pool` may be tried, 0 when it may go now, null when the history is fresh. */
function waitFor(pool: Address, nowMs: number): number | null {
  const entry = histories.get(pool);
  if (entry && nowMs - entry.atMs < CHART_HISTORY_MAX_AGE_MS) return null;
  const failed = failedAt.get(pool);
  return Math.max(coolDown.left(nowMs), failed !== undefined ? failed + RETRY_MS - nowMs : 0, 0);
}

async function load(pool: Address): Promise<void> {
  if (loading.has(pool) || waitFor(pool, Date.now()) !== 0) return;
  loading.add(pool);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const ref = await poolRefFor(pool);
    const decimals = await mintDecimals(ref.baseMint);
    countRequest('http', 'geckoterminal');
    timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(ohlcvUrl(pool, ref.baseMint), { headers: { accept: GECKO_ACCEPT }, signal: controller.signal });
    if (res.status === 429) {
      coolDown.hit(Date.now(), retryAfterMs(res.headers.get('retry-after'), Date.now()));
      return;
    }
    coolDown.ok();
    if (res.status >= 500) throw new Error(`GeckoTerminal answered HTTP ${res.status}`);
    // Any other refusal (a pool GeckoTerminal does not know) counts as no history, not as a failure to retry.
    const points = res.ok ? parseOhlcv(await res.json(), decimals, Date.now()) : [];
    failedAt.delete(pool);
    setBounded(histories, pool, { atMs: Date.now(), points }, MAX_POOLS);
    listeners.forEach((l) => l());
  } catch {
    // No history is fine: the chart draws the live line alone.
    setBounded(failedAt, pool, Date.now(), MAX_POOLS);
  } finally {
    if (timer) clearTimeout(timer);
    loading.delete(pool);
  }
}

/** Reference points (oldest first, the live price's units) for the charted pool; empty until loaded or when unavailable. */
export function usePoolHistory(pool: Address | null): readonly RefPoint[] {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!pool) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // One read now; after a failure or a 429 another once the wait is over, while the chart stays open.
    const attempt = () => {
      timer = null;
      if (!alive || !appInForeground()) return;
      void load(pool).then(() => {
        const wait = alive ? waitFor(pool, Date.now()) : null;
        if (wait !== null && !timer) timer = setTimeout(attempt, Math.max(wait, 1_000));
      });
    };
    attempt();
    // Back from the background after a while: the history before the live line is out of date.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !timer) attempt();
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, [pool]);

  return pool ? (histories.get(pool)?.points ?? NONE) : NONE;
}
