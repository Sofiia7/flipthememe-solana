// Pure parts of the Seeker Genesis Token (SGT) check (chain/sgt.ts), free of React Native for node:test.
//
// An SGT is a Token-2022 mint with decimals 0, minted once per Seeker into the primary Seed Vault
// account. Solana Mobile's verification recipe (docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token):
// list the wallet's Token-2022 accounts, skip the empty ones (a transferred SGT leaves an empty
// account), decode each mint and require BOTH extensions: MetadataPointer.metadataAddress and
// TokenGroupMember.group equal to the SGT group address below. Only the group's authority can add
// members, so a look-alike mint cannot join the group.
export const SGT_GROUP = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export type SeekerGenesis = {
  /** The SGT mint (one per device, usable as an anti-sybil key). */
  mint: string;
  /** Position in the SGT group ("Seeker #31988"), when the mint reports it. */
  memberNumber: number | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Mints of the non-empty token accounts in a `getTokenAccountsByOwner` jsonParsed `value` array. */
export function heldMints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const mints = new Set<string>();
  for (const row of value) {
    const info = isRecord(row) && isRecord(row.account) && isRecord(row.account.data) && isRecord(row.account.data.parsed) ? row.account.data.parsed.info : null;
    if (!isRecord(info) || typeof info.mint !== 'string' || !isRecord(info.tokenAmount)) continue;
    const amount = info.tokenAmount.amount;
    if (typeof amount === 'string' && /^\d+$/.test(amount) && BigInt(amount) > 0n) mints.add(info.mint);
  }
  return [...mints];
}

/** The SGT facts of one mint account (jsonParsed `getMultipleAccounts` entry), or null when it is not an SGT. */
export function seekerGenesisFromMint(mint: string, account: unknown): SeekerGenesis | null {
  if (!isRecord(account) || account.owner !== TOKEN_2022_PROGRAM || !isRecord(account.data) || !isRecord(account.data.parsed)) return null;
  const info = account.data.parsed.info;
  if (!isRecord(info) || info.decimals !== 0 || !Array.isArray(info.extensions)) return null;
  const extensions: unknown[] = info.extensions;
  const state = (name: string): Record<string, unknown> | null => {
    const ext = extensions.find((e) => isRecord(e) && e.extension === name);
    return isRecord(ext) && isRecord(ext.state) ? ext.state : null;
  };
  const pointer = state('metadataPointer');
  const member = state('tokenGroupMember');
  if (!pointer || !member) return null;
  if (pointer.metadataAddress !== SGT_GROUP || member.group !== SGT_GROUP) return null;
  return { mint, memberNumber: typeof member.memberNumber === 'number' ? member.memberNumber : null };
}

/** The first SGT among the parsed mint accounts (same order as `mints`), or null. */
export function firstSeekerGenesis(mints: readonly string[], accounts: readonly unknown[]): SeekerGenesis | null {
  for (let i = 0; i < mints.length; i++) {
    const found = seekerGenesisFromMint(mints[i]!, accounts[i]);
    if (found) return found;
  }
  return null;
}

/** "SEEKER #31988", or "SEEKER" when the number is unknown. */
export function seekerLabel(sgt: SeekerGenesis): string {
  return sgt.memberNumber === null ? 'SEEKER' : `SEEKER #${sgt.memberNumber}`;
}
