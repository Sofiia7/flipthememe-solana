/**
 * Creates or updates HouseLimits, the on-chain ceiling of the house (October 2026 upgrade): the
 * most the house may put into one round and into rounds per UTC day. Idempotent: creates the
 * account when it is missing, updates it when a cap differs, otherwise does nothing.
 *
 *   node services/keeper/scripts/init-house-limits.ts [--round-cap <lamports>] [--daily-cap <lamports>] [--dry-run]
 *
 * Defaults are the keeper's own defaults: 50000000 (0.05 SOL) per round, 2000000000 (2 SOL) per
 * UTC day. Zero stops house fills. Env: DEVNET_RPC, KEEPER_KEYPAIR (the admin key; see src/config.ts).
 */
import { configAddress, decodeConfig, decodeHouseLimits, houseLimitsAddress, initHouseLimits, updateHouseLimits } from '@flipthememe/client';
import { describeError, readAccount, sendInstructions } from '../src/chain.ts';
import { DEFAULT_HOUSE_DAILY_BUDGET, DEFAULT_HOUSE_ROUND_CAP, loadConfig } from '../src/config.ts';
import { loadKeypairSigner } from '../src/keypair.ts';
import { hostOf } from '../src/log.ts';
import { lamportsArg, planHouseLimits } from '../src/plans.ts';
import { makeRpc } from '../src/rpc.ts';

const sol = (lamports: bigint): string => `${lamports / 1_000_000_000n}.${(lamports % 1_000_000_000n).toString().padStart(9, '0')} SOL`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const want = {
    roundCap: lamportsArg(argv, '--round-cap', DEFAULT_HOUSE_ROUND_CAP),
    dailyCap: lamportsArg(argv, '--daily-cap', DEFAULT_HOUSE_DAILY_BUDGET),
  };
  const cfg = loadConfig();
  const signer = await loadKeypairSigner(cfg.keypairPath);
  const rpc = makeRpc(cfg.devnetRpc, 20_000);
  console.log(`devnet RPC ${hostOf(cfg.devnetRpc)}, admin ${signer.address}${dryRun ? ' (dry run)' : ''}`);

  const config = await readAccount(rpc, await configAddress(), decodeConfig);
  if (!config) throw new Error('Config does not exist on this cluster');
  if (config.admin !== signer.address) throw new Error(`the admin is ${config.admin}, not ${signer.address}`);
  const key = await houseLimitsAddress();
  const current = await readAccount(rpc, key, decodeHouseLimits);
  if (current) {
    console.log(`house limits ${key}: round cap ${sol(current.roundCap)}, daily cap ${sol(current.dailyCap)}, spent ${sol(current.spent)} on UTC day ${current.day}`);
  } else {
    console.log(`house limits ${key} do not exist yet`);
  }
  const action = planHouseLimits(current, want);
  console.log(`wanted: round cap ${sol(want.roundCap)}, daily cap ${sol(want.dailyCap)} -> ${action}`);
  if (action === 'none' || dryRun) return;
  const ix = action === 'init' ? await initHouseLimits({ admin: signer, ...want }) : await updateHouseLimits({ admin: signer, ...want });
  console.log(`${action === 'init' ? 'initialized' : 'updated'}: ${await sendInstructions(rpc, signer, [ix])}`);
}

main().catch((error: unknown) => {
  console.error(`init-house-limits failed: ${describeError(error)}`);
  process.exit(1);
});
