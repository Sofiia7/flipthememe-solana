import { useCallback, useMemo, useRef, useState } from 'react';
import * as Haptics from 'expo-haptics';
import { getSignatureFromTransaction, type Address, type Instruction, type Signature } from '@solana/kit';
import { claim, placeBet, refundExpired, sendAndConfirm, signLocally, type Side } from '@flipthememe/client';
import { CLAIM_KEY_MIN_LAMPORTS } from '../config';
import type { SolanaRpc } from '../chain/rpc';
import { observeSend } from '../chain/sendPhase';
import { checkSignature, sendErrorProof, settleSendError, settledError, type TxCheck } from '../chain/txStatus';
import { humanError } from '../lib/errors';
import { playSound } from '../sound/sound';
import { recordEvent } from '../lib/diagnostics';
import { recordLatency } from '../lib/requestLog';
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
      if (!owner || !sessionKey) {
        setBet({ phase: 'failed', roundId, side, amount, signature: null, error: !owner ? 'Connect your wallet. Bet not sent.' : 'Device key is not ready. Bet not sent; retry when loaded.', at: Date.now() });
        return;
      }
      busy.current = true;
      const startedAt = Date.now();
      setBet({ phase: 'signing', roundId, side, amount, signature: null, error: null, at: Date.now() });
      // The arcade feedback comes with the tap, not with the confirmation a second or two later
      // (playSound is silent when muted in Profile).
      playSound('bet');
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
      // Set once the bet is stored and about to go out: from then on only the chain decides its fate.
      let sent: PendingBet | null = null;
      const landed = (signature: string) => {
        recordLatency('bet_confirmation', Date.now() - startedAt);
        recordEvent('bet_confirmed');
        setBet((s) => (s.signature === signature ? { ...s, phase: 'confirmed', at: Date.now() } : s));
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        onChanged();
      };
      try {
        const ix = await placeBet({ owner, sessionSigner: sessionKey.signer, roundId, side, amount, face: faceBytes });
        const signed = await signLocally(rpc, sessionKey.signer, [ix]);
        const signature = getSignatureFromTransaction(signed.transaction);
        const pending: PendingBet = { owner, roundId, side, amount, signature, at: Date.now(), lastValidBlockHeight: signed.lastValidBlockHeight };
        // Do not broadcast money-changing transactions without a durable recovery record.
        try { await savePendingBet(pending); }
        catch { throw new Error('Cannot save transaction recovery data. Bet not sent. Free device storage and retry.'); }
        sent = pending;
        onPending(pending);
        recordEvent('bet_sent');
        setBet((s) => ({ ...s, phase: 'sending', signature }));
        const tracked = observeSend(rpc, () => setBet((s) => (s.signature === signature ? { ...s, phase: 'confirming' } : s)));
        await sendAndConfirm(tracked, signed);
        landed(signature);
      } catch (error) {
        let shown: unknown = error;
        if (sent) {
          // A timeout or a dropped connection proves nothing: one look at the chain, and without a
          // clear answer the bet stays pending (AppProvider keeps checking its signature).
          const tx = sent;
          const proof = sendErrorProof(error);
          let check: TxCheck | null = null;
          if (proof !== 'failed') check = await checkSignature(rpc, tx).catch(() => null);
          const verdict = settleSendError(proof, check?.verdict ?? null);
          if (verdict === 'confirmed') {
            landed(tx.signature);
            return;
          }
          if (verdict === 'pending') {
            setBet(IDLE);
            onChanged();
            return;
          }
          await clearPendingBet(tx.signature).catch(() => undefined);
          onPending(null);
          shown = settledError(tx.signature, verdict, check, error);
        }
        setBet((s) => ({ ...s, phase: 'failed', error: humanError(shown, 'bet'), at: Date.now() }));
        recordEvent('bet_failed');
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      } finally {
        busy.current = false;
      }
    },
    [rpc, owner, sessionKey, faceBytes, onPending, onChanged],
  );

  const reset = useCallback(() => setBet(IDLE), []);
  const recoverConfirmed = useCallback((pending: PendingBet) => {
    if (pending.owner !== owner || busy.current) return;
    setBet({ phase: 'confirmed', roundId: pending.roundId, side: pending.side, amount: pending.amount, signature: pending.signature, error: null, at: Date.now() });
  }, [owner]);

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
        // The device key pays the fee only when it holds what one more fee needs (config.ts); else the wallet signs.
        if (sessionKey && (keyLamports ?? 0n) >= CLAIM_KEY_MIN_LAMPORTS) {
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

  // One object per change, so the app context (and everything reading it) does not see a new one on every render.
  return useMemo(() => ({ bet, place, reset, recoverConfirmed, claiming, claimError, claimPosition }), [bet, place, reset, recoverConfirmed, claiming, claimError, claimPosition]);
}

export type Betting = ReturnType<typeof useBetting>;
