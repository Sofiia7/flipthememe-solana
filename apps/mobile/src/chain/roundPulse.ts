// "7 IN · 0.42 SOL": how many players are in the open round and how much they put in, shown big on the
// arena as social proof. It reads what the arena already has (the round's positions and totals); no
// backend. Pure TypeScript (no React Native imports) for node:test.

export type RoundPulse = {
  /** Players in the round (the house is not a player). */
  players: number;
  /** Everything staked on both sides, lamports. */
  total: bigint;
};

/**
 * Players and total for one round. The position list can lag behind the round's own count (it is read
 * again when the count moves), so the larger of the two counts is used, with the house taken out.
 */
export function roundPulse(input: {
  positions: readonly { account: { isHouse: boolean } }[];
  positionCount: number;
  rawUp: bigint;
  rawDown: bigint;
}): RoundPulse {
  let listed = 0;
  let house = 0;
  for (const p of input.positions) {
    if (p.account.isHouse) house++;
    else listed++;
  }
  const counted = Math.max(0, input.positionCount - house);
  return { players: Math.max(listed, counted), total: input.rawUp + input.rawDown };
}

/** "7 IN · 0.42 SOL"; null while nobody is in (the panel then says BE THE FIRST TO CALL IT). */
export function pulseText(p: RoundPulse, formatSol: (lamports: bigint) => string): string | null {
  if (p.players <= 0) return null;
  return `${p.players} IN · ${formatSol(p.total)} SOL`;
}
