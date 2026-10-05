import { useCallback, useRef, useState } from 'react';
import * as Haptics from 'expo-haptics';
import { getSignatureFromTransaction, type Address, type Instruction, type Signature } from '@solana/kit';
import { TransactionFailed, claim, placeBet, refundExpired, sendAndConfirm, signLocally, type Side } from '@flipthememe/client';
import type { SolanaRpc } from '../chain/rpc';
import { observeSend } from '../chain/sendPhase';
import { humanError } from '../lib/errors';
import { clearPendingBet, savePendingBet, type PendingBet } from './pendingBet';
import type { SessionKey } from './sessionKey';

export type BetPhase = 'idle' | 'signing' | 'sending' | 'confirming' | 'confirmed' | 'failed';

export type BetState = {
  phase: BetPhase;
  roundId: bigint | null;
  side: number | null;
  amount: bigint | null;
  signature: string | null;
  error: string | null;
  at: number;
};

const IDLE: BetState = { phase: 'idle', roundId: null, side: null, amount: null, signature: null, error: null, at: 0 };

/** True when the transaction can no longer land, so a stored pending bet can be dropped. */
function definitelyFailed(error: unknown): boolean {
  if (error instanceof TransactionFailed) return error.detail !== 'timeout';
  const text = error instanceof Error ? error.message : String(error);
  // A dropped connection may have delivered the transaction; keep it pending until the round closes.
  return !/network request failed|failed to fetch|abort/i.test(text);
}

export function useBetting(input: {
  rpc: SolanaRpc;
  owner: Address | null;
  sessionKey: SessionKey | null;
  faceBytes: Uint8Array;
  onPending: (bet: PendingBet | null) => void;
  onChanged: () => void;
  signWithWallet: (payer: Address, instructions: Instruction[]) => Promise<Signature>;
}) {
  const { rpc, owner, sessionKey, faceBytes, onPending, onChanged, signWithWallet } = input;
  const [bet, setBet] = useState<BetState>(IDLE);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<{ position: string; message: string } | null>(null);
  const busy = useRef(false);

  const place = useCallback(
    async (roundId: bigint, side: Side, amount: bigint) => {
      if (busy.current) return; // double-tap guard
      if (!owner || !sessionKey) return;
      busy.current = true;
      setBet({ phase: 'signing', roundId, side, amount, signature: null, error: null, at: Date.now() });
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
      let saved = false;
      try {
        const ix = await placeBet({ owner, sessionSigner: sessionKey.signer, roundId, side, amount, face: faceBytes });
        const signed = await signLocally(rpc, sessionKey.signer, [ix]);
        const signature = getSignatureFromTransaction(signed.transaction);
        const pending: PendingBet = { owner, roundId, side, amount, signature, at: Date.now() };
        await savePendingBet(pending).catch(() => undefined);
        saved = true;
        onPending(pending);
        setBet((s) => ({ ...s, phase: 'sending', signature }));
        const tracked = observeSend(rpc, () => setBet((s) => (s.signature === signature ? { ...s, phase: 'confirming' } : s)));
        await sendAndConfirm(tracked, signed);
        setBet((s) => (s.signature === signature ? { ...s, phase: 'confirmed', at: Date.now() } : s));
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        onChanged();
      } catch (error) {
        if (saved && definitelyFailed(error)) {
          await clearPendingBet().catch(() => undefined);
          onPending(null);
        }
        setBet((s) => ({ ...s, phase: 'failed', error: humanError(error, 'bet'), at: Date.now() }));
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      } finally {
        busy.current = false;
      }
    },
    [rpc, owner, sessionKey, faceBytes, onPending, onChanged],
  );

  const reset = useCallback(() => setBet(IDLE), []);

  /**
   * Manual claim (the keeper normally does it). Permissionless: the session key pays the fee
   * when it can, otherwise the wallet signs. The payout always lands in the owner's vault.
   * `refundFirst` also ends a round the keeper never settled (after its deadline) in the same tx.
   */
  const claimPosition = useCallback(
    async (positionAddress: string, roundId: bigint, positionOwner: Address, keyLamports: bigint | null, refundFirst = false) => {
      if (claiming) return;
      setClaiming(positionAddress);
      setClaimError(null);
      try {
        const ixs = [...(refundFirst ? [await refundExpired({ roundId })] : []), await claim({ roundId, owner: positionOwner })];
        if (sessionKey && (keyLamports ?? 0n) >= 20_000n) {
          await sendAndConfirm(rpc, await signLocally(rpc, sessionKey.signer, ixs));
        } else if (owner) {
          await signWithWallet(owner, ixs);
        } else {
          throw new Error('Connect a wallet to pay the claim fee.');
        }
        onChanged();
      } catch (error) {
        setClaimError({ position: positionAddress, message: humanError(error, 'claim') });
      } finally {
        setClaiming(null);
      }
    },
    [claiming, rpc, sessionKey, owner, signWithWallet, onChanged],
  );

  return { bet, place, reset, claiming, claimError, claimPosition };
}

export type Betting = ReturnType<typeof useBetting>;
