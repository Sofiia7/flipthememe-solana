/**
 * STATE_FILE: the house budget ledger (UTC day) and the selected pool, so a restart keeps both.
 * Written atomically (temp file + rename); a missing or unreadable file starts fresh.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAddress, type Address } from '@solana/kit';
import { MAX_LEDGER_WALLETS, emptyLedger, type HouseLedger } from './house.ts';
import { toJson } from './log.ts';
import { isRung, type Rung } from './poolgate.ts';

/** `rung` is the fallback-ladder rung (0 = fresh); files written before it existed map fallback to 3. */
export type PersistedPool = { pool: Address; baseMint: Address; name: string; selectedAtMs: number; rung: Rung; fallback: boolean };
export type KeeperState = { house: HouseLedger; pool: PersistedPool | null };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseFills(raw: unknown): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  const entries = Object.entries(raw)
    .filter((e): e is [string, number] => isAddress(e[0]) && typeof e[1] === 'number' && Number.isSafeInteger(e[1]) && e[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_LEDGER_WALLETS);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

export function parseState(raw: unknown, nowMs: number): KeeperState {
  const state: KeeperState = { house: emptyLedger(nowMs), pool: null };
  if (!isRecord(raw)) return state;
  const house = raw.house;
  if (
    isRecord(house) &&
    typeof house.day === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(house.day) &&
    typeof house.spent === 'string' &&
    /^\d+$/.test(house.spent) &&
    Array.isArray(house.rounds)
  ) {
    state.house = {
      day: house.day,
      spent: BigInt(house.spent),
      rounds: house.rounds.filter((r): r is string => typeof r === 'string' && /^\d+$/.test(r)),
    };
    // Per-wallet fill counts of the day (files written before the wallet limit have none); bad entries are dropped.
    const fills = parseFills(house.fills);
    if (fills) state.house.fills = fills;
  }
  const pool = raw.pool;
  if (
    isRecord(pool) &&
    typeof pool.pool === 'string' &&
    isAddress(pool.pool) &&
    typeof pool.baseMint === 'string' &&
    isAddress(pool.baseMint) &&
    typeof pool.selectedAtMs === 'number' &&
    Number.isFinite(pool.selectedAtMs)
  ) {
    const rung: Rung = isRung(pool.rung) ? pool.rung : pool.fallback === true ? 3 : 0;
    state.pool = {
      pool: pool.pool,
      baseMint: pool.baseMint,
      name: typeof pool.name === 'string' ? pool.name : '',
      selectedAtMs: pool.selectedAtMs,
      rung,
      fallback: rung > 0,
    };
  }
  return state;
}

/** Writes via a temp file and rename, so a crash never leaves half a JSON file behind. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${toJson(value)}\n`;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body);
  try {
    renameSync(tmp, path);
  } catch {
    // Windows refuses to replace a file another process holds open; fall back to a plain write.
    writeFileSync(path, body);
  }
}

export class StateStore {
  readonly path: string;
  state: KeeperState;

  constructor(path: string, nowMs: number) {
    this.path = path;
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      raw = null;
    }
    this.state = parseState(raw, nowMs);
  }

  save(): void {
    writeJsonAtomic(this.path, { version: 1, house: this.state.house, pool: this.state.pool });
  }
}
