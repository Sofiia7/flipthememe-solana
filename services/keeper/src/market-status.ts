import type { Selection } from './selector.ts';
export function marketStatus(pool: Selection | null, readiness: string | null, paused: boolean, observingPools: number, now = Date.now()) {
  const match = readiness?.match(/(\d+)\/(\d+) priced shadow minutes/);
  return {
    updatedAt: new Date(now).toISOString(),
    phase: paused ? 'paused' : !pool ? 'searching' : readiness ? 'observing' : 'ready',
    reason: paused ? 'New bets are temporarily paused. Existing bets can settle and be withdrawn.' : !pool ? 'No market currently passes the activity, price-drift and momentum checks.' : readiness ?? 'Market checks passed. Waiting for the next minute boundary.',
    progress: match ? { observed: Number(match[1]), required: Number(match[2]) } : null,
    observingPools,
    pool: pool ? { pool: pool.pool, baseMint: pool.baseMint, name: pool.name } : null,
  };
}
