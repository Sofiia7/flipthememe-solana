// Every play session of a wallet, on any device: which one is this phone, what each may still
// spend, which can be revoked. Pure TypeScript (no React Native imports), so node:test covers it.
//
// Session account (programs/flip-the-meme/src/lib.rs), 138 bytes:
//   0 discriminator (8) | 8 authority (32) | 40 vault (32) | 72 signer (32) | 104 expiry i64 |
//   112 max_per_bet u64 | 120 session_cap u64 | 128 spent u64 | 136 revoked bool | 137 bump u8
// The app lists them with getProgramAccounts: dataSize 138 and memcmp of the owner at offset 8.
import type { SessionAccount } from '@flipthememe/client';

export const SESSION_SPACE = 138;
export const SESSION_OFFSETS = { authority: 8, vault: 40, signer: 72, expiry: 104, maxPerBet: 112, sessionCap: 120, spent: 128, revoked: 136 } as const;

/** One transaction revokes at most this many sessions (it stays well under the 1232-byte limit). */
export const MAX_REVOKES_PER_TX = 12;

export type SessionStatus = 'none' | 'active' | 'expired' | 'revoked' | 'used-up';

export function sessionStatusOf(session: SessionAccount | null, nowSec: number, minStake: bigint): SessionStatus {
  if (!session) return 'none';
  if (session.revoked) return 'revoked';
  if (nowSec >= Number(session.expiry)) return 'expired';
  if (session.spent + minStake > session.sessionCap) return 'used-up';
  return 'active';
}

export type SessionEntry = { address: string; account: SessionAccount };

export type SessionRow = {
  address: string;
  signer: string;
  /** Signed by this phone's device key. */
  mine: boolean;
  status: Exclude<SessionStatus, 'none'>;
  /** Expiry, unix seconds. */
  expiry: number;
  /** Seconds until it expires (0 once expired). */
  secondsLeft: number;
  maxPerBet: bigint;
  /** The session cap: a turnover allowance since sessionCapFor, the top up itself on older sessions. */
  budget: bigint;
  spent: bigint;
  /** Neither revoked nor expired: the device can still bet with it, so the owner can revoke it. */
  revocable: boolean;
};

/** The listed sessions with this phone's own (read more often) in place of its listed copy. */
export function withDeviceSession(list: readonly SessionEntry[], fresh: SessionEntry | null): SessionEntry[] {
  if (!fresh) return [...list];
  const out = list.filter((s) => s.address !== fresh.address);
  out.push(fresh);
  return out;
}

/** This phone first, then sessions that can still bet, then the latest expiry. */
export function sessionRows(
  list: readonly SessionEntry[],
  opts: { deviceKey: string | null; nowSec: number; minStake: bigint },
): SessionRow[] {
  const rows: SessionRow[] = list.map(({ address, account }) => {
    const expiry = Number(account.expiry);
    const secondsLeft = Math.max(0, expiry - opts.nowSec);
    return {
      address,
      signer: account.signer,
      mine: opts.deviceKey !== null && account.signer === opts.deviceKey,
      status: sessionStatusOf(account, opts.nowSec, opts.minStake) as SessionRow['status'],
      expiry,
      secondsLeft,
      maxPerBet: account.maxPerBet,
      budget: account.sessionCap,
      spent: account.spent,
      revocable: !account.revoked && secondsLeft > 0,
    };
  });
  return rows.sort((a, b) => Number(b.mine) - Number(a.mine) || Number(b.revocable) - Number(a.revocable) || b.expiry - a.expiry);
}

/**
 * The least allowance a session carries since it became turnover (maxPerBet x capTurnoverFactor, see
 * sessionCapFor). Sessions made before that have the top up itself as their cap, which is below this:
 * they show what was staked of their limit.
 */
export function sessionLimitedBelow(rules: { maxPerBet: bigint; capTurnoverFactor: bigint }): bigint {
  return rules.maxPerBet * rules.capTurnoverFactor;
}

/**
 * What a row says about its use. `spent` is the total staked through the session (the program never
 * subtracts), so a new session reads "staked 0.06 SOL so far" and an old small-cap one "staked 0.04 of
 * its 0.10 SOL limit".
 */
export function sessionUsageText(row: Pick<SessionRow, 'spent' | 'budget'>, limitedBelow: bigint, format: (lamports: bigint) => string): string {
  if (row.budget < limitedBelow) return `staked ${format(row.spent)} of its ${format(row.budget)} SOL limit`;
  return row.spent > 0n ? `staked ${format(row.spent)} SOL so far` : 'no bets yet';
}

/** Signers of the sessions REVOKE ALL covers (one transaction's worth). */
export function revocableSigners(rows: readonly SessionRow[]): string[] {
  return rows.filter((r) => r.revocable).map((r) => r.signer).slice(0, MAX_REVOKES_PER_TX);
}
