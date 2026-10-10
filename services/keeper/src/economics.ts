/** Research tooling only. These calculations never choose or rewrite a user's outcome. */
export function wilson(wins: number, decided: number) {
  if (!Number.isSafeInteger(wins) || !Number.isSafeInteger(decided) || wins < 0 || decided < wins) throw new Error('Invalid counts');
  if (!decided) return null;
  const z = 1.95996398454, p = wins / decided, d = 1 + z * z / decided;
  const mid = (p + z * z / (2 * decided)) / d;
  const half = z * Math.sqrt(p * (1 - p) / decided + z * z / (4 * decided * decided)) / d;
  return { lower: Math.max(0, mid - half), upper: Math.min(1, mid + half) };
}
export function contribution(i: { rawStake: number; matchedShare: number; feeBps: number; rpc: number; transactions: number; archive: number; support: number; acquisition: number; houseNetCost: number }) {
  if (Object.values(i).some(v => !Number.isFinite(v))) throw new Error('Non-finite economics inputs');
  if ([i.rpc, i.transactions, i.archive, i.support, i.acquisition].some(v => v < 0)) throw new Error('Negative operating costs');
  if (i.rawStake < 0 || i.matchedShare < 0 || i.matchedShare > 1 || i.feeBps < 0 || i.feeBps > 10000) throw new Error('Invalid economics inputs');
  const matched = i.rawStake * i.matchedShare;
  const fees = matched * i.feeBps / 10000;
  const costs = i.rpc + i.transactions + i.archive + i.support + i.acquisition + i.houseNetCost;
  return { matched, fees, costs, contribution: fees - costs, units: 'all amounts must use the same currency' };
}
/** Constant-product quote needed to move spot by r; excludes arbitrage/holding/MEV and is not an attack-cost guarantee. */
export function spotMoveEstimate(quoteReserve: number, relativeMove: number, swapFee: number) {
  if (![quoteReserve, relativeMove, swapFee].every(Number.isFinite)) throw new Error('Non-finite pool inputs');
  if (quoteReserve <= 0 || relativeMove <= 0 || swapFee < 0 || swapFee >= 1) throw new Error('Invalid pool inputs');
  const quoteIn = quoteReserve * (Math.sqrt(1 + relativeMove) - 1) / (1 - swapFee);
  return { quoteIn, entryFee: quoteIn * swapFee, warning: 'Spot-only lower-bound model; replay both windows with fees, arbitrage, latency and concurrent exposure before a mainnet decision.' };
}
export type ReplayRow = { opensAt: number; dir: 'up' | 'down' | 'tie' | 'unpriced'; observedOnly?: boolean; matchedShare?: number; networkCost?: number; preCutoffMove?: number; lateMove?: number };
export function replay(rows: readonly ReplayRow[], feeBps = 200) {
  if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps > 10000) throw new Error('Invalid fee');
  for (const r of rows) {
    if (!Number.isSafeInteger(r.opensAt) || r.opensAt < 0 || !['up', 'down', 'tie', 'unpriced'].includes(r.dir) || (r.networkCost !== undefined && (!Number.isFinite(r.networkCost) || r.networkCost < 0)) || (r.matchedShare !== undefined && (!Number.isFinite(r.matchedShare) || r.matchedShare < 0 || r.matchedShare > 1))) throw new Error('Invalid replay row');
  }
  const sorted = rows.filter(r => !r.observedOnly).sort((a, b) => a.opensAt - b.opensAt);
  const split = Math.floor(sorted.length * .7);
  const test = sorted.slice(split);
  const policies = ['random', 'always-up', 'always-down', 'momentum', 'contrarian', 'late-momentum'] as const;
  const results = policies.map(policy => {
    let wins = 0, losses = 0, refunds = 0, skipped = 0, matched = 0, net = 0;
    for (const r of test) {
      let up: boolean;
      const feature = policy === 'late-momentum' ? r.lateMove : r.preCutoffMove;
      if (['momentum', 'contrarian', 'late-momentum'].includes(policy) && (feature === undefined || !Number.isFinite(feature))) { skipped++; continue; }
      up = policy === 'always-up' || (policy === 'random' ? ((Math.imul(r.opensAt, 1664525) + 1013904223) >>> 8) % 2 === 0 : policy === 'always-down' ? false : policy === 'contrarian' ? feature! < 0 : feature! >= 0);
      const share = r.matchedShare ?? 1;
      if (share < 0 || share > 1) throw new Error('Invalid matched share');
      net -= r.networkCost ?? 0;
      if (r.dir === 'tie' || r.dir === 'unpriced' || share === 0) { refunds++; continue; }
      matched += share;
      if (up === (r.dir === 'up')) { wins++; net += share * (1 - 2 * feeBps / 10000); }
      else { losses++; net -= share; }
    }
    return { policy, wins, losses, refunds, skipped, matchedStakeUnits: matched, netStakeUnits: net, winConfidence95: wilson(wins, wins + losses) };
  });
  return { temporalSplit: { calibration: split, heldOut: test.length, firstHeldOut: test[0]?.opensAt ?? null }, assumptions: 'Shadow rows default to full matching and zero network cost. Supply measured matching/costs and features recorded before cutoff; missing features are skipped. No claim of fair odds or mainnet profitability.', results };
}
