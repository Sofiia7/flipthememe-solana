// "While you were away": my rounds that turned final while the app was closed, summed up once.
// Pure TypeScript for node:test; AppProvider keeps the last acknowledged round id per wallet.

export type AwayItem = { id: bigint; kind: 'won' | 'lost' | 'refund' | 'full-refund'; stake: bigint; payout: bigint };

export type AwaySummary = {
  won: number;
  lost: number;
  refunded: number;
  /** Payouts minus stakes over these rounds (lamports, may be negative). */
  net: bigint;
  /** The newest round in the summary: acknowledging it hides them all. */
  lastId: bigint;
};

export function awaySummary(items: readonly AwayItem[]): AwaySummary | null {
  if (items.length === 0) return null;
  let won = 0;
  let lost = 0;
  let refunded = 0;
  let net = 0n;
  let lastId = items[0].id;
  for (const it of items) {
    if (it.kind === 'won') won++;
    else if (it.kind === 'lost') lost++;
    else refunded++;
    net += it.payout - it.stake;
    if (it.id > lastId) lastId = it.id;
  }
  return { won, lost, refunded, net, lastId };
}

/** "2 won, 1 lost · net +0.0192 SOL" with the amount formatter of the caller. */
export function awayText(s: AwaySummary, sol: (lamports: bigint) => string): string {
  const parts = [s.won ? `${s.won} won` : '', s.lost ? `${s.lost} lost` : '', s.refunded ? `${s.refunded} refunded` : ''].filter(Boolean);
  const sign = s.net > 0n ? '+' : s.net < 0n ? '-' : '';
  return `While you were away: ${parts.join(', ')} · net ${sign}${sol(s.net < 0n ? -s.net : s.net)} SOL`;
}
