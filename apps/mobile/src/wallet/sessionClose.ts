// Closing finished play sessions (program: close_session). Every new device or reinstall leaves a
// Session account behind (rent about 0.0014-0.0019 SOL); only the owner can take it back, and only once
// the session can no longer bet. This file decides which rows the Wallet tab may offer, how many go into
// one wallet approval, whether a fresh read of the accounts still agrees, and what the result says.
// Pure TypeScript (no React Native imports), so node:test covers it.
import { decodeSession } from '@flipthememe/client';
import type { SessionRow } from './sessionList.ts';

/**
 * One transaction closes at most this many sessions. Each close adds 46 bytes (its account key and a
 * 14-byte instruction) to a transaction that is 200 bytes with none, so 22 would fill the 1232-byte
 * packet; 12 leaves a wallet about 480 bytes for instructions of its own. Compute is no limit: a close
 * uses a few thousand of its 200_000 units (flow.rs measures it). The same cap as REVOKE ALL.
 */
export const MAX_CLOSES_PER_TX = 12;

/**
 * The program closes from `now >= expiry` on its own clock. The app's chain clock is an estimate, so an
 * expired row is offered only this many seconds after its expiry: a tap never lands a second early and
 * fails the whole batch with SessionStillActive.
 */
export const CLOSE_MARGIN_SECS = 30;

/** A session to close: its account (to read) and the device key it was issued to (to build the instruction). */
export type CloseTarget = { signer: string; address: string };

/**
 * Revoked, or expired for the margin. A session that can still bet is never closable, this phone's own
 * included, and neither is one that is merely used up: its cap is reached but the program still counts
 * it as active until it is revoked or expires.
 */
export function isClosable(row: Pick<SessionRow, 'status' | 'expiry'>, nowSec: number): boolean {
  return row.status === 'revoked' || nowSec >= row.expiry + CLOSE_MARGIN_SECS;
}

export function closableRows(rows: readonly SessionRow[], nowSec: number): SessionRow[] {
  return rows.filter((row) => isClosable(row, nowSec));
}

/** `items` in order, split into groups of at most `size` (a transaction's worth each). */
export function closeBatches<T>(items: readonly T[], size: number = MAX_CLOSES_PER_TX): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error('A batch needs a size of at least 1.');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type CloseOffer = {
  /** Every closable session, in the order of the rows. */
  targets: CloseTarget[];
  /** What one tap of CLOSE FINISHED closes: the first transaction's worth. */
  batch: CloseTarget[];
  /** Closable sessions that wait for the next tap. */
  later: number;
};

/** What the Wallet tab offers right now. */
export function closeOffer(rows: readonly SessionRow[], nowSec: number): CloseOffer {
  const targets = closableRows(rows, nowSec).map((row) => ({ signer: row.signer, address: row.address }));
  const [batch = []] = closeBatches(targets);
  return { targets, batch, later: targets.length - batch.length };
}

/** An account read over RPC (chain/fetch.ts RawAccount), or null when it does not exist. */
export type SessionRead = { data: Uint8Array; lamports: bigint } | null;

export type ClosePlan = {
  /** The targets whose fresh account still says closable. */
  close: CloseTarget[];
  /** Every lamport those accounts hold: what the program sends back to the owner. */
  rent: bigint;
  /** Not on chain any more (closed meanwhile, for example from another phone). */
  gone: number;
  /** Can bet again (the owner granted it a new session meanwhile). */
  active: number;
  /** Not a session of this owner or not this device key's: left alone. */
  foreign: number;
};

/**
 * The list on screen can be 15 seconds old, and one session that can bet again would fail the whole
 * transaction. So the accounts are read again just before the wallet is asked to sign, and only those
 * that still read as closable go in. `reads` has one entry per target, in order.
 */
export function confirmClosable(owner: string, targets: readonly CloseTarget[], reads: readonly SessionRead[], nowSec: number): ClosePlan {
  if (reads.length !== targets.length) throw new Error('Expected one read per target.');
  const plan: ClosePlan = { close: [], rent: 0n, gone: 0, active: 0, foreign: 0 };
  targets.forEach((target, i) => {
    const read = reads[i];
    if (!read) {
      plan.gone++;
      return;
    }
    let account;
    try {
      account = decodeSession(read.data);
    } catch {
      plan.foreign++;
      return;
    }
    if (account.authority !== owner || account.signer !== target.signer) {
      plan.foreign++;
      return;
    }
    if (!account.revoked && nowSec < Number(account.expiry) + CLOSE_MARGIN_SECS) {
      plan.active++;
      return;
    }
    plan.close.push(target);
    plan.rent += read.lamports;
  });
  return plan;
}

/** "Closed 2 old sessions, 0.0027 SOL of rent came back." plus what was left out or still waits. */
export function closeDoneText(
  done: { count: number; rent: bigint; later: number; skipped: number },
  format: (lamports: bigint) => string,
): string {
  const what = done.count === 1 ? '1 old session' : `${done.count} old sessions`;
  let text = `Closed ${what}, ${format(done.rent)} of rent came back.`;
  if (done.later > 0) text += ` ${done.later} more to close.`;
  if (done.skipped > 0) text += ` ${done.skipped} skipped: closed already, or in use again.`;
  return text;
}

/** Why a tap closed nothing, when the fresh read left no session to close. */
export function closeNothingText(plan: Pick<ClosePlan, 'gone' | 'active' | 'foreign'>): string {
  if (plan.active > 0) return 'Not closed: that session is in use again. Revoke it first, then close it.';
  if (plan.gone > 0) return 'Those sessions are already closed.';
  return 'Could not close: the session was not found for this wallet.';
}
