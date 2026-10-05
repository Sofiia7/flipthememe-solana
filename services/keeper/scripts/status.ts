/**
 * Prints the devnet Config, the last rounds and the keeper/house balances.
 *
 *   node services/keeper/scripts/status.ts [rounds=10]
 *
 * Env: DEVNET_RPC, KEEPER_KEYPAIR (only its address is used), STATE_FILE (status.json is read
 * from the same folder when the keeper writes one).
 */
import { readFileSync } from 'node:fs';
import { Outcome, PROGRAM_ID, RefundReason, RoundStatus, configAddress, vaultAddress, type RoundAccount } from '@flipthememe/client';
import { readSnapshot } from '../src/chain.ts';
import { loadConfig } from '../src/config.ts';
import { loadKeypairSigner } from '../src/keypair.ts';
import { hostOf } from '../src/log.ts';
import { makeRpc } from '../src/rpc.ts';

const sol = (lamports: bigint): string => {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, '0');
  return `${whole}.${frac}`;
};
const nameOf = (map: Record<string, number>, value: number): string =>
  Object.entries(map).find(([, v]) => v === value)?.[0] ?? String(value);
const iso = (secs: bigint): string => new Date(Number(secs) * 1000).toISOString().replace('.000Z', 'Z');

function describe(r: RoundAccount): string {
  const status = nameOf(RoundStatus, r.status);
  const outcome = r.status === RoundStatus.Final ? ` ${nameOf(Outcome, r.outcome)}` : '';
  const reason = r.refundReason !== RefundReason.None ? `(${nameOf(RefundReason, r.refundReason)})` : '';
  return [
    `#${r.id}`.padEnd(7),
    iso(r.opensAt),
    `${status}${outcome}${reason}`.padEnd(24),
    `up ${sol(r.rawUp)} down ${sol(r.rawDown)} house ${sol(r.houseAmount)}`,
    `pos ${r.positionCount} claimed ${r.claimedCount}${r.feesSwept ? ' swept' : ''}`,
    `max_bank ${sol(r.maxBank)}`,
    r.strikeSamples || r.exitSamples ? `samples ${r.strikeSamples}/${r.exitSamples}` : '',
    `pool ${r.pool}`,
  ]
    .filter(Boolean)
    .join('  ');
}

async function main(): Promise<void> {
  const count = Math.max(1, Math.min(60, Number(process.argv[2] ?? 10) || 10));
  const cfg = loadConfig();
  const signer = await loadKeypairSigner(cfg.keypairPath);
  const rpc = makeRpc(cfg.devnetRpc, 20_000);
  const head = await readSnapshot(rpc, signer.address, []);
  console.log(`devnet ${hostOf(cfg.devnetRpc)}  program ${PROGRAM_ID}`);
  console.log(`keeper ${signer.address}  balance ${sol(head.keeperLamports)} SOL`);
  const vault = head.houseVault;
  console.log(
    `house vault ${await vaultAddress(signer.address)}  ${vault ? `available ${sol(vault.available)} locked ${sol(vault.locked)} SOL` : 'not opened'}`,
  );
  const config = head.config;
  if (!config) {
    console.log(`config ${await configAddress()} does not exist yet`);
    return;
  }
  console.log(`config ${await configAddress()}`);
  console.log(
    `  admin ${config.admin}\n  price_authority ${config.priceAuthority}\n  house_authority ${config.houseAuthority}\n  treasury ${config.treasury}`,
  );
  console.log(
    `  paused ${config.paused}  next_round_id ${config.nextRoundId}  stake ${sol(config.minStake)}..${sol(config.maxStake)}  min_bank ${sol(config.minBank)}  fees ${config.feeWinBps}/${config.feeRefundBps} bps`,
  );
  console.log(`  total_available ${sol(config.totalAvailable)}  total_locked ${sol(config.totalLocked)}`);

  const ids: bigint[] = [];
  for (let id = config.nextRoundId - 1n; id >= 0n && ids.length < count; id--) ids.push(id);
  const snap = await readSnapshot(rpc, signer.address, ids);
  console.log(`last ${ids.length} rounds (newest first):`);
  for (const id of ids) {
    const round = snap.rounds.get(id);
    console.log(round ? `  ${describe(round)}` : `  #${id}`.padEnd(9) + ' closed (empty round)');
  }

  try {
    const status = JSON.parse(readFileSync(cfg.statusFile, 'utf8')) as Record<string, unknown>;
    console.log(`keeper status file ${cfg.statusFile}: updated ${String(status.updatedAt)}, last action ${String(status.lastSuccessfulActionAt)}`);
  } catch {
    // no status file next to STATE_FILE: the keeper is not running from this folder
  }
}

main().catch((error: unknown) => {
  console.error(`status failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
