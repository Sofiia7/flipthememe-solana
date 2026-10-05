import { AccountRole, getU32Encoder, getU64Encoder, type Address, type Instruction } from '@solana/kit';
import { SYSTEM_PROGRAM_ID } from './constants.ts';
import type { SignerLike } from './instructions.ts';

/** System Program instruction index of `Transfer` (u32 little-endian in the first 4 data bytes). */
const SYSTEM_TRANSFER = 2;

/**
 * System Program `Transfer`: moves `lamports` from `from` (writable signer) to `to` (writable).
 * Data layout: u32 LE 2, then u64 LE lamports (12 bytes).
 */
export function transferSol(i: { from: SignerLike; to: Address; lamports: bigint }): Instruction {
  const data = new Uint8Array(12);
  data.set(getU32Encoder().encode(SYSTEM_TRANSFER) as Uint8Array, 0);
  data.set(getU64Encoder().encode(i.lamports) as Uint8Array, 4);
  const from =
    typeof i.from === 'string'
      ? { address: i.from, role: AccountRole.WRITABLE_SIGNER }
      : { address: i.from.address, role: AccountRole.WRITABLE_SIGNER, signer: i.from };
  return {
    programAddress: SYSTEM_PROGRAM_ID,
    accounts: [from, { address: i.to, role: AccountRole.WRITABLE }],
    data,
  } as Instruction;
}
