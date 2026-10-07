/**
 * A cheap detector for a second keeper creating rounds against the same program. Two keepers do no harm to
 * the money (every step is decided from the chain state), but they race for each round id, burn fees on
 * the losing transaction and keep separate house ledgers.
 *
 * Two signs, both seen at create time:
 * - the round at the upcoming minute boundary is already on the chain and this process did not create it
 *   (steps.ts leaves the create alone in that case, quietly);
 * - the create fails with InvalidRoundId: another transaction took the id between the read and the send.
 *
 * Each boundary counts once. `another_keeper_suspected` is logged for it (at most one line per 30 s). After
 * three boundaries in a row, with no round of this keeper's own created in between, create is paused for
 * 5 minutes (`another_keeper_create_paused`), so the two keepers stop fighting over ids; everything else
 * (strike, settle, claim, ...) goes on. The count starts again when the pause is over.
 *
 * A keeper that restarts between creating a round and the boundary sees its own round as foreign once;
 * its next create resets the count, so a restart never gets near three.
 */
import type { Logger } from './log.ts';

export const SUSPECTS_BEFORE_PAUSE = 3;
export const CREATE_PAUSE_MS = 5 * 60_000;
export const SUSPECT_LOG_EVERY_MS = 30_000;

export class AnotherKeeperGuard {
  private readonly logger: Logger;
  private readonly limit: number;
  private readonly pauseMs: number;
  private readonly counted = new Set<bigint>();
  private consecutive = 0;
  private pausedUntilMs = 0;
  private lastLogAtMs = Number.NEGATIVE_INFINITY;
  /** Boundaries counted as suspicious since start (status.json). */
  suspected = 0;

  constructor(opts: { logger: Logger; limit?: number; pauseMs?: number }) {
    this.logger = opts.logger;
    this.limit = opts.limit ?? SUSPECTS_BEFORE_PAUSE;
    this.pauseMs = opts.pauseMs ?? CREATE_PAUSE_MS;
  }

  /** True while create is paused. */
  paused(nowMs: number): boolean {
    return nowMs < this.pausedUntilMs;
  }

  pausedUntil(): number | null {
    return this.pausedUntilMs > 0 ? this.pausedUntilMs : null;
  }

  /** A round that this keeper did not create already stands at (or past) the upcoming boundary. */
  foreignRound(opensAt: bigint, roundId: bigint, nowMs: number): void {
    this.note(opensAt, nowMs, { sign: 'round_exists', round: roundId });
  }

  /** Create failed with InvalidRoundId: the id was taken meanwhile. */
  invalidRoundId(opensAt: bigint, nowMs: number): void {
    this.note(opensAt, nowMs, { sign: 'invalid_round_id' });
  }

  /** This keeper created a round: whatever was suspected, it is creating its own again. */
  created(): void {
    this.consecutive = 0;
  }

  private note(opensAt: bigint, nowMs: number, fields: Record<string, unknown>): void {
    if (this.counted.has(opensAt)) return;
    this.counted.add(opensAt);
    for (const b of this.counted) if (b < opensAt - 10n * 60n) this.counted.delete(b);
    this.consecutive++;
    this.suspected++;
    if (nowMs - this.lastLogAtMs >= SUSPECT_LOG_EVERY_MS) {
      this.lastLogAtMs = nowMs;
      this.logger({ event: 'another_keeper_suspected', opensAt: new Date(Number(opensAt) * 1000).toISOString(), consecutive: this.consecutive, ...fields });
    }
    if (this.consecutive >= this.limit) {
      this.pausedUntilMs = nowMs + this.pauseMs;
      this.consecutive = 0;
      this.logger({ event: 'another_keeper_create_paused', until: new Date(this.pausedUntilMs).toISOString(), minutes: this.pauseMs / 60_000, hint: 'stop the other keeper; only one may run' });
    }
  }
}
