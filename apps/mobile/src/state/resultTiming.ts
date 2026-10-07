// How long each result overlay stays up. Pure TypeScript (no React Native imports) for node:test.
//
// A win stays up to 20 s (a queued result is never stuck behind it), counted again after a share sheet.
// The win overlay does not hold for its offer: the offer takes itself away 6 s before entry closes, so a hold
// could only keep a queued result waiting. A rekt is short, but not while the
// SAME CALL / FLIP IT offer is on it: a loser who is reading the offer must not lose it to a timer, and
// the offer takes itself away (chain/repeatBet.ts) once the open round is about to close.

export const WIN_MS = 20_000;
export const REKT_MS = 6_000;
export const REFUND_MS = 4_000;

/** A rekt that holds on to an offer is closed after this anyway: a safety net, the offer ends long before. */
export const REKT_HOLD_MAX_MS = 60_000;
/** When the offer goes away on its own the rekt stays this much longer, so the screen never snaps shut under a thumb. */
export const REKT_GRACE_MS = 1_500;

/**
 * Milliseconds from now until a REKT overlay closes by itself.
 * - no offer on it: the usual REKT_MS after it appeared (at least REKT_GRACE_MS from now);
 * - an offer shown: held (only the REKT_HOLD_MAX_MS safety net counts), unless another result waits
 *   behind this one: that one is not made to wait for an offer, so the usual time applies.
 * Call it again when `offerShown` or `queued` changes; `elapsedMs` is the time since the overlay appeared.
 */
export function rektCloseDelay(input: { elapsedMs: number; offerShown: boolean; queued: boolean }): number {
  const elapsed = Math.max(0, input.elapsedMs);
  if (input.offerShown && !input.queued) return Math.max(REKT_GRACE_MS, REKT_HOLD_MAX_MS - elapsed);
  return Math.max(REKT_GRACE_MS, REKT_MS - elapsed);
}
