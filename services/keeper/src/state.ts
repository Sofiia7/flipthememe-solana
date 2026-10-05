/**
 * STATE_FILE: the house budget ledger (UTC day) and the selected pool, so a restart keeps both.
 * Written atomically (temp file + rename); a missing or unreadable file starts fresh.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAddress, type Address } from '@solana/kit';
import { emptyLedger, type HouseLedger } from './house.ts';
import { toJson } from './log.ts';

export type PersistedPool = { pool: Address; baseMint: Address; name: string; selectedAtMs: number; fallback: boolean };
export type KeeperState = { house: HouseLedger; pool: PersistedPool | null };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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
    state.pool = {
      pool: pool.pool,
      baseMint: pool.baseMint,
      name: typeof pool.name === 'string' ? pool.name : '',
      selectedAtMs: pool.selectedAtMs,
      fallback: pool.fallback === true,
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
