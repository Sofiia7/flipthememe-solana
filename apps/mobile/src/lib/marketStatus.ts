import type { Address } from '@solana/kit';
export type MarketStatus = { updatedAt: string; phase: 'paused' | 'searching' | 'observing' | 'ready'; reason: string; progress: { observed: number; required: number } | null; observingPools: number; pool: { pool: Address; baseMint: Address; name: string } | null };
export function parseMarketStatus(raw: unknown): MarketStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as MarketStatus;
  if (!['paused', 'searching', 'observing', 'ready'].includes(r.phase) || !Number.isFinite(Date.parse(r.updatedAt)) || typeof r.reason !== 'string' || r.reason.length > 500) return null;
  const address = (v: unknown) => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
  if (r.pool && (!address(r.pool.pool) || !address(r.pool.baseMint) || typeof r.pool.name !== 'string' || r.pool.name.length > 200)) return null;
  if (r.progress && (!Number.isInteger(r.progress.observed) || !Number.isInteger(r.progress.required) || r.progress.observed < 0 || r.progress.required < 1 || r.progress.required > 100 || r.progress.observed > r.progress.required)) return null;
  if (!Number.isInteger(r.observingPools) || r.observingPools < 0 || r.observingPools > 100) return null;
  return r;
}
export function waitingView(status: MarketStatus | null, now: number) {
  if (!status || now - Date.parse(status.updatedAt) > 240_000 || Date.parse(status.updatedAt) > now + 30_000) return { title: 'WAITING FOR MARKET STATUS', detail: 'Cannot confirm when betting will resume. Reconnecting...', progress: null };
  return { title: status.phase === 'paused' ? 'NEW BETS PAUSED' : status.phase === 'observing' ? 'CHECKING THIS MARKET' : status.phase === 'ready' ? 'PREPARING NEXT ROUND' : 'CHECKING MARKETS', detail: status.phase === 'observing' ? `Measuring price moves before opening bets. Observing ${status.observingPools} markets.` : status.reason, progress: status.progress };
}
