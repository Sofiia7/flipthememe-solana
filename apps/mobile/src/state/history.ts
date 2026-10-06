// History that outlives the chain: the program closes a Position account about an hour after its
// round is final and claimed, so every result this phone sees final is also kept on the phone, per
// wallet. History and Profile show the chain rows plus the kept rows the chain no longer has (the
// chain row wins when both exist). Pure TypeScript (no React Native imports), so node:test covers
// it; storage is injected.
import { RoundStatus, type PositionAccount, type RoundAccount } from '@flipthememe/client';
import { positionResult, roundResultLabel, type PositionResult, type ResultLabel } from '../chain/phase.ts';
import type { KeyValueStorage } from '../lib/boolStore.ts';

export type ChainRound = { id: bigint; address: string; account: RoundAccount };
export type ChainPosition = { address: string; account: PositionAccount; round: ChainRound | null };

/** One finished round of mine, as History and Profile show it. */
export type HistoryRecord = {
  /** Position account address (closed once claimed and old). */
  position: string;
  roundId: bigint;
  /** Round account address. */
  round: string;
  side: number;
  stake: bigint;
  /** Part of the stake that played. */
  accepted: bigint | null;
  /** Credited to the game balance. */
  payout: bigint | null;
  kind: Exclude<PositionResult['kind'], 'pending'>;
  label: ResultLabel;
  tokenMint: string;
  pool: string;
  strike: bigint;
  exit: bigint;
  /** Round times, unix seconds. */
  opensAt: number;
  exitEnd: number;
  claimed: boolean;
  /** The 8 face bytes of the bet, hex (the win card draws them). */
  face: string;
  /** Local ms when this phone first kept it. */
  savedAt: number;
};

export type HistoryEntry<P extends ChainPosition = ChainPosition> =
  | { kind: 'chain'; key: string; roundId: bigint | null; position: P }
  | { kind: 'stored'; key: string; roundId: bigint; record: HistoryRecord };

/** Kept rows per wallet, newest rounds first. */
export const HISTORY_CAP = 500;

/** Storage entry per wallet; bump the version when the row format changes. */
const PREFIX = 'ftm.history.v1.';
export const historyEntry = (owner: string) => `${PREFIX}${owner}`;

