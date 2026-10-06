/**
 * The attestor's Durable Object logic, free of Workers runtime imports so node:test can drive it
 * (index.ts wraps it in the DurableObject class).
 *
 * Rounds: every REFRESH_MS one devnet getMultipleAccounts reads Config (next_round_id), the
 * OracleConfig and the Round accounts next_round_id - ROUNDS_BACK .. next_round_id by PDA.
 *
 * Samples: while a window is open (SAMPLE_MARGIN_MS on both sides) an alarm fires about once a
 * second and reads each pool's two vaults on mainnet with the client's observePrice: one
 * getMultipleAccounts, commitment confirmed, price = quote * 10^12 / base, with the context slot.
 * One SQLite row per pool and read: pool, time, slot, price and the strike and exit round it
 * served (round N's exit window and round N+1's strike window are the same 10 seconds). Rows older
 * than RETAIN_MS are deleted. Between windows the next alarm is the next window's start or the next
 * refresh, whichever comes first.
 *
 * attest(): check.ts on the transaction, the round fresh from devnet, the samples (samples.ts),
 * then the Ed25519 signature over the message bytes.
 */
import {
  PROGRAM_ID,
  configAddress,
  decodeConfig,
  decodeOracleConfig,
  decodeRound,
  isAccount,
  isActivated,
  loadPool,
  observePrice,
  oracleAddress,
  roundAddress,
  type ConfigAccount,
  type OracleConfigAccount,
  type PoolRef,
  type RoundAccount,
} from '@flipthememe/client';
import { getBase58Decoder, getBase64Encoder, type Address } from '@solana/kit';
import {
  ROUND_ACCOUNT_INDEX,
  Refusal,
  checkRound,
  decodeBase64,
  parseAttestRequest,
  statusName,
  type AttestRequest,
  type ProgramPdas,
} from './check.ts';
import { failure, type Result } from './http.ts';
import { loadAttestorKey, type AttestorKey } from './key.ts';
import { Failover, describe, endpointsFor } from './rpc.ts';
import {
  DEFAULT_TOLERANCE_BPS,
  SAMPLE_MARGIN_MS,
  activeWindows,
  compareSamples,
  nextSamplingStart,
  pendingWindows,
  windowOf,
  type Observation,
  type RoundWindow,
  type WindowKind,
} from './samples.ts';

export const TICK_MS = 1_000;
export const REFRESH_MS = 15_000;
export const RETAIN_MS = 60 * 60 * 1000;
export const PRUNE_EVERY_MS = 10 * 60 * 1000;
/** Rounds read per refresh besides next_round_id itself: enough for every window still ahead. */
export const ROUNDS_BACK = 4n;
const MIN_ALARM_GAP_MS = 100;
/** The cron ping re-arms an alarm that should have fired this long ago. */
const STALE_ALARM_MS = 60_000;
/** Per endpoint. The keeper gives an attest call 5 s, which must cover one devnet read and a fallback. */
const RPC_TIMEOUT_MS = 3_000;
const LOG_EVERY_MS = 60_000;
/** Attest calls kept for the health report (in memory: a restart of the object clears them). */
const RECENT_ATTESTS = 20;

/**
 * Public endpoints that serve Worker subrequests (checked 2026-10-06 with the CF-Worker header that
 * Cloudflare adds to them): api.devnet.solana.com and api.mainnet-beta.solana.com answer 403 "Your
 * IP or provider is blocked"; OnFinality's public devnet RPC and publicnode answer. The Solana devnet
 * endpoint stays last for local runs.
 */
export const DEVNET_RPCS = ['https://solana-devnet.api.onfinality.io/public', 'https://api.devnet.solana.com'];
export const MAINNET_RPCS = ['https://solana-rpc.publicnode.com'];

export type SqlValue = string | number | null;
export type Sql = { exec(query: string, ...bindings: SqlValue[]): { toArray(): unknown[] } };
export type Alarms = { getAlarm(): Promise<number | null>; setAlarm(scheduledTime: number): Promise<void> };
export type AttestorEnv = {
  ATTESTOR_SECRET?: string;
  ATTEST_TOLERANCE_BPS?: string;
  MAINNET_RPC?: string;
  DEVNET_RPC?: string;
};
export type LogFields = Record<string, unknown>;

export type CoreOptions = {
  sql: Sql;
  alarms: Alarms;
  env: AttestorEnv;
  now?: () => number;
  devnet?: Failover;
  mainnet?: Failover;
  log?: (fields: LogFields) => void;
};

