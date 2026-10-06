// Whether the result overlay may offer to call the open round again ("SAME CALL" / "FLIP IT"), and
// for how much. It applies every guard the arena applies to its UP and DOWN buttons (open round,
// fresh data, not paused, active session, balance for the amount plus the position rent, round and
// session stake limits, pool depth, nothing in flight, no position of mine in the round yet), so an
// offer never leads to a bet the arena would have refused. Pure TypeScript (no React Native
// imports), so node:test covers every guard.
import { Side, winMultiplierBps } from '@flipthememe/client';
import type { SessionAccount } from '@flipthememe/client';
import { sessionStatusOf } from '../wallet/sessionList.ts';
import { classifyRounds, fitsDepth, type RoundRef } from './phase.ts';

/** A repeat is offered only while at least this much entry time is left: the overlay takes time to read. */
export const REPEAT_MIN_SECS_LEFT = 6;
/** Arena data older than this is not trusted for a bet (the arena shows its stale banner at the same age). */
export const REPEAT_MAX_ARENA_AGE_MS = 10_000;
/** An amount cut down to fit is rounded down to this step (0.0001 SOL), so the label shows exactly what is bet. */
const AMOUNT_STEP = 100_000n;

/** Why no repeat is offered. */
export type RepeatBlock =
  | 'no-round'
  | 'closing'
  | 'no-wallet'
  | 'loading'
  | 'no-session'
  | 'no-gas'
  | 'busy'
  | 'stale'
  | 'paused'
  | 'already-in'
  | 'balance'
  | 'session-limit'
  | 'stake-limits'
  | 'depth';

export type RepeatBetInput = {
  /** The arena rounds (any order); the one accepting entries now is the open round. */
  rounds: readonly RoundRef[];
  /** Program time now, unix seconds (may be fractional). */
  nowSec: number;
  /** Local clock, ms, and the local ms of the last successful arena read (null before the first). */
  nowMs: number;
  arenaUpdatedAt: number | null;
  /** Betting paused by the operator. */
  paused: boolean;
  /** Connected wallet owner, null when none. */
  owner: string | null;
  /** My account data belongs to the connected wallet. */
  myReady: boolean;
  session: SessionAccount | null;
  /** Spendable game balance (lamports). */
  available: bigint;
  /** Rent parked by one position until the keeper closes it. */
  positionRent: bigint;
  /** SOL on the device key, which pays the network fee, and what one more bet needs there. */
  keyLamports: bigint | null;
  gasPerBet: bigint;
  /** Do I already hold a position in this round (see holdsPosition). */
  holds: (roundId: bigint) => boolean;
  /** A bet of mine is signing, sending or confirming. */
  working: boolean;
  /** Round of a bet of mine that went out and is not seen on chain yet, if any. */
  pendingRoundId: bigint | null;
  /** The call just finished: its side and stake. */
  side: number;
  stake: bigint;
};

export type RepeatOffer = {
  roundId: bigint;
  /** Stake of the finished call, cut down to what the balance, the session and the round allow. */
  amount: bigint;
  /** The side just called, and the other one. */
  same: Side;
  flip: Side;
  /** Whether the pool depth still takes `amount` on that side. At least one is true. */
  sameFits: boolean;
  flipFits: boolean;
};

export type RepeatResult = ({ ok: true } & RepeatOffer) | { ok: false; reason: RepeatBlock };

const min = (...values: bigint[]) => values.reduce((a, b) => (b < a ? b : a));

/** The repeat to offer for the round open now, or the reason there is none. */
export function canRepeatBet(input: RepeatBetInput): RepeatResult {
  const no = (reason: RepeatBlock): RepeatResult => ({ ok: false, reason });
  const { open } = classifyRounds(input.rounds, input.nowSec);
  if (!open) return no('no-round');
  const a = open.account;
  if (Number(a.cutoffAt) - input.nowSec < REPEAT_MIN_SECS_LEFT) return no('closing');
  if (!input.owner) return no('no-wallet');
  if (!input.myReady) return no('loading');
  const session = input.session;
  if (!session || sessionStatusOf(session, input.nowSec, a.minStake) !== 'active') return no('no-session');
  if ((input.keyLamports ?? 0n) < input.gasPerBet) return no('no-gas');
  if (input.working || input.pendingRoundId === open.id) return no('busy');
  if (input.arenaUpdatedAt === null || input.nowMs - input.arenaUpdatedAt > REPEAT_MAX_ARENA_AGE_MS) return no('stale');
  if (input.paused) return no('paused');
  if (input.holds(open.id)) return no('already-in');

  // The amount: the stake of the finished call, cut down to what fits.
  const funds = input.available - input.positionRent;
  const sessionRoom = min(session.maxPerBet, session.sessionCap - session.spent);
  const capped = min(input.stake, a.maxStake, sessionRoom, funds);
  if (capped < a.minStake) {
    if (funds < a.minStake) return no('balance');
    if (sessionRoom < a.minStake) return no('session-limit');
    return no('stake-limits');
  }
  const floored = capped - (capped % AMOUNT_STEP);
  const amount = capped < input.stake && floored >= a.minStake ? floored : capped;

  const same = (input.side === Side.Up ? Side.Up : Side.Down) as Side;
  const flip = (same === Side.Up ? Side.Down : Side.Up) as Side;
  const sameFits = fitsDepth(a, same, amount);
  const flipFits = fitsDepth(a, flip, amount);
  if (!sameFits && !flipFits) return no('depth');
  return { ok: true, roundId: open.id, amount, same, flip, sameFits, flipFits };
}

/**
 * Do I already hold a position in round `roundId`? Looks at my own positions and at the players the
 * arena read for that round (the house does not count): the same two sources the arena reads.
 */
export function holdsPosition(
  roundId: bigint,
  owner: string,
  myPositions: readonly { round: { id: bigint } | null }[],
  roundPlayers: readonly { account: { authority: string; isHouse: boolean } }[],
): boolean {
  return myPositions.some((p) => p.round?.id === roundId) || roundPlayers.some((p) => p.account.authority === owner && !p.account.isHouse);
}

/** "x1.96": what a winning call pays on its matched part, from the round's win fee. */
export function multiplierText(feeWinBps: number): string {
  const bps = winMultiplierBps(feeWinBps);
  return `x${bps / 10_000n}.${((bps % 10_000n) / 100n).toString().padStart(2, '0')}`;
}
