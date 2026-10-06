/**
 * Moves the house and price roles off the keeper key. A dry run unless --execute: it prints the
 * plan with every amount. HOUSE_KEYPAIR becomes the house authority with a vault of its own,
 * PRICE_KEYPAIR the price authority, TREASURY (an address, no key) the treasury; an unset one keeps
 * the role where it is. The keeper key stays admin and fee payer. One transaction, so it lands
 * whole or not at all (src/plans.ts, planRoleSplit):
 *   withdraw    the free house money from the keeper's house vault       (keeper key signs)
 *   transfer    it, the new vault's rent and a position-rent reserve      (keeper key signs)
 *   open_vault  and deposit for the new house key                         (house key signs)
 *   update_config with the new price authority, house authority and treasury, all else unchanged
 *
 *   node services/keeper/scripts/split-roles.ts [--amount <lamports>] [--house-rent-reserve <lamports>] [--execute]
 *
 * Run it while betting is paused and no round is in flight, then start the keeper with the same
 * PRICE_KEYPAIR and HOUSE_KEYPAIR; without them it skips strikes and fills (keeper_not_*_authority).
 * Env: DEVNET_RPC, KEEPER_KEYPAIR, PRICE_KEYPAIR, HOUSE_KEYPAIR, TREASURY (see src/config.ts).
 */
import {
  configAddress,
  decodeConfig,
  decodeVault,
  deposit,
  openVault,
  transferSol,
  updateConfig,
  vaultAddress,
  withdraw,
} from '@flipthememe/client';
import type { Instruction } from '@solana/kit';
import { VAULT_ACCOUNT_SIZE, describeError, readAccount, sendInstructions } from '../src/chain.ts';
import { loadConfig } from '../src/config.ts';
import { loadRoleSigners } from '../src/keypair.ts';
import { hostOf } from '../src/log.ts';
import { argValue, lamportsArg, planRoleSplit, type SplitStep } from '../src/plans.ts';
import { makeRpc } from '../src/rpc.ts';

/** About 200 house positions at 0.00116 SOL each: the keeper closes them a day after their round. */
const DEFAULT_RENT_RESERVE = 250_000_000n;
const FEE_RESERVE = 50_000_000n;

const sol = (lamports: bigint): string => `${lamports / 1_000_000_000n}.${(lamports % 1_000_000_000n).toString().padStart(9, '0')} SOL`;

function describe(step: SplitStep): string {
  switch (step.kind) {
    case 'withdraw':
      return `withdraw ${sol(step.lamports)} from the house vault of ${step.vaultOwner} to that wallet`;
    case 'transfer':
      return `transfer ${sol(step.lamports)} from ${step.from} to ${step.to} (deposit ${sol(step.deposit)} + vault rent ${sol(step.vaultRent)} + position-rent reserve ${sol(step.rentTopUp)})`;
    case 'open-vault':
      return `open_vault for ${step.owner} (rent ${sol(step.rent)}, paid by ${step.owner})`;
    case 'deposit':
      return `deposit ${sol(step.lamports)} into the vault of ${step.owner}`;
    case 'update-config':
      return `update_config: price_authority ${step.priceAuthority}, house_authority ${step.houseAuthority}, treasury ${step.treasury} (all other values unchanged)`;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const cfg = loadConfig();
  const roles = await loadRoleSigners(cfg);
  const keeper = roles.keeper;
  const rpc = makeRpc(cfg.devnetRpc, 20_000);
  console.log(`devnet RPC ${hostOf(cfg.devnetRpc)}, keeper ${keeper.address}${execute ? '' : ' (dry run)'}`);

  const config = await readAccount(rpc, await configAddress(), decodeConfig);
  if (!config) throw new Error('Config does not exist on this cluster');
  const house = roles.house.address;
  const treasury = cfg.treasury ?? config.treasury;
  const [keeperLamports, newHouseLamports, oldVault, newVault, vaultRent] = await Promise.all([
    rpc.getBalance(keeper.address, { commitment: 'confirmed' }).send().then((r) => r.value),
    rpc.getBalance(house, { commitment: 'confirmed' }).send().then((r) => r.value),
    vaultAddress(config.houseAuthority).then((v) => readAccount(rpc, v, decodeVault)),
    vaultAddress(house).then((v) => readAccount(rpc, v, decodeVault)),
    rpc.getMinimumBalanceForRentExemption(BigInt(VAULT_ACCOUNT_SIZE)).send(),
  ]);
  console.log(`now:  price_authority ${config.priceAuthority}, house_authority ${config.houseAuthority}, treasury ${config.treasury}`);
  console.log(`want: price_authority ${roles.price.address}, house_authority ${house}, treasury ${treasury}`);
  console.log(`keeper wallet ${sol(keeperLamports)}; old house vault ${oldVault ? `available ${sol(oldVault.available)}, locked ${sol(oldVault.locked)}` : 'missing'}`);

  const plan = planRoleSplit({
    config,
    keeper: keeper.address,
    keeperLamports,
    price: roles.price.address,
    house,
    treasury,
    oldVault,
    newVault,
    newHouseLamports,
    amount: argValue(argv, '--amount') === null ? null : lamportsArg(argv, '--amount', 0n),
    vaultRent,
    rentReserve: lamportsArg(argv, '--house-rent-reserve', DEFAULT_RENT_RESERVE),
    feeReserve: FEE_RESERVE,
  });
  for (const warning of plan.warnings) console.log(`  WARNING: ${warning}`);
  if (plan.steps.length > 0) console.log(`plan (one transaction, fee payer ${keeper.address}):`);
  plan.steps.forEach((step, i) => console.log(`  ${i + 1}. ${describe(step)}`));
  if (plan.errors.length > 0) throw new Error(plan.errors.join('; '));
  if (plan.steps.length === 0) return;
  if (!execute) {
    console.log('dry run: nothing was sent; add --execute to send exactly this plan');
    return;
  }

  const ixs: Instruction[] = [];
  for (const step of plan.steps) {
    if (step.kind === 'withdraw') ixs.push(await withdraw({ owner: keeper, amount: step.lamports }));
    if (step.kind === 'transfer') ixs.push(transferSol({ from: keeper, to: step.to, lamports: step.lamports }));
    if (step.kind === 'open-vault') ixs.push(await openVault({ owner: roles.house }));
    if (step.kind === 'deposit') ixs.push(await deposit({ owner: roles.house, amount: step.lamports }));
    if (step.kind === 'update-config') {
      const { priceAuthority, houseAuthority, treasury: newTreasury } = step;
      const { minStake, maxStake, minBank, feeWinBps, feeRefundBps } = config;
      ixs.push(await updateConfig({ admin: keeper, params: { priceAuthority, houseAuthority, treasury: newTreasury, minStake, maxStake, minBank, feeWinBps, feeRefundBps } }));
    }
  }
  console.log(`sent: ${await sendInstructions(rpc, keeper, ixs)}`);
}

main().catch((error: unknown) => {
  console.error(`split-roles failed: ${describeError(error)}`);
  process.exit(1);
});