type SampleRow = { at_ms: number; slot: number; price: string };
/** One attest call for the health report: `sharedSlots` is null when no comparison ran. */
type AttestRecord = {
  at: string | null;
  round: string | null;
  instruction: string | null;
  result: string;
  keeperSamples: number | null;
  sharedSlots: number | null;
};
type Snapshot = { config: ConfigAccount | null; oracle: OracleConfigAccount | null; rounds: Map<bigint, RoundAccount> };
type Base64Account = { data: readonly [string, string]; owner: Address } | null;

const base64 = getBase64Encoder();
const base58 = getBase58Decoder();

const iso = (ms: number | null | undefined): string | null => (ms ? new Date(ms).toISOString() : null);

const logLine = (fields: LogFields) =>
  console.log(JSON.stringify(fields, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)));

/** ATTEST_TOLERANCE_BPS: whole basis points, 0 to 10000; unset means the default. */
export function parseTolerance(raw: string | undefined): number {
  const text = raw?.trim();
  if (!text) return DEFAULT_TOLERANCE_BPS;
  if (!/^\d{1,5}$/.test(text) || Number(text) > 10_000) {
    throw new Error('ATTEST_TOLERANCE_BPS must be whole basis points from 0 to 10000');
  }
  return Number(text);
}

/** The account's data when the FlipTheMeme program owns it. */
function programData(account: Base64Account | undefined): Uint8Array | null {
  return account && account.owner === PROGRAM_ID ? new Uint8Array(base64.encode(account.data[0])) : null;
}

/** No devnet endpoint answered: the attestor cannot see the round, so it does not sign. */
class DevnetUnavailable extends Error {}

export class AttestorCore {
  private readonly sql: Sql;
  private readonly alarms: Alarms;
  private readonly env: AttestorEnv;
  private readonly now: () => number;
  private readonly devnet: Failover;
  private readonly mainnet: Failover;
  private readonly log: (fields: LogFields) => void;
  private readonly tolerance: { bps: number } | { error: string };

  private keyPromise: Promise<AttestorKey> | null = null;
  private pdas: Promise<ProgramPdas> | null = null;
  private readonly startedAt: number;
  private readonly recent: AttestRecord[] = [];
  /** Since the object started. `compared`: calls that reached the slot-by-slot comparison. */
  private readonly totals = { attests: 0, signed: 0, compared: 0, keeperSamples: 0, sharedSlots: 0 };
  private rounds: Map<bigint, RoundAccount> | null = null;
  private nextRoundId: bigint | null = null;
  private oracle: OracleConfigAccount | null = null;
  private refreshTriedAt = 0;
  private refreshedAt = 0;
  private prunedAt = 0;
  private plannedAt = 0;
  private ticking = false;
  private lastSample: { atMs: number; slot: bigint } | null = null;
  private readonly poolRefs = new Map<string, Promise<PoolRef>>();
  private readonly roundPdas = new Map<bigint, Address>();
  private readonly errors: Record<string, { at: string | null; error: string }> = {};
  private readonly loggedAt = new Map<string, number>();

