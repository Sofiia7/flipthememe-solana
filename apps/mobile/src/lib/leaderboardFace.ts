/** Preserve the exact eight face bytes carried by an indexed on-chain position. */
export function leaderboardFaceBytes(hex: unknown): Uint8Array | null {
  if (typeof hex !== 'string' || !/^[0-9a-f]{16}$/.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g)!, value => parseInt(value, 16));
}
