import { useEffect, useState } from 'react';

/** The earliest of the moments (local ms) that still lie ahead of `nowMs`; null when none does. */
export function soonestAfter(nowMs: number, moments: readonly (number | null | undefined)[]): number | null {
  let best: number | null = null;
  for (const moment of moments) {
    if (moment === null || moment === undefined || !Number.isFinite(moment) || moment <= nowMs) continue;
    if (best === null || moment < best) best = moment;
  }
  return best;
}

/** The longest delay setTimeout accepts. */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** A little past the moment, so the re-render sees it as passed. */
const WAKE_MARGIN_MS = 30;

/**
 * Re-renders the component once when the local time `atMs` has passed. There is no ticking interval: a
 * long list of rows costs nothing while it waits for its next deadline. `null` waits for nothing.
 */
export function useWakeAt(atMs: number | null): void {
  const [, setWoken] = useState(0);
  useEffect(() => {
    if (atMs === null) return;
    const wait = atMs - Date.now();
    if (wait <= 0) {
      // Passed between the render and this effect: render again now, the deadline no longer counts.
      setWoken((n) => n + 1);
      return;
    }
    const id = setTimeout(() => setWoken((n) => n + 1), Math.min(wait, MAX_TIMEOUT_MS) + WAKE_MARGIN_MS);
    return () => clearTimeout(id);
  }, [atMs]);
}
