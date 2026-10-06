// Dev builds only: counts network requests by source and logs the total once a minute, so the
// polling load can be read off a phone in the Metro log. Release builds skip all of it.

const counts = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;
const enabled = typeof __DEV__ !== 'undefined' && __DEV__;

/** One request: `source` is devnet, mainnet or http; `what` is the RPC method or the service. */
export function countRequest(source: string, what: string): void {
  if (!enabled) return;
  const key = `${source} ${what}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  if (!timer) timer = setInterval(report, 60_000);
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
