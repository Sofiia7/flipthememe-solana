// A friend's challenge from a shared link ("oxbla.skr called UP on $WIF in round #496"), kept on the
// phone for a week. Installing the app, connecting a wallet and topping up take longer than the minute
// a round is open, so the Arena keeps the challenge on screen until OK: how that round went, and where
// to meet the friend now. Rounds start every minute and calls are matched in one shared bank, so the
// invitation is to a later round of the same arena, never to a money match with the friend. Nothing
// here places a bet or picks a side. Pure TypeScript (no React Native imports) for node:test; storage
// is injected.
import { RoundStatus, Side, type RoundAccount } from '@flipthememe/client';
import { roundResultLabel, type ResultLabel } from '../chain/phase.ts';
import type { KeyValueStorage } from '../lib/boolStore.ts';
import { cleanAddress, cleanName, cleanRoundId, cleanTicker, formatCountdown, shortAddress, type RoundLink } from '../lib/format.ts';

export type Challenge = RoundLink & {
  /** Local ms when the link opened the app. */
  at: number;
};

/** The one stored challenge: a newer link replaces it. */
export const CHALLENGE_KEY = 'ftm.challenge.v1';
/** A challenge is shown this long after its link opened the app, unless OK dismisses it first. */
export const CHALLENGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Stored = Omit<Challenge, 'round'> & { round: string };

export function serializeChallenge(c: Challenge): string {
  const stored: Stored = { round: c.round.toString(), side: c.side, ticker: c.ticker, by: c.by, name: c.name, at: c.at };
  return JSON.stringify(stored);
}

/** The stored challenge, checked like a link: a bad round or time drops it, a bad optional value only that value. */
export function parseChallenge(raw: string | null): Challenge | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<Record<keyof Stored, unknown>> | null;
    const round = typeof s?.round === 'string' ? cleanRoundId(s.round) : null;
    if (!s || round === null || typeof s.at !== 'number' || !Number.isFinite(s.at)) return null;
    return {
      round,
      side: s.side === 'up' || s.side === 'down' ? s.side : null,
      ticker: typeof s.ticker === 'string' ? cleanTicker(s.ticker) : null,
      by: typeof s.by === 'string' ? cleanAddress(s.by) : null,
      name: typeof s.name === 'string' ? cleanName(s.name) : null,
      at: s.at,
    };
  } catch {
    return null;
  }
}

/** True for a week after the link opened the app; a time far ahead (a phone clock set back) counts as stale too. */
export function challengeActive(c: Pick<Challenge, 'at'>, nowMs: number): boolean {
  return Math.abs(nowMs - c.at) < CHALLENGE_TTL_MS;
}

/** AsyncStorage, or a fake in node tests. */
export type ChallengeStorage = KeyValueStorage & { removeItem(key: string): Promise<void> };

/** The stored challenge. Writes run one at a time, so a new link and an OK never land out of order. */
export function createChallengeStore(storage: ChallengeStorage) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    /** The stored challenge while it is active; an expired or unreadable one is removed. */
    load: (nowMs: number) =>
      serial(async (): Promise<Challenge | null> => {
        const raw = await storage.getItem(CHALLENGE_KEY);
        const c = parseChallenge(raw);
        if (c && challengeActive(c, nowMs)) return c;
        if (raw !== null) await storage.removeItem(CHALLENGE_KEY);
        return null;
      }),
    save: (c: Challenge) => serial(() => storage.setItem(CHALLENGE_KEY, serializeChallenge(c))),
    clear: () => serial(() => storage.removeItem(CHALLENGE_KEY)),
  };
}

// ---------------------------------------------------------------------------------------------
// What the card on the Arena says.

/** Who sent it: their display name, else their short address, else A FRIEND. */
export function inviterName(c: Pick<Challenge, 'name' | 'by'>): string {
  return c.name ?? (c.by ? shortAddress(c.by) : 'A FRIEND');
}

/** "oxbla.skr called UP on $WIF · round #496"; a link without a side only names the round. */
export function challengeHeadline(c: Challenge): string {
  const token = c.ticker ? ` on $${c.ticker}` : '';
  return c.side ? `${inviterName(c)} called ${c.side.toUpperCase()}${token} · round #${c.round}` : `${inviterName(c)} sent you round #${c.round}${token}`;
}

/** The challenged round as the card tells it. Unknown: not read yet, closed because nobody played it, or unreadable. */
export type ChallengeRoundState =
  | { kind: 'unknown' }
  | { kind: 'upcoming'; secondsLeft: number }
  | { kind: 'open'; secondsLeft: number }
  /** Entry closed, not final; `secondsLeft` runs to the end of the exit window, then the keeper settles. */
  | { kind: 'live'; secondsLeft: number }
  | { kind: 'final'; label: ResultLabel };

export function challengeRoundState(a: RoundAccount | null, nowSec: number): ChallengeRoundState {
  if (!a) return { kind: 'unknown' };
  if (a.status === RoundStatus.Final) return { kind: 'final', label: roundResultLabel(a) };
  if (nowSec >= Number(a.cutoffAt)) return { kind: 'live', secondsLeft: Number(a.exitEnd) - nowSec };
  if (nowSec >= Number(a.opensAt)) return { kind: 'open', secondsLeft: Number(a.cutoffAt) - nowSec };
  return { kind: 'upcoming', secondsLeft: Number(a.opensAt) - nowSec };
}

/**
 * One line on the challenged round, null when nothing is known about it: then nothing is said about a
 * result. "They" is the inviter, on the side the link names.
 */
export function roundStateLine(c: Pick<Challenge, 'round' | 'side'>, state: ChallengeRoundState): string | null {
  const id = `Round #${c.round}`;
  switch (state.kind) {
    case 'unknown':
      return null;
    case 'upcoming':
      return `${id} opens in ${formatCountdown(state.secondsLeft)}.`;
    case 'open':
      return `${id} is open: pick your side, entry closes in ${formatCountdown(state.secondsLeft)}.`;
    case 'live':
      return state.secondsLeft > 0 ? `${id} is live: result in ${formatCountdown(state.secondsLeft)}.` : `${id} is settling: result soon.`;
    case 'final': {
      const { label } = state;
      if (label === 'UP' || label === 'DOWN') {
        if (!c.side) return `${id} went ${label}.`;
        return `${id} went ${label}: ${c.side === label.toLowerCase() ? 'they won' : 'they lost'}.`;
      }
      if (label === 'PENDING') return null;
      if (label === 'TIE') return `${id} was a tie: refund.`;
      if (label === 'NO MATCH') return `${id} had no match: refund.`;
      return `${id} ended in a refund.`;
    }
  }
}

/** The inviter's own call among a round's positions (the house never counts). */
export function inviterPosition<P extends { account: { authority: string; isHouse: boolean } }>(
  positions: readonly P[],
  by: string | null,
): P | null {
  if (!by) return null;
  return positions.find((p) => p.account.authority === by && !p.account.isHouse) ?? null;
}

/**
 * Where to meet: the inviter's call in the round open now, when the arena shows one, else an invitation
 * to the open round (or the next one). The reader's side is never suggested beyond "the other side".
 */
export function meetLine(c: Pick<Challenge, 'name' | 'by'>, openId: bigint | null, inviterSide: number | null): string {
  if (openId !== null && inviterSide !== null) {
    return `${inviterName(c)} is in round #${openId} now: ${inviterSide === Side.Up ? 'UP' : 'DOWN'}. Take the other side.`;
  }
  return `Rounds start every minute: call ${openId !== null ? `round #${openId}` : 'the next one'} whenever you are ready.`;
}