const KINDS: readonly HistoryRecord['kind'][] = ['won', 'lost', 'refund', 'full-refund'];
const LABELS: readonly ResultLabel[] = ['UP', 'DOWN', 'TIE', 'NO PRICE', 'EXPIRED', 'REFUND', 'NO MATCH', 'PENDING'];

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** The face bytes of a kept row (8 bytes; zeros if unreadable). */
export function recordFace(record: HistoryRecord): Uint8Array {
  const out = new Uint8Array(8);
  if (!/^[0-9a-f]{16}$/.test(record.face)) return out;
  for (let i = 0; i < 8; i++) out[i] = parseInt(record.face.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The row to keep for a position whose round is final; null while it is not. */
export function recordOf(p: ChainPosition, savedAt: number): HistoryRecord | null {
  const round = p.round;
  if (!round || round.account.status !== RoundStatus.Final) return null;
  const a = round.account;
  // Once final the result no longer depends on the time.
  const r = positionResult(p.account, a, Number(a.exitEnd));
  if (r.kind === 'pending') return null;
  return {
    position: p.address,
    roundId: round.id,
    round: round.address,
    side: p.account.side,
    stake: p.account.stake,
    accepted: r.accepted,
    payout: r.payout,
    kind: r.kind,
    label: roundResultLabel(a),
    tokenMint: a.tokenMint,
    pool: a.pool,
    strike: a.strikePrice,
    exit: a.exitPrice,
    opensAt: Number(a.opensAt),
    exitEnd: Number(a.exitEnd),
    claimed: p.account.claimed,
    face: toHex(p.account.face.slice(0, 8)),
    savedAt,
  };
}

function sameRecord(a: HistoryRecord, b: HistoryRecord): boolean {
  return (
    a.position === b.position &&
    a.roundId === b.roundId &&
    a.round === b.round &&
    a.side === b.side &&
    a.stake === b.stake &&
    a.accepted === b.accepted &&
    a.payout === b.payout &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.tokenMint === b.tokenMint &&
    a.pool === b.pool &&
    a.strike === b.strike &&
    a.exit === b.exit &&
    a.opensAt === b.opensAt &&
    a.exitEnd === b.exitEnd &&
    a.claimed === b.claimed &&
    a.face === b.face
  );
}

const byRoundDesc = (a: { roundId: bigint; position: string }, b: { roundId: bigint; position: string }) =>
  a.roundId > b.roundId ? -1 : a.roundId < b.roundId ? 1 : a.position < b.position ? -1 : a.position > b.position ? 1 : 0;

/**
 * Kept rows after a successful read of all my positions: final rounds are added or updated (a claim
 * flips `claimed`), and a kept row whose account is gone is marked claimed (the program closes a
 * position only after its claim). Newest `cap` rounds stay. Returns `records` itself when nothing changed.
 */
export function reconcileHistory(
  records: readonly HistoryRecord[],
  chain: readonly ChainPosition[],
  opts: { cap?: number; nowMs: number },
): readonly HistoryRecord[] {
  const cap = opts.cap ?? HISTORY_CAP;
  const kept = new Map(records.map((r) => [r.position, r]));
  let changed = false;
  for (const p of chain) {
    const fresh = recordOf(p, opts.nowMs);
    if (!fresh) continue;
    const old = kept.get(fresh.position);
    if (old && sameRecord(old, fresh)) continue;
    kept.set(fresh.position, old ? { ...fresh, savedAt: old.savedAt } : fresh);
    changed = true;
  }
  const onChain = new Set(chain.map((p) => p.address));
  for (const [position, r] of kept) {
    if (!r.claimed && !onChain.has(position)) {
      kept.set(position, { ...r, claimed: true });
      changed = true;
    }
  }
  if (!changed && records.length <= cap) return records;
  return [...kept.values()].sort(byRoundDesc).slice(0, cap);
}

/**
 * Chain rows plus the kept rows the chain no longer has, newest round first (rows without round
 * data last). A chain row wins over a kept one of the same position or round, except a chain row
 * whose round could not be read: the kept row has everything, so it shows instead.
 */
export function mergeHistory<P extends ChainPosition>(chain: readonly P[], records: readonly HistoryRecord[]): HistoryEntry<P>[] {
  const kept = new Map(records.map((r) => [r.position, r]));
  const out: HistoryEntry<P>[] = [];
  const shown = new Set<string>();
  const rounds = new Set<bigint>();
  for (const p of chain) {
    if (!p.round && kept.has(p.address)) continue;
    out.push({ kind: 'chain', key: p.address, roundId: p.round?.id ?? null, position: p });
    shown.add(p.address);
    if (p.round) rounds.add(p.round.id);
  }
  for (const r of records) {
    if (shown.has(r.position) || rounds.has(r.roundId)) continue;
    out.push({ kind: 'stored', key: r.position, roundId: r.roundId, record: r });
    shown.add(r.position);
  }
  return out.sort((a, b) => {
    const x = a.roundId ?? -1n;
    const y = b.roundId ?? -1n;
    return x > y ? -1 : x < y ? 1 : 0;
  });
}

export type HistoryStats = { rounds: number; wins: number; losses: number; refunds: number; open: number; net: bigint };

/** Profile numbers over the merged history (finished rounds count towards net). */
export function historyStats(entries: readonly HistoryEntry[], nowSec: number): HistoryStats {
  let wins = 0;
  let losses = 0;
  let refunds = 0;
  let open = 0;
  let staked = 0n;
  let returned = 0n;
  for (const e of entries) {
    let kind: PositionResult['kind'];
    let stake: bigint;
    let payout: bigint | null;
    if (e.kind === 'stored') {
      ({ kind, stake, payout } = e.record);
    } else {
      const p = e.position;
      if (!p.round) continue;
      if (p.round.account.status !== RoundStatus.Final) {
        open++;
        continue;
      }
      const r = positionResult(p.account, p.round.account, nowSec);
      kind = r.kind;
      stake = p.account.stake;
      payout = r.payout;
    }
    if (kind === 'won') wins++;
    else if (kind === 'lost') losses++;
    else refunds++;
    staked += stake;
    returned += payout ?? 0n;
  }
  return { rounds: entries.length, wins, losses, refunds, open, net: returned - staked };
}

type StoredRow = Omit<HistoryRecord, 'roundId' | 'stake' | 'accepted' | 'payout' | 'strike' | 'exit'> & {
  roundId: string;
  stake: string;
  accepted: string | null;
  payout: string | null;
  strike: string;
  exit: string;
};

export function serializeHistory(records: readonly HistoryRecord[]): string {
  const rows: StoredRow[] = records.map((r) => ({
    ...r,
    roundId: r.roundId.toString(),
    stake: r.stake.toString(),
    accepted: r.accepted === null ? null : r.accepted.toString(),
    payout: r.payout === null ? null : r.payout.toString(),
    strike: r.strike.toString(),
    exit: r.exit.toString(),
  }));
  return JSON.stringify({ v: 1, rows });
}

const UINT = /^\d{1,20}$/;
const isAddress = (v: unknown): v is string => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
const uint = (v: unknown): bigint | undefined => (typeof v === 'string' && UINT.test(v) ? BigInt(v) : undefined);
const uintOrNull = (v: unknown): bigint | null | undefined => (v === null ? null : uint(v));

function fromStored(row: Partial<StoredRow> | null): HistoryRecord | null {
  if (!row || !isAddress(row.position) || !isAddress(row.round) || !isAddress(row.tokenMint) || !isAddress(row.pool)) return null;
  const roundId = uint(row.roundId);
  const stake = uint(row.stake);
  const accepted = uintOrNull(row.accepted);
  const payout = uintOrNull(row.payout);
  const strike = uint(row.strike);
  const exit = uint(row.exit);
  if (roundId === undefined || stake === undefined || accepted === undefined || payout === undefined || strike === undefined || exit === undefined) {
    return null;
  }
  if (!KINDS.includes(row.kind as HistoryRecord['kind']) || !LABELS.includes(row.label as ResultLabel)) return null;
  return {
    position: row.position,
    roundId,
    round: row.round,
    side: row.side === 1 ? 1 : 0,
    stake,
    accepted,
    payout,
    kind: row.kind as HistoryRecord['kind'],
    label: row.label as ResultLabel,
    tokenMint: row.tokenMint,
    pool: row.pool,
    strike,
    exit,
    opensAt: Number(row.opensAt) || 0,
    exitEnd: Number(row.exitEnd) || 0,
    claimed: row.claimed === true,
    face: typeof row.face === 'string' && /^[0-9a-f]{16}$/.test(row.face) ? row.face : '0000000000000000',
    savedAt: Number(row.savedAt) || 0,
  };
}

/** Kept rows from storage, newest first; unreadable rows and other versions are dropped. */
export function parseHistory(raw: string | null): HistoryRecord[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as { v?: unknown; rows?: unknown };
    if (data?.v !== 1 || !Array.isArray(data.rows)) return [];
    const out: HistoryRecord[] = [];
    for (const row of data.rows as (Partial<StoredRow> | null)[]) {
      const r = fromStored(row);
      if (r) out.push(r);
    }
    return out.sort(byRoundDesc);
  } catch {
    return [];
  }
}

export function createHistoryStore(storage: KeyValueStorage) {
  return {
    load: async (owner: string): Promise<HistoryRecord[]> => parseHistory(await storage.getItem(historyEntry(owner))),
    save: (owner: string, records: readonly HistoryRecord[]) => storage.setItem(historyEntry(owner), serializeHistory(records)),
  };
}
