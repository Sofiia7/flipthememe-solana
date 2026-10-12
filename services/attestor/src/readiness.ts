/** Readiness is deliberately independent of process liveness. Idle pools need no fresh sample. */
export function readiness(input: { now: number; refreshedAt: number; oracleMatches: boolean; keyOk: boolean; windows: readonly { startMs: number; endMs: number; lastSampleAt?: number | null }[]; lastSampleAt: number | null }) {
  const reasons: string[] = [];
  if (!input.keyOk) reasons.push('signing_key_unavailable');
  if (!input.oracleMatches) reasons.push('oracle_not_verified');
  if (!input.refreshedAt || input.now - input.refreshedAt > 90_000) reasons.push('devnet_snapshot_stale');
  const staleWindow = input.windows.some(w => {
    if (input.now < w.startMs + 3_000 || input.now >= w.endMs) return false;
    const sampledAt = w.lastSampleAt === undefined ? input.lastSampleAt : w.lastSampleAt;
    return sampledAt === null || sampledAt < w.startMs || input.now - sampledAt > 4_000;
  });
  if (staleWindow) reasons.push('window_samples_stale');
  return { ready: reasons.length === 0, reasons, checkedAt: new Date(input.now).toISOString() };
}
