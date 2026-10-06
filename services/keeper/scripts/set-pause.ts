/**
 * Pauses or resumes new bets with set_pause. Paused, the program refuses place_bet and the keeper
 * creates no rounds; settlement, refunds, claims, withdrawals and closing positions keep working.
 *
 *   node services/keeper/scripts/set-pause.ts on|off [--dry-run]
 *
 * Env: DEVNET_RPC, KEEPER_KEYPAIR (the admin key; see src/config.ts).
 */
import { configAddress, decodeConfig, setPause } from '@flipthememe/client';
import { describeError, readAccount, sendInstructions } from '../src/chain.ts';
import { loadConfig } from '../src/config.ts';
import { loadKeypairSigner } from '../src/keypair.ts';
import { makeRpc } from '../src/rpc.ts';

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'on' && mode !== 'off') throw new Error('usage: set-pause.ts on|off [--dry-run]');
  const paused = mode === 'on';
  const dryRun = process.argv.includes('--dry-run');
  const cfg = loadConfig();
  const signer = await loadKeypairSigner(cfg.keypairPath);
  const rpc = makeRpc(cfg.devnetRpc, 20_000);
  const config = await readAccount(rpc, await configAddress(), decodeConfig);
  if (!config) throw new Error('Config does not exist on this cluster');
  if (config.admin !== signer.address) throw new Error(`the admin is ${config.admin}, not ${signer.address}`);
  console.log(`paused ${config.paused} -> ${paused}${dryRun ? ' (dry run)' : ''}`);
  if (config.paused === paused || dryRun) return;
  console.log(`done: ${await sendInstructions(rpc, signer, [await setPause({ admin: signer, paused })])}`);
}

main().catch((error: unknown) => {
  console.error(`set-pause failed: ${describeError(error)}`);
  process.exit(1);
});
