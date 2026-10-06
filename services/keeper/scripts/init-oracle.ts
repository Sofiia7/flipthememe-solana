/**
 * Creates or updates OracleConfig, the independent price attestor (October 2026 upgrade). While
 * `required` is true, set_strike and settle of a matched round need the attestor's signature;
 * refund_expired and claims never do. Idempotent: creates the account when it is missing, updates
 * it when a value differs, otherwise does nothing.
 *
 *   node services/keeper/scripts/init-oracle.ts [--attestor <pubkey>] [--required true|false] [--attestor-keypair <path>] [--dry-run]
 *
 * A flag that is left out keeps the current value; a fresh account gets no attestor
 * (11111111111111111111111111111111) and required false. --required true needs an attestor.
 * The admin key alone may only strengthen the oracle: switching a required attestor off or
 * replacing it needs the attestor in office to co-sign, from its key file (--attestor-keypair);
 * without it the script refuses before sending anything.
 * Env: DEVNET_RPC, KEEPER_KEYPAIR (the admin key; see src/config.ts).
 */
import { configAddress, decodeConfig, decodeOracleConfig, initOracle, oracleAddress, setOracle } from '@flipthememe/client';
import { describeError, readAccount, sendInstructions } from '../src/chain.ts';
import { loadConfig } from '../src/config.ts';
import { loadKeypairSigner } from '../src/keypair.ts';
import { hostOf } from '../src/log.ts';
import { addressArg, argValue, boolArg, oracleCosigner, planOracle, wantedOracle } from '../src/plans.ts';
import { makeRpc } from '../src/rpc.ts';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const args = { attestor: addressArg(argv, '--attestor'), required: boolArg(argv, '--required') };
  const keyPath = argValue(argv, '--attestor-keypair');
  const cfg = loadConfig();
  const signer = await loadKeypairSigner(cfg.keypairPath);
  const inOffice = keyPath === null ? null : await loadKeypairSigner(keyPath);
  const rpc = makeRpc(cfg.devnetRpc, 20_000);
  console.log(`devnet RPC ${hostOf(cfg.devnetRpc)}, admin ${signer.address}${dryRun ? ' (dry run)' : ''}`);

  const config = await readAccount(rpc, await configAddress(), decodeConfig);
  if (!config) throw new Error('Config does not exist on this cluster');
  if (config.admin !== signer.address) throw new Error(`the admin is ${config.admin}, not ${signer.address}`);
  const key = await oracleAddress();
  const current = await readAccount(rpc, key, decodeOracleConfig);
  console.log(current ? `oracle ${key}: attestor ${current.attestor}, required ${current.required}` : `oracle ${key} does not exist yet`);
  const want = wantedOracle(current, args);
  if (want.attestor === signer.address || want.attestor === config.priceAuthority) {
    console.log(`  WARNING: the attestor ${want.attestor} is the keeper or price key, so it is not an independent second signer`);
  }
  const action = planOracle(current, want);
  const cosign = oracleCosigner(current, want, inOffice?.address ?? null);
  console.log(`wanted: attestor ${want.attestor}, required ${want.required} -> ${action}${cosign.cosigner ? `, co-signed by the attestor in office ${cosign.cosigner}` : ''}`);
  if (action === 'none') return;
  if (cosign.error) {
    if (dryRun) {
      console.log(`  would be refused: ${cosign.error}`);
      return;
    }
    throw new Error(cosign.error);
  }
  if (dryRun) return;
  const ix =
    action === 'init'
      ? await initOracle({ admin: signer, ...want })
      : await setOracle({ admin: signer, ...want, currentAttestor: cosign.cosigner ? inOffice : null });
  console.log(`${action === 'init' ? 'initialized' : 'updated'}: ${await sendInstructions(rpc, signer, [ix])}`);
}

main().catch((error: unknown) => {
  console.error(`init-oracle failed: ${describeError(error)}`);
  process.exit(1);
});
