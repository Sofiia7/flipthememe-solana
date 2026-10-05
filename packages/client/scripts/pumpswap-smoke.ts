/**
 * Live smoke run of the PumpSwap price source against mainnet (not part of the test suite):
 * discover pools on GeckoTerminal, take the first one that passes the gate, load it, observe the
 * price 5 times 1 s apart and print the SOL depth of the pool.
 *
 *   cd packages/client
 *   node scripts/pumpswap-smoke.ts
 *
 * SOLANA_RPC_URL overrides the RPC. By default the public mainnet RPC is used, with
 * solana-rpc.publicnode.com as the fallback.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { createSolanaRpc } from '@solana/kit';
import {
  discoverPumpSwapPools,
  loadPool,
  observePrice,
  passesGate,
  quoteReserveLamports,
  windowMean,
  type PoolCandidate,
  type PriceObservation,
} from '../src/pumpswap.ts';

const RPC_URLS = process.env.SOLANA_RPC_URL
  ? [process.env.SOLANA_RPC_URL]
  : ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'];
const OBSERVATIONS = 5;
const LAMPORTS_PER_SOL_DECIMALS = 9;
const MIN_QUOTE_RESERVE_LAMPORTS = 50n * 10n ** 9n; // design gate: 50 SOL of quote depth
// price = lamports per raw unit * 10^12; pump.fun tokens have 6 decimals, so SOL per token = price / 10^15
const PRICE_TO_SOL_PER_TOKEN_DECIMALS = 15;

/** Fixed-point bigint -> decimal string, no floating point. */
function decimal(value: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  return `${sign}${abs / unit}.${(abs % unit).toString().padStart(decimals, '0')}`;
}

function describeCandidate(c: PoolCandidate, nowMs: number): string {
  const ageH = ((nowMs - c.createdAtMs) / 3_600_000).toFixed(1);
  return `${c.name.padEnd(22)} ${c.pool}  tx5m=${String(c.txM5).padStart(4)}  age=${ageH.padStart(6)}h  reserve=$${Math.round(c.reserveUsd)}  vol1h=$${Math.round(c.volumeH1Usd)}`;
}

async function runOnChain(rpcUrl: string, candidate: PoolCandidate): Promise<void> {
  const rpc = createSolanaRpc(rpcUrl);
  console.log(`\nRPC ${rpcUrl}`);
  const ref = await loadPool(rpc, candidate.pool);
  console.log(`pool        ${ref.pool}`);
  console.log(`base mint   ${ref.baseMint}`);
  console.log(`quote mint  ${ref.quoteMint}`);
  console.log(`base vault  ${ref.baseVault}`);
  console.log(`quote vault ${ref.quoteVault}`);

  const observations: PriceObservation[] = [];
  for (let i = 0; i < OBSERVATIONS; i++) {
    if (i > 0) await sleep(1_000);
    const o = await observePrice(rpc, ref);
    observations.push(o);
    console.log(
      `#${i + 1} ${new Date(o.atMs).toISOString()} slot=${o.slot} base=${o.baseAmount} quote=${o.quoteAmount} price=${o.price} (~${decimal(o.price, PRICE_TO_SOL_PER_TOKEN_DECIMALS)} SOL/token)`,
    );
  }
  const first = observations[0];
  const last = observations[observations.length - 1];
  if (first && last) {
    const mean = windowMean(observations, first.atMs, last.atMs + 1);
    console.log(
      mean
        ? `window mean over ${mean.samples.length} distinct slots: ${mean.price}`
        : 'window mean: null (fewer than 5 distinct slots)',
    );
  }

  const reserve = await quoteReserveLamports(rpc, ref);
  console.log(
    `quote reserve ${decimal(reserve, LAMPORTS_PER_SOL_DECIMALS)} SOL (${reserve} lamports), depth gate 50 SOL: ${reserve >= MIN_QUOTE_RESERVE_LAMPORTS ? 'pass' : 'FAIL'}`,
  );
}

async function main(): Promise<void> {
  const nowMs = Date.now();
  const candidates = await discoverPumpSwapPools(fetch, nowMs);
  const passing = candidates.filter((c) => passesGate(c, nowMs));
  console.log(`GeckoTerminal: ${candidates.length} PumpSwap pools quoted in SOL, ${passing.length} pass the gate`);
  for (const c of candidates.slice(0, 10)) {
    console.log(`  ${passesGate(c, nowMs) ? 'PASS' : '    '} ${describeCandidate(c, nowMs)}`);
  }

  const picked = passing[0] ?? candidates[0];
  if (!picked) throw new Error('GeckoTerminal returned no usable PumpSwap pools');
  if (!passing[0]) console.log('no pool passes the gate, falling back to the most active one');
  console.log(`\npicked: ${describeCandidate(picked, nowMs)}`);

  let lastError: unknown;
  for (const url of RPC_URLS) {
    try {
      await runOnChain(url, picked);
      return;
    } catch (error) {
      lastError = error;
      console.log(`RPC ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw lastError;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
