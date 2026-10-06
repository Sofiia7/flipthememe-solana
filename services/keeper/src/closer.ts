/**
 * Returns the rent of played rounds (audits A09 and L2). close_position is permissionless: once a
 * round is Final, a position is claimed and POSITION_CLOSE_DELAY_SECS have passed since the round's
 * exit_end, anyone may close it and its lamports go back into the owner's vault as available
 * balance (the vault paid the rent at the bet; for older positions a device key did). The keeper
 * waits longer than the program requires (CLOSE_AFTER_SECS). This is the least urgent work of the
 * keeper: the scheduler starts one scan or one batch at a time, only while nothing else is in
 * flight (see Scheduler.closePositions).
 *
 * The Round account itself (rent paid by the keeper at create_round) is closed after its last
 * position: the upgraded program decrements round.position_count in close_position, and
 * close_empty_round accepts a Final round with position_count == 0 that is swept (or has no bank).
 * Rounds whose positions the old program closed never decrement the count and stay on chain; the
 * read-then-check below skips them for good.
 */
import { POSITION_CLOSE_DELAY_SECS, RoundStatus, closeEmptyRound, closePosition, decodeRound, type RoundAccount } from '@flipthememe/client';
import { getBase64Encoder, type Address, type Signature, type TransactionSigner } from '@solana/kit';
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
/**
 * Round closes per transaction: three accounts per close, and config and the admin are shared, so
 * ten with distinct rounds take about 650 bytes of the 1232.
 */
export const ROUND_CLOSE_BATCH = 10;
export const CLOSE_SCAN_MS = 5 * 60_000;
/** The first scan waits this long after start-up, out of the way of the start-up reads. */
export const CLOSE_FIRST_SCAN_MS = 60_000;
/** Extra seconds past exit_end + the close delay, against an error in the devnet clock estimate. */
export const CLOSE_MARGIN_SECS = 30n;
/** A position or a round that failed to close on its own is left alone this long. */
export const CLOSE_REJECT_MS = 60 * 60_000;
/** A round with no positions left whose bank is not swept yet is looked at on this many scans, then forgotten. */
export const MAX_ROUND_CHECKS = 12;
/** A round the program refused to close this many times is given up (a person can close it by hand). */
export const MAX_ROUND_REJECTS = 3;

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

/** A round that is ready for close_empty_round, with the lamports its account holds. */
export type RoundClosable = {
  round: Address;
  roundId: bigint;
  lamports: bigint;
  /** Set after its batch failed: sent in a transaction of its own to find the one that fails. */
  alone?: boolean;
};

type RoundInfo = { id: bigint; exitEnd: bigint; final: boolean };

/** A round the keeper expects to be ready soon: its last position was closed (by us or by someone else). */
type PendingRound = {
  roundId: bigint;
  /** Reads that found no positions but an unswept bank. */
  checks: number;
  /** Close attempts the program refused. */
  rejects: number;
  /** Not looked at before this time (ms): the cooldown after a refusal. */
  retryAtMs: number;
};

const base64 = getBase64Encoder();

/**
 * Rounds by account address with their balance, 100 per getMultipleAccounts; null where there is
 * none. Like readRoundsAt, but the log of a close names the lamports the account really holds.
 */
async function readRoundsWithLamports(rpc: SolanaRpc, addresses: readonly Address[]): Promise<Map<Address, { round: RoundAccount; lamports: bigint } | null>> {
  const out = new Map<Address, { round: RoundAccount; lamports: bigint } | null>();
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const { value } = await rpc.getMultipleAccounts(chunk, { encoding: 'base64', commitment: 'confirmed' }).send();
    chunk.forEach((address, k) => {
      const account = value[k];
      out.set(address, account ? { round: decodeRound(base64.encode(account.data[0]) as Uint8Array), lamports: account.lamports } : null);
    });
  }
  return out;
}

export class PositionCloser {
  queue: Closable[] = [];
  /** Rounds that are ready to close (read fresh, no positions left, bank swept or empty), oldest first. */
  roundQueue: RoundClosable[] = [];
  closed = 0;
  closedLamports = 0n;
  closedRounds = 0;
  closedRoundLamports = 0n;
  nextScanAtMs: number;
  batch = CLOSE_BATCH;
  roundBatch = ROUND_CLOSE_BATCH;
  /** Seconds after a round's exit_end before its positions are closed (at least the program's minimum). */
  readonly closeAfterSecs: bigint;
  /** Gets the rent of a closed round: config.admin (the scheduler keeps this current), by default the keeper. */
  admin: Address;

