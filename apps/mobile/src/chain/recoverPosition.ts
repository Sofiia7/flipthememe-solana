import type { Address } from '@solana/kit';
import { decodePosition, positionAddress, OFFSETS } from '@flipthememe/client';
import { decodeRoundSafe, fetchAccounts, fetchPositionsBy, roundAddressCached, type PositionView, type RoundView } from './fetch.ts';
import { withOwnPosition } from './arenaPositions.ts';
import type { SolanaRpc } from './rpc';

/** Read a sent call directly: program-wide scans may lag or be unavailable on public RPCs. */
export async function recoverPosition(rpc: SolanaRpc, owner: Address, roundId: bigint): Promise<{ position: PositionView; round: RoundView } | null> {
  const roundAddress = await roundAddressCached(roundId);
  const position = await positionAddress(roundAddress, owner);
  const [rawPosition, rawRound] = await fetchAccounts(rpc, [position, roundAddress]);
  if (!rawPosition || !rawRound) return null;
  const account = decodePosition(rawPosition.data);
  const round = decodeRoundSafe(rawRound);
  if (!round || round.id !== roundId || account.authority !== owner || account.round !== roundAddress || account.isHouse) throw new Error('Position recovery returned a different player or round.');
  return { position: { address: position, account, lamports: rawPosition.lamports }, round: { address: roundAddress, id: roundId, account: round } };
}

/** Position scan errors cannot discard previously verified calls or block a successful direct read. */
export async function readPositionSnapshot(rpc: SolanaRpc, owner: Address, roundId: bigint | null, previous: readonly PositionView[], scan: boolean) {
  const [directRead, scanRead] = await Promise.allSettled([
    roundId === null ? Promise.resolve(null) : recoverPosition(rpc, owner, roundId),
    scan ? fetchPositionsBy(rpc, OFFSETS.positionAuthority, owner) : Promise.resolve(previous),
  ]);
  const recovered = directRead.status === 'fulfilled' ? directRead.value : null;
  const positions = withOwnPosition(scanRead.status === 'fulfilled' ? scanRead.value : previous, recovered?.position);
  const error = scanRead.status === 'rejected' ? scanRead.reason : directRead.status === 'rejected' ? directRead.reason : null;
  return { positions: [...positions], recovered, error, scanSucceeded: scanRead.status === 'fulfilled' };
}
