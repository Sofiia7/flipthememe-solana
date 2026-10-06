/**
 * FlipTheMeme keeper (devnet). One process, no HTTP server:
 * - pool selection every 60 s (GeckoTerminal, at most 4 requests, + mainnet depth check),
 * - mainnet price sampling every 1 s,
 * - round scheduler every 1 s (create, house fill, strike, settle, claim, sweep, close, expire),
 *   with the attestor co-signing prices when ATTEST_URL is set, and on quiet ticks the closing
 *   of paid positions (rent back to their owners),
 * - devnet clock estimate every 60 s, scan for old unfinished rounds every 10 min,
 * - status.json next to STATE_FILE rewritten every tick,
 * - observations.json next to it: the last 15 minutes of price observations, written at most
 *   every 5 s and on shutdown, loaded at start (a restart inside a price window keeps its samples),
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
import { loadRoleSigners } from './keypair.ts';
import { hostOf, log, throttled } from './log.ts';
import { ObservationPersister, ObservationStore } from './observations.ts';
import { MINUTE_MS, RUNG_NAMES } from './poolgate.ts';
import { FailoverRpc, makeRpc, shortError } from './rpc.ts';
import { PoolRefs, Sampler } from './sampler.ts';
import { Scheduler } from './scheduler.ts';
import { PoolSelector, poolChain, type Selection } from './selector.ts';
import { StateStore, writeJsonAtomic } from './state.ts';
import { LoopErrorLog, STALL_AFTER_MS, watchStall } from './supervise.ts';

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
  const devnet = makeRpc(cfg.devnetRpc, 15_000);
  const mainnet = new FailoverRpc(cfg.mainnetRpcs, log, { timeoutMs: 5_000 });
  const store = new ObservationStore();
  const persister = new ObservationPersister({ store, path: cfg.observationsFile, logger: log });
  const refs = new PoolRefs(mainnet);
  const sampler = new Sampler({ refs, mainnet, store, logger: log });
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
    houseRoundCap: cfg.houseRoundCap,
    houseDailyBudget: cfg.houseDailyBudget,
    poolOverride: cfg.poolOverride,
    poolGate: {
      ageMin: [cfg.poolGate.minAgeMs / MINUTE_MS, cfg.poolGate.maxAgeMs / MINUTE_MS],
      minTxM5: cfg.poolGate.minTxM5,
      holdMin: cfg.poolGate.holdMs / MINUTE_MS,
      switchRatio: cfg.poolGate.switchRatio,
      keepMinTxM5: cfg.poolGate.keepMinTxM5,
      keepMaxAgeMin: cfg.poolGate.keepMaxAgeMs / MINUTE_MS,
    },
  });

  // Before anything samples: what the last run saw in the last 15 minutes, if it is still usable.
  persister.restore(Date.now());

  let scheduler: Scheduler | null = null;
  const persisted = state.state.pool;
  const initial: Selection | null =
    persisted && !cfg.poolOverride
      ? { ...persisted, quoteReserve: 0n, reserveAtMs: 0 }
      : null;
  // Trending first (one call finds the hottest fresh pools); one new_pools page keeps the tracked list growing.
  const discovery = new PoolDiscovery({ gate: cfg.poolGate, logger: log, trending: true, newPoolsPages: 1 });
  const selector = new PoolSelector({
    source: discovery,
    chain: poolChain(refs, mainnet),
    gate: cfg.poolGate,
    logger: log,
    override: cfg.poolOverride,
    initial,
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

  scheduler = new Scheduler({
    rpc: devnet,
    signer,
    priceSigner: roles.price,
    houseSigner: roles.house,
    attestor,
    cfg,
    state,
    selector,
    store,
    clock,
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
      mainnetRpc: mainnet.lastHost,
    });
  };

  const samplePools = (): Address[] => {
    const pools = sched.activeRoundPools();
    if (selector.current) pools.push(selector.current.pool);
    return pools;
  };

  const errors = new LoopErrorLog(log);
  // The last scheduler tick that completed, with or without an error: a loop that keeps failing
  // is the error log's business, a loop that stopped completing is the watchdog's.
  let lastTickDoneMs = Date.now();
  const loops: Loop[] = [
    every('selector', 60_000, 5_000, errors, () => selector.refresh(Date.now())),
    every('sampler', 1_000, 0, errors, () => sampler.sample(samplePools())),
    every('scheduler', 1_000, 300, errors, async () => {
      try {
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
    // The persister writes at most every 5 s; looking once a second keeps that pace even when a timer fires early.
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
  log({ event: 'fatal', error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
