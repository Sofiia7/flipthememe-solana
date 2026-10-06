import { useCallback, useState } from 'react';
import { RoundStatus, configAddress, decodeConfig } from '@flipthememe/client';
import { POLL } from '../config';
import { usePolling } from '../lib/usePolling';
import { decodeRoundSafe, fetchAccounts, roundAddressCached, type RoundView } from './fetch';
import { recentRound } from './roundStore';
import { rateLimitWaitMs, type SolanaRpc } from './rpc';

/** One read of a round by id. `round` null: no readable account (closed, not created yet, or unreadable). */
export type RoundRead = {
  id: bigint;
  round: RoundView | null;
  /** No account although the config of the same read is past this id: closed because nobody played it. */
  closed: boolean;
};

/**
 * A round by id, for a challenge link that may name any round: read once, then every 15 s while it can
 * still change. A final or closed round is not read again; a failed read says nothing and is tried again
 * later. A round the arena has just read is taken from there. `id` null: no reads. Returns null until
 * the first read of this id answers.
 */
export function useRoundById(rpc: SolanaRpc, id: bigint | null): RoundRead | null {
  const [read, setRead] = useState<RoundRead | null>(null);
  const current = read !== null && read.id === id ? read : null;
  const settled = current !== null && (current.closed || current.round?.account.status === RoundStatus.Final);

  const poll = useCallback(async (): Promise<number> => {
    if (id === null) return POLL.challengeRoundMs;
    try {
      const address = await roundAddressCached(id);
      const shared = recentRound(address, POLL.sharedRoundMs);
      if (shared) {
        setRead({ id, round: shared, closed: false });
        return POLL.challengeRoundMs;
      }
      // With the config in the same snapshot, as the arena does: a missing round below nextRoundId was closed.
      const [config, raw] = await fetchAccounts(rpc, [await configAddress(), address]);
      const account = decodeRoundSafe(raw ?? null);
      let nextRoundId: bigint | null = null;
      try {
        nextRoundId = config ? decodeConfig(config.data).nextRoundId : null;
      } catch {
        // No config to compare with: the round is read again later.
      }
      setRead({ id, round: account ? { id, address, account } : null, closed: !raw && nextRoundId !== null && id < nextRoundId });
      return POLL.challengeRoundMs;
    } catch (error) {
      return Math.max(POLL.challengeRoundMs, rateLimitWaitMs(error) ?? 0);
    }
  }, [rpc, id]);

  usePolling(poll, POLL.challengeRoundMs, id !== null && !settled, id);
  return current;
}
