import { getAddressEncoder, getProgramDerivedAddress, getU64Encoder, type Address } from '@solana/kit';
import { PROGRAM_ID } from './constants.ts';

const addressBytes = getAddressEncoder();
const u64 = getU64Encoder();

async function pda(seeds: (string | Uint8Array)[], programId: Address): Promise<Address> {
  const [found] = await getProgramDerivedAddress({ programAddress: programId, seeds });
  return found;
}

export function configAddress(programId: Address = PROGRAM_ID): Promise<Address> {
  return pda(['config'], programId);
}

export function vaultAddress(owner: Address, programId: Address = PROGRAM_ID): Promise<Address> {
  return pda(['vault', addressBytes.encode(owner) as Uint8Array], programId);
}

export function sessionAddress(vault: Address, signer: Address, programId: Address = PROGRAM_ID): Promise<Address> {
  return pda(['session', addressBytes.encode(vault) as Uint8Array, addressBytes.encode(signer) as Uint8Array], programId);
}

export function roundAddress(id: bigint, programId: Address = PROGRAM_ID): Promise<Address> {
  return pda(['round', u64.encode(id) as Uint8Array], programId);
}

export function positionAddress(round: Address, owner: Address, programId: Address = PROGRAM_ID): Promise<Address> {
  return pda(['position', addressBytes.encode(round) as Uint8Array, addressBytes.encode(owner) as Uint8Array], programId);
}
