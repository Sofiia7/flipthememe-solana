// "YOU 3 : 1 oxbla": the personal score against the friend whose challenge link opened the app. A round
// counts when we both hold a position in it, on opposite sides, and it finished Up or Down: whoever's
// side won takes the point. Rounds where we called the same side, or that ended in a refund, are not a
// duel and count for nobody. The arena only reads the last few rounds, so the app keeps what it has seen
// in a small ledger (persisted per wallet and rival on this device). Pure TypeScript (no React Native
// imports) for node:test.
import { Outcome, RoundStatus, Side } from '@flipthememe/client';

export type DuelWinner = 'you' | 'them';
/** Round id to the one who took that round. */
export type DuelLedger = ReadonlyMap<bigint, DuelWinner>;
export const EMPTY_LEDGER: DuelLedger = new Map();
/** Rounds remembered per rival; the oldest go first. */
export const LEDGER_CAP = 200;

export const duelStorageKey = (me: string, rival: string) => `ftm:duels:v1:${me}:${rival}`;

export function encodeLedger(ledger: DuelLedger): string {
  return JSON.stringify([...ledger].map(([id, winner]) => [id.toString(), winner]));
}

/** Corrupt local data never supplies points or prevents the arena from opening. */
export function decodeLedger(raw: string | null): DuelLedger {
  if (!raw) return EMPTY_LEDGER;
  try {
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > LEDGER_CAP) return EMPTY_LEDGER;
    const ledger = new Map<bigint, DuelWinner>();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(row[0]) || (row[1] !== 'you' && row[1] !== 'them')) return EMPTY_LEDGER;
      const id = BigInt(row[0]);
      if (id > 18446744073709551615n || ledger.has(id)) return EMPTY_LEDGER;
      ledger.set(id, row[1]);
    }
    return ledger;
  } catch { return EMPTY_LEDGER; }
}

type RoundLike = { id: bigint; account: { status: number; outcome: number } };
type PlayerLike = { account: { authority: string; side: number; isHouse: boolean } };

/** Who won the duel in this round, or null when it was no duel (see the file header). */
export function duelWinner(round: RoundLike, players: readonly PlayerLike[], me: string, rival: string): DuelWinner | null {
  if (me === rival) return null;
  if (round.account.status !== RoundStatus.Final) return null;
  const winningSide = round.account.outcome === Outcome.Up ? Side.Up : round.account.outcome === Outcome.Down ? Side.Down : null;
  if (winningSide === null) return null;
  const mine = players.find((p) => !p.account.isHouse && p.account.authority === me);
  const theirs = players.find((p) => !p.account.isHouse && p.account.authority === rival);
  if (!mine || !theirs || mine.account.side === theirs.account.side) return null;
  return mine.account.side === winningSide ? 'you' : 'them';
}

/**
 * The ledger after this read of the arena: every round of the window that is a finished duel is added
 * (a round already in the ledger keeps its point). Returns `ledger` itself when nothing changed.
 */
export function updateLedger(
  ledger: DuelLedger,
  rounds: readonly RoundLike[],
  positionsByRound: ReadonlyMap<bigint, readonly PlayerLike[]>,
  me: string,
  rival: string,
): DuelLedger {
  let next: Map<bigint, DuelWinner> | null = null;
  for (const round of rounds) {
    if (ledger.has(round.id)) continue;
    const winner = duelWinner(round, positionsByRound.get(round.id) ?? [], me, rival);
    if (winner === null) continue;
    next ??= new Map(ledger);
    next.set(round.id, winner);
  }
  if (!next) return ledger;
  if (next.size > LEDGER_CAP) {
    const keep = [...next.keys()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)).slice(0, LEDGER_CAP);
    return new Map(keep.map((id) => [id, next.get(id)!]));
  }
  return next;
}

export type DuelScore = { you: number; them: number };

/** The score, or null before the first finished duel (nothing to show). */
export function scoreOf(ledger: DuelLedger): DuelScore | null {
  if (ledger.size === 0) return null;
  let you = 0;
  let them = 0;
  for (const w of ledger.values()) {
    if (w === 'you') you++;
    else them++;
  }
  return { you, them };
}

/** "YOU 3 : 1 oxbla"; the rival is "RIVAL" when no name is known. */
export function scoreLine(score: DuelScore, rivalName: string | null): string {
  return `YOU ${score.you} : ${score.them} ${rivalName && rivalName.length > 0 ? rivalName : 'RIVAL'}`;
}
