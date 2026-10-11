import { shadowSamplingWindow } from './market-reserve.ts';
import { marketStatus } from './market-status.ts';
import { OracleHealth } from './oracle-health.ts';
/**
 * FlipTheMeme keeper (devnet). One process, no HTTP server:
 * - pool selection every 60 s (GeckoTerminal, at most 4 requests, + mainnet depth and token checks),
 * - mainnet price sampling on a fixed 1 s tick (a slow read never holds the next one back),
 * - shadow rounds: the outcome of the round that would open at every minute boundary, from the same
 *   observations (shadow.ts; shadow.jsonl and the aggregate in status.json),
 * - round scheduler every 1 s (create, house fill, strike, settle, claim, sweep, close, expire),
 *   with the attestor co-signing prices when ATTEST_URL is set, and on quiet ticks the closing
 *   of paid positions (rent back to their owners); a line per swept round goes to rounds.jsonl,
 * - devnet clock estimate every 60 s, scan for old unfinished rounds every 10 min,
 * - status.json next to STATE_FILE rewritten every tick,
 * - observations.json next to it: the last 15 minutes of price observations, written every 5 s from
 *   20 s before a price window until it ends, once a minute otherwise, and on shutdown, loaded at
 *   start (a restart inside a price window keeps its samples),
 * - a self-watchdog: no completed scheduler tick for 120 s = keeper_stalled and exit 1, so
 *   Docker (restart: unless-stopped) starts the keeper again.
 */
import { DEVNET_PARAMS } from '@flipthememe/client';
import type { Address } from '@solana/kit';
import { AttestorClient } from './attest.ts';
import { ChainClock, describeError } from './chain.ts';
import { loadConfig } from './config.ts';
import { PoolDiscovery } from './discovery.ts';
import { remainingBudget, rollover } from './house.ts';
import { JsonlFile } from './jsonl.ts';
import { loadRoleSigners } from './keypair.ts';
import { hostOf, log, throttled } from './log.ts';
import { ObservationPersister, ObservationStore } from './observations.ts';
import { MINUTE_MS, RUNG_NAMES } from './poolgate.ts';
import { FailoverRpc, makeDevnetRpc, shortError } from './rpc.ts';
import { RoundLog } from './roundlog.ts';
import { Leaderboard } from './leaderboard.ts';
import { dirname, join } from 'node:path';
import { PoolRefs, Sampler } from './sampler.ts';
import { Scheduler } from './scheduler.ts';
import { PoolSelector, poolChain, type Selection } from './selector.ts';
import { ShadowBook } from './shadow.ts';
import { StateStore, writeJsonAtomic } from './state.ts';
import { LoopErrorLog, STALL_AFTER_MS, watchStall } from './supervise.ts';
import { TokenChecker } from './tokencheck.ts';

type Loop = { stop(): void; idle(): Promise<void> };

/**
 * Runs `fn` every `intervalMs`, aligned to the wall clock (plus `phaseMs`), never overlapping
 * itself. An error is logged by `errors` (throttled: the first at once, then one line per 30 s,
 * then a recovery line) and the loop carries on.
 */
