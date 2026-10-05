/**
 * Recent mainnet price observations per pool (about 15 minutes), and the samples of one
 * strike or exit window as they go into set_strike / settle.
 */
import { windowMean, type PriceObservation, type PriceSample } from '@flipthememe/client';

export const RETAIN_MS = 15 * 60 * 1000;

export class ObservationStore {
  private readonly byPool = new Map<string, PriceObservation[]>();
  private readonly retainMs: number;

  constructor(retainMs: number = RETAIN_MS) {
    this.retainMs = retainMs;
  }

  add(pool: string, observation: PriceObservation): void {
    let list = this.byPool.get(pool);
    if (!list) {
      list = [];
      this.byPool.set(pool, list);
    }
    list.push(observation);
    this.pruneList(pool, list, observation.atMs);
  }

  get(pool: string): readonly PriceObservation[] {
    return this.byPool.get(pool) ?? [];
  }

  latest(pool: string): PriceObservation | null {
    const list = this.byPool.get(pool);
    return list && list.length > 0 ? (list[list.length - 1] ?? null) : null;
  }

  pools(): string[] {
    return [...this.byPool.keys()];
  }

  /** Drops observations older than the retention window, and pools left without any. */
  prune(nowMs: number): void {
    for (const [pool, list] of this.byPool) this.pruneList(pool, list, nowMs);
  }

  private pruneList(pool: string, list: PriceObservation[], nowMs: number): void {
    const cutoff = nowMs - this.retainMs;
    let drop = 0;
    while (drop < list.length && (list[drop]?.atMs ?? 0) < cutoff) drop++;
    if (drop > 0) list.splice(0, drop);
    if (list.length === 0) this.byPool.delete(pool);
  }
}

/**
 * Samples for the window [startSecs, endSecs) of the round's pool: the client's windowMean
 * selection (one per slot, sorted by slot, at most 16, zero prices dropped), or an empty list
 * when fewer than 5 remain. An empty list is valid input: the program then refunds the round
 * as unpriceable, or ends it as NotActivated if it never had a matched bank.
 */
export function windowSamples(observations: readonly PriceObservation[], startSecs: bigint, endSecs: bigint): PriceSample[] {
  const mean = windowMean(observations, Number(startSecs) * 1000, Number(endSecs) * 1000);
  return mean ? mean.samples.map((o) => ({ slot: o.slot, price: o.price })) : [];
}
