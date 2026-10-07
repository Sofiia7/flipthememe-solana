// Shared helpers for the pool selection tests (not a test file itself).
import type { PoolCandidate } from '@flipthememe/client';
import type { Candidate } from '../src/poolgate.ts';
import { getAddressDecoder, type Address } from '@solana/kit';

export const NOW = Date.parse('2026-10-05T12:00:00Z');
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const SOL = 1_000_000_000n;

/** A distinct, valid address per number (any 32 bytes are an address). */
export function testAddress(i: number): Address {
  const bytes = new Uint8Array(32);
  bytes[0] = 7;
  bytes[30] = Math.floor(i / 256);
  bytes[31] = i % 256;
  return getAddressDecoder().decode(bytes);
}

/** GeckoTerminal numbers of pool `i`: `txM5` trades in 5 minutes, created `ageMs` before `nowMs`. */
export function candidate(i: number, txM5: number, ageMs: number, nowMs: number = NOW): PoolCandidate {
  return {
    pool: testAddress(i),
    baseMint: testAddress(1000 + i),
    name: `T${i} / SOL`,
    reserveUsd: 50_000,
    createdAtMs: nowMs - ageMs,
    txM5,
    volumeH1Usd: 10_000,
  };
}

/** `c` with its 5-minute trades split into `buys` and `sells` (txM5 becomes their sum), as discovery.ts passes them on. */
export function withFlow(c: PoolCandidate, buys: number, sells: number): Candidate {
  return { ...c, txM5: buys + sells, buys, sells };
}
