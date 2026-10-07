/**
 * rounds.jsonl: one line per round the keeper sweeps, for the numbers nobody else keeps. Positions and
 * rounds are closed a day after they are played and their rent goes back, so the chain forgets who played;
 * this file is the keeper's own record of how many real people the arena had.
 *
 * A line carries what the keeper knows at the sweep (the round is final, every position is claimed): the
 * outcome and prices, the three bank figures, and from the positions of the round `humans` (positions that
 * are not the house's), `wallets` (distinct owners among them) and `positions` (all of them, house included).
 * `humans` and `wallets` are null when the positions could not be read or were closed before the sweep.
 * `players` lists those wallets (at most 50), so that the unique wallets of the whole file can be counted: a count
 * per round cannot be added up across rounds.
 * scripts/stats.ts turns the file into the figures for the deck. The file is bounded (jsonl.ts).
 */
import { Outcome, RefundReason, type PositionAccount, type RoundAccount } from '@flipthememe/client';
import type { JsonlFile } from './jsonl.ts';
import type { Logger } from './log.ts';

export type RoundRow = {
  id: string;
  /** When the line was written (ISO). */
  ts: string;
  /** Unix seconds of the round's opens_at. */
  opensAt: number;
  pool: string;
  /** The pool's name as the keeper's selector knew it; null for a round created before a restart or by another keeper. */
  name: string | null;
  outcome: string;
  refundReason: string;
  /** Decimal strings (u64). */
  strike: string;
  exit: string;
  rawUp: string;
  rawDown: string;
  houseAmount: string;
  humans: number | null;
  wallets: number | null;
  /** The distinct human wallets of the round (at most MAX_PLAYERS); null together with humans and wallets. */
  players: string[] | null;
  positions: number;
};

export const MAX_PLAYERS = 50;

const OUTCOME_NAMES: Record<number, string> = {
  [Outcome.Pending]: 'pending',
  [Outcome.Up]: 'up',
  [Outcome.Down]: 'down',
  [Outcome.Refund]: 'refund',
  [Outcome.NotActivated]: 'not_activated',
};
const REFUND_NAMES: Record<number, string> = {
  [RefundReason.None]: 'none',
  [RefundReason.Tie]: 'tie',
  [RefundReason.Unpriceable]: 'unpriceable',
  [RefundReason.Expired]: 'expired',
};

/** The people in a round's positions: those that are not the house's, and the distinct wallets among them. */
export function countHumans(positions: readonly Pick<PositionAccount, 'authority' | 'isHouse'>[]): { humans: number; wallets: number; players: string[] } {
  const humans = positions.filter((p) => !p.isHouse);
  const players = [...new Set<string>(humans.map((p) => p.authority))];
  return { humans: humans.length, wallets: players.length, players: players.slice(0, MAX_PLAYERS) };
}

export function roundRow(
  round: RoundAccount,
  name: string | null,
  positions: readonly Pick<PositionAccount, 'authority' | 'isHouse'>[] | null,
  nowMs: number,
): RoundRow {
  const counted = positions && positions.length > 0 ? countHumans(positions) : null;
  return {
    id: round.id.toString(),
    ts: new Date(nowMs).toISOString(),
    opensAt: Number(round.opensAt),
    pool: round.pool,
    name,
    outcome: OUTCOME_NAMES[round.outcome] ?? String(round.outcome),
    refundReason: REFUND_NAMES[round.refundReason] ?? String(round.refundReason),
    strike: round.strikePrice.toString(),
    exit: round.exitPrice.toString(),
    rawUp: round.rawUp.toString(),
    rawDown: round.rawDown.toString(),
    houseAmount: round.houseAmount.toString(),
    humans: counted ? counted.humans : null,
    wallets: counted ? counted.wallets : null,
    players: counted ? counted.players : null,
    positions: round.positionCount,
  };
}

/** Rows read back are kept this many at most for the "already written" check. */
const KNOWN_ROWS = 5_000;

export class RoundLog {
  private readonly file: JsonlFile;
  private readonly logger: Logger;
  private readonly known = new Set<string>();
  private writeFailed = false;

  constructor(opts: { file: JsonlFile; logger: Logger }) {
    this.file = opts.file;
    this.logger = opts.logger;
    try {
      for (const raw of this.file.read(KNOWN_ROWS)) if (typeof raw.id === 'string') this.known.add(raw.id);
    } catch (error) {
      this.logger({ event: 'rounds_log_read_failed', file: this.file.path, error: error instanceof Error ? error.message.slice(0, 200) : 'unreadable' });
    }
  }

  has(id: bigint): boolean {
    return this.known.has(id.toString());
  }

  /** Appends the row once per round id; a failed write is logged once, never thrown (a log must not stop a sweep). */
  add(row: RoundRow): void {
    if (this.known.has(row.id)) return;
    this.known.add(row.id);
    try {
      this.file.append(row);
      this.writeFailed = false;
    } catch (error) {
      this.known.delete(row.id);
      if (!this.writeFailed) this.logger({ event: 'rounds_log_write_failed', file: this.file.path, error: error instanceof Error ? error.message.slice(0, 200) : 'unwritable' });
      this.writeFailed = true;
    }
  }
}
