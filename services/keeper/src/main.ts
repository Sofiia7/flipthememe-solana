/**
 * FlipTheMeme keeper (devnet). One process, no HTTP server:
 * - pool selection every 60 s (GeckoTerminal, at most 4 requests, + mainnet depth check),
 * - mainnet price sampling every 1 s,
 * - round scheduler every 1 s (create, house fill, strike, settle, claim, sweep, close, expire),
 * - devnet clock estimate every 60 s, scan for old unfinished rounds every 10 min,
 * - status.json next to STATE_FILE rewritten every tick.
 */
import { DEVNET_PARAMS } from '@flipthememe/client';
import type { Address } from '@solana/kit';
import { ChainClock, describeError } from './chain.ts';
import { loadConfig } from './config.ts';
import { PoolDiscovery } from './discovery.ts';
import { remainingBudget, rollover } from './house.ts';
import { loadKeypairSigner } from './keypair.ts';
import { hostOf, log, throttled } from './log.ts';
import { ObservationStore } from './observations.ts';
import { MINUTE_MS, RUNG_NAMES } from './poolgate.ts';
import { FailoverRpc, makeRpc, shortError } from './rpc.ts';
import { PoolRefs, Sampler } from './sampler.ts';
import { Scheduler } from './scheduler.ts';
import { PoolSelector, poolChain, type Selection } from './selector.ts';
import { StateStore, writeJsonAtomic } from './state.ts';

type Loop = { stop(): void; idle(): Promise<void> };

/**
 * Runs `fn` every `intervalMs`, aligned to the wall clock (plus `phaseMs`), never overlapping
 * itself. Errors are logged and the loop carries on.
 */
function every(name: string, intervalMs: number, phaseMs: number, fn: () => Promise<void>): Loop {
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
      .catch((error: unknown) => log({ event: 'loop_error', loop: name, error: shortError(error) }))
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
  const signer = await loadKeypairSigner(cfg.keypairPath);
  const startMs = Date.now();
  const state = new StateStore(cfg.stateFile, startMs);
  const devnet = makeRpc(cfg.devnetRpc, 15_000);
  const mainnet = new FailoverRpc(cfg.mainnetRpcs, log, { timeoutMs: 5_000 });
  const store = new ObservationStore();
  const refs = new PoolRefs(mainnet);
  const sampler = new Sampler({ refs, mainnet, store, logger: log });
  const clock = new ChainClock();

  log({
    event: 'start',
    keeper: signer.address,
    devnetRpc: hostOf(cfg.devnetRpc),
    mainnetRpcs: cfg.mainnetRpcs.map(hostOf),
    stateFile: cfg.stateFile,
    statusFile: cfg.statusFile,
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
      state.state.pool = { pool: s.pool, baseMint: s.baseMint, name: s.name, selectedAtMs: s.selectedAtMs, rung: s.rung, fallback: s.fallback };
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

  scheduler = new Scheduler({ rpc: devnet, signer, cfg, state, selector, store, clock, logger: log });
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

  const loops: Loop[] = [
    every('selector', 60_000, 5_000, () => selector.refresh(Date.now())),
    every('sampler', 1_000, 0, () => sampler.sample(samplePools())),
    every('scheduler', 1_000, 300, async () => {
      try {
        await sched.tick(Date.now());
      } finally {
        writeStatus();
      }
    }),
    every('clock', 60_000, 30_000, async () => {
      await clock.refresh(devnet);
    }),
    every('backlog', 10 * 60_000, 15_000, () => sched.scanBacklog()),
  ];

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log({ event: 'stopping', signal });
    for (const loop of loops) loop.stop();
    await Promise.allSettled(loops.map((l) => l.idle()));
    await sched.drain(30_000);
    try {
      state.save();
      writeStatus();
    } catch (error) {
      log({ event: 'final_write_failed', error: shortError(error) });
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
