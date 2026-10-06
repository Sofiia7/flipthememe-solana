/**
 * Recent mainnet price observations per pool (about 15 minutes), and the samples of one
 * strike or exit window as they go into set_strike / settle. The store is written to a JSON file
 * next to the state file (at most every 5 s, and on a graceful shutdown) and read back at start,
 * so a restart inside a window does not throw its samples away.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { windowMean, type PriceObservation, type PriceSample } from '@flipthememe/client';
import type { Logger } from './log.ts';
import { writeJsonAtomic } from './state.ts';

export const RETAIN_MS = 15 * 60 * 1000;
/** At most one write of the observations file per this long. */
export const PERSIST_EVERY_MS = 5_000;
export const OBSERVATIONS_VERSION = 1;
/** 15 minutes of a few pools is a few hundred KB; a file far above that is not ours and is not read. */
export const MAX_OBSERVATIONS_FILE_BYTES = 4 * 1024 * 1024;
/** An observation stamped further ahead of the clock than this was written by a wrong clock: dropped at load. */
export const FUTURE_SKEW_MS = 5_000;

export class ObservationStore {
  /** Counts every change, so the persister knows whether there is anything new to write. */
  revision = 0;
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
    this.revision++;
    this.pruneList(pool, list, observation.atMs);
  }

  /** Puts observations read back from the file in front of what the store holds, in time order. */
  restore(pools: ReadonlyMap<string, readonly PriceObservation[]>): void {
    for (const [pool, restored] of pools) {
      const merged = [...restored, ...(this.byPool.get(pool) ?? [])].sort((a, b) => a.atMs - b.atMs);
      if (merged.length > 0) this.byPool.set(pool, merged);
    }
    this.revision++;
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

  /** The observations of the last retention window before `nowMs`, per pool, oldest first (pools without any are left out). */
  recent(nowMs: number): Map<string, PriceObservation[]> {
    const out = new Map<string, PriceObservation[]>();
    const cutoff = nowMs - this.retainMs;
    for (const [pool, list] of this.byPool) {
      const kept = list.filter((o) => o.atMs >= cutoff);
      if (kept.length > 0) out.set(pool, kept);
    }
    return out;
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

// ---- the observations file ------------------------------------------------------------------

/**
 * The file: {"version": 1, "savedAt": <ms>, "pools": {"<pool>": [[atMs, slot, baseAmount, quoteAmount, price], ...]}}.
 * Slots and amounts are decimal strings (a u64 does not fit a JS number); only atMs is a number.
 */
export function serializeObservations(store: ObservationStore, nowMs: number): unknown {
  const pools: Record<string, [number, string, string, string, string][]> = {};
  for (const [pool, list] of store.recent(nowMs)) {
    pools[pool] = list.map((o) => [o.atMs, o.slot.toString(), o.baseAmount.toString(), o.quoteAmount.toString(), o.price.toString()]);
  }
  return { version: OBSERVATIONS_VERSION, savedAt: nowMs, pools };
}

const U64_TEXT = /^\d{1,20}$/;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

function parseEntry(entry: unknown, oldestMs: number, newestMs: number): PriceObservation | null {
  if (!Array.isArray(entry) || entry.length !== 5) return null;
  const [atMs, slot, baseAmount, quoteAmount, price] = entry as unknown[];
  if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs < oldestMs || atMs > newestMs) return null;
  const numbers: bigint[] = [];
  for (const text of [slot, baseAmount, quoteAmount, price]) {
    if (typeof text !== 'string' || !U64_TEXT.test(text)) return null;
    const value = BigInt(text);
    if (value > U64_MAX) return null;
    numbers.push(value);
  }
  return { atMs, slot: numbers[0] ?? 0n, baseAmount: numbers[1] ?? 0n, quoteAmount: numbers[2] ?? 0n, price: numbers[3] ?? 0n };
}

export type ParsedObservations = { pools: Map<string, PriceObservation[]>; kept: number; dropped: number };

/**
 * The observations of a parsed file that are still usable at `nowMs`: not older than `retainMs`,
 * not stamped in the future, well formed. A bad entry is dropped on its own; a file that is not
 * of this format at all throws. Per pool the entries come back in time order.
 */
export function parseObservations(raw: unknown, nowMs: number, retainMs: number = RETAIN_MS): ParsedObservations {
  const file = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const poolsRaw = file?.pools;
  if (!file || file.version !== OBSERVATIONS_VERSION || typeof poolsRaw !== 'object' || poolsRaw === null || Array.isArray(poolsRaw)) {
    throw new Error(`not an observations file of version ${OBSERVATIONS_VERSION}`);
  }
  const pools = new Map<string, PriceObservation[]>();
  let kept = 0;
  let dropped = 0;
  for (const [pool, entries] of Object.entries(poolsRaw as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    const list: PriceObservation[] = [];
    for (const entry of entries) {
      const observation = parseEntry(entry, nowMs - retainMs, nowMs + FUTURE_SKEW_MS);
      if (observation) list.push(observation);
      else dropped++;
    }
    if (list.length === 0) continue;
    list.sort((a, b) => a.atMs - b.atMs);
    pools.set(pool, list);
    kept += list.length;
  }
  return { pools, kept, dropped };
}

/** Keeps the observations file in step with the store: load at start, throttled writes, a final write on shutdown. */
export class ObservationPersister {
  private readonly store: ObservationStore;
  private readonly path: string;
  private readonly logger: Logger;
  private readonly everyMs: number;
  /** Revision of the store as last written (0: a store that never changed has nothing to write). */
  private savedRevision = 0;
  private savedAtMs = Number.NEGATIVE_INFINITY;

  constructor(opts: { store: ObservationStore; path: string; logger: Logger; everyMs?: number }) {
    this.store = opts.store;
    this.path = opts.path;
    this.logger = opts.logger;
    this.everyMs = opts.everyMs ?? PERSIST_EVERY_MS;
  }

  /** Loads what the file still has that is usable at `nowMs`. A missing file is the normal first start; a bad one is logged and ignored. */
  restore(nowMs: number): void {
    if (existsSync(this.path)) {
      try {
        if (statSync(this.path).size > MAX_OBSERVATIONS_FILE_BYTES) throw new Error(`file is larger than ${MAX_OBSERVATIONS_FILE_BYTES} bytes`);
        const parsed = parseObservations(JSON.parse(readFileSync(this.path, 'utf8')), nowMs);
        this.store.restore(parsed.pools);
        this.logger({ event: 'observations_restored', pools: parsed.pools.size, observations: parsed.kept, dropped: parsed.dropped });
      } catch (error) {
        this.logger({ event: 'observations_restore_failed', error: error instanceof Error ? error.message.slice(0, 200) : 'unreadable' });
      }
    }
    // What was just loaded is what the file holds (give or take stale entries): nothing to write yet.
    this.savedRevision = this.store.revision;
  }

  /** Writes when something changed and the last write is at least `everyMs` old. Returns whether it wrote; a failed write throws. */
  maybeSave(nowMs: number): boolean {
    if (this.store.revision === this.savedRevision || nowMs - this.savedAtMs < this.everyMs) return false;
    return this.write(nowMs);
  }

  /** Writes when something changed since the last write, whatever the interval (graceful shutdown). */
  saveNow(nowMs: number): boolean {
    if (this.store.revision === this.savedRevision) return false;
    return this.write(nowMs);
  }

  private write(nowMs: number): boolean {
    // Marked before the write: a failing disk is retried at the normal pace, not on every tick.
    this.savedAtMs = nowMs;
    const revision = this.store.revision;
    writeJsonAtomic(this.path, serializeObservations(this.store, nowMs));
    this.savedRevision = revision;
    return true;
  }
}
