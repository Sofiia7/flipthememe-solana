/**
 * Round scheduler. Every tick reads Config, the house Vault, HouseLimits, OracleConfig and the last
 * rounds from devnet, then starts, per round, the first step that is due (see steps.ts). Steps run
 * in the background, one at a time per round, so a slow confirmation never stalls the other
 * rounds; a failed step is logged and retried on a later tick. On a quiet tick, paid positions
 * are closed so their rent goes back, and the Round account after its last position (closer.ts).
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
  positionAddress,
  refundExpired,
  roundTimes,
  setStrike,
  settle,
  sweepFees,
  type ConfigAccount,
  type PriceSample,
  type ProgramErrorName,
  type RoundAccount,
} from '@flipthememe/client';
import type { Address, Instruction, KeyPairSigner, Signature } from '@solana/kit';
import { AttestRefused, NO_ATTESTOR, refusalBackoffMs, sendAttested, type AttestorClient } from './attest.ts';
import {
  POSITION_ACCOUNT_SIZE,
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
import { PositionCloser } from './closer.ts';
import type { KeeperConfig } from './config.ts';
import { AnotherKeeperGuard } from './guard.ts';
import {
  chainRoom,
  houseFillAmount,
  matchedWallet,
  recordFill,
  recordWalletFill,
  remainingBudget,
  rollover,
  roundsLeftToday,
  utcDay,
  walletFills,
} from './house.ts';
import { throttled, type LogFields, type Logger } from './log.ts';
import { windowSamples, type ObservationStore } from './observations.ts';
import { RoundLog, roundRow } from './roundlog.ts';
import type { SolanaRpc } from './rpc.ts';
import type { PoolSelector } from './selector.ts';
import type { StateStore } from './state.ts';
import { certificateInstructions } from './certificate.ts';
import { createDue, nextStep, roundAhead, type StepKind } from './steps.ts';

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
/**
 * Returning rent (paid positions, finished rounds) never competes with the rounds: a scan or a batch starts only on a tick
 * where nothing else is in flight, inside the quiet part of the minute (strike and settle fall due
 * at second 41, claims follow, the next round is created from second 45), at most one every
 * CLOSE_INTERVAL_MS. So it holds at most one of the MAX_PARALLEL_STEPS slots, and only then.
 */
export const CLOSE_FROM_SECOND = 3;
export const CLOSE_UNTIL_SECOND = 33;
export const CLOSE_INTERVAL_MS = 10_000;

type Due = { priority: number; id: bigint; lane: string; stepKey: string; run: () => Promise<void> };
/** The devnet clock estimate may be this far from the local clock before the keeper warns (strike and exit windows drift with it). */
export const CLOCK_WARN_MS = 3_000;
/** A new round opens only while the current pool has an observation at most this old. */
const SAMPLER_FRESH_MS = 15_000;
const LOW_BALANCE_LAMPORTS = 200_000_000n;
/** The position rent is read from the RPC and kept this long (it changes only with the cluster's rent). */
export const POSITION_RENT_TTL_MS = 60 * 60_000;

type Failure = { count: number; retryAtMs: number };

/** A claim step that left positions the program refused: asked again after this long (the rest is already claimed). */
export const CLAIM_RETRY_MS = 60_000;

/** Some positions of a round were refused by the program one by one; the others are claimed. */
export class ClaimIncomplete extends Error {
  readonly roundId: bigint;
  readonly positions: number;

  constructor(roundId: bigint, positions: number) {
    super(`claim of round ${roundId}: ${positions} position(s) refused by the program`);
    this.name = 'ClaimIncomplete';
    this.roundId = roundId;
    this.positions = positions;
  }
}

/**
 * How long a failed step is left alone, given how many times in a row it has failed (1 for the
 * first). An attestor refusal waits by its reason (attest.ts), a claim with refused positions a
 * minute, NotDue (the devnet clock is a little behind) a second, anything else 2^n seconds up to 30.
 */