  private readonly rpc: SolanaRpc;
  private readonly signer: TransactionSigner;
  private readonly logger: Logger;
  /** exit_end and id never change, and a claimed position's round is Final for good. */
  private readonly rounds = new Map<Address, RoundInfo>();
  private readonly rejected = new Map<Address, number>();
  /**
   * Rounds that may be ready to close: every round of a batch this keeper closed, and every round
   * whose last claimed position disappeared between two scans. Small and in memory: a round leaves
   * it when it is closed, gone, still has positions (a later close of one puts it back), or was
   * refused or left unswept too often.
   */
  private readonly pending = new Map<Address, PendingRound>();

  constructor(deps: { rpc: SolanaRpc; signer: TransactionSigner; logger: Logger; startMs?: number; closeAfterSecs?: bigint; admin?: Address }) {
    this.rpc = deps.rpc;
    this.signer = deps.signer;
    this.logger = deps.logger;
    this.admin = deps.admin ?? deps.signer.address;
    this.nextScanAtMs = (deps.startMs ?? Date.now()) + CLOSE_FIRST_SCAN_MS;
    this.closeAfterSecs = effectiveCloseAfter(deps.closeAfterSecs ?? CLOSE_AFTER_SECS);
  }

  scanDue(nowMs: number): boolean {
    return nowMs >= this.nextScanAtMs;
  }

  hasWork(): boolean {
    return this.queue.length > 0 || this.roundQueue.length > 0;
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
    for (const [address, round] of this.rounds) {
      if (seen.has(address)) continue;
      this.rounds.delete(address);
      // No claimed position of this round is left: closed by this keeper, by someone else, or by a
      // transaction whose confirmation was lost. The round may be ready to close now.
      if (round.final) this.remember(address, round.id);
    }
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
    await this.checkRounds(nowMs);
  }

  /**
   * Sends one transaction: the next batch of round closes if there is one (a round that is ready
   * is money in hand), else the next batch of position closes. After a batch of positions the
   * rounds it touched are read fresh and queued when they are ready.
   */
  async closeNext(nowMs: number): Promise<void> {
    if (this.roundQueue.length > 0) return this.closeRounds(nowMs);
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
    for (const c of batch) this.remember(c.round, c.roundId);
    await this.checkRounds(nowMs, batch.map((c) => c.round));
  }