  constructor(opts: CoreOptions) {
    this.sql = opts.sql;
    this.alarms = opts.alarms;
    this.env = opts.env;
    this.now = opts.now ?? (() => Date.now());
    this.startedAt = this.now();
    const publicUrls = (urls: string[]) => urls.map((url) => ({ url }));
    this.devnet =
      opts.devnet ??
      new Failover(endpointsFor([{ url: opts.env.DEVNET_RPC, secret: 'DEVNET_RPC' }, ...publicUrls(DEVNET_RPCS)], RPC_TIMEOUT_MS), this.now);
    this.mainnet =
      opts.mainnet ??
      new Failover(endpointsFor([{ url: opts.env.MAINNET_RPC, secret: 'MAINNET_RPC' }, ...publicUrls(MAINNET_RPCS)], RPC_TIMEOUT_MS), this.now);
    this.log = opts.log ?? logLine;
    try {
      this.tolerance = { bps: parseTolerance(opts.env.ATTEST_TOLERANCE_BPS) };
    } catch (error) {
      this.tolerance = { error: describe(error) };
    }
    // One row per read. The key serves the attest query (one pool, a time range); a read that
    // served round N's exit and round N+1's strike is stored once, with both round ids.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS samples (
      pool TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      slot INTEGER NOT NULL,
      price TEXT NOT NULL,
      strike_round INTEGER,
      exit_round INTEGER,
      PRIMARY KEY (pool, at_ms)
    ) WITHOUT ROWID`);
  }

  // ---- the sampling loop ----------------------------------------------------------------------

  /**
   * The alarm handler: inside a window read the pools, otherwise refresh the rounds when due; then
   * re-arm. A refresh waits for the end of a window, so a slow devnet never delays a read (the
   * rounds ahead are known at least 90 s before their first window, and attest reads its round
   * fresh anyway).
   */
  async tick(): Promise<void> {
    this.ticking = true;
    try {
      const now = this.now();
      const due = this.rounds ? activeWindows(this.rounds.values(), now) : [];
      // Windows that never leave a gap (not the 60 s cadence) still get a refresh once a minute.
      const refreshDue = now - this.refreshTriedAt >= (due.length > 0 ? 4 * REFRESH_MS : REFRESH_MS);
      await Promise.all([due.length > 0 ? this.sample(due) : undefined, refreshDue ? this.refresh(now) : undefined]);
      if (now - this.prunedAt >= PRUNE_EVERY_MS) this.prune(now);
    } finally {
      try {
        await this.schedule();
      } finally {
        this.ticking = false;
      }
    }
  }

  /** Re-arms the loop when no alarm is pending (first start, or an alarm dropped after retries). */
  async ping(): Promise<Result> {
    await this.ensureLoop();
    return { status: 200, body: { ok: true } };
  }

  private async ensureLoop(): Promise<void> {
    if (this.ticking) return;
    const at = await this.alarms.getAlarm();
    const now = this.now();
    if (at !== null && at >= now - STALE_ALARM_MS) return;
    this.plannedAt = now;
    await this.alarms.setAlarm(now);
  }

  /**
   * Inside a window: a second after the last planned tick. Otherwise the next window's start or the
   * next refresh, whichever is first, but not before the sampling of the current window is over
   * (a tick inside a window reads instead of refreshing).
   */
  private async schedule(): Promise<void> {
    const now = this.now();
    const rounds = this.rounds ? [...this.rounds.values()] : [];
    let next = Math.max(this.plannedAt + TICK_MS, now + MIN_ALARM_GAP_MS);
    if (activeWindows(rounds, next).length === 0) {
      const samplingEnds = activeWindows(rounds, now).map((w) => w.endMs + SAMPLE_MARGIN_MS);
      next = Math.min(nextSamplingStart(rounds, now) ?? Number.POSITIVE_INFINITY, this.refreshTriedAt + REFRESH_MS);
      next = Math.max(next, now + MIN_ALARM_GAP_MS, ...samplingEnds);
    }
    this.plannedAt = next;
    await this.alarms.setAlarm(next);
  }

  private async refresh(now: number): Promise<void> {
    this.refreshTriedAt = now;
    try {
      let snap = await this.readDevnet(this.nextRoundId);
      const next = snap.config?.nextRoundId;
      if (next === undefined) throw new Error('the Config account is missing on devnet');
      // One round created since the last refresh is already in the window read; more, or a first
      // read without a hint, need a second read around the new next_round_id.
      const hint = this.nextRoundId;
      if (hint === null || next < hint || next > hint + 1n) snap = await this.readDevnet(next);
      this.nextRoundId = snap.config?.nextRoundId ?? next;
      this.rounds = snap.rounds;
      this.oracle = snap.oracle;
      this.refreshedAt = now;
      // Pool vaults are read once per pool, ahead of its first window.
      const pools = new Set(pendingWindows(snap.rounds.values()).filter((w) => w.endMs + SAMPLE_MARGIN_MS > now).map((w) => w.pool));
      if (this.poolRefs.size > 64) this.poolRefs.clear();
      await Promise.all([...pools].map((pool) => this.poolRef(pool).then(() => undefined, (error) => this.note('mainnet', error))));
    } catch (error) {
      this.note('devnet', error);
    }
  }

  /** The Config and OracleConfig PDAs, derived once. */
  private programPdas(): Promise<ProgramPdas> {
    this.pdas ??= Promise.all([configAddress(), oracleAddress()]).then(([config, oracle]) => ({ config, oracle }));
    return this.pdas;
  }

  private async roundPda(id: bigint): Promise<Address> {
    let found = this.roundPdas.get(id);
    if (!found) {
      found = await roundAddress(id);
      if (this.roundPdas.size > 256) this.roundPdas.clear();
      this.roundPdas.set(id, found);
    }
    return found;
  }

  /** Config, OracleConfig and the rounds hint - ROUNDS_BACK .. hint, in one getMultipleAccounts. */
  private async readDevnet(hint: bigint | null): Promise<Snapshot> {
    const ids: bigint[] = [];
    if (hint !== null) for (let id = hint > ROUNDS_BACK ? hint - ROUNDS_BACK : 0n; id <= hint; id++) ids.push(id);
    const { config, oracle } = await this.programPdas();
    const keys = [config, oracle, ...(await Promise.all(ids.map((id) => this.roundPda(id))))];
    const { value } = await this.devnet.call('getMultipleAccounts', (rpc) =>
      rpc.getMultipleAccounts(keys, { encoding: 'base64', commitment: 'confirmed' }).send(),
    );
    const data = value.map((account) => programData(account as Base64Account));
    const [configData, oracleData] = data;
    const rounds = new Map<bigint, RoundAccount>();
    ids.forEach((id, i) => {
      const bytes = data[2 + i];
      if (!bytes || !isAccount('Round', bytes)) return;
      const round = decodeRound(bytes);
      if (round.id === id) rounds.set(id, round);
    });
    return {
      config: configData && isAccount('Config', configData) ? decodeConfig(configData) : null,
      oracle: oracleData && isAccount('OracleConfig', oracleData) ? decodeOracleConfig(oracleData) : null,
      rounds,
    };
  }

  /** The pool's vaults, read once from mainnet (PumpSwap pools never move them). */
  private poolRef(pool: string): Promise<PoolRef> {
    let ref = this.poolRefs.get(pool);
    if (!ref) {
      ref = this.mainnet.call('loadPool', (rpc) => loadPool(rpc, pool as Address));
      this.poolRefs.set(pool, ref);
      ref.catch(() => this.poolRefs.delete(pool));
    }
    return ref;
  }

  /** One read per pool of the open windows; each stored row names the rounds it served. */
  private async sample(due: RoundWindow[]): Promise<void> {
    const pools = [...new Set(due.map((w) => w.pool))];
    await Promise.all(
      pools.map(async (pool) => {
        try {
          const ref = await this.poolRef(pool);
          const read = await this.mainnet.call('observePrice', (rpc) => observePrice(rpc, ref, this.now));
          if (read.price <= 0n) return; // a drained quote side; the keeper drops these too
          const served = (kind: WindowKind) => {
            const w = due.find((d) => d.pool === pool && d.kind === kind);
            return w ? Number(w.roundId) : null;
          };
          this.sql.exec(
            'INSERT OR IGNORE INTO samples (pool, at_ms, slot, price, strike_round, exit_round) VALUES (?, ?, ?, ?, ?, ?)',
            pool,
            read.atMs,
            Number(read.slot),
            read.price.toString(),
            served('strike'),
            served('exit'),
          );
          if (!this.lastSample || read.atMs >= this.lastSample.atMs) this.lastSample = { atMs: read.atMs, slot: read.slot };
        } catch (error) {
          this.note('mainnet', error);
        }
      }),
    );
  }

  private prune(now: number): void {
    this.sql.exec('DELETE FROM samples WHERE at_ms < ?', now - RETAIN_MS);
    this.prunedAt = now;
  }

  /** Remembers the last error per source for the health report; logs at most once a minute each. */
  private note(source: string, error: unknown): void {
    const now = this.now();
    const text = describe(error);
    this.errors[source] = { at: iso(now), error: text };
    if (now - (this.loggedAt.get(source) ?? 0) >= LOG_EVERY_MS) {
      this.loggedAt.set(source, now);
      this.log({ event: `${source}_error`, error: text });
    }
  }

  // ---- co-signing -----------------------------------------------------------------------------

  private key(): Promise<AttestorKey> {
    this.keyPromise ??= loadAttestorKey(this.env.ATTESTOR_SECRET);
    return this.keyPromise;
  }

  /** Every read of the window's pool from SAMPLE_MARGIN_MS before the window to as long after it. */
  private ownSamples(window: RoundWindow): Observation[] {
    const rows = this.sql
      .exec(
        'SELECT at_ms, slot, price FROM samples WHERE pool = ? AND at_ms >= ? AND at_ms < ? ORDER BY at_ms',
        window.pool,
        window.startMs - SAMPLE_MARGIN_MS,
        window.endMs + SAMPLE_MARGIN_MS,
      )
      .toArray() as SampleRow[];
    return rows.map((r) => ({ atMs: r.at_ms, slot: BigInt(r.slot), price: BigInt(r.price) }));
  }

  /** The round the instruction prices (account ROUND_ACCOUNT_INDEX), read from devnet now, at its PDA. */
  private async findRound(request: AttestRequest): Promise<RoundAccount> {
    const address = request.accounts[ROUND_ACCOUNT_INDEX] as Address;
    let accounts: readonly unknown[];
    try {
      ({ value: accounts } = await this.devnet.call('getMultipleAccounts', (rpc) =>
        rpc.getMultipleAccounts([address], { encoding: 'base64', commitment: 'confirmed' }).send(),
      ));
    } catch (error) {
      this.note('devnet', error);
      throw new DevnetUnavailable();
    }
    const bytes = programData(accounts[0] as Base64Account);
    let round: RoundAccount | null = null;
    try {
      if (bytes && isAccount('Round', bytes)) round = decodeRound(bytes);
    } catch {
      // too short to be a Round
    }
    if (!round) throw new Refusal('round_not_found', `account ${ROUND_ACCOUNT_INDEX} (${address}) is not a Round of the program on devnet`);
    if (address !== (await this.roundPda(round.id))) {
      throw new Refusal('round_not_found', `account ${address} holds round ${round.id} but is not its PDA`);
    }
    return round;
  }

  /** Keeps the call for the health report. */
  private record(entry: Omit<AttestRecord, 'at'>): void {
    this.totals.attests++;
    if (entry.result === 'signed') this.totals.signed++;
    if (entry.sharedSlots !== null) {
      this.totals.compared++;
      this.totals.keeperSamples += entry.keeperSamples ?? 0;
      this.totals.sharedSlots += entry.sharedSlots;
    }
    this.recent.push({ at: iso(this.now()), ...entry });
    if (this.recent.length > RECENT_ATTESTS) this.recent.shift();
  }

  /**
   * POST /v1/attest: the base64 wire transaction in, a signature or a refusal out. Every call
   * leaves one "attest" log line and one health record; `sharedSlots` (keeper samples at a slot the
   * attestor read too) is null when no comparison ran. Refusal details such as the prices at a
   * mismatched slot go to the log line only.
   */
  async attest(tx: string): Promise<Result> {
    await this.ensureLoop().catch((error) => this.note('alarm', error));
    let request: AttestRequest | null = null;
    let round: RoundAccount | null = null;
    const finish = (result: Result, outcome: string, fields: LogFields = {}, sharedSlots: number | null = null): Result => {
      const keeperSamples = request ? request.samples.length : null;
      const instruction = request ? request.instruction : null;
      this.record({ round: round ? round.id.toString() : null, instruction, result: outcome, keeperSamples, sharedSlots });
      this.log({ event: 'attest', signed: result.status === 200, result: outcome, round: round?.id ?? null, instruction, keeperSamples, sharedSlots, ...fields });
      return result;
    };

    if ('error' in this.tolerance) return finish(failure(503, 'not_configured', this.tolerance.error), 'not_configured');
    let key: AttestorKey;
    try {
      key = await this.key();
    } catch (error) {
      return finish(failure(503, 'not_configured', describe(error)), 'not_configured');
    }
    const wire = decodeBase64(tx);
    if (!wire) return finish(failure(400, 'bad_request', 'tx must be a base64 wire transaction'), 'bad_request');

    try {
      request = parseAttestRequest(wire, key.address, await this.programPdas());
      round = await this.findRound(request);
      checkRound(request.instruction, round, this.now());
      const { messageBytes } = request;
      const signed = async (): Promise<Result> => ({ status: 200, body: { signature: base58.decode(await key.sign(messageBytes)), attestor: key.address } });
      if (request.instruction === 'set_strike' && request.samples.length === 0 && !isActivated(round.rawUp, round.rawDown, round.minBank)) {
        // No matched bank: the program ends the round as NotActivated and returns every stake
        // without reading the samples or the attestor; co-signing it fixes no price.
        return finish(await signed(), 'signed', { verdict: 'not_activated', feePayer: request.feePayer });
      }
      const window = windowOf(round, request.instruction === 'set_strike' ? 'strike' : 'exit');
      const agreement = compareSamples(request.samples, this.ownSamples(window), window, this.tolerance.bps);
      const verdict = {
        verdict: 'agree',
        keeperMean: agreement.keeperMean,
        ownMean: agreement.ownMean,
        diffBps: agreement.diffBps,
        ownSamples: agreement.ownSamples,
        feePayer: request.feePayer,
      };
      return finish(await signed(), 'signed', verdict, agreement.sharedSlots);
    } catch (error) {
      if (error instanceof Refusal) {
        const { sharedSlots, ...detail } = error.detail;
        const shared = typeof sharedSlots === 'number' ? sharedSlots : null;
        return finish(failure(422, error.reason, error.message), error.reason, { error: error.message, ...detail }, shared);
      }
      if (error instanceof DevnetUnavailable) {
        return finish(failure(503, 'devnet_unavailable', 'devnet could not be read, so the round cannot be checked; try again'), 'devnet_unavailable');
      }
      return finish(failure(500, 'internal', 'the attestor failed on this request'), 'internal', { error: describe(error) });
    }
  }

  // ---- health ---------------------------------------------------------------------------------

  private windowHealth(w: RoundWindow) {
    const row = this.sql
      .exec('SELECT COUNT(*) AS n, MIN(slot) AS lo, MAX(slot) AS hi FROM samples WHERE pool = ? AND at_ms >= ? AND at_ms < ?', w.pool, w.startMs, w.endMs)
      .toArray()[0] as { n: number; lo: number | null; hi: number | null };
    return { start: iso(w.startMs), end: iso(w.endMs), samples: row.n, slots: row.n > 0 ? [String(row.lo), String(row.hi)] : null };
  }

  /** GET /v1/attestor: the key, the sampler's state and the on-chain OracleConfig. */
  async health(): Promise<Result> {
    await this.ensureLoop().catch((error) => this.note('alarm', error));
    let attestor: Address | null = null;
    let keyError: string | null = null;
    try {
      attestor = (await this.key()).address;
    } catch (error) {
      keyError = describe(error);
    }
    const configError = 'error' in this.tolerance ? this.tolerance.error : null;
    const totals = this.sql
      .exec('SELECT COUNT(*) AS samples, COUNT(DISTINCT strike_round) AS strikes, COUNT(DISTINCT exit_round) AS exits, MAX(at_ms) AS last FROM samples')
      .toArray()[0] as { samples: number; strikes: number; exits: number; last: number | null };
    const rounds = [...(this.rounds?.values() ?? [])]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((r) => ({
        id: r.id.toString(),
        status: statusName(r.status),
        pool: r.pool,
        strike: this.windowHealth(windowOf(r, 'strike')),
        exit: this.windowHealth(windowOf(r, 'exit')),
      }));
    const body: Record<string, unknown> = {
      attestor,
      ...(keyError ? { keyError } : {}),
      ...(configError ? { configError } : {}),
      toleranceBps: 'bps' in this.tolerance ? this.tolerance.bps : null,
      sampler: {
        lastSampleAt: iso(this.lastSample?.atMs ?? totals.last),
        lastSampleSlot: this.lastSample ? this.lastSample.slot.toString() : null,
        lastRefreshAt: iso(this.refreshedAt),
        nextAlarmAt: iso(await this.alarms.getAlarm()),
        nextRoundId: this.nextRoundId === null ? null : this.nextRoundId.toString(),
        /** Strike and exit windows with at least one stored read (the last RETAIN_MS). */
        windowsObserved: totals.strikes + totals.exits,
        samplesStored: totals.samples,
        rounds,
        errors: this.errors,
        devnet: this.devnet.names,
        mainnet: this.mainnet.names,
      },
      // Since the object started (a deploy or an eviction restarts it). `coverage`: the share of
      // compared keeper samples that sat at a slot the attestor read too, checked to the unit.
      attests: {
        since: iso(this.startedAt),
        ...this.totals,
        coverage: this.totals.keeperSamples > 0 ? Math.round((this.totals.sharedSlots / this.totals.keeperSamples) * 100) / 100 : null,
        recent: [...this.recent],
      },
      oracle: this.oracle
        ? { attestor: this.oracle.attestor, required: this.oracle.required, matchesKey: attestor === null ? null : this.oracle.attestor === attestor }
        : null,
    };
    return { status: keyError || configError ? 503 : 200, body };
  }
}
