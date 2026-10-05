/**
 * One-time devnet setup after the program is deployed (idempotent: skips what exists):
 * 1. initialize_config with DEVNET_PARAMS; admin, price_authority, house_authority and treasury
 *    are all the keeper key;
 * 2. open the keeper's Vault (the house) and deposit HOUSE_DEPOSIT_LAMPORTS (default 2 SOL),
 *    only when the vault does not exist yet.
 *
 *   node services/keeper/scripts/init-config.ts [--dry-run]
 *
 * Env: DEVNET_RPC, KEEPER_KEYPAIR, HOUSE_DEPOSIT_LAMPORTS (see src/config.ts).
 */
import {
  DEVNET_PARAMS,
  PROGRAM_ID,
  configAddress,
  decodeConfig,
  decodeVault,
  deposit,
  initializeConfig,
  openVault,
  vaultAddress,
} from '@flipthememe/client';
import { getBase64Encoder } from '@solana/kit';
import { describeError, sendInstructions } from '../src/chain.ts';
import { DEFAULT_HOUSE_DEPOSIT, loadConfig, parseLamports } from '../src/config.ts';
import { loadKeypairSigner } from '../src/keypair.ts';
import { hostOf } from '../src/log.ts';
import { makeRpc } from '../src/rpc.ts';

const FEE_RESERVE = 50_000_000n; // keep 0.05 SOL in the keeper wallet for fees and rent

const sol = (lamports: bigint): string => {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, '0');
  return `${whole}.${frac} SOL`;
};

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const cfg = loadConfig();
  const depositAmount = parseLamports('HOUSE_DEPOSIT_LAMPORTS', process.env.HOUSE_DEPOSIT_LAMPORTS, DEFAULT_HOUSE_DEPOSIT);
  const signer = await loadKeypairSigner(cfg.keypairPath);
  const me = signer.address;
  const rpc = makeRpc(cfg.devnetRpc, 20_000);
  const b64 = getBase64Encoder();
  console.log(`devnet RPC ${hostOf(cfg.devnetRpc)}, program ${PROGRAM_ID}, keeper ${me}${dryRun ? ' (dry run)' : ''}`);

  const program = await rpc.getAccountInfo(PROGRAM_ID, { encoding: 'base64' }).send();
  if (!program.value?.executable) throw new Error(`program ${PROGRAM_ID} is not deployed on this cluster`);

  const balance = (await rpc.getBalance(me, { commitment: 'confirmed' }).send()).value;
  console.log(`keeper balance ${sol(balance)}`);

  const configKey = await configAddress();
  const configAcc = await rpc.getAccountInfo(configKey, { encoding: 'base64', commitment: 'confirmed' }).send();
  if (configAcc.value) {
    const config = decodeConfig(b64.encode(configAcc.value.data[0]) as Uint8Array);
    console.log(`config ${configKey} exists: next_round_id ${config.nextRoundId}, paused ${config.paused}`);
    for (const [role, key] of [
      ['admin', config.admin],
      ['price_authority', config.priceAuthority],
      ['house_authority', config.houseAuthority],
      ['treasury', config.treasury],
    ] as const) {
      if (key !== me) console.log(`  WARNING: ${role} is ${key}, not the keeper key`);
    }
  } else if (dryRun) {
    console.log(`would initialize config ${configKey} with`, DEVNET_PARAMS);
  } else {
    const ix = await initializeConfig({
      admin: signer,
      params: { priceAuthority: me, houseAuthority: me, treasury: me, ...DEVNET_PARAMS },
    });
    const sig = await sendInstructions(rpc, signer, [ix]);
    console.log(`config ${configKey} initialized: ${sig}`);
  }

  const vaultKey = await vaultAddress(me);
  const vaultAcc = await rpc.getAccountInfo(vaultKey, { encoding: 'base64', commitment: 'confirmed' }).send();
  if (vaultAcc.value) {
    const vault = decodeVault(b64.encode(vaultAcc.value.data[0]) as Uint8Array);
    console.log(`house vault ${vaultKey} exists: available ${sol(vault.available)}, locked ${sol(vault.locked)}`);
    return;
  }
  if (balance < depositAmount + FEE_RESERVE) {
    throw new Error(`keeper balance ${sol(balance)} is below the deposit ${sol(depositAmount)} plus a 0.05 SOL reserve`);
  }
  if (dryRun) {
    console.log(`would open house vault ${vaultKey} and deposit ${sol(depositAmount)}`);
    return;
  }
  const ixs = [await openVault({ owner: signer })];
  if (depositAmount > 0n) ixs.push(await deposit({ owner: signer, amount: depositAmount }));
  const sig = await sendInstructions(rpc, signer, ixs);
  console.log(`house vault ${vaultKey} opened with ${sol(depositAmount)}: ${sig}`);
}

main().catch((error: unknown) => {
  console.error(`init-config failed: ${describeError(error)}`);
  process.exit(1);
});
