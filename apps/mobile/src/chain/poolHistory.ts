// Reference history for the price chart: the charted pool's last 1-minute candles from GeckoTerminal,
// converted to the live price's units. Picture only: none of it ever reaches a strike, a standing or
// a payout. Free of React Native so node:test covers it.
import { LAMPORTS_PER_SOL, PRICE_SCALE } from '@flipthememe/client';

/**
 * One reference price at a local time. `price` is in the live price's units (see `ohlcvScale`) but
 * a float, so it cannot slip into the bigint math that decides money.
 */
export type RefPoint = { atMs: number; price: number };

/** Candles per request: the chart shows 90 s, the rest covers a late GeckoTerminal. */
export const GECKO_OHLCV_LIMIT = 10;
/** GeckoTerminal pins the response format to an API version through the Accept header. */
export const GECKO_ACCEPT = 'application/json;version=20230203';

const GECKO_POOLS = 'https://api.geckoterminal.com/api/v2/networks/solana/pools';
const CANDLE_MS = 60_000;

/**
 * The pool's last 1-minute candles (newest first), priced in SOL per whole base token:
 * `currency=token` gives the price in the other token of the pair, and naming the base mint as
 * `token` keeps that true whichever side GeckoTerminal calls the base.
 */
export function ohlcvUrl(pool: string, baseMint: string, limit = GECKO_OHLCV_LIMIT): string {
  return `${GECKO_POOLS}/${pool}/ohlcv/minute?aggregate=1&limit=${limit}&currency=token&token=${baseMint}`;
}

/**
 * Factor from SOL per whole base token to the live price unit, which is
 * `quote lamports * PRICE_SCALE / base raw units` (see observePrice in @flipthememe/client):
 * 10^9 * 10^12 / 10^decimals, so 10^15 for pump.fun's 6-decimal tokens.
 */
export function ohlcvScale(baseDecimals: number): number {
  return Number(LAMPORTS_PER_SOL * PRICE_SCALE) / 10 ** baseDecimals;
}

/**
 * The candles as a line in the live price's units, oldest first: the oldest candle's open at its
 * start, then every close at the end of its minute. The candle still running ends at `fetchedAtMs`
 * (its close is the last trade GeckoTerminal has seen). Malformed or non-positive rows are skipped
 * and the times strictly increase, so a phone clock behind GeckoTerminal's drops the newest row.
 */
export function parseOhlcv(body: unknown, baseDecimals: number, fetchedAtMs: number): RefPoint[] {
  if (!Number.isInteger(baseDecimals) || baseDecimals < 0 || baseDecimals > 18) return [];
  const list = field(body, 'data', 'attributes', 'ohlcv_list');
  if (!Array.isArray(list)) return [];
  const scale = ohlcvScale(baseDecimals);
  const candles = new Map<number, { open: number; close: number }>();
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [startSec, open, close] = [Number(row[0]), Number(row[1]), Number(row[4])];
    if (!Number.isFinite(startSec) || startSec <= 0 || !(open > 0) || !(close > 0) || !Number.isFinite(open + close)) continue;
    candles.set(startSec * 1000, { open: open * scale, close: close * scale });
  }
  const starts = [...candles.keys()].sort((a, b) => a - b);
  const out: RefPoint[] = [];
  const push = (atMs: number, price: number) => {
    if (atMs <= fetchedAtMs && (out.length === 0 || atMs > out[out.length - 1].atMs)) out.push({ atMs, price });
  };
  starts.forEach((startMs, i) => {
    const c = candles.get(startMs)!;
    if (i === 0) push(startMs, c.open);
    push(Math.min(startMs + CANDLE_MS, fetchedAtMs), c.close);
  });
  return out;
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
