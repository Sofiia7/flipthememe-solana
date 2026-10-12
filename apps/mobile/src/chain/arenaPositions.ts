import type { PositionView } from './fetch';

/** A delayed arena scan must not hide a position already read from the player's account. */
export function withOwnPosition(positions: readonly PositionView[], own?: PositionView | null): readonly PositionView[] {
  return !own || positions.some(p => p.address === own.address) ? positions : [...positions, own];
}

/** Keep a confirmed receipt visible until the position replaces it, even after entry closes. */
export function showBetReceipt(phase: string, roundId: bigint | null, visible: boolean): boolean {
  return phase === 'signing' || phase === 'sending' || phase === 'confirming' || phase === 'failed' || (phase === 'confirmed' && roundId !== null && !visible);
}
