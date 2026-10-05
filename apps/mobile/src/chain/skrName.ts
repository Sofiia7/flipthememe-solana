// Pure parts of the Seeker ID lookup (chain/skr.ts), kept free of React Native for node:test.
import { getUtf8Decoder } from '@solana/kit';

/** ANS name record header: discriminator, parent, owner, class, expiry, creation, flags, padding. */
const HEADER_BYTES = 200;
/** One plain label; anything else (dots, spaces, invisible characters) is not shown. */
const LABEL = /^[\p{L}\p{N}\p{M}_-]{1,63}$/u;

/** "<label>.skr" from a reverse lookup account's data, or null. */
export function nameFromRecord(data: Uint8Array): string | null {
  const label = getUtf8Decoder().decode(data.subarray(HEADER_BYTES)).split('\0')[0];
  return LABEL.test(label) ? `${label}.skr` : null;
}

/** Several names: case-blind order, then code point, so the pick never depends on RPC order. */
export function pickName(names: readonly string[]): string | null {
  return [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || (a < b ? -1 : a > b ? 1 : 0))[0] ?? null;
}
