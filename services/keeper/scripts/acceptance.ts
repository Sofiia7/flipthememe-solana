/** Live devnet acceptance with recoverable throwaway keys and transaction journal.
 * Never run on mainnet. No mobile UI/physical-device coverage is claimed.
 * Bundle for the operator container; ACCEPTANCE_DIR must be a private persistent directory.
 * --close-only resumes archival/rent recovery after the program's one-hour close delay.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createPrivateKey, createPublicKey } from 'node:crypto';
import { getBase64EncodedWireTransaction, getSignatureFromTransaction, getBase64Encoder, type Signature, type TransactionSigner, type Instruction, type Base64EncodedWireTransaction } from '@solana/kit';
import { PROGRAM_ID, POSITION_ACCOUNT_SIZE, POSITION_CLOSE_DELAY_SECS, RoundStatus, Side, decodeRound, decodePosition, decodeVault, configAddress, decodeConfig, roundAddress, positionAddress, vaultAddress, openVault, deposit, startSession, placeBet, claim, withdraw, revokeSession, closeSession, closePosition, transferSol, signLocally, positionPayout, houseContext } from '@flipthememe/client';
import { loadKeypairSigner } from '../src/keypair.ts';
import { readAccount } from '../src/chain.ts';
import { makeDevnetRpc } from '../src/rpc.ts';

const dir = process.env.ACCEPTANCE_DIR ?? '/data/acceptance-20261010';
mkdirSync(dir, { recursive: true, mode: 0o700 });
const path = join(dir, 'proof.json');
type Action = { signature: string; wire: string; confirmed?: boolean; at: string };
type Proof = { stage: string; actions: Record<string, Action>; roundId?: string; stake?: string; owners?: string[]; result?: unknown; archives?: unknown[]; closeDueAt?: string; withdrawn?: string[]; closed?: boolean };
const proof: Proof = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { stage: 'created', actions: {} };
const json = (v: unknown) => JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? x.toString() : x);
const save = () => { writeFileSync(path + '.tmp', json(proof) + '\n', { mode: 0o600 }); renameSync(path + '.tmp', path); };
const stage = (s: string, details?: unknown) => { proof.stage = s; save(); console.log(json({ at: new Date().toISOString(), stage: s, details })); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };

async function key(name: string) {
  const p = join(dir, name + '.json');
  if (!existsSync(p)) {
    const seed = randomBytes(32);
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), type: 'pkcs8', format: 'der' });
    const pub = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
    writeFileSync(p, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
    seed.fill(0);
  }
  return loadKeypairSigner(p);
}

async function main() {
  const rpc = makeDevnetRpc([process.env.DEVNET_RPC ?? 'https://api.devnet.solana.com', 'https://solana-devnet.api.onfinality.io/public']);
  assert(await rpc.getGenesisHash().send() === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', 'REFUSED: chain is not Solana devnet');
  const keeper = await loadKeypairSigner(process.env.KEEPER_KEYPAIR ?? '/secrets/keeper.json');
  const owners = await Promise.all([key('player-up'), key('player-down')]);
  const devices = await Promise.all([key('device-up'), key('device-down')]);
  proof.owners = owners.map(o => o.address); save();
  async function tx(name: string, signer: TransactionSigner, instructions: Instruction[]) {
    let action = proof.actions[name];
    if (action?.confirmed) return action.signature;
    if (!action) {
      const signed = await signLocally(rpc, signer, instructions);
      action = { signature: getSignatureFromTransaction(signed.transaction), wire: getBase64EncodedWireTransaction(signed.transaction), at: new Date().toISOString() };
      proof.actions[name] = action; save(); // journal before broadcast
    }
    const known = (await rpc.getSignatureStatuses([action.signature as Signature], { searchTransactionHistory: true }).send()).value[0];
    if (!known) {
      assert(Date.now() - Date.parse(action.at) < 90_000, 'Pending transaction expired; reconcile saved signature before any new send: ' + name);
      await rpc.sendTransaction(action.wire as Base64EncodedWireTransaction, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3n }).send();
    }
    for (let i = 0; i < 45; i++) {
      const s = (await rpc.getSignatureStatuses([action.signature as Signature], { searchTransactionHistory: true }).send()).value[0];
      if (s?.err) throw new Error('Transaction failed ' + name + ': ' + json(s.err));
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) { action.confirmed = true; save(); console.log(json({ action: name, signature: action.signature })); return action.signature; }
      await sleep(1200);
    }
    throw new Error('Confirmation pending; resume using journal: ' + name);
  }
  const b64 = getBase64Encoder();
  async function archived(i: number, id: bigint) {
    const response = await fetch('https://sol.flipthememe.com/v1/history?owner=' + owners[i].address, { signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) return null;
    assert(response.ok, 'History HTTP ' + response.status);
    const data = await response.json() as { owner: string; rows: { position: string; round: string; positionData: string; roundData: string }[] };
    assert(data.owner === owners[i].address, 'Archive owner mismatch');
    const row = data.rows.find(r => r.position === positionKeys[i]);
    if (!row) return null;
    const p = decodePosition(Uint8Array.from(b64.encode(row.positionData))); const r = decodeRound(Uint8Array.from(b64.encode(row.roundData)));
    assert(p.authority === owners[i].address && r.id === id && row.round === roundKey && p.round === row.round && r.status === RoundStatus.Final, 'Invalid archive context');
    if (!p.claimed) return null; // wait for the post-claim snapshot
    assert(p.stake === stake && p.side === (i === 0 ? Side.Up : Side.Down), 'Archive changed the player stake or side');
    assert(p.payout === positionPayout(r.rawUp, r.rawDown, r.outcome, r.feeWinBps, r.feeRefundBps, p.side, p.stake, houseContext(r, p)), 'Archive payout differs from program rules');
    return { owner: data.owner, position: row.position, roundId: r.id, stake: p.stake, payout: p.payout, claimed: p.claimed, indexedAt: (data as unknown as { indexedAt: string }).indexedAt };
  }
  const config = await readAccount(rpc, await configAddress(), decodeConfig);
  assert(config && !config.paused, 'Program missing or paused');
  const stake = proof.stake ? BigInt(proof.stake) : config!.minBank > config!.minStake ? config!.minBank : config!.minStake;
  assert(stake <= 50_000_000n && stake <= config!.maxStake, 'Acceptance exceeds bounded test stake');
  proof.stake = stake.toString(); save();
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(POSITION_ACCOUNT_SIZE)).send();
  if (!process.argv.includes('--close-only')) {
    for (let i = 0; i < 2; i++) {
      await tx('fund-' + i, keeper, [transferSol({ from: keeper, to: owners[i].address, lamports: stake + rent + 20_000_000n })]);
      await tx('setup-' + i, owners[i], [await openVault({ owner: owners[i] }), await deposit({ owner: owners[i], amount: stake + rent }), await startSession({ owner: owners[i], sessionSigner: devices[i].address, expiry: BigInt(Math.floor(Date.now() / 1000) + 3600), maxPerBet: stake, sessionCap: stake }), transferSol({ from: owners[i], to: devices[i].address, lamports: 1_000_000n })]);
    }
    stage('wallets-ready', { owners: proof.owners, stake });
    if (!proof.roundId) {
      for (let i = 0; i < 100; i++) {
        const c = await readAccount(rpc, await configAddress(), decodeConfig);
        const id = c!.nextRoundId - 1n;
        const r = await readAccount(rpc, await roundAddress(id), decodeRound);
        const now = Date.now() / 1000;
        if (r && r.status === RoundStatus.Open && now >= Number(r.opensAt) && now < Number(r.cutoffAt) - 25 && r.maxBank >= stake) { proof.roundId = id.toString(); save(); break; }
        await sleep(2000);
      }
    }
    assert(proof.roundId, 'No eligible round; wallets remain recoverable');
  }
  assert(proof.roundId, 'No saved round');
  const id = BigInt(proof.roundId!); const roundKey = await roundAddress(id);
  const positionKeys = await Promise.all(owners.map(o => positionAddress(roundKey, o.address)));
  if (!process.argv.includes('--close-only')) {
    for (let i = 0; i < 2; i++) await tx('bet-' + i, devices[i], [await placeBet({ owner: owners[i].address, sessionSigner: devices[i], roundId: id, side: i === 0 ? Side.Up : Side.Down, amount: stake, face: new Uint8Array([10, 10, 20, 26, 0, 0, 0, i + 1]) })]);
    stage('bets-confirmed', { roundId: id, stakePerSide: stake });
    let final = null;
    for (let i = 0; i < 85; i++) {
      const r = await readAccount(rpc, roundKey, decodeRound);
      assert(r, 'Played round disappeared before archival');
      if (r!.status === RoundStatus.Final) { final = r; break; }
      await sleep(5000);
    }
    assert(final, 'Settlement timed out; resume with saved keys');
    assert(final!.rawUp >= stake && final!.rawDown >= stake, 'Round did not match both sides');
    proof.result = { roundId: id, outcome: final!.outcome, refundReason: final!.refundReason, rawUp: final!.rawUp, rawDown: final!.rawDown, strikeSamples: final!.strikeSamples, exitSamples: final!.exitSamples, strikePrice: final!.strikePrice, exitPrice: final!.exitPrice };
    proof.closeDueAt = new Date(Number(final!.exitEnd + POSITION_CLOSE_DELAY_SECS) * 1000 + 15_000).toISOString();
    stage('round-final', proof.result);
    for (let i = 0; i < 2; i++) {
      let p = await readAccount(rpc, positionKeys[i], decodePosition);
      if (!p?.claimed) await tx('claim-' + i, owners[i], [await claim({ roundId: id, owner: owners[i].address })]);
      p = await readAccount(rpc, positionKeys[i], decodePosition);
      const expected = positionPayout(final!.rawUp, final!.rawDown, final!.outcome, final!.feeWinBps, final!.feeRefundBps, p!.side, p!.stake, houseContext(final!, p!));
      assert(p?.claimed && p.payout === expected, 'Payout differs from on-chain rules');
    }
    stage('claims-verified');
    for (let attempt = 0; attempt < 18; attempt++) {
      const rows = await Promise.all(owners.map((_o, i) => archived(i, id)));
      if (rows.every(Boolean)) { proof.archives = rows; save(); break; }
      await sleep(20_000);
    }
    assert(proof.archives?.length === 2, 'Signed history was not published within six minutes');
    stage('archive-restored-from-empty-local-state', proof.archives);
    proof.withdrawn ??= [];
    for (let i = 0; i < 2; i++) {
      const v = await readAccount(rpc, await vaultAddress(owners[i].address), decodeVault);
      assert(v?.locked === 0n, 'Claim left funds locked');
      if (proof.actions['withdraw-' + i] || v!.available > 0n) await tx('withdraw-' + i, owners[i], [await withdraw({ owner: owners[i], amount: v!.available })]);
      const after = await readAccount(rpc, await vaultAddress(owners[i].address), decodeVault);
      assert(after?.available === 0n && after.locked === 0n, 'Withdrawal did not clear vault balance');
      await tx('revoke-close-session-' + i, owners[i], [await revokeSession({ owner: owners[i], sessionSigner: devices[i].address }), await closeSession({ owner: owners[i], sessionSigner: devices[i].address })]);
      proof.withdrawn = [...new Set([...proof.withdrawn, owners[i].address])]; save();
    }
    stage('withdrawal-and-session-close-verified', { closeDueAt: proof.closeDueAt });
    return;
  }
  assert(proof.archives?.length === 2 && proof.withdrawn?.length === 2, 'Prerequisites missing for delayed close');
  if (proof.closed) { console.log(json({ stage: proof.stage, alreadyCompleted: true })); return; }
  stage('waiting-for-program-close-delay', { due: proof.closeDueAt });
  while (Date.now() < Date.parse(proof.closeDueAt!)) await sleep(Math.min(45_000, Date.parse(proof.closeDueAt!) - Date.now()));
  for (let i = 0; i < 2; i++) {
    assert(await archived(i, id), 'Archive missing before closing position');
    if (await readAccount(rpc, positionKeys[i], decodePosition)) await tx('close-position-' + i, owners[i], [await closePosition({ roundId: id, owner: owners[i].address })]);
    assert(!await readAccount(rpc, positionKeys[i], decodePosition), 'Position still exists');
    assert(await archived(i, id), 'History lost after account closure');
    // A crash after the first withdrawal must not require its already-returned rent again.
    if (!proof.actions['withdraw-rent-' + i]?.confirmed) {
      const v = await readAccount(rpc, await vaultAddress(owners[i].address), decodeVault);
      assert(v && v.locked === 0n && (proof.actions['withdraw-rent-' + i] || v.available >= rent), 'Position rent was not returned');
      await tx('withdraw-rent-' + i, owners[i], [await withdraw({ owner: owners[i], amount: v!.available })]);
    }
    const after = await readAccount(rpc, await vaultAddress(owners[i].address), decodeVault);
    assert(after?.available === 0n && after.locked === 0n, 'Rent withdrawal did not clear vault balance');
  }
  proof.closed = true; stage('position-close-rent-and-archive-verified');
}
main().catch(error => { console.error(json({ stage: proof.stage, error: error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[URL]') : 'acceptance failed' })); process.exitCode = 1; });
