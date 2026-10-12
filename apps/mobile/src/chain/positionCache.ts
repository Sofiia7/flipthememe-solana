/** Final transition needs one complete scan, even when a previous open snapshot had enough rows. */
export function needsPositionScan(cachedCount: number | null, positionCount: number, final: boolean, finalSynced: boolean): boolean {
  if (positionCount === 0) return false;
  return cachedCount === null || cachedCount < positionCount || (final && !finalSynced);
}