  status(): LogFields {
    return {
      closeAfterSecs: this.closeAfterSecs,
      queued: this.queue.length,
      queuedLamports: sum(this.queue),
      closed: this.closed,
      closedLamports: this.closedLamports,
      nextScanAt: new Date(this.nextScanAtMs).toISOString(),
      closedRounds: this.closedRounds,
      closedRoundLamports: this.closedRoundLamports,
      roundsQueued: this.roundQueue.length,
      roundsPending: this.pending.size,
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

  private remember(round: Address, roundId: bigint): void {
    if (!this.pending.has(round)) this.pending.set(round, { roundId, checks: 0, rejects: 0, retryAtMs: 0 });
  }

  /**
   * Reads the pending rounds fresh (all of them, or only `only`) and queues the ones that are
   * ready: Final, no positions left, and the bank swept or empty. Rounds whose positions the
   * keeper still has to close are not read yet. A read that fails is logged and tried again on
   * the next scan, except an HTTP 429, which goes up so the scheduler backs off.
   */
  private async checkRounds(nowMs: number, only?: readonly Address[]): Promise<void> {
    const queued = new Set(this.roundQueue.map((r) => r.round));
    const busy = new Set(this.queue.map((c) => c.round));
    const addresses = [...new Set(only ?? this.pending.keys())].filter((address) => {
      const pending = this.pending.get(address);
      return pending !== undefined && !queued.has(address) && !busy.has(address) && pending.retryAtMs <= nowMs;
    });
    if (addresses.length === 0) return;
    let found: Map<Address, { round: RoundAccount; lamports: bigint } | null>;
    try {
      found = await readRoundsWithLamports(this.rpc, addresses);
    } catch (error) {
      if (isRateLimited(error)) throw error;
      this.logger({ event: 'round_check_failed', rounds: addresses.length, error: describeError(error) });
      return;
    }
    let closable = 0;
    let lamports = 0n;
    let notEmpty = 0;
    let unswept = 0;
    for (const address of addresses) {
      const pending = this.pending.get(address);
      if (!pending) continue;
      const entry = found.get(address) ?? null;
      if (!entry || entry.round.status !== RoundStatus.Final) {
        // Closed already (or never was ours to close).
        this.pending.delete(address);
        continue;
      }
      const { round } = entry;
      if (round.positionCount > 0) {
        // Positions are left, or the old program closed them without the count: nothing to do now.
        // The close of a later position puts the round back.
        this.pending.delete(address);
        notEmpty++;
        continue;
      }
      if (!round.feesSwept && round.rawUp + round.rawDown > 0n) {
        unswept++;
        pending.checks++;
        if (pending.checks >= MAX_ROUND_CHECKS) this.pending.delete(address);
        continue;
      }
      this.roundQueue.push({ round: address, roundId: round.id, lamports: entry.lamports });
      closable++;
      lamports += entry.lamports;
    }
    this.roundQueue.sort((a, b) => (a.roundId < b.roundId ? -1 : a.roundId > b.roundId ? 1 : 0));
    this.logger({ event: 'rounds_checked', checked: addresses.length, closable, lamports, notEmpty, unswept });
  }

  /** Sends one transaction with the next batch of round closes. */
  private async closeRounds(nowMs: number): Promise<void> {
    const batch = this.nextRoundBatch();
    if (batch.length === 0) return;
    const ixs = await Promise.all(batch.map((r) => closeEmptyRound({ roundId: r.roundId, admin: this.admin })));
    let sig: Signature;
    try {
      sig = await sendInstructions(this.rpc, this.signer, ixs);
    } catch (error) {
      if (isTooLarge(error) && this.roundBatch > 1) {
        this.roundBatch = Math.max(1, Math.floor(this.roundBatch / 2));
        this.logger({ event: 'round_close_batch_shrunk', roundCloseBatch: this.roundBatch });
        return;
      }
      const reason = describeError(error);
      let retry = 'on the next try';
      if (!isRateLimited(error)) {
        this.dropRounds(batch);
        // A failing batch is retried one round per transaction; a single failure is set aside.
        if (batch.length > 1) {
          this.roundQueue.unshift(...batch.map((r) => ({ ...r, alone: true })));
          retry = 'one by one';
        } else if (batch[0]) {
          retry = this.reject(batch[0], nowMs);
        }
      }
      for (const r of batch) this.logger({ event: 'round_close_failed', round: r.roundId, error: reason, retry });
      throw error;
    }
    this.dropRounds(batch);
    this.closedRounds += batch.length;
    this.closedRoundLamports += batch.reduce((total, r) => total + r.lamports, 0n);
    for (const r of batch) {
      this.pending.delete(r.round);
      this.rounds.delete(r.round);
      this.logger({ event: 'round_closed', round: r.roundId, lamports: r.lamports, sig });
    }
  }

  /** Sets a round the program refused aside for CLOSE_REJECT_MS, or gives it up after MAX_ROUND_REJECTS refusals. */
  private reject(round: RoundClosable, nowMs: number): string {
    const pending = this.pending.get(round.round);
    if (!pending) return 'not again';
    pending.rejects++;
    if (pending.rejects >= MAX_ROUND_REJECTS) {
      this.pending.delete(round.round);
      return 'not again';
    }
    pending.retryAtMs = nowMs + CLOSE_REJECT_MS;
    return 'after the cooldown';
  }

  private nextRoundBatch(): RoundClosable[] {
    const head = this.roundQueue[0];
    if (!head) return [];
    if (head.alone) return [head];
    const out: RoundClosable[] = [];
    for (const r of this.roundQueue) {
      if (r.alone || out.length >= this.roundBatch) break;
      out.push(r);
    }
    return out;
  }

  private dropRounds(batch: RoundClosable[]): void {
    const gone = new Set(batch.map((r) => r.round));
    this.roundQueue = this.roundQueue.filter((r) => !gone.has(r.round));
  }
}

function sum(list: readonly Closable[]): bigint {
  return list.reduce((total, c) => total + c.lamports, 0n);
}
