import { AccountRole, address, getAddressEncoder, getBase58Encoder, getI64Encoder, getU32Encoder, getU64Encoder, type Address, type Instruction } from '@solana/kit';
import { PROGRAM_ID } from './constants.ts';
import { oracleAddress, roundAddress } from './pda.ts';
import type { RoundAccount } from './accounts.ts';
import type { PriceSample } from './instructions.ts';

export const ED25519_PROGRAM = address('Ed25519SigVerify111111111111111111111111111');
export const INSTRUCTIONS_SYSVAR = address('Sysvar1nstructions1111111111111111111111111');
export const PRICE_DOMAIN = new TextEncoder().encode('FlipTheMeme devnet price v1\0');
export type PriceKind = 'strike' | 'exit';
export type CertificateRound = Pick<RoundAccount, 'id' | 'pool' | 'strikeStart' | 'strikeEnd' | 'exitStart' | 'exitEnd'>;
export type PriceCertificate = { roundId: string; kind: PriceKind; attestor: Address; signature: string; samples: { slot: string; price: string }[] };

const concat = (parts: readonly Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const pubkey = (p: Address) => new Uint8Array(getAddressEncoder().encode(p));
const u64 = (n: bigint) => new Uint8Array(getU64Encoder().encode(n));

export async function priceMessage(round: CertificateRound, kind: PriceKind, samples: readonly PriceSample[], programId: Address = PROGRAM_ID): Promise<Uint8Array> {
  if (samples.length > 16) throw new Error('A certificate holds at most 16 samples');
  const times = kind === 'strike' ? [round.strikeStart, round.strikeEnd] : [round.exitStart, round.exitEnd];
  return concat([PRICE_DOMAIN, pubkey(programId), pubkey(await roundAddress(round.id, programId)), pubkey(round.pool), new Uint8Array([kind === 'strike' ? 0 : 1]),
    ...times.map((t) => new Uint8Array(getI64Encoder().encode(t))), new Uint8Array(getU32Encoder().encode(samples.length)), ...samples.flatMap((s) => [u64(s.slot), u64(s.price)])]);
}

/** One self-contained native verification instruction. The program accepts these exact offsets only. */
export function verifyPriceInstruction(attestor: Address, signature: string, message: Uint8Array): Instruction {
  const sig = new Uint8Array(getBase58Encoder().encode(signature));
  if (sig.length !== 64 || message.length > 65535) throw new Error('Invalid price signature or message length');
  const header = new Uint8Array(16);
  header[0] = 1;
  const view = new DataView(header.buffer);
  [16, 65535, 80, 65535, 112, message.length, 65535].forEach((n, i) => view.setUint16(2 + i * 2, n, true));
  return { programAddress: ED25519_PROGRAM, accounts: [], data: concat([header, sig, pubkey(attestor), message]) };
}

export async function attestedPriceInstructions(round: CertificateRound, kind: PriceKind, samples: readonly PriceSample[], attestor: Address, signature: string, programId: Address = PROGRAM_ID): Promise<Instruction[]> {
  const message = await priceMessage(round, kind, samples, programId);
  // sha256(global:set_strike_attested), sha256(global:settle_attested), first eight bytes.
  const discriminator = kind === 'strike' ? [59, 192, 137, 245, 134, 154, 191, 17] : [36, 146, 167, 174, 227, 157, 188, 192];
  return [verifyPriceInstruction(attestor, signature, message), {
    programAddress: programId,
    accounts: [{ address: await roundAddress(round.id, programId), role: AccountRole.WRITABLE }, { address: await oracleAddress(programId), role: AccountRole.READONLY }, { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY }],
    data: concat([new Uint8Array(discriminator), new Uint8Array(getU32Encoder().encode(samples.length)), ...samples.flatMap((s) => [u64(s.slot), u64(s.price)])]),
  }];
}
