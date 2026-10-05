// Pure formatting helpers. No React Native imports: node tests load this file directly.
// Money is always bigint lamports; nothing here turns lamports into a float.

const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Exact SOL string from lamports. Truncates (never rounds up) past `maxDecimals`,
 * keeps at least `minDecimals`. `sign: true` prefixes "+" for positive values.
 */
export function formatSol(
  lamports: bigint,
  opts: { maxDecimals?: number; minDecimals?: number; sign?: boolean } = {},
): string {
  const maxDecimals = opts.maxDecimals ?? 4;
  const minDecimals = Math.min(opts.minDecimals ?? 2, maxDecimals);
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  let frac = (abs % LAMPORTS_PER_SOL).toString().padStart(9, '0').slice(0, maxDecimals);
  while (frac.length > minDecimals && frac.endsWith('0')) frac = frac.slice(0, -1);
  const body = frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
  const isZero = /^[0.]*$/.test(body);
  const prefix = negative && !isZero ? '-' : opts.sign && !negative && !isZero ? '+' : '';
  return prefix + body;
}

/** "0.05 SOL" */
export function sol(lamports: bigint, opts?: Parameters<typeof formatSol>[1]): string {
  return `${formatSol(lamports, opts)} SOL`;
}

/** "AbCd...WxYz" */
export function shortAddress(value: string, chars = 4): string {
  if (value.length <= chars * 2 + 3) return value;
  return `${value.slice(0, chars)}...${value.slice(-chars)}`;
}

/** "0:42", "1:05"; negative input shows "0:00". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** "45 s", "6 min", "3 h", "2 d" */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** "23h 59m", "5m 03s", "42s" */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

/** "$157K", "$1.2M", "$950" */
export function formatUsdCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${Math.round(value / 1e3)}K`;
  return `$${Math.round(value)}`;
}

/** Local wall clock "14:05:09" from unix seconds. */
export function formatClock(unixSeconds: number, withSeconds = true): string {
  const d = new Date(unixSeconds * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (!withSeconds) return `${hh}:${mm}`;
  return `${hh}:${mm}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** "Oct 5, 14:05" from unix seconds. */
export function formatDateTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${formatClock(unixSeconds, false)}`;
}

/**
 * Relative change of two integer prices in millionths of a percent (1 = 0.000001%).
 * Prices are compared as integers (both use the same scale), so no float rounding decides a sign.
 */
export function changeMicroPct(from: bigint, to: bigint): bigint | null {
  if (from <= 0n) return null;
  return ((to - from) * 100_000_000n) / from;
}

/** "+0.12%", "-1.50%", "+0.003%", "0.00%" from millionths of a percent. */
export function formatMicroPct(micro: bigint | null): string {
  if (micro === null) return '-';
  if (micro === 0n) return '0.00%';
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  // 2 decimals from 0.01% up, more below that, so a tiny but real move never prints as 0.00%.
  const decimals = abs >= 10_000n ? 2 : abs >= 1_000n ? 3 : abs >= 100n ? 4 : 6;
  const unit = 10n ** BigInt(6 - decimals);
  const scaled = abs / unit; // percent * 10^decimals, truncated
  const whole = scaled / 10n ** BigInt(decimals);
  const frac = (scaled % 10n ** BigInt(decimals)).toString().padStart(decimals, '0');
  return `${negative ? '-' : '+'}${whole}.${frac}%`;
}

export type DeltaView = {
  /** Millionths of a percent, as changeMicroPct. */
  micro: bigint;
  /** "+0.42%", "-0.31%", "0.00%" */
  text: string;
  arrow: '▲' | '▼' | '=';
  tone: 'up' | 'down' | 'flat';
};

/** The big "price vs strike" readout: "+0.42% ▲". Integer math, so the sign never comes from float noise. */
export function deltaView(strike: bigint | null | undefined, price: bigint | null | undefined): DeltaView | null {
  if (strike === null || strike === undefined || price === null || price === undefined) return null;
  const micro = changeMicroPct(strike, price);
  if (micro === null) return null;
  const tone = micro > 0n ? 'up' : micro < 0n ? 'down' : 'flat';
  return { micro, text: formatMicroPct(micro), arrow: tone === 'up' ? '▲' : tone === 'down' ? '▼' : '=', tone };
}

/** Compact age: "45s", "12m", "3h", "2d". */
export function formatAgoShort(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * "pool 12m old", from the pool's creation time (DexScreener pairCreatedAt, ms). For a pump.fun
 * coin that is usually when it graduated, but the app does not claim it: it only knows the pool.
 */
export function poolAgeLabel(pairCreatedAtMs: number | null | undefined, nowMs: number): string | null {
  if (pairCreatedAtMs === null || pairCreatedAtMs === undefined || !Number.isFinite(pairCreatedAtMs) || pairCreatedAtMs <= 0) return null;
  const age = nowMs - pairCreatedAtMs;
  if (age < 10_000) return 'pool just opened';
  return `pool ${formatAgoShort(age)} old`;
}

/** Web link to a round: shared in messengers, opens the app through Android App Links. */
export const WEB_ROUND_LINK = 'https://sol.flipthememe.com/r/';

/** Round id from the app scheme (flipthememe://round/12) or the web link (https://sol.flipthememe.com/r/12). */
export function parseRoundLink(url: string | null | undefined): bigint | null {
  if (!url) return null;
  const match =
    url.match(/^flipthememe:\/\/+round\/(\d{1,20})(?:[/?#].*)?$/i) ?? url.match(/^https:\/\/sol\.flipthememe\.com\/r\/(\d{1,20})(?:[/?#].*)?$/i);
  if (!match) return null;
  try {
    return BigInt(match[1]);
  } catch {
    return null;
  }
}
