/**
 * Round scheduler. Every tick reads Config, the keeper's Vault and the last rounds from devnet,
 * then starts, per round, the first step that is due (see steps.ts). Steps run in the
 * background, one at a time per round, so a slow confirmation never stalls the other rounds;
 * a failed step is logged and retried on a later tick.
 */
import {
  DEPTH_K,
  MAX_BANK_CEILING,
  PROGRAM_ERRORS,
  RoundStatus,
  Side,
  claim,
  closeEmptyRound,
  createRound,
  houseFill,
  isActivated,
  refundExpired,
  roundTimes,
  setStrike,
  settle,
  sweepFees,
  type ConfigAccount,
  type ProgramErrorName,
  type RoundAccount,
} from '@flipthememe/client';
import type { Address, Instruction, KeyPairSigner } from '@solana/kit';
import {
  cachedRoundAddress,
  describeError,
  fetchPositions,
  fetchUnfinishedRoundIds,
  isRateLimited,
  isTooLarge,
  readSnapshot,
  sendInstructions,
  type ChainClock,
  type Snapshot,
} from './chain.ts';
import type { KeeperConfig } from './config.ts';
import { houseFillAmount, recordFill, remainingBudget, rollover, utcDay } from './house.ts';
import { throttled, type LogFields, type Logger } from './log.ts';
import { windowSamples, type ObservationStore } from './observations.ts';
import type { SolanaRpc } from './rpc.ts';
import type { PoolSelector } from './selector.ts';
import type { StateStore } from './state.ts';
import { createDue, nextStep, type StepKind } from './steps.ts';

/** Rounds read every tick: ids next_round_id - ROUND_WINDOW .. next_round_id. */
export const ROUND_WINDOW = 6;
/** Older unfinished rounds found by the start-up scan, processed this many at a time. */
export const BACKLOG_BATCH = 40;
/** After a confirmed step, the same step on the same round is not retried for this long. */
export const SUCCESS_COOLDOWN_MS = 8_000;
export const CLAIM_BATCH_START = 5;
/**
 * Transactions in flight at once. Every confirmation polls the RPC, and around second 41-46 of
 * each minute strike, settle, claims, sweep, close and the next create all fall due together;
 * unbounded, that burst drew HTTP 429 from the public devnet RPC.
 */
export const MAX_PARALLEL_STEPS = 2;
/** After an HTTP 429 from devnet, no reads or new transactions for this long. */
export const RATE_LIMIT_PAUSE_MS = 4_000;
/** Dispatch order when more steps are due than slots: time-critical first. */
const PRIORITY: Record<StepKind | 'create', number> = { create: 0, fill: 1, strike: 2, settle: 2, expire: 3, claim: 4, sweep: 4, close: 4 };

type Due = { priority: number; id: bigint; lane: string; stepKey: string; run: () => Promise<void> };
/** A new round opens only while the current pool has an observation at most this old. */
const SAMPLER_FRESH_MS = 15_000;
const LOW_BALANCE_LAMPORTS = 200_000_000n;

type Failure = { count: number; retryAtMs: number };

export type SchedulerDeps = {
  rpc: SolanaRpc;
  signer: KeyPairSigner;
  cfg: KeeperConfig;
  state: StateStore;
  selector: PoolSelector;
  store: ObservationStore;
  clock: ChainClock;
  logger: Logger;
};

export class Scheduler {
  snapshot: Snapshot | null = null;
  lastActionAtMs: number | null = null;
  lastAction: LogFields | null = null;
  lastTickAtMs: number | null = null;

  private readonly rpc: SolanaRpc;
  private readonly signer: KeyPairSigner;
  private readonly cfg: KeeperConfig;
  private readonly state: StateStore;
  private readonly selector: PoolSelector;
  private readonly store: ObservationStore;
  private readonly clock: ChainClock;
  private readonly logger: Logger;
  private readonly warn: (key: string, fields: LogFields) => void;

