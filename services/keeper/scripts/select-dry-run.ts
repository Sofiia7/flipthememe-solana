/**
 * Read-only dry run of the pool selection on live data. It is not a keeper: no key, no devnet, no
 * state file. One discovery refresh with at most 2 GeckoTerminal requests (pools/multi for the
 * seeded pools, then page 1 of the PumpSwap top list), the mainnet depth checks, and the pool the
 * keeper would pick.
 *
 *   node services/keeper/scripts/select-dry-run.ts [saved new_pools page.json ...] [--save DIR]
 *
 * The keeper learns new pools from GeckoTerminal `new_pools` while they are a few minutes old, so a
 * fresh process knows none that are already 10+ minutes old. Saved `new_pools` pages (for example
 * packages/client/test/fixtures/geckoterminal-new-pools-page1.json) seed that set; without them
 * only the fallback ladder has candidates. `--save DIR` writes the raw GeckoTerminal answers there.
 * MAINNET_RPCS and the POOL_* variables are read as by the keeper.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEVNET_PARAMS, fetchNewPumpSwapPools, type GeckoTerminalFetch } from '@flipthememe/client';
import { DEFAULT_MAINNET_RPCS, loadPoolGate } from '../src/config.ts';
import { PoolDiscovery, type DiscoveryResult } from '../src/discovery.ts';
import { log } from '../src/log.ts';
import { MINUTE_MS, RUNG_NAMES, rankCandidates } from '../src/poolgate.ts';
import { FailoverRpc } from '../src/rpc.ts';
import { PoolRefs } from '../src/sampler.ts';
import { PoolSelector, poolChain } from '../src/selector.ts';

const MAX_REQUESTS = 2;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const saveAt = args.indexOf('--save');
  const saveDir = saveAt >= 0 ? args[saveAt + 1] : undefined;
  if (saveAt >= 0 && !saveDir) throw new Error('--save needs a directory');
  const seeds = args.filter((_, i) => saveAt < 0 || (i !== saveAt && i !== saveAt + 1));
  const gate = loadPoolGate(process.env);
  const nowMs = Date.now();

  let requests = 0;
  const live: GeckoTerminalFetch = async (url, init) => {
    requests++;
    if (requests > MAX_REQUESTS) throw new Error(`dry run: more than ${MAX_REQUESTS} GeckoTerminal requests`);
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const body: unknown = await res.json();
    console.log(`GeckoTerminal ${res.status} ${url.length > 140 ? `${url.slice(0, 140)}...` : url}`);
    if (saveDir) {
      mkdirSync(saveDir, { recursive: true });
      writeFileSync(join(saveDir, `${requests}-response.json`), `${JSON.stringify({ url, status: res.status, fetchedAt: new Date().toISOString(), body }, null, 2)}\n`);
    }
    return { ok: res.ok, status: res.status, json: async () => body };
  };
  const discovery = new PoolDiscovery({ gate, logger: log, fetchFn: live, maxCalls: MAX_REQUESTS, newPoolsPages: 0 });
  for (const file of seeds) {
    const body: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const page = await fetchNewPumpSwapPools(async () => ({ ok: true, status: 200, json: async () => body }), 1, nowMs);
    for (const c of page.pumpSwap) discovery.track(c, nowMs);
    console.log(`seed ${file}: ${page.rows} rows, PumpSwap: ${page.pumpSwap.map((c) => `${c.name} ${c.pool}`).join(', ') || 'none'}`);
  }

  let seen: DiscoveryResult = { candidates: [], complete: false };
  const mainnetRpcs = (process.env.MAINNET_RPCS?.split(',') ?? DEFAULT_MAINNET_RPCS).map((u) => u.trim()).filter((u) => u !== '');
  const mainnet = new FailoverRpc(mainnetRpcs, log, { timeoutMs: 5_000 });
  const selector = new PoolSelector({
    source: { refresh: async (now, current) => (seen = await discovery.refresh(now, current)) },
    chain: poolChain(new PoolRefs(mainnet), mainnet),
    gate,
    logger: log,
    override: null,
    minBank: () => DEVNET_PARAMS.minBank,
    initial: null,
    onChange: () => undefined,
  });
  await selector.refresh(nowMs);

  console.log(`\ncandidates (${seen.candidates.length}, discovery ${seen.complete ? 'complete' : 'incomplete'}), best first:`);
  for (const r of rankCandidates(seen.candidates, nowMs, gate).slice(0, 15)) {
    const c = r.candidate;
    const age = (nowMs - c.createdAtMs) / MINUTE_MS;
    console.log(
      `  ${RUNG_NAMES[r.rung].padEnd(10)} score ${r.score.toFixed(1).padStart(7)}  tx5m ${String(c.txM5).padStart(4)}  age ${age < 120 ? `${age.toFixed(0)} min` : `${(age / 60).toFixed(1)} h`}  $${Math.round(c.reserveUsd)}  ${c.name}  ${c.pool}`,
    );
  }
  const s = selector.current;
  console.log(
    s
      ? `\nchosen: ${s.name} ${s.pool} (mint ${s.baseMint}), rung ${RUNG_NAMES[s.rung]}, quote reserve ${Number(s.quoteReserve) / 1e9} SOL`
      : '\nchosen: none',
  );
  console.log(`GeckoTerminal requests: ${requests}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
