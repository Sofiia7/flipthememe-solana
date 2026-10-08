/** Anyone with a funded devnet fee payer may relay a canonical public price certificate.
 * node services/keeper/scripts/relay-price.ts <round-id> strike|exit --keypair <file>
 * No keeper, price-authority or attestor key, nor ATTEST_TOKEN, is required.
 */
import { decodeOracleConfig, decodeRound, oracleAddress, roundAddress } from '@flipthememe/client';
import { certificateInstructions } from '../src/certificate.ts';
import { readAccount, sendInstructions } from '../src/chain.ts';
import { loadConfig } from '../src/config.ts';
import { loadKeypairSigner } from '../src/keypair.ts';
import { argValue } from '../src/plans.ts';
import { makeRpc } from '../src/rpc.ts';

async function main() {
  const [id, kind] = process.argv.slice(2);
  const keypair = argValue(process.argv.slice(2), '--keypair');
  if (!id || !/^(0|[1-9][0-9]{0,19})$/.test(id) || BigInt(id) > 18446744073709551615n || (kind !== 'strike' && kind !== 'exit') || !keypair) throw new Error('usage: relay-price.ts <round-id> strike|exit --keypair <funded-devnet-keypair>');
  const cfg = loadConfig();
  const rpc = makeRpc(cfg.devnetRpc, 20_000);
  const [round, oracle] = await Promise.all([readAccount(rpc, await roundAddress(BigInt(id)), decodeRound), readAccount(rpc, await oracleAddress(), decodeOracleConfig)]);
  if (!round || !oracle) throw new Error('round or oracle missing');
  const instructions = await certificateInstructions(cfg.attestUrl ?? 'https://sol.flipthememe.com', round, kind, oracle.attestor);
  const payer = await loadKeypairSigner(keypair);
  console.log(`Relaying ${kind} for round ${id}; fee payer ${payer.address}`);
  console.log(await sendInstructions(rpc, payer, instructions));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'relay failed'); process.exitCode = 1; });