  private nextIdHint: bigint | null = null;
  private readonly backlog = new Set<bigint>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly failures = new Map<string, Failure>();
  private readonly fillSkipLogged = new Set<bigint>();
  private claimBatch = CLAIM_BATCH_START;
  private pausedUntilMs = 0;

  constructor(deps: SchedulerDeps) {
    this.rpc = deps.rpc;
    this.signer = deps.signer;
    this.cfg = deps.cfg;
    this.state = deps.state;
    this.selector = deps.selector;
    this.store = deps.store;
    this.clock = deps.clock;
    this.logger = deps.logger;
    this.warn = throttled(deps.logger, 60_000);
  }

  /** Pools of rounds that are not final yet: the sampler keeps observing them. */
  activeRoundPools(): Address[] {
    const pools: Address[] = [];
    for (const round of this.snapshot?.rounds.values() ?? []) {
      if (round && round.status !== RoundStatus.Final) pools.push(round.pool);
    }
    return pools;
  }

  async tick(nowMs: number): Promise<void> {
    if (Date.now() < this.pausedUntilMs) return;
    let snap: Snapshot;
    try {
      snap = await this.read();
    } catch (error) {
      if (isRateLimited(error)) this.pausedUntilMs = Date.now() + RATE_LIMIT_PAUSE_MS;
      throw error;
    }
    this.snapshot = snap;
    this.lastTickAtMs = nowMs;
    const config = snap.config;
    if (!config) {
      this.warn('config', { event: 'config_missing', hint: 'run scripts/init-config.ts after the program is deployed' });
      return;
    }
    const me = this.signer.address;
    if (snap.keeperLamports < LOW_BALANCE_LAMPORTS) {
      this.warn('balance', { event: 'keeper_balance_low', lamports: snap.keeperLamports });
    }
    this.reconcileHouse(snap, nowMs);

    const due: Due[] = [];
    const rounds = [...snap.rounds.values()].filter((r): r is RoundAccount => r !== null);
    const create = createDue(nowMs, rounds);
    if (create) {
      if (config.paused) this.warn('paused', { event: 'config_paused', note: 'not creating rounds' });
      else if (config.admin !== me) this.warn('admin', { event: 'keeper_not_admin', admin: config.admin });
      else {
        const opensAt = create.opensAt;
        due.push({ priority: PRIORITY.create, id: config.nextRoundId, lane: 'create', stepKey: `create:${opensAt}`, run: () => this.create(config, opensAt, nowMs) });
      }
    }

    for (const [id, round] of snap.rounds) {
      if (!round) {
        this.backlog.delete(id);
        continue;
      }
      const step = nextStep(round, nowMs, { chainOffsetMs: this.clock.offsetMs });
      if (step.kind === 'done') {
        this.backlog.delete(id);
        continue;
      }
      if (step.kind === 'wait') continue;
      if (!this.authorized(step.kind, config)) continue;
      const kind = step.kind;
      due.push({ priority: PRIORITY[kind], id, lane: `round:${id}`, stepKey: `${kind}:${id}`, run: () => this.run(kind, round, snap, config) });
    }

    due.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const d of due) {
      if (this.inFlight.size >= MAX_PARALLEL_STEPS) break;
      this.dispatch(d.lane, d.stepKey, d.run);
    }
    this.forgetOld(config.nextRoundId);
  }

  /** Loads unfinished rounds older than the per-tick window (start-up and every few minutes). */
  async scanBacklog(): Promise<void> {
    if (this.nextIdHint === null) await this.read();
    const next = this.nextIdHint;
    if (next === null) return; // no Config yet
    const windowStart = next - BigInt(ROUND_WINDOW);
    const ids = await fetchUnfinishedRoundIds(this.rpc);
    let added = 0;
    for (const id of ids) {
      if (id >= windowStart || this.backlog.has(id)) continue;
      this.backlog.add(id);
      added++;
    }
    if (added > 0) this.logger({ event: 'backlog', added, total: this.backlog.size });
  }

  /** Waits for steps in flight (used on shutdown). */
  async drain(timeoutMs: number): Promise<void> {
    const all = Promise.allSettled([...this.inFlight.values()]);
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  status(): LogFields {
    const snap = this.snapshot;
    return {
      lastRoundId: snap?.config && snap.config.nextRoundId > 0n ? snap.config.nextRoundId - 1n : null,
      nextRoundId: snap?.config?.nextRoundId ?? null,
      paused: snap?.config?.paused ?? null,
      lastTickAt: this.lastTickAtMs === null ? null : new Date(this.lastTickAtMs).toISOString(),
      lastSuccessfulActionAt: this.lastActionAtMs === null ? null : new Date(this.lastActionAtMs).toISOString(),
      lastAction: this.lastAction,
      keeperLamports: snap?.keeperLamports ?? null,
      houseVaultAvailable: snap?.houseVault?.available ?? null,
      houseVaultLocked: snap?.houseVault?.locked ?? null,
      inFlight: [...this.inFlight.keys()],
      backlog: this.backlog.size,
      claimBatch: this.claimBatch,
      chainClockOffsetMs: this.clock.offsetMs,
    };
  }

  private async read(): Promise<Snapshot> {
    const me = this.signer.address;
    if (this.nextIdHint === null) {
      const head = await readSnapshot(this.rpc, me, []);
      if (!head.config) return head;
      this.nextIdHint = head.config.nextRoundId;
    }
    let snap = await readSnapshot(this.rpc, me, this.idsToRead(this.nextIdHint));
    const next = snap.config?.nextRoundId;
    if (next !== undefined && next !== this.nextIdHint) {
      // One round created since the last tick is already covered (the window includes the hint).
      const covered = next === this.nextIdHint + 1n;
      this.nextIdHint = next;
      if (!covered) snap = await readSnapshot(this.rpc, me, this.idsToRead(next));
    }
    return snap;
  }

  private idsToRead(next: bigint): bigint[] {
    const ids = new Set<bigint>();
    const from = next > BigInt(ROUND_WINDOW) ? next - BigInt(ROUND_WINDOW) : 0n;
    for (let id = from; id <= next; id++) ids.add(id);
    const old = [...this.backlog].filter((id) => id < from).sort((a, b) => (a < b ? -1 : 1));
    for (const id of old.slice(0, BACKLOG_BATCH)) ids.add(id);
    return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  private authorized(kind: StepKind, config: ConfigAccount): boolean {
    const me = this.signer.address;
    if (kind === 'fill' && config.houseAuthority !== me) {
      this.warn('house', { event: 'keeper_not_house_authority', houseAuthority: config.houseAuthority });
      return false;
    }
    if ((kind === 'strike' || kind === 'settle') && config.priceAuthority !== me) {
      this.warn('price', { event: 'keeper_not_price_authority', priceAuthority: config.priceAuthority });
      return false;
    }
    return true;
  }

  /**
   * Starts `fn` unless the lane (one per round, one for create) is busy, the step just
   * succeeded, or it failed recently and is backing off.
   */
  private dispatch(lane: string, stepKey: string, fn: () => Promise<void>): void {
    const now = Date.now();
    if (this.inFlight.has(lane)) return;
    if ((this.cooldownUntil.get(stepKey) ?? 0) > now) return;
    const failure = this.failures.get(stepKey);
    if (failure && failure.retryAtMs > now) return;
    const task = (async () => {
      try {
        await fn();
        this.failures.delete(stepKey);
        this.cooldownUntil.set(stepKey, Date.now() + SUCCESS_COOLDOWN_MS);
      } catch (error) {
        const count = (failure?.count ?? 0) + 1;
        // NotDue means the devnet clock is a little behind: simply try again next tick.
        const wait = describeError(error) === 'NotDue' ? 1_000 : Math.min(30_000, 1_000 * 2 ** count);
        this.failures.set(stepKey, { count, retryAtMs: Date.now() + wait });
        if (isRateLimited(error)) this.pausedUntilMs = Date.now() + RATE_LIMIT_PAUSE_MS;
      } finally {
        this.inFlight.delete(lane);
      }
    })();
    this.inFlight.set(lane, task);
  }

  /** Sends one transaction and writes the action line: {t, round, step, sig | error}. */
  private async act(roundId: bigint, step: string, instructions: Instruction[], extra: LogFields = {}): Promise<void> {
    try {
      const sig = await sendInstructions(this.rpc, this.signer, instructions);
      this.logger({ round: roundId, step, sig, ...extra });
      this.lastActionAtMs = Date.now();
      this.lastAction = { round: roundId, step, sig };
    } catch (error) {
      const reason = describeError(error);
      // Without a program error the outcome is unknown (e.g. HTTP 429 while confirming): keep the
      // signature so it can be looked up. The next tick decides from the chain state either way.
      const sig = (error as { keeperSignature?: string } | null)?.keeperSignature;
      const unknown = sig !== undefined && !PROGRAM_ERRORS.includes(reason as ProgramErrorName);
      this.logger({ round: roundId, step, error: reason, ...(unknown ? { sig, landed: 'unknown' } : {}), ...extra });
      throw error;
    }
  }

  private async run(kind: StepKind, round: RoundAccount, snap: Snapshot, config: ConfigAccount): Promise<void> {
    switch (kind) {
      case 'fill':
        return this.fill(round, snap);
      case 'strike': {
        // A round without a matched bank ends as NotActivated whatever the samples say.
        const activated = isActivated(round.rawUp, round.rawDown, round.minBank);
        const samples = activated ? windowSamples(this.store.get(round.pool), round.strikeStart, round.strikeEnd) : [];
        const ix = await setStrike({ priceAuthority: this.signer, roundId: round.id, samples });
        return this.act(round.id, 'strike', [ix], { samples: samples.length, activated });
      }
      case 'settle': {
        const samples = windowSamples(this.store.get(round.pool), round.exitStart, round.exitEnd);
        const ix = await settle({ priceAuthority: this.signer, roundId: round.id, samples });
        return this.act(round.id, 'settle', [ix], { samples: samples.length });
      }
      case 'expire':
        return this.act(round.id, 'expire', [await refundExpired({ roundId: round.id })]);
      case 'claim':
        return this.claimAll(round);
      case 'sweep':
        return this.act(round.id, 'sweep', [await sweepFees({ roundId: round.id, treasury: config.treasury })]);
      case 'close':
        return this.act(round.id, 'close', [await closeEmptyRound({ roundId: round.id, admin: config.admin })]);
    }
  }

  private async create(config: ConfigAccount, opensAt: bigint, nowMs: number): Promise<void> {
    const pool = this.selector.current;
    if (!pool) {
      this.warn('no-pool', { event: 'create_skipped', reason: 'no pool selected yet' });
      return;
    }
    // Without a live price feed the round would end unpriceable and cost players the refund fee.
    const latest = this.store.latest(pool.pool);
    if (!latest || nowMs - latest.atMs > SAMPLER_FRESH_MS) {
      this.warn('stale-price', { event: 'create_skipped', reason: 'no fresh price observation of the pool', pool: pool.pool });
      return;
    }
    const reserve = latest.quoteAmount;
    const byDepth = reserve / DEPTH_K;
    const maxBank = byDepth < MAX_BANK_CEILING ? byDepth : MAX_BANK_CEILING;
    // The depth gate again, on the newest reserve and Config's min_bank. A round activates once
    // 2 x its smaller side reaches min_bank, and the depth rule keeps that at most max_bank: with
    // max_bank below min_bank it never activates, and a one-sided bet only waits for its refund.
    if (maxBank <= 0n || maxBank < config.minBank) {
      this.warn('shallow-pool', { event: 'round_skipped_shallow_pool', pool: pool.pool, reserve, maxBank, minBank: config.minBank });
      return;
    }
    const roundId = config.nextRoundId;
    const ix = await createRound({
      admin: this.signer,
      roundId,
      args: { tokenMint: pool.baseMint, pool: pool.pool, ...roundTimes(opensAt), maxBank },
    });
    await this.act(roundId, 'create', [ix], { opensAt: new Date(Number(opensAt) * 1000).toISOString(), pool: pool.pool, maxBank });
  }

  private async fill(round: RoundAccount, snap: Snapshot): Promise<void> {
    const now = Date.now();
    const plan = houseFillAmount({
      rawUp: round.rawUp,
      rawDown: round.rawDown,
      minBank: round.minBank,
      maxBank: round.maxBank,
      roundCap: this.cfg.houseRoundCap,
      remainingBudget: remainingBudget(this.state.state.house, this.cfg.houseDailyBudget, now),
      vaultAvailable: snap.houseVault?.available ?? 0n,
    });
    if (plan.kind === 'skip') {
      if (!this.fillSkipLogged.has(round.id)) {
        this.fillSkipLogged.add(round.id);
        this.logger({ round: round.id, step: 'fill', skipped: plan.reason, rawUp: round.rawUp, rawDown: round.rawDown });
      }
      return;
    }
    const ix = await houseFill({ house: this.signer, roundId: round.id, amount: plan.amount });
    await this.act(round.id, 'fill', [ix], { amount: plan.amount, side: plan.side === Side.Up ? 'up' : 'down' });
    this.state.state.house = recordFill(this.state.state.house, round.id, plan.amount, Date.now());
    this.state.save();
  }

  /** Claims every unclaimed position, several per transaction; halves the batch if it is too large. */
  private async claimAll(round: RoundAccount): Promise<void> {
    const positions = (await fetchPositions(this.rpc, await cachedRoundAddress(round.id))).filter((p) => !p.claimed);
    let i = 0;
    while (i < positions.length) {
      const chunk = positions.slice(i, i + this.claimBatch);
      const ixs = await Promise.all(chunk.map((p) => claim({ roundId: round.id, owner: p.authority })));
      try {
        await this.act(round.id, 'claim', ixs, { positions: chunk.length });
        i += chunk.length;
      } catch (error) {
        if (isTooLarge(error) && this.claimBatch > 1) {
          this.claimBatch = Math.max(1, Math.floor(this.claimBatch / 2));
          this.logger({ round: round.id, event: 'claim_batch_shrunk', claimBatch: this.claimBatch });
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Counts house stakes found on chain against today's budget (idempotent per round), so a fill
   * confirmed while the keeper was restarting is not forgotten.
   */
  private reconcileHouse(snap: Snapshot, nowMs: number): void {
    const before = this.state.state.house;
    let ledger = rollover(before, nowMs);
    const today = utcDay(nowMs);
    for (const round of snap.rounds.values()) {
      if (!round || round.houseAmount === 0n) continue;
      if (utcDay(Number(round.cutoffAt) * 1000) !== today) continue;
      ledger = recordFill(ledger, round.id, round.houseAmount, nowMs);
    }
    if (ledger !== before) {
      this.state.state.house = ledger;
      this.state.save();
    }
  }

  private forgetOld(next: bigint): void {
    const floor = next - BigInt(ROUND_WINDOW * 4);
    for (const id of this.fillSkipLogged) if (id < floor) this.fillSkipLogged.delete(id);
    const now = Date.now();
    for (const [key, until] of this.cooldownUntil) if (until < now) this.cooldownUntil.delete(key);
    for (const [key, f] of this.failures) if (f.retryAtMs < now - 10 * 60_000) this.failures.delete(key);
  }
}