function every(name: string, intervalMs: number, phaseMs: number, errors: LoopErrorLog, fn: () => Promise<void>): Loop {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> = Promise.resolve();
  const schedule = () => {
    if (stopped) return;
    const now = Date.now();
    const delay = intervalMs - ((now - phaseMs) % intervalMs);
    timer = setTimeout(run, delay);
  };
  const run = () => {
    running = fn()
      .then(
        () => errors.success(name, Date.now()),
        (error: unknown) => errors.failure(name, shortError(error), Date.now()),
      )
      .finally(schedule);
  };
  run();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    idle: () => running,
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const roles = await loadRoleSigners(cfg);
  const signer = roles.keeper;
  const attestor = cfg.attestUrl ? new AttestorClient({ url: cfg.attestUrl, token: cfg.attestToken }) : null;
  const startMs = Date.now();
  const state = new StateStore(cfg.stateFile, startMs);
  const devnet = makeDevnetRpc([cfg.devnetRpc, ...(process.env.DEVNET_RPC_FALLBACKS?.split(',').map(u => u.trim()).filter(Boolean) ?? ['https://solana-devnet.api.onfinality.io/public', 'https://api.devnet.solana.com'])]);
  const mainnet = new FailoverRpc(cfg.mainnetRpcs, log, { timeoutMs: 5_000 });
  const store = new ObservationStore();
  const persister = new ObservationPersister({ store, path: cfg.observationsFile, logger: log });
  const refs = new PoolRefs(mainnet);
  const sampler = new Sampler({ refs, mainnet, store, logger: log });
  const shadow = new ShadowBook({ store, logger: log, file: new JsonlFile(cfg.shadowFile, cfg.shadowMaxLines) });
  const roundLog = new RoundLog({ file: new JsonlFile(cfg.roundsFile, cfg.roundsMaxLines), logger: log });
  const tokens = cfg.tokenCheck.enabled ? new TokenChecker({ mainnet, holderMaxPct: cfg.tokenCheck.holderMaxPct, ttlMs: cfg.tokenCheck.ttlMs }) : null;
  const clock = new ChainClock();

  log({
    event: 'start',
    keeper: signer.address,
    priceAuthority: roles.price.address,
    house: roles.house.address,
    attestUrl: cfg.attestUrl ? hostOf(cfg.attestUrl) : null,
    // Whether the shared secret is set; its value never reaches the log.
    attestToken: cfg.attestToken !== null,
    closeAfterSecs: cfg.closeAfterSecs,
    devnetRpc: hostOf(cfg.devnetRpc),
    mainnetRpcs: cfg.mainnetRpcs.map(hostOf),
    stateFile: cfg.stateFile,
    statusFile: cfg.statusFile,
    observationsFile: cfg.observationsFile,
    shadowFile: cfg.shadowFile,
    roundsFile: cfg.roundsFile,
    houseRoundCap: cfg.houseRoundCap,
    houseDailyBudget: cfg.houseDailyBudget,
    houseSwitchPauseSecs: cfg.houseSwitchPauseSecs,
    houseWalletDailyFills: cfg.houseWalletDailyFills,
    housePaceDivisor: cfg.housePaceDivisor,
    tokenCheck: cfg.tokenCheck.enabled ? { holderMaxPct: cfg.tokenCheck.holderMaxPct, ttlMin: cfg.tokenCheck.ttlMs / MINUTE_MS } : false,
    poolOverride: cfg.poolOverride,
    poolGate: {
      ageMin: [cfg.poolGate.minAgeMs / MINUTE_MS, cfg.poolGate.maxAgeMs / MINUTE_MS],
      minTxM5: cfg.poolGate.minTxM5,
      holdMin: cfg.poolGate.holdMs / MINUTE_MS,
      switchRatio: cfg.poolGate.switchRatio,
      keepMinTxM5: cfg.poolGate.keepMinTxM5,
      keepMaxAgeMin: cfg.poolGate.keepMaxAgeMs / MINUTE_MS,
      maxImbalance: cfg.poolGate.maxImbalance,
      youthWeight: cfg.poolGate.youthWeight,
      neutral: cfg.poolGate.neutral,
    },
  });

  // Before anything samples: what the last run saw in the last 15 minutes, if it is still usable.
  persister.restore(Date.now());
  shadow.restore(Date.now());

  let scheduler: Scheduler | null = null;
  const persisted = state.state.pool;
  const initial: Selection | null =
    persisted && !cfg.poolOverride
      ? { ...persisted, quoteReserve: 0n, reserveAtMs: 0 }
      : null;
  // Discover by activity and new listings; trending never seeds production selection.
  let selector: PoolSelector;
  const discovery = new PoolDiscovery({ gate: cfg.poolGate, logger: log, trending: false, newPoolsPages: 1,
    topPages: cfg.poolGate.balanced ? [1, 2, 3, 4, 5] : undefined,
    isolateNewPools: !!cfg.poolGate.balanced,
    reservePools: () => selector?.watching.length ? selector.watching.map(p => p.pool) : shadow.observedPools(Date.now()),
  });
  selector = new PoolSelector({
    source: discovery,
    chain: poolChain(refs, mainnet, tokens),
    gate: cfg.poolGate,
    logger: log,
    override: cfg.poolOverride,
    initial,
    reservePrice: (pool, nowMs) => {
      const price = store.latest(pool);
      return price && nowMs - price.atMs <= 10_000 ? price.quoteAmount : null;
    },
    marketSample: (pool, nowMs) => shadow.market(pool, nowMs),
    marketBias: (pool, nowMs) => cfg.poolGate.neutral ? shadow.bias(pool, nowMs) : null,
    marketWarming: (pool, nowMs) => !!cfg.poolGate.neutral && shadow.readiness(pool, nowMs) !== null && shadow.bias(pool, nowMs) === null,
    minBank: () => scheduler?.snapshot?.config?.minBank ?? DEVNET_PARAMS.minBank,
    onChange: (s) => {
      state.state.pool = s ? { pool: s.pool, baseMint: s.baseMint, name: s.name, selectedAtMs: s.selectedAtMs, rung: s.rung, fallback: s.fallback } : null;
      state.save();
    },
  });
  if (initial) log({ event: 'pool_restored', pool: initial.pool, name: initial.name, rung: RUNG_NAMES[initial.rung] });

  try {
    await clock.refresh(devnet);
    log({ event: 'chain_clock', offsetMs: clock.offsetMs });
  } catch (error) {
    log({ event: 'chain_clock_failed', error: describeError(error), assumedOffsetMs: clock.offsetMs });
  }

  let leaderboard: Leaderboard | null = null;
  const oracleHealth = new OracleHealth(cfg.attestUrl);
  scheduler = new Scheduler({
    canClosePosition: position => leaderboard?.archived(position) ?? false,
    rpc: devnet,
    signer,
    priceSigner: roles.price,
    houseSigner: roles.house,
    attestor,
    marketReady: async (pool, nowMs) => {
      if (!cfg.legacyPrices && oracleHealth.refusal(nowMs)) await oracleHealth.check();
      return (!leaderboard ? 'History archive is unavailable; new rounds wait.' : null) ?? (!cfg.legacyPrices ? oracleHealth.refusal(Date.now()) : null) ?? (cfg.poolGate.neutral ? shadow.readiness(pool, Date.now()) : null);
    },
    cfg,
    state,
    selector,
    store,
    clock,
    roundLog,
    logger: log,
  });
  const sched = scheduler;

  const statusWriteFailed = throttled(log, 60_000);
  const writeStatus = () => {
    try {
      writeStatusFile();
    } catch (error) {
      statusWriteFailed('status', { event: 'status_write_failed', file: cfg.statusFile, error: shortError(error) });
    }
  };
  const writeStatusFile = () => {
    const now = Date.now();
    const pool = selector.current;
    const house = rollover(state.state.house, now);
    writeJsonAtomic(cfg.statusFile, {
      updatedAt: new Date(now).toISOString(),
      startedAt: new Date(startMs).toISOString(),
      keeper: signer.address,
      selectionPolicy: { neutral: cfg.poolGate.neutral, balancedReserve: cfg.poolGate.balanced, trending: false, youthWeight: cfg.poolGate.youthWeight, maxImbalance: cfg.poolGate.maxImbalance, maxPriceMoveM5: cfg.poolGate.maxPriceMoveM5, momentumMinMinutes: cfg.poolGate.neutral ? 10 : null, momentumMaxShare: cfg.poolGate.neutral ? 0.8 : null, warmupRequired: !!cfg.poolGate.neutral },
      priceProtocol: cfg.legacyPrices ? 'legacy-cosign' : 'detached-canonical',
      marketReadiness: pool && cfg.poolGate.neutral ? shadow.readiness(pool.pool, now) : null,
      marketReserve: selector.reserveStatus,
      observingPools: selector.watching.map(p => ({ pool: p.pool, readiness: shadow.readiness(p.pool, now) })),
      ...sched.status(),
      houseBudget: {
        day: house.day,
        spent: house.spent,
        budget: cfg.houseDailyBudget,
        remaining: remainingBudget(house, cfg.houseDailyBudget, now),
        roundCap: cfg.houseRoundCap,
      },
      pool: pool
        ? {
            pool: pool.pool,
            baseMint: pool.baseMint,
            name: pool.name,
            rung: RUNG_NAMES[pool.rung],
            fallback: pool.fallback,
            selectedAt: new Date(pool.selectedAtMs).toISOString(),
            quoteReserve: pool.quoteReserve,
          }
        : null,
      discovery: cfg.poolOverride ? null : discovery.status(now),
      sampler: sampler.freshness(now),
      // The share of UP over the last 200 minutes of rounds that would have opened every minute (shadow.ts).
      shadow: shadow.summary(now),
      mainnetRpc: mainnet.lastHost,
    });
  };

  const samplePools = (): Address[] => {
    const pools = sched.activeRoundPools();
    if (selector.current) pools.push(selector.current.pool);
    // A pool that was dropped after a shadow round was noted for it stays read until that round is evaluated.
    if (shadowSamplingWindow(Date.now())) pools.push(...selector.watching.map(p => p.pool), ...shadow.pendingPools());
    return pools;
  };
  const shadowPool = () => {
    const current = selector.current;
    return current ? { pool: current.pool, baseMint: current.baseMint, name: current.name, rung: RUNG_NAMES[current.rung] } : null;
  };

  const errors = new LoopErrorLog(log);
  try {
    leaderboard = new Leaderboard(join(dirname(cfg.stateFile), 'leaderboard.json'), devnet, signer);
  } catch (error) {
    // Preserve a broken ledger for recovery; an optional ranking must never stop settlement.
    log({ event: 'leaderboard_disabled', error: shortError(error) });
  }
  // The last scheduler tick that completed, with or without an error: a loop that keeps failing
  // is the error log's business, a loop that stopped completing is the watchdog's.
  let lastTickDoneMs = Date.now();
  const loops: Loop[] = [
    every('oracle-readiness', 5_000, 1_000, errors, () => oracleHealth.check()),
    every('market-status', 10_000, 12_000, errors, async () => {
      if (!cfg.legacyPrices && oracleHealth.refusal(Date.now())) await oracleHealth.check();
      const pool = selector.current;
      const oracleRefusal = !cfg.legacyPrices ? oracleHealth.refusal(Date.now()) : null;
      await leaderboard?.publish(shadow.summary(Date.now()), marketStatus(pool, oracleRefusal ?? (cfg.poolGate.neutral ? pool ? shadow.readiness(pool.pool, Date.now()) : selector.watching.map(p => shadow.bias(p.pool, Date.now())).find(Boolean) ?? null : null), (sched.snapshot?.config?.paused ?? false) || oracleRefusal !== null, selector.watching.length));
    }),
    every('leaderboard', 120_000, 45_000, errors, async () => { await leaderboard?.tick(shadow.summary(Date.now())); }),
    every('selector', 60_000, 5_000, errors, () => selector.refresh(Date.now())),
    // Starts the reads and returns: the 1 s tick does not wait for them (sampler.ts: two in flight per pool).
    every('sampler', 1_000, 0, errors, async () => sampler.tick(samplePools())),
    every('shadow', 1_000, 700, errors, async () => shadow.tick(Date.now(), shadowPool(), selector.watching)),
    every('scheduler', 1_000, 300, errors, async () => {
      try {
        selector.activateReserve(Date.now());
        await sched.tick(Date.now());
      } finally {
        writeStatus();
        lastTickDoneMs = Date.now();
      }
    }),
    every('clock', 60_000, 30_000, errors, async () => {
      await clock.refresh(devnet);
    }),
    every('backlog', 10 * 60_000, 15_000, errors, () => sched.scanBacklog()),
    // The persister decides the pace (5 s around the price windows, a minute otherwise); looking once a second is enough.
    every('observations', 1_000, 600, errors, async () => {
      persister.maybeSave(Date.now());
    }),
  ];

  const stopWatchdog = watchStall({
    lastBeatMs: () => lastTickDoneMs,
    onStall: (idleMs) => {
      log({ event: 'keeper_stalled', loop: 'scheduler', idleMs, limitMs: STALL_AFTER_MS, action: 'exit 1, the container restarts' });
      try {
        // The samplers still ran: keep what they saw, so the restart can price a window in progress.
        persister.saveNow(Date.now());
      } catch {
        // the restart matters more than the file
      }
      process.exit(1);
    },
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log({ event: 'stopping', signal });
    stopWatchdog();
    for (const loop of loops) loop.stop();
    await Promise.allSettled(loops.map((l) => l.idle()));
    await sched.drain(30_000);
    try {
      state.save();
      writeStatus();
    } catch (error) {
      log({ event: 'final_write_failed', error: shortError(error) });
    }
    try {
      persister.saveNow(Date.now());
    } catch (error) {
      log({ event: 'final_write_failed', file: cfg.observationsFile, error: shortError(error) });
    }
    log({ event: 'stopped' });
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => log({ event: 'unhandled_rejection', error: shortError(reason) }));

main().catch((error: unknown) => {
  log({ event: 'fatal', error: shortError(error) });
  process.exit(1);
});