export function retryDelayMs(error: unknown, failures: number): number {
  if (error instanceof AttestRefused) return refusalBackoffMs(error.reason, failures);
  if (error instanceof ClaimIncomplete) return CLAIM_RETRY_MS;
  if (describeError(error) === 'NotDue') return 1_000;
  return Math.min(30_000, 1_000 * 2 ** failures);
}

/** The program refused the transaction (as opposed to a transport failure, where the outcome is unknown). */
const isProgramError = (error: unknown): boolean => PROGRAM_ERRORS.includes(describeError(error) as ProgramErrorName);

export type SchedulerDeps = {
  canClosePosition?: (position: string) => boolean;
  rpc: SolanaRpc;
  /** The keeper key: fee payer of every transaction, and the admin that creates rounds. */
  signer: KeyPairSigner;
  /** PRICE_KEYPAIR and HOUSE_KEYPAIR; each defaults to `signer`. */
  priceSigner?: KeyPairSigner;
  houseSigner?: KeyPairSigner;
  /** Present when ATTEST_URL is set. */
  attestor?: AttestorClient | null;
  certificates?: typeof certificateInstructions;
  marketReady?: (pool: string, nowMs: number) => string | null | Promise<string | null>;
  closer?: PositionCloser;
  /** rounds.jsonl: a line per swept round (humans, wallets, outcome); absent = no such record. */
  roundLog?: RoundLog | null;
  /** Detector of a second keeper; the scheduler makes its own when none is given. */
  guard?: AnotherKeeperGuard;
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
  private readonly priceSigner: KeyPairSigner;
  private readonly houseSigner: KeyPairSigner;
  private readonly attestor: AttestorClient | null;
  private readonly certificates: typeof certificateInstructions;
  private readonly marketReady: (pool: string, nowMs: number) => string | null | Promise<string | null>;
  private readonly closer: PositionCloser;
  private readonly cfg: KeeperConfig;
  private readonly state: StateStore;
  private readonly selector: PoolSelector;
  private readonly store: ObservationStore;
  private readonly clock: ChainClock;
  private readonly logger: Logger;
  private readonly warn: (key: string, fields: LogFields) => void;
  private readonly warnClock: (key: string, fields: LogFields) => void;
  private readonly roundLog: RoundLog | null;
  readonly guard: AnotherKeeperGuard;

  /** Ids of the rounds this process tried to create: a round at the next boundary that is not one of them is someone else's. */
  private readonly ownRounds = new Set<bigint>();
  /** Pool names as the selector had them, for rounds.jsonl (a round only knows its pool address). */
  private readonly poolNames = new Map<string, string>();
  /** Rounds whose house fill was refused for the wallet limit (the positions are not read again), and rounds counted against a wallet. */
  private readonly walletBlocked = new Set<bigint>();
  private readonly walletRecorded = new Set<bigint>();

  private nextIdHint: bigint | null = null;
  private readonly backlog = new Set<bigint>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly failures = new Map<string, Failure>();
  private readonly fillSkipLogged = new Set<bigint>();
  private claimBatch = CLAIM_BATCH_START;
  private pausedUntilMs = 0;
  private nextPositionsAtMs = 0;
  /** Rent of a position account: the house vault pays it on top of the stake at every fill. */
  private positionRent: { lamports: bigint; atMs: number } | null = null;

  constructor(deps: SchedulerDeps) {
    this.rpc = deps.rpc;
    this.signer = deps.signer;
    this.priceSigner = deps.priceSigner ?? deps.signer;
    this.houseSigner = deps.houseSigner ?? deps.signer;
    this.attestor = deps.attestor ?? null;
    this.certificates = deps.certificates ?? certificateInstructions;
    this.marketReady = deps.marketReady ?? (() => null);
    this.closer = deps.closer ?? new PositionCloser({ rpc: deps.rpc, signer: deps.signer, logger: deps.logger, closeAfterSecs: deps.cfg.closeAfterSecs });
    if (deps.canClosePosition) this.closer.canClosePosition = deps.canClosePosition;
    this.cfg = deps.cfg;
    this.state = deps.state;
    this.selector = deps.selector;
    this.store = deps.store;
    this.clock = deps.clock;
    this.logger = deps.logger;
    this.warn = throttled(deps.logger, 60_000);
    this.warnClock = throttled(deps.logger, 10 * 60_000);
    this.roundLog = deps.roundLog ?? null;
    this.guard = deps.guard ?? new AnotherKeeperGuard({ logger: deps.logger });
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
    this.noteSelection();
    if (Math.abs(this.clock.offsetMs) > CLOCK_WARN_MS) {
      this.warnClock('clock', {
        event: 'clock_offset_warning',
        offsetMs: this.clock.offsetMs,
        limitMs: CLOCK_WARN_MS,
        hint: 'the devnet clock and this host differ: strike and exit windows drift, the attestor may refuse the samples (slot_out_of_range); check NTP on the host',
      });
    }
    // close_empty_round pays the rent of a finished round to config.admin.
    this.closer.admin = config.admin;
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
      else if (this.guard.paused(nowMs)) {
        const until = this.guard.pausedUntil();
        this.warn('another-keeper', { event: 'create_paused_another_keeper', until: until === null ? null : new Date(until).toISOString() });
      } else {
        const opensAt = create.opensAt;
        due.push({ priority: PRIORITY.create, id: config.nextRoundId, lane: 'create', stepKey: `create:${opensAt}`, run: () => this.create(config, opensAt, nowMs) });
      }
    } else if (!config.paused && config.admin === me) {
      // Nothing to create because a round already stands at the boundary: ours (this process made it), or another keeper's.
      const ahead = roundAhead(nowMs, rounds);
      if (ahead && !this.ownRounds.has(ahead.id)) this.guard.foreignRound(ahead.opensAt, ahead.id, nowMs);
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
      const canonical = !this.cfg.legacyPrices && snap.oracle?.required === true && isActivated(round.rawUp, round.rawDown, round.minBank);
      if (!this.authorized(step.kind, config, canonical)) continue;
      const kind = step.kind;
      due.push({ priority: PRIORITY[kind], id, lane: `round:${id}`, stepKey: `${kind}:${id}`, run: () => this.run(kind, round, snap, config) });
    }

    due.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const d of due) {
      if (this.inFlight.size >= MAX_PARALLEL_STEPS) break;
      this.dispatch(d.lane, d.stepKey, d.run);
    }
    this.closePositions(nowMs);
    this.forgetOld(config.nextRoundId);
  }

  /** Lowest priority: see CLOSE_FROM_SECOND. Pause or not, rent can always go back. */
  private closePositions(nowMs: number): void {
    if (this.inFlight.size > 0 || nowMs < this.nextPositionsAtMs) return;
    const second = Math.floor(nowMs / 1000) % 60;
    if (second < CLOSE_FROM_SECOND || second >= CLOSE_UNTIL_SECOND) return;
    if (this.closer.scanDue(nowMs)) {
      this.nextPositionsAtMs = nowMs + CLOSE_INTERVAL_MS;
      const chainNowSecs = this.chainNowSecs(nowMs);
      this.dispatch('positions', 'positions:scan', () => this.closer.scan(nowMs, chainNowSecs));
    } else if (this.closer.hasWork()) {
      this.nextPositionsAtMs = nowMs + CLOSE_INTERVAL_MS;
      this.dispatch('positions', 'positions:close', () => this.closer.closeNext(nowMs));
    }
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
      priceAuthority: this.priceSigner.address,
      house: this.houseSigner.address,
      houseLamports: snap?.houseLamports ?? null,
      houseVaultAvailable: snap?.houseVault?.available ?? null,
      houseVaultLocked: snap?.houseVault?.locked ?? null,
      houseLimits: snap?.houseLimits ? this.houseLimitsStatus(snap.houseLimits) : null,
      oracle: snap?.oracle ? { attestor: snap.oracle.attestor, required: snap.oracle.required, attestUrl: this.attestor !== null } : null,
      positions: this.closer.status(),
      inFlight: [...this.inFlight.keys()],
      backlog: this.backlog.size,
      claimBatch: this.claimBatch,
      positionRent: this.positionRent?.lamports ?? null,
      chainClockOffsetMs: this.clock.offsetMs,
      clockOffsetWarning: Math.abs(this.clock.offsetMs) > CLOCK_WARN_MS,
      anotherKeeper: { suspected: this.guard.suspected, createPausedUntil: this.guard.pausedUntil() === null ? null : new Date(this.guard.pausedUntil() ?? 0).toISOString() },
    };
  }

  /** Remembers the current pool's name for rounds.jsonl. */
  private noteSelection(): void {
    const selected = this.selector.current;
    if (!selected) return;
    this.poolNames.set(selected.pool, selected.name);
    if (this.poolNames.size > 100) {
      const oldest = this.poolNames.keys().next().value;
      if (oldest !== undefined && oldest !== selected.pool) this.poolNames.delete(oldest);
    }
  }

  private houseLimitsStatus(limits: NonNullable<Snapshot['houseLimits']>): LogFields {
    const room = chainRoom(limits, 0n, this.chainNowSecs(Date.now()));
    return { roundCap: limits.roundCap, dailyCap: limits.dailyCap, day: room.day, spent: room.spentToday, remaining: room.daily };
  }

  private chainNowSecs(nowMs: number): bigint {
    return BigInt(Math.floor((nowMs + this.clock.offsetMs) / 1000));
  }

  private async read(): Promise<Snapshot> {
    const me = this.signer.address;
    const house = this.houseSigner.address;
    if (this.nextIdHint === null) {
      const head = await readSnapshot(this.rpc, me, [], house);
      if (!head.config) return head;
      this.nextIdHint = head.config.nextRoundId;
    }
    let snap = await readSnapshot(this.rpc, me, this.idsToRead(this.nextIdHint), house);
    const next = snap.config?.nextRoundId;
    if (next !== undefined && next !== this.nextIdHint) {
      // One round created since the last tick is already covered (the window includes the hint).
      const covered = next === this.nextIdHint + 1n;
      this.nextIdHint = next;
      if (!covered) snap = await readSnapshot(this.rpc, me, this.idsToRead(next), house);
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

  private authorized(kind: StepKind, config: ConfigAccount, canonical: boolean): boolean {
    if (kind === 'fill' && config.paused) {
      // The program refuses house_fill while the arena is paused (Paused, 6015): no point asking.
      this.warn('house-paused', { event: 'house_fill_paused', note: 'config is paused: no house fills' });
      return false;
    }
    if (kind === 'fill' && config.houseAuthority !== this.houseSigner.address) {
      this.warn('house', { event: 'keeper_not_house_authority', houseAuthority: config.houseAuthority, houseKey: this.houseSigner.address });
      return false;
    }
    if (!canonical && (kind === 'strike' || kind === 'settle') && config.priceAuthority !== this.priceSigner.address) {
      this.warn('price', { event: 'keeper_not_price_authority', priceAuthority: config.priceAuthority, priceKey: this.priceSigner.address });
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
        this.failures.set(stepKey, { count, retryAtMs: Date.now() + retryDelayMs(error, count) });
        if (isRateLimited(error)) this.pausedUntilMs = Date.now() + RATE_LIMIT_PAUSE_MS;
      } finally {
        this.inFlight.delete(lane);
      }
    })();
    this.inFlight.set(lane, task);
  }

  /** Sends one transaction and writes the action line: {t, round, step, sig | error}. */
  private act(roundId: bigint, step: string, instructions: Instruction[], extra: LogFields = {}): Promise<void> {
    return this.actWith(roundId, step, () => sendInstructions(this.rpc, this.signer, instructions), extra);
  }

  /** `act` for a custom send; `extra` is read when the line is written, after `send` resolved. */
  private async actWith(roundId: bigint, step: string, send: () => Promise<Signature>, extra: LogFields = {}): Promise<void> {
    try {
      const sig = await send();
      this.logger({ round: roundId, step, sig, ...extra });
      this.lastActionAtMs = Date.now();
      this.lastAction = { round: roundId, step, sig };
    } catch (error) {
      const reason = describeError(error);
      // Without a program error the outcome is unknown (e.g. HTTP 429 while confirming): keep the
      // signature so it can be looked up. The next tick decides from the chain state either way.
      const sig = (error as { keeperSignature?: string } | null)?.keeperSignature;
      const unknown = sig !== undefined && !isProgramError(error);
      this.logger({ round: roundId, step, error: reason, ...(unknown ? { sig, landed: 'unknown' } : {}), ...extra });
      throw error;
    }
  }

  private async run(kind: StepKind, round: RoundAccount, snap: Snapshot, config: ConfigAccount): Promise<void> {
    switch (kind) {
      case 'fill':
        return this.fill(round, snap);
      case 'strike': {
        // A round without a matched bank ends as NotActivated whatever the samples say; no price
        // is used, so the program needs no attestor for it either.
        const activated = isActivated(round.rawUp, round.rawDown, round.minBank);
        const samples = activated ? windowSamples(this.store.get(round.pool), round.strikeStart, round.strikeEnd) : [];
        return this.price('strike', round, samples, snap, activated, { samples: samples.length, activated });
      }
      case 'settle': {
        const samples = windowSamples(this.store.get(round.pool), round.exitStart, round.exitEnd);
        return this.price('settle', round, samples, snap, true, { samples: samples.length });
      }
      case 'expire':
        return this.act(round.id, 'expire', [await refundExpired({ roundId: round.id })]);
      case 'claim':
        return this.claimAll(round);
      case 'sweep':
        await this.recordRound(round);
        return this.act(round.id, 'sweep', [await sweepFees({ roundId: round.id, treasury: config.treasury })]);
      case 'close':
        return this.act(round.id, 'close', [await closeEmptyRound({ roundId: round.id, admin: config.admin })]);
    }
  }

  /**
   * set_strike or settle, signed by the price key. With ATTEST_URL set and an attestor in
   * OracleConfig, the attestor co-signs first (attest.ts). While the chain requires it, a price
   * goes out only with its signature: a refusal or an outage fails the step, which is retried
   * until settle_deadline (a refusal by its reason: 5 s, 15 s, 60 s, then every 120 s for the
   * transient ones, every 120 s for the others; an outage with the step backoff of 2^n s up to
   * 30 s), after which the round takes its normal refund (refund_expired needs no attestor).
   * While not required, the keeper sends without it.
   */
  private async price(step: 'strike' | 'settle', round: RoundAccount, samples: PriceSample[], snap: Snapshot, priced: boolean, extra: LogFields): Promise<void> {
    const oracle = snap.oracle;
    if (!oracle) {
      this.warn('oracle', { event: 'oracle_missing', hint: 'run scripts/init-oracle.ts after the program upgrade' });
      return;
    }
    if (oracle.required && priced && !this.cfg.legacyPrices) {
      const url = this.attestor?.url;
      if (!url) {
        this.warn('attest-url', { event: 'attestor_required_no_url', round: round.id, step, attestor: oracle.attestor, hint: 'set ATTEST_URL' });
        return;
      }
      return this.actWith(round.id, step, async () => {
        const instructions = await this.certificates(url, round, step === 'strike' ? 'strike' : 'exit', oracle.attestor);
        return sendInstructions(this.rpc, this.signer, instructions);
      }, { ...extra, priceMode: 'detached-canonical' });
    }
    const build = step === 'strike' ? setStrike : settle;
    const unattested = () => build({ priceAuthority: this.priceSigner, roundId: round.id, samples });
    const attestor = this.attestor;
    const required = oracle.required && priced;
    if (!priced || attestor === null || oracle.attestor === NO_ATTESTOR) {
      if (required) {
        this.warn('attest-url', { event: 'attestor_required_no_url', round: round.id, step, attestor: oracle.attestor, hint: 'set ATTEST_URL' });
        return;
      }
      return this.act(round.id, step, [await unattested()], extra);
    }
    const ix = await build({ priceAuthority: this.priceSigner, roundId: round.id, samples, attestor: oracle.attestor });
    const deadlineMs = Number(round.settleDeadline) * 1000 - this.clock.offsetMs;
    const fields: LogFields = { ...extra, attested: false };
    return this.actWith(
      round.id,
      step,
      async () => {
        const sent = await sendAttested(this.rpc, this.signer, [ix], oracle.attestor, attestor, deadlineMs);
        if (sent.kind === 'sent') {
          fields.attested = true;
          this.logger({ event: 'attest_ok', round: round.id, step, attestor: oracle.attestor, attempts: sent.attest.attempts, ms: sent.attest.ms });
          return sent.signature;
        }
        const a = sent.attest;
        this.logger({
          event: a.kind === 'refused' ? 'attest_refused' : 'attest_failed',
          round: round.id,
          step,
          reason: a.reason,
          ...(a.kind === 'refused' ? { status: a.status } : {}),
          attempts: a.attempts,
          required,
        });
        if (required) {
          // A refusal backs off by its reason (retryDelayMs); an outage keeps the step backoff.
          if (a.kind === 'refused') throw new AttestRefused(a.reason, a.status, a.attempts);
          throw new Error(`attestation ${a.kind}: ${a.reason}`);
        }
        // Not required yet (the attestor runs alongside): the price goes out as before.
        return sendInstructions(this.rpc, this.signer, [await unattested()]);
      },
      fields,
    );
  }

  private async create(config: ConfigAccount, opensAt: bigint, nowMs: number): Promise<void> {
    const pool = this.selector.current;
    if (!pool) {
      this.warn('no-pool', { event: 'create_skipped', reason: 'no pool selected yet' });
      return;
    }
    const notReady = await this.marketReady(pool.pool, nowMs);
    if (notReady) {
      this.warn('market-ready', { event: 'create_skipped', reason: notReady, pool: pool.pool });
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
    // Several overlapping windows on one pool share the same manipulation budget.
    const committed = [...(this.snapshot?.rounds.values() ?? [])].reduce((sum, r) => sum + (r && r.pool === pool.pool && r.status !== RoundStatus.Final ? r.maxBank : 0n), 0n);
    const room = byDepth > committed ? byDepth - committed : 0n;
    // A result window lasts 160 seconds and we precreate the next minute's round.
    // Reserve capacity for four overlapping rounds instead of lending it all to the first.
    const perRound = byDepth / 4n;
    const available = room < perRound ? room : perRound;
    const maxBank = available < MAX_BANK_CEILING ? available : MAX_BANK_CEILING;
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
    this.ownRounds.add(roundId);
    try {
      await this.act(roundId, 'create', [ix], { opensAt: new Date(Number(opensAt) * 1000).toISOString(), pool: pool.pool, maxBank });
    } catch (error) {
      if (describeError(error) === 'InvalidRoundId') {
        // Another transaction took the id between our read and our send.
        this.ownRounds.delete(roundId);
        this.guard.invalidRoundId(opensAt, Date.now());
      }
      throw error;
    }
    this.guard.created();
  }

  private async positionRentLamports(nowMs: number): Promise<bigint> {
    if (this.positionRent === null || nowMs - this.positionRent.atMs > POSITION_RENT_TTL_MS) {
      const lamports = await this.rpc.getMinimumBalanceForRentExemption(BigInt(POSITION_ACCOUNT_SIZE)).send();
      this.positionRent = { lamports, atMs: nowMs };
    }
    return this.positionRent.lamports;
  }

  /** The skip line of a fill, once per round (the fill step is asked again every few seconds of its window). */
  private logFillSkip(round: RoundAccount, reason: string, fields: LogFields = {}): void {
    if (this.fillSkipLogged.has(round.id)) return;
    this.fillSkipLogged.add(round.id);
    this.logger({ round: round.id, step: 'fill', skipped: reason, rawUp: round.rawUp, rawDown: round.rawDown, ...fields });
  }

  private async fill(round: RoundAccount, snap: Snapshot): Promise<void> {
    const now = Date.now();
    const limits = snap.houseLimits;
    if (!limits) {
      // house_fill needs the HouseLimits account: without it the program refuses every fill.
      this.warn('house-limits', { event: 'house_limits_missing', hint: 'run scripts/init-house-limits.ts after the program upgrade' });
      return;
    }
    const paused = snap.config?.paused ?? false;
    if (paused) {
      this.logFillSkip(round, 'paused');
      return;
    }
    // A pool that was chosen a moment ago has not shown its flow yet: the house stays out of its first minutes.
    const selected = this.selector.current;
    const pauseMs = this.cfg.houseSwitchPauseSecs * 1000;
    if (pauseMs > 0 && selected && selected.pool === round.pool && now - selected.selectedAtMs < pauseMs) {
      this.logFillSkip(round, 'pool-switch-pause', { poolSelectedAt: new Date(selected.selectedAtMs).toISOString(), pauseSecs: this.cfg.houseSwitchPauseSecs });
      return;
    }
    if (this.walletBlocked.has(round.id)) return;
    const room = chainRoom(limits, round.houseAmount, this.chainNowSecs(now));
    // The program takes the house position's rent from the house vault on top of the stake.
    const rent = await this.positionRentLamports(now);
    const available = snap.houseVault?.available ?? 0n;
    const plan = houseFillAmount({
      rawUp: round.rawUp,
      rawDown: round.rawDown,
      minBank: round.minBank,
      maxBank: round.maxBank,
      roundCap: this.cfg.houseRoundCap,
      remainingBudget: remainingBudget(this.state.state.house, this.cfg.houseDailyBudget, now),
      chainRoundRoom: room.round,
      chainDailyRoom: room.daily,
      vaultAvailable: available > rent ? available - rent : 0n,
      paused,
      pace: this.cfg.housePaceDivisor > 0 ? { roundsLeft: roundsLeftToday(now), divisor: this.cfg.housePaceDivisor } : undefined,
    });
    if (plan.kind === 'skip') {
      const onChain = plan.reason === 'chain-round-cap' || plan.reason === 'chain-daily-cap';
      this.logFillSkip(
        round,
        plan.reason,
        onChain ? { event: 'fill_skipped_onchain_cap', roundCap: limits.roundCap, houseAmount: round.houseAmount, dailyCap: limits.dailyCap, spentToday: room.spentToday } : {},
      );
      return;
    }
    // At most HOUSE_WALLET_DAILY_FILLS fills per wallet and UTC day: the wallet is the owner of the biggest stake
    // the fill matches. The positions are read only now, when a fill is really about to go out.
    let wallet: string | null = null;
    const limit = this.cfg.houseWalletDailyFills;
    if (limit > 0) {
      let positions;
      try {
        positions = await fetchPositions(this.rpc, await cachedRoundAddress(round.id));
      } catch (error) {
        this.warn('fill-positions', { event: 'fill_positions_failed', round: round.id, error: describeError(error) });
        throw error;
      }
      wallet = matchedWallet(positions, plan.side);
      if (wallet !== null) {
        const fills = walletFills(this.state.state.house, wallet, now);
        if (fills >= limit) {
          this.walletBlocked.add(round.id);
          this.logFillSkip(round, 'wallet-limit', { event: 'fill_skipped_wallet_limit', wallet, fillsToday: fills, limit });
          return;
        }
      }
    }
    const ix = await houseFill({ house: this.houseSigner, roundId: round.id, amount: plan.amount });
    await this.act(round.id, 'fill', [ix], {
      amount: plan.amount,
      side: plan.side === Side.Up ? 'up' : 'down',
      ...(plan.paced !== undefined ? { paced: plan.paced } : {}),
      ...(wallet !== null ? { wallet } : {}),
    });
    let ledger = recordFill(this.state.state.house, round.id, plan.amount, Date.now());
    if (wallet !== null && !this.walletRecorded.has(round.id)) {
      this.walletRecorded.add(round.id);
      ledger = recordWalletFill(ledger, wallet, Date.now());
    }
    this.state.state.house = ledger;
    this.state.save();
  }

  /**
   * One line of rounds.jsonl for a round about to be swept (once per round id): its outcome and prices, and
   * from its positions how many were real people. A failed read of the positions leaves those two null.
   */
  private async recordRound(round: RoundAccount): Promise<void> {
    const log = this.roundLog;
    if (!log || log.has(round.id)) return;
    let positions: Awaited<ReturnType<typeof fetchPositions>> | null = null;
    if (round.positionCount > 0) {
      try {
        positions = await fetchPositions(this.rpc, await cachedRoundAddress(round.id));
      } catch (error) {
        this.warn('round-log-positions', { event: 'rounds_log_positions_failed', round: round.id, error: describeError(error) });
      }
    }
    log.add(roundRow(round, this.poolNames.get(round.pool) ?? null, positions, Date.now()));
  }

  /**
   * Claims every unclaimed position, several per transaction; halves the batch if it is too large.
   * When the program refuses a batch, its positions are claimed one per transaction, so one bad
   * position cannot keep the others from being paid: it is named in the log (`claim_position_failed`),
   * the step ends with ClaimIncomplete and asks for the leftovers again after CLAIM_RETRY_MS. A
   * failure that is not a program error (a timeout, HTTP 429) stays as it was: the outcome is
   * unknown, the step fails and the next attempt reads the positions from the chain again.
   */
  private async claimAll(round: RoundAccount): Promise<void> {
    const roundKey = await cachedRoundAddress(round.id);
    const positions = (await fetchPositions(this.rpc, roundKey)).filter((p) => !p.claimed);
    let refused = 0;
    let i = 0;
    while (i < positions.length) {
      const chunk = positions.slice(i, i + this.claimBatch);
      const ixs = await Promise.all(chunk.map((p) => claim({ roundId: round.id, owner: p.authority })));
      try {
        await this.act(round.id, 'claim', ixs, { positions: chunk.length });
      } catch (error) {
        if (isTooLarge(error) && this.claimBatch > 1) {
          this.claimBatch = Math.max(1, Math.floor(this.claimBatch / 2));
          this.logger({ round: round.id, event: 'claim_batch_shrunk', claimBatch: this.claimBatch });
          continue;
        }
        if (!isProgramError(error)) throw error;
        const only = chunk[0];
        if (chunk.length === 1 && only) {
          // Already tried alone (the failed attempt is in the log); only name it.
          if (await this.noteRefused(round.id, roundKey, only.authority, error)) refused++;
        } else {
          for (const p of chunk) {
            try {
              await this.act(round.id, 'claim', [await claim({ roundId: round.id, owner: p.authority })], { positions: 1, owner: p.authority });
            } catch (single) {
              if (!isProgramError(single)) throw single;
              if (await this.noteRefused(round.id, roundKey, p.authority, single)) refused++;
            }
          }
        }
      }
      i += chunk.length;
    }
    if (refused > 0) throw new ClaimIncomplete(round.id, refused);
  }

  /**
   * Logs a position the program refused to claim. AlreadyClaimed is not a problem (the player
   * claimed it from the app in the meantime): returns false for it, true for any other refusal.
   */
  private async noteRefused(roundId: bigint, round: Address, owner: Address, error: unknown): Promise<boolean> {
    const reason = describeError(error);
    if (reason === 'AlreadyClaimed') return false;
    this.logger({ event: 'claim_position_failed', round: roundId, owner, position: await positionAddress(round, owner), error: reason });
    return true;
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
    for (const set of [this.walletBlocked, this.walletRecorded, this.ownRounds]) for (const id of set) if (id < floor) set.delete(id);
    const now = Date.now();
    for (const [key, until] of this.cooldownUntil) if (until < now) this.cooldownUntil.delete(key);
    for (const [key, f] of this.failures) if (f.retryAtMs < now - 10 * 60_000) this.failures.delete(key);
  }
}
