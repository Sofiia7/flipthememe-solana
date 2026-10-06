/**
 * Devnet smoke test of a played round; the keeper must be running. A throwaway player (new key,
 * funded with about 0.07 SOL from the keeper key) opens a vault, deposits the stake plus the
 * position rent, starts a session and bets on UP in the round that is open now; the session key
 * gets only enough for fees, since the vault pays the rent. The keeper should then fill DOWN as
 * the house after cutoff, set the strike, settle, claim both positions and sweep the fees; this
 * script follows the round until it is swept (at most 6 minutes).
 *
 *   node services/keeper/scripts/smoke-bet.ts [stakeLamports=50000000]
 *
 * Env: DEVNET_RPC, KEEPER_KEYPAIR (see src/config.ts).
 */
import {
  POSITION_ACCOUNT_SIZE,
  RoundStatus,
  Outcome,
  Side,
  decodeRound,
  decodeVault,
  deposit,
  openVault,
  placeBet,
  roundAddress,
  startSession,
  transferSol,
  vaultAddress,
  type RoundAccount,
} from '@flipthememe/client';
import { generateKeyPairSigner, getBase64Encoder } from '@solana/kit';
import { describeError, readAccount, readSnapshot, sendInstructions } from '../src/chain.ts';
import { loadConfig } from '../src/config.ts';
import { loadKeypairSigner } from '../src/keypair.ts';
import { makeRpc, type SolanaRpc } from '../src/rpc.ts';

const SOL = 1_000_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = getBase64Encoder();

async function readRound(rpc: SolanaRpc, id: bigint): Promise<RoundAccount | null> {
  const { value } = await rpc.getAccountInfo(await roundAddress(id), { encoding: 'base64', commitment: 'confirmed' }).send();
  return value ? decodeRound(b64.encode(value.data[0]) as Uint8Array) : null;
}

async function main(): Promise<void> {
  const stake = BigInt(process.argv[2] ?? 50_000_000n);
  const cfg = loadConfig();
  const keeper = await loadKeypairSigner(cfg.keypairPath);
  const rpc = makeRpc(cfg.devnetRpc, 20_000);
  const player = await generateKeyPairSigner();
  const session = await generateKeyPairSigner();
  console.log(`player ${player.address}, session key ${session.address}, stake ${stake} lamports`);

  // Wait for a round that has at least 15 s of entry left.
  let roundId: bigint | null = null;
  for (let i = 0; i < 90 && roundId === null; i++) {
    const head = await readSnapshot(rpc, keeper.address, []);
    if (!head.config) throw new Error('config does not exist');
    const latest = head.config.nextRoundId - 1n;
    const round = latest >= 0n ? await readRound(rpc, latest) : null;
    const now = Date.now() / 1000;
    if (round && round.status === RoundStatus.Open && now >= Number(round.opensAt) && now < Number(round.cutoffAt) - 15) roundId = latest;
    else await sleep(2_000);
  }
  if (roundId === null) throw new Error('no open round with 15 s of entry left within 3 minutes; is the keeper running?');
  console.log(`betting UP in round ${roundId}`);

  // The vault pays the position rent on top of the stake; the session key pays fees only, and
  // 0.001 SOL keeps it above the rent-exempt minimum of a plain wallet with fees to spare.
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(POSITION_ACCOUNT_SIZE)).send();
  const fund = await sendInstructions(rpc, keeper, [transferSol({ from: keeper, to: player.address, lamports: stake + rent + 20_000_000n })]);
  console.log(`funded player: ${fund}`);
  const setup = await sendInstructions(rpc, player, [
    await openVault({ owner: player }),
    await deposit({ owner: player, amount: stake + rent }),
    await startSession({
      owner: player,
      sessionSigner: session.address,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      maxPerBet: stake,
      sessionCap: stake,
    }),
    transferSol({ from: player, to: session.address, lamports: 1_000_000n }),
  ]);
  console.log(`vault + deposit of stake ${stake} + position rent ${rent} + session: ${setup}`);
  const face = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const keyBefore = (await rpc.getBalance(session.address, { commitment: 'confirmed' }).send()).value;
  const bet = await sendInstructions(rpc, session, [
    await placeBet({ owner: player.address, sessionSigner: session, roundId, side: Side.Up, amount: stake, face }),
  ]);
  const keyAfter = (await rpc.getBalance(session.address, { commitment: 'confirmed' }).send()).value;
  const vault = await readAccount(rpc, await vaultAddress(player.address), decodeVault);
  console.log(`bet placed: ${bet}`);
  // Expected: the vault keeps 0 available (stake locked, rent paid), the session key paid one fee.
  console.log(`vault available ${vault?.available} locked ${vault?.locked}; session key paid ${keyBefore - keyAfter} lamports`);

  let last = '';
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    let r: RoundAccount | null;
    try {
      r = await readRound(rpc, roundId);
    } catch (error) {
      console.log(`read failed (${describeError(error)}), retrying`);
      await sleep(10_000);
      continue;
    }
    if (!r) throw new Error(`round ${roundId} disappeared`);
    const line = `status ${Object.keys(RoundStatus)[r.status]} outcome ${Object.keys(Outcome)[r.outcome]} up ${r.rawUp} down ${r.rawDown} house ${r.houseAmount} positions ${r.positionCount} claimed ${r.claimedCount} swept ${r.feesSwept} strike ${r.strikePrice} (${r.strikeSamples}) exit ${r.exitPrice} (${r.exitSamples})`;
    if (line !== last) console.log(`${new Date().toISOString()} ${line}`);
    last = line;
    if (r.feesSwept) {
      console.log(`round ${roundId} done; stake was ${Number(stake) / Number(SOL)} SOL`);
      return;
    }
    await sleep(5_000);
  }
  throw new Error(`round ${roundId} was not swept within 6 minutes`);
}

main().catch((error: unknown) => {
  console.error(`smoke-bet failed: ${describeError(error)}`);
  process.exit(1);
});
