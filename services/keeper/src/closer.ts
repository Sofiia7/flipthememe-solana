/**
 * Returns the rent of paid positions (audit A09). close_position is permissionless: once a round
 * is Final, a position is claimed and POSITION_CLOSE_DELAY_SECS have passed since the round's
 * exit_end, anyone may close it and its lamports go back into the owner's vault as available
 * balance (the vault paid the rent at the bet; for older positions a device key did). The keeper
 * waits longer than the program requires (CLOSE_AFTER_SECS). This is the least urgent work of the
 * keeper: the scheduler starts one scan or one batch at a time, only while nothing else is in
 * flight (see Scheduler.closePositions).
 */
import { POSITION_CLOSE_DELAY_SECS, RoundStatus, closePosition } from '@flipthememe/client';
import type { Address, TransactionSigner } from '@solana/kit';
import { describeError, fetchClaimedPositions, isRateLimited, isTooLarge, readRoundsAt, sendInstructions } from './chain.ts';
import type { LogFields, Logger } from './log.ts';
import type { SolanaRpc } from './rpc.ts';

/**
 * The keeper closes a position this long after its round's exit_end (env CLOSE_AFTER_SECS), not
 * at the program's one-hour minimum: the app writes a finished round into the phone's history
 * only while it still sees the position on chain, so a player who opens the app within a day
 * keeps every row. The rent goes back all the same, just later.
 */
export const CLOSE_AFTER_SECS = 86_400n;

/** Never below the program's minimum: the chain would refuse such a close with NotDue. */
export function effectiveCloseAfter(secs: bigint): bigint {
  return secs > POSITION_CLOSE_DELAY_SECS ? secs : POSITION_CLOSE_DELAY_SECS;
}

/**
 * Closes per transaction: config, then round, position and vault per close; eight with distinct
 * rounds and owners still fit the 1232-byte limit.
 */
export const CLOSE_BATCH = 8;
export const CLOSE_SCAN_MS = 5 * 60_000;
/** The first scan waits this long after start-up, out of the way of the start-up reads. */
export const CLOSE_FIRST_SCAN_MS = 60_000;
/** Extra seconds past exit_end + the close delay, against an error in the devnet clock estimate. */
export const CLOSE_MARGIN_SECS = 30n;
/** A position that failed to close on its own is left alone this long. */
export const CLOSE_REJECT_MS = 60 * 60_000;

export type Closable = {
  position: Address;
  owner: Address;
  round: Address;
  roundId: bigint;
  lamports: bigint;
  isHouse: boolean;
  /** Set after its batch failed: sent in a transaction of its own to find the one that fails. */
  alone?: boolean;
};

type RoundInfo = { id: bigint; exitEnd: bigint; final: boolean };

export class PositionCloser {
  queue: Closable[] = [];
  closed = 0;
  closedLamports = 0n;
  nextScanAtMs: number;
  batch = CLOSE_BATCH;
  /** Seconds after a round's exit_end before its positions are closed (at least the program's minimum). */
  readonly closeAfterSecs: bigint;

  private readonly rpc: SolanaRpc;
  private readonly signer: TransactionSigner;
  private readonly logger: Logger;
  /** exit_end and id never change, and a claimed position's round is Final for good. */
  private readonly rounds = new Map<Address, RoundInfo>();
  private readonly rejected = new Map<Address, number>();

  constructor(deps: { rpc: SolanaRpc; signer: TransactionSigner; logger: Logger; startMs?: number; closeAfterSecs?: bigint }) {
    this.rpc = deps.rpc;
    this.signer = deps.signer;
    this.logger = deps.logger;
    this.nextScanAtMs = (deps.startMs ?? Date.now()) + CLOSE_FIRST_SCAN_MS;
    this.closeAfterSecs = effectiveCloseAfter(deps.closeAfterSecs ?? CLOSE_AFTER_SECS);
  }

  scanDue(nowMs: number): boolean {
    return nowMs >= this.nextScanAtMs;
  }

  hasWork(): boolean {
    return this.queue.length > 0;
  }

