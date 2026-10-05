/**
 * Changes the fees of new rounds with update_config, keeping every other config value. Rounds
 * already created keep the fees they were created with.
 *
 *   node services/keeper/scripts/set-fees.ts --refund-bps 0 [--win-bps 200] [--dry-run]
 *
 * Env: DEVNET_RPC, KEEPER_KEYPAIR (the admin key; see src/config.ts).
 */
import { configAddress, decodeConfig, updateConfig } from '@flipthememe/client';
import { getBase64Encoder } from '@solana/kit';
import { sendInstructions } from '../src/chain.ts';
import { loadConfig } from '../src/config.ts';
import { loadKeypairSigner } from '../src/keypair.ts';
import { makeRpc } from '../src/rpc.ts';

function bpsArg(name: string): number | null {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const value = Number(process.argv[i + 1]);
  if (!Number.isInteger(value) || value < 0 || value > 1000) throw new Error(`${name} needs an integer 0..1000`);
  return value;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const refund = bpsArg('--refund-bps');
  const win = bpsArg('--win-bps');
  if (refund === null && win === null) throw new Error('nothing to change: pass --refund-bps and/or --win-bps');
  const cfg = loadConfig();
  const signer = await loadKeypairSigner(cfg.keypairPath);
  const rpc = makeRpc(cfg.devnetRpc, 20_000);
  const key = await configAddress();
  const acc = await rpc.getAccountInfo(key, { encoding: 'base64', commitment: 'confirmed' }).send();
  if (!acc.value) throw new Error(`config ${key} not found`);
  const c = decodeConfig(getBase64Encoder().encode(acc.value.data[0]) as Uint8Array);
  if (c.admin !== signer.address) throw new Error(`the admin is ${c.admin}, not ${signer.address}`);
  const params = {
    priceAuthority: c.priceAuthority,
    houseAuthority: c.houseAuthority,
    treasury: c.treasury,
    minStake: c.minStake,
    maxStake: c.maxStake,
    minBank: c.minBank,
    feeWinBps: win ?? c.feeWinBps,
    feeRefundBps: refund ?? c.feeRefundBps,
  };
  console.log(`fees ${c.feeWinBps}/${c.feeRefundBps} bps -> ${params.feeWinBps}/${params.feeRefundBps} bps${dryRun ? ' (dry run)' : ''}`);
  if (dryRun) return;
  const sig = await sendInstructions(rpc, signer, [await updateConfig({ admin: signer, params })]);
  console.log(`updated: ${sig}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
