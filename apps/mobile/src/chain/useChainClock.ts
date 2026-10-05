import { useRef, useState } from 'react';
import { POLL } from '../config';
import { usePolling } from '../lib/usePolling';
import type { SolanaRpc } from './rpc';

/**
 * Devnet clock offset in seconds (program time minus local time). The program checks entry
 * against its own Clock, which runs 1-2 s behind real time on devnet, so countdowns use it.
 * Estimated from getBlockTime of the latest confirmed slot, median of the last 5 samples.
 */
export function useChainClock(rpc: SolanaRpc): number {
  const [offset, setOffset] = useState(0);
  const samples = useRef<number[]>([]);

  usePolling(
    async () => {
      const t0 = Date.now();
      const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
      let blockTime: bigint | null = null;
      for (const candidate of [slot, slot - 1n, slot - 2n]) {
        try {
          const value = await rpc.getBlockTime(candidate).send();
          if (value !== null) {
            blockTime = BigInt(value);
            break;
          }
        } catch {
          // Block not available yet: try the previous slot.
        }
      }
      if (blockTime === null) return;
      // blockTime is whole seconds (floor); +0.5 centres the truncation.
      const sample = Number(blockTime) + 0.5 - t0 / 1000;
      samples.current = [...samples.current.slice(-4), sample];
      const sorted = [...samples.current].sort((a, b) => a - b);
      setOffset(sorted[Math.floor(sorted.length / 2)]);
    },
    samples.current.length === 0 ? 5_000 : POLL.clockMs,
  );

  return offset;
}

/** Program time now, in (fractional) unix seconds. */
export function chainNowSec(offsetSec: number, nowMs: number = Date.now()): number {
  return nowMs / 1000 + offsetSec;
}

/** Local ms for a program timestamp (seconds). */
export function chainToLocalMs(chainSec: number | bigint, offsetSec: number): number {
  return (Number(chainSec) - offsetSec) * 1000;
}
