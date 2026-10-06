/**
 * Supervision of the keeper's own loops (wired in main.ts):
 * - LoopErrorLog: a loop that fails every second (devnet down for an hour) writes one line when it
 *   starts failing, then at most one per 30 s, then one line when it works again;
 * - the self-watchdog: when the scheduler loop has not completed a tick for 120 s while the
 *   process is up, the keeper exits with code 1 and Docker (`restart: unless-stopped`) starts it again.
 */
import type { Logger } from './log.ts';

/** After the first failure of a loop, at most one `loop_error` line per this long. */
export const LOOP_ERROR_EVERY_MS = 30_000;
/** A scheduler loop without a completed tick for this long is stuck, not slow. */
export const STALL_AFTER_MS = 120_000;
/** How often the watchdog looks at the clock. */
export const STALL_CHECK_EVERY_MS = 10_000;

type Outage = {
  firstAtMs: number;
  lastLoggedAtMs: number;
  /** Every failure of this outage, logged or not. */
  failures: number;
  /** Failures since the last line (not counting the failure that wrote that line). */
  suppressed: number;
};

export class LoopErrorLog {
  private readonly logger: Logger;
  private readonly everyMs: number;
  private readonly outages = new Map<string, Outage>();

  constructor(logger: Logger, everyMs: number = LOOP_ERROR_EVERY_MS) {
    this.logger = logger;
    this.everyMs = everyMs;
  }

  /** A run of `loop` failed with `error` (a short text, already free of URLs and keys). */
  failure(loop: string, error: string, nowMs: number): void {
    const outage = this.outages.get(loop);
    if (!outage) {
      this.outages.set(loop, { firstAtMs: nowMs, lastLoggedAtMs: nowMs, failures: 1, suppressed: 0 });
      this.logger({ event: 'loop_error', loop, error });
      return;
    }
    outage.failures++;
    if (nowMs - outage.lastLoggedAtMs < this.everyMs) {
      outage.suppressed++;
      return;
    }
    // The line shows the latest error and how many failures it stands for besides itself.
    this.logger({ event: 'loop_error', loop, error, suppressed: outage.suppressed, failures: outage.failures });
    outage.suppressed = 0;
    outage.lastLoggedAtMs = nowMs;
  }

  /** A run of `loop` finished without an error: closes an outage with one recovery line. */
  success(loop: string, nowMs: number): void {
    const outage = this.outages.get(loop);
    if (!outage) return;
    this.outages.delete(loop);
    this.logger({ event: 'loop_recovered', loop, failures: outage.failures, suppressed: outage.suppressed, downMs: nowMs - outage.firstAtMs });
  }
}

/** True when the last completed tick is `limitMs` or more in the past (a clock that went backwards is not a stall). */
export function isStalled(lastBeatMs: number, nowMs: number, limitMs: number = STALL_AFTER_MS): boolean {
  return nowMs - lastBeatMs >= limitMs;
}

/**
 * Checks every `checkEveryMs` whether the loop beat recently and calls `onStall` once, with the
 * idle time, when it did not. Returns the function that stops the check. The timer is unref'd:
 * it never keeps a finished process alive.
 */
export function watchStall(opts: {
  lastBeatMs: () => number;
  onStall: (idleMs: number) => void;
  now?: () => number;
  checkEveryMs?: number;
  limitMs?: number;
}): () => void {
  const now = opts.now ?? Date.now;
  const limitMs = opts.limitMs ?? STALL_AFTER_MS;
  const timer = setInterval(() => {
    const at = now();
    const last = opts.lastBeatMs();
    if (!isStalled(last, at, limitMs)) return;
    clearInterval(timer);
    opts.onStall(at - last);
  }, opts.checkEveryMs ?? STALL_CHECK_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
