// Local counters only. Release builds expose them through an explicit diagnostics export.

const counts = new Map<string, number>();
const totals = new Map<string, number>();
const samples = new Map<string, number[]>();
const startedAt = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const enabled = typeof __DEV__ !== 'undefined' && __DEV__;

/** One request: `source` is devnet, mainnet or http; `what` is the RPC method or the service. */
export function countRequest(source: string, what: string): void {
  const key = `${source} ${what}`;
  if (totals.size < 100 || totals.has(key)) totals.set(key, (totals.get(key) ?? 0) + 1);
  if (!enabled) return;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  if (!timer) timer = setInterval(report, 60_000);
}

export function recordLatency(kind: 'rpc_devnet' | 'rpc_mainnet' | 'bet_confirmation', ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const data = samples.get(kind) ?? [];
  data.push(Math.round(ms));
  samples.set(kind, data.slice(-1000));
}

export function requestReport() {
  return { since: new Date(startedAt).toISOString(), elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), requests: Object.fromEntries(totals), latency: Object.fromEntries([...samples].map(([kind, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return [kind, { samples: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] }];
  })), scope: 'this app process; RPC latency includes errors; confirmation latency includes confirmed bets only; no global traffic or retention estimate' };
}

function report(): void {
  if (counts.size === 0) return;
  const bySource = new Map<string, { total: number; parts: string[] }>();
  let total = 0;
  for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const [source, what] = key.split(' ');
    const entry = bySource.get(source) ?? { total: 0, parts: [] };
    entry.total += n;
    entry.parts.push(`${what} ${n}`);
    bySource.set(source, entry);
    total += n;
  }
  counts.clear();
  const detail = [...bySource].map(([source, e]) => `${source} ${e.total} (${e.parts.join(', ')})`).join('; ');
  console.log(`[ftm] requests in the last minute: ${total} - ${detail}`);
}
