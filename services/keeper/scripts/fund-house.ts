/**
 * Tops up the house vault from the keeper wallet, so a lone player keeps getting matched while the
 * arena is judged. A dry run unless --execute: it prints the plan with every amount. One transaction,
 * so it lands whole or not at all:
 *   transfer  <amount> from the keeper wallet to the house wallet   (keeper key signs, fee payer)
 *   deposit   <amount> into the house vault                         (house key signs)
 *
 *   node services/keeper/scripts/fund-house.ts --sol 3 [--execute]
 *   node services/keeper/scripts/fund-house.ts --amount <lamports> [--execute]
 *
 * The program's HouseLimits (per round and per UTC day) still cap how much the house can stake; this
 * only raises what is available inside those caps. Devnet test SOL only.
 * Env: DEVNET_RPC, KEEPER_KEYPAIR, HOUSE_KEYPAIR (see src/config.ts).
 */
import { configAddress, decodeConfig, decodeVault, deposit, transferSol, vaultAddress } from '@flipthememe/client';
import { describeError, readAccount, sendInstructions } from '../src/chain.ts';
import { loadConfig } from '../src/config.ts';
import { loadRoleSigners } from '../src/keypair.ts';
import { hostOf } from '../src/log.ts';
import { argValue, lamportsArg } from '../src/plans.ts';
import { makeRpc } from '../src/rpc.ts';

/** Left on the keeper wallet for fees and the program's own rent needs. */
const KEEPER_RESERVE = 1_000_000_000n;

const sol = (lamports: bigint): string => `${lamports / 1_000_000_000n}.${(lamports % 1_000_000_000n).toString().padStart(9, '0')} SOL`;

/** "3" or "3.35" SOL as lamports, without floating point. */
function solToLamports(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(text);
  if (!match) throw new Error(`--sol must be a plain decimal number of SOL, got "${text}"`);
  return BigInt(match[1]) * 1_000_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const solArg = argValue(argv, '--sol');
  const amount = solArg === null ? lamportsArg(argv, '--amount', 0n) : solToLamports(solArg);
  if (amount <= 0n) throw new Error('pass --sol <amount> or --amount <lamports>');

  const cfg = loadConfig();
  const roles = await loadRoleSigners(cfg);
  const { keeper, house } = roles;
  const rpc = makeRpc(cfg.devnetRpc, 20_000);
  console.log(`devnet RPC ${hostOf(cfg.devnetRpc)}, keeper ${keeper.address}, house ${house.address}${execute ? '' : ' (dry run)'}`);

  const config = await readAccount(rpc, await configAddress(), decodeConfig);
  if (!config) throw new Error('Config does not exist on this cluster');
  if (config.houseAuthority !== house.address) {
    throw new Error(`HOUSE_KEYPAIR ${house.address} is not the house authority ${config.houseAuthority}; a deposit would not reach the vault the program fills from`);
  }
  const [keeperLamports, vault] = await Promise.all([
    rpc.getBalance(keeper.address, { commitment: 'confirmed' }).send().then((r) => r.value),
    vaultAddress(house.address).then((v) => readAccount(rpc, v, decodeVault)),
  ]);
  if (!vault) throw new Error('the house vault does not exist yet; open it first');
  console.log(`keeper wallet ${sol(keeperLamports)}; house vault available ${sol(vault.available)}, locked ${sol(vault.locked)}`);
  if (keeperLamports < amount + KEEPER_RESERVE) {
    throw new Error(`the keeper wallet must keep ${sol(KEEPER_RESERVE)} for fees: it holds ${sol(keeperLamports)}, so at most ${sol(keeperLamports > KEEPER_RESERVE ? keeperLamports - KEEPER_RESERVE : 0n)} can move`);
  }

  console.log(`plan (one transaction, fee payer ${keeper.address}):`);
  console.log(`  1. transfer ${sol(amount)} from ${keeper.address} to ${house.address}`);
  console.log(`  2. deposit ${sol(amount)} into the house vault, which will then hold ${sol(vault.available + amount)} available`);
  if (!execute) {
    console.log('dry run: nothing was sent; add --execute to send exactly this plan');
    return;
  }
  const signature = await sendInstructions(rpc, keeper, [transferSol({ from: keeper, to: house.address, lamports: amount }), await deposit({ owner: house, amount })]);
  console.log(`sent: ${signature}`);
}

main().catch((error: unknown) => {
  console.error(`fund-house failed: ${describeError(error)}`);
  process.exit(1);
});