  /** Rebuilds the queue from the chain: every claimed position whose delay has passed. */
  async scan(nowMs: number, chainNowSecs: bigint): Promise<void> {
    this.nextScanAtMs = nowMs + CLOSE_SCAN_MS;
    const claimed = await fetchClaimedPositions(this.rpc);
    const seen = new Set(claimed.map((c) => c.position.round));
    const unknown = [...seen].filter((r) => !this.rounds.has(r));
    for (const [address, round] of await readRoundsAt(this.rpc, unknown)) {
      if (round) this.rounds.set(address, { id: round.id, exitEnd: round.exitEnd, final: round.status === RoundStatus.Final });
    }
    for (const address of this.rounds.keys()) if (!seen.has(address)) this.rounds.delete(address);
    for (const [position, until] of this.rejected) if (until <= nowMs) this.rejected.delete(position);

    const queue: Closable[] = [];
    let waiting = 0;
    for (const c of claimed) {
      const round = this.rounds.get(c.position.round);
      if (!round?.final || this.rejected.has(c.address)) continue;
      if (chainNowSecs < round.exitEnd + this.closeAfterSecs + CLOSE_MARGIN_SECS) {
        waiting++;
        continue;
      }
      queue.push({ position: c.address, owner: c.position.authority, round: c.position.round, roundId: round.id, lamports: c.lamports, isHouse: c.position.isHouse });
    }
    // Oldest rounds first; positions of one round side by side share the round account.
    queue.sort((a, b) => (a.roundId < b.roundId ? -1 : a.roundId > b.roundId ? 1 : 0));
    this.queue = queue;
    this.logger({ event: 'positions_scan', claimed: claimed.length, closable: queue.length, lamports: sum(queue), waiting, skipped: this.rejected.size });
  }

  /** Sends one transaction with the next batch from the queue. */
  async closeNext(nowMs: number): Promise<void> {
    const batch = this.nextBatch();
    if (batch.length === 0) return;
    const ixs = await Promise.all(batch.map((c) => closePosition({ roundId: c.roundId, owner: c.owner })));
    try {
      const sig = await sendInstructions(this.rpc, this.signer, ixs);
      this.drop(batch);
      this.closed += batch.length;
      this.closedLamports += sum(batch);
      this.logger({
        event: 'positions_closed',
        positions: batch.length,
        lamports: sum(batch),
        house: batch.filter((c) => c.isHouse).length,
        rounds: [...new Set(batch.map((c) => c.roundId))],
        queued: this.queue.length,
        sig,
      });
    } catch (error) {
      if (isTooLarge(error) && this.batch > 1) {
        this.batch = Math.max(1, Math.floor(this.batch / 2));
        this.logger({ event: 'close_batch_shrunk', closeBatch: this.batch });
        return;
      }
      const reason = describeError(error);
      if (!isRateLimited(error)) {
        this.drop(batch);
        // A failing batch is retried one position per transaction; a single failure is set aside.
        if (batch.length > 1) this.queue.unshift(...batch.map((c) => ({ ...c, alone: true })));
        else if (batch[0]) this.rejected.set(batch[0].position, nowMs + CLOSE_REJECT_MS);
      }
      this.logger({ event: 'positions_close_failed', positions: batch.length, error: reason, retry: batch.length > 1 ? 'one by one' : 'after the next scan' });
      throw error;
    }
  }

  status(): LogFields {
    return {
      closeAfterSecs: this.closeAfterSecs,
      queued: this.queue.length,
      queuedLamports: sum(this.queue),
      closed: this.closed,
      closedLamports: this.closedLamports,
      nextScanAt: new Date(this.nextScanAtMs).toISOString(),
    };
  }

  private nextBatch(): Closable[] {
    const head = this.queue[0];
    if (!head) return [];
    if (head.alone) return [head];
    const out: Closable[] = [];
    for (const c of this.queue) {
      if (c.alone || out.length >= this.batch) break;
      out.push(c);
    }
    return out;
  }

  private drop(batch: Closable[]): void {
    const gone = new Set(batch.map((c) => c.position));
    this.queue = this.queue.filter((c) => !gone.has(c.position));
  }
}

function sum(list: readonly Closable[]): bigint {
  return list.reduce((total, c) => total + c.lamports, 0n);
}
