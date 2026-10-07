/**
 * Is the pool's token safe to play? Read from mainnet once per mint, answered from memory for 30
 * minutes after that (selector.ts asks before it picks a pool):
 *
 * - SPL Mint layout (82 bytes): mint_authority COption<Pubkey> @0 (a u32 tag, then 32 bytes), supply
 *   u64 @36, decimals @44, is_initialized @45, freeze_authority COption<Pubkey> @46. Both authorities
 *   must be revoked (tag 0): with a mint authority anyone holding it prints supply into the pool, with a
 *   freeze authority it freezes the accounts it likes. pump.fun revokes both at launch;
 * - the owner of the mint is the Token or the Token-2022 program. Token-2022 mints are padded to 165
 *   bytes, carry the account type (1 = mint) @165 and a TLV list of extensions from 166 (u16 type, u16
 *   length, value). Token-2022 without a dangerous extension is fine, pump.fun mints can be Token-2022.
 *   Refused: TransferFeeConfig, TransferHook, PermanentDelegate, NonTransferable, Pausable, and
 *   DefaultAccountState set to frozen;
 * - holders: getTokenLargestAccounts lists the 20 biggest token accounts. The biggest one that is not the
 *   pool's own base vault must hold at most HOLDER_MAX_PCT percent of the supply (20 by default): in a pool
 *   where one account holds more, that account moves the price and can also bet.
 *
 * The mint checks fail closed in the selector: an RPC error reading the mint is thrown from here (not
 * cached) and the candidate is skipped for this refresh. The holder check is best effort: the public
 * mainnet RPCs rate limit or block getTokenLargestAccounts, so when it cannot be read the verdict stands
 * on the mint checks, is marked `holders: 'unchecked'` and is looked at again after five minutes.
 */
import { getBase64Encoder, type Address } from '@solana/kit';
import type { FailoverRpc, SolanaRpc } from './rpc.ts';

/** `holders: 'unchecked'` when the holder list could not be read (the mint checks still passed). */
export type TokenVerdict = { ok: true; supply: bigint; holders?: 'unchecked' } | { ok: false; reason: string };

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** A refused mint is remembered as long as an accepted one. */
export const TOKEN_CACHE_TTL_MS = 30 * 60_000;
export const DEFAULT_HOLDER_MAX_PCT = 20;
/** A verdict that lacks holder data is read again after this long. */
export const UNCHECKED_TTL_MS = 5 * 60_000;

const MINT_LENGTH = 82;
const MINT_AUTHORITY_TAG_OFFSET = 0;
const SUPPLY_OFFSET = 36;
const IS_INITIALIZED_OFFSET = 45;
const FREEZE_AUTHORITY_TAG_OFFSET = 46;
/** Token-2022: account type byte, then the TLV list. */
const ACCOUNT_TYPE_OFFSET = 165;
const ACCOUNT_TYPE_MINT = 1;
const TLV_OFFSET = ACCOUNT_TYPE_OFFSET + 1;

/** spl_token_2022 ExtensionType numbers that a pool must not have. */
const EXTENSION = {
  Uninitialized: 0,
  TransferFeeConfig: 1,
  DefaultAccountState: 6,
  NonTransferable: 9,
  PermanentDelegate: 12,
  TransferHook: 14,
  Pausable: 26,
} as const;
const DANGEROUS_EXTENSIONS: ReadonlyMap<number, string> = new Map([
  [EXTENSION.TransferFeeConfig, 'transfer fee extension'],
  [EXTENSION.NonTransferable, 'non-transferable extension'],
  [EXTENSION.PermanentDelegate, 'permanent delegate extension'],
  [EXTENSION.TransferHook, 'transfer hook extension'],
  [EXTENSION.Pausable, 'pausable extension'],
]);
/** AccountState::Frozen as DefaultAccountState stores it. */
const ACCOUNT_STATE_FROZEN = 2;

const u16 = (data: Uint8Array, at: number): number => (data[at] ?? 0) | ((data[at + 1] ?? 0) << 8);
const u32 = (data: Uint8Array, at: number): number => u16(data, at) + u16(data, at + 2) * 0x1_0000;
const u64 = (data: Uint8Array, at: number): bigint => new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(at, true);

/**
 * The verdict on the mint account alone: owner, authorities, Token-2022 extensions. `data` is the whole
 * account data. A mint that cannot be read as one is refused.
 */
export function inspectMint(owner: string, data: Uint8Array): TokenVerdict {
  if (owner !== TOKEN_PROGRAM_ID && owner !== TOKEN_2022_PROGRAM_ID) return { ok: false, reason: `not owned by a token program (${owner})` };
  if (data.length < MINT_LENGTH) return { ok: false, reason: `mint account is ${data.length} bytes, expected at least ${MINT_LENGTH}` };
  if (data[IS_INITIALIZED_OFFSET] !== 1) return { ok: false, reason: 'mint is not initialized' };
  const mintTag = u32(data, MINT_AUTHORITY_TAG_OFFSET);
  const freezeTag = u32(data, FREEZE_AUTHORITY_TAG_OFFSET);
  if (mintTag > 1 || freezeTag > 1) return { ok: false, reason: 'mint authority fields are malformed' };
  if (mintTag === 1) return { ok: false, reason: 'mint authority is not revoked' };
  if (freezeTag === 1) return { ok: false, reason: 'freeze authority is not revoked' };
  if (owner === TOKEN_2022_PROGRAM_ID && data.length > MINT_LENGTH) {
    const dangerous = dangerousExtension(data);
    if (dangerous) return { ok: false, reason: dangerous };
  }
  const supply = u64(data, SUPPLY_OFFSET);
  if (supply <= 0n) return { ok: false, reason: 'supply is zero' };
  return { ok: true, supply };
}

/** The reason of the first dangerous extension in a Token-2022 mint, or null (also for a layout that is not a mint's: refused). */
function dangerousExtension(data: Uint8Array): string | null {
  if (data.length <= ACCOUNT_TYPE_OFFSET) return 'token-2022 mint is shorter than its account type byte';
  if (data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) return 'token-2022 account type is not a mint';
  let at = TLV_OFFSET;
  while (at + 4 <= data.length) {
    const type = u16(data, at);
    const length = u16(data, at + 2);
    if (type === EXTENSION.Uninitialized) break; // zero padding after the last entry
    if (at + 4 + length > data.length) return 'token-2022 extension list is malformed';
    const reason = DANGEROUS_EXTENSIONS.get(type);
    if (reason) return reason;
    if (type === EXTENSION.DefaultAccountState && data[at + 4] === ACCOUNT_STATE_FROZEN) return 'default account state is frozen';
    at += 4 + length;
  }
  return null;
}

export type LargestAccount = { address: string; amount: string };

/**
 * The reason when the biggest token account that is not one of `excluded` (the pool's base vault) holds
 * more than `maxBps` basis points of `supply`; null otherwise. `maxBps` is a share of the supply, 2000 = 20 %.
 */
export function holderConcentration(largest: readonly LargestAccount[], excluded: ReadonlySet<string>, supply: bigint, maxBps: number): string | null {
  let top: bigint = 0n;
  let topAddress = '';
  for (const account of largest) {
    if (excluded.has(account.address)) continue;
    const amount = BigInt(account.amount);
    if (amount > top) {
      top = amount;
      topAddress = account.address;
    }
  }
  if (top * 10_000n <= supply * BigInt(Math.round(maxBps))) return null;
  const pct = Number((top * 10_000n) / supply) / 100;
  return `top holder ${topAddress} has ${pct}% of the supply (limit ${maxBps / 100}%)`;
}

type Entry = { verdict: TokenVerdict; vault: string; atMs: number };

export class TokenChecker {
  private readonly mainnet: Pick<FailoverRpc, 'call'>;
  private readonly maxBps: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, Entry>();
  /** Reads that went to the RPC (a cache hit does not count). */
  reads = 0;
  /** Verdicts given without holder data because getTokenLargestAccounts failed. */
  holderUnchecked = 0;

  constructor(opts: { mainnet: Pick<FailoverRpc, 'call'>; holderMaxPct?: number; ttlMs?: number; now?: () => number }) {
    this.mainnet = opts.mainnet;
    this.maxBps = Math.round((opts.holderMaxPct ?? DEFAULT_HOLDER_MAX_PCT) * 100);
    this.ttlMs = opts.ttlMs ?? TOKEN_CACHE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * The verdict on `mint` for the pool whose base vault is `baseVault`. Throws when the mint cannot be
   * read (the caller fails closed); a missing holder list does not throw (see `read`). A verdict is
   * kept for the TTL, an error is not.
   */
  async check(mint: Address, baseVault: Address): Promise<TokenVerdict> {
    const now = this.now();
    const known = this.cache.get(mint);
    const life = known && known.verdict.ok && known.verdict.holders === 'unchecked' ? Math.min(this.ttlMs, UNCHECKED_TTL_MS) : this.ttlMs;
    if (known && known.vault === baseVault && now - known.atMs < life) return known.verdict;
    this.reads++;
    const verdict = await this.mainnet.call('tokenCheck', (rpc) => this.read(rpc, mint, baseVault));
    this.cache.set(mint, { verdict, vault: baseVault, atMs: this.now() });
    for (const [key, entry] of this.cache) if (this.now() - entry.atMs >= this.ttlMs) this.cache.delete(key);
    return verdict;
  }

  private async read(rpc: SolanaRpc, mint: Address, baseVault: Address): Promise<TokenVerdict> {
    const { value: account } = await rpc.getAccountInfo(mint, { encoding: 'base64', commitment: 'confirmed' }).send();
    if (account === null) return { ok: false, reason: 'mint account not found' };
    const data = new Uint8Array(getBase64Encoder().encode(account.data[0]));
    const mintVerdict = inspectMint(account.owner, data);
    if (!mintVerdict.ok) return mintVerdict;
    // Best effort: the public mainnet RPCs rate limit getTokenLargestAccounts (429) or block it, and a
    // check that stops the arena whenever they do would be worse than the risk it covers. The mint
    // checks above are mandatory (getAccountInfo works everywhere); without holder data the verdict
    // rests on them alone and is looked at again sooner.
    let largest: readonly { address: unknown; amount: string }[];
    try {
      ({ value: largest } = await rpc.getTokenLargestAccounts(mint, { commitment: 'confirmed' }).send());
    } catch {
      this.holderUnchecked++;
      return { ...mintVerdict, holders: 'unchecked' };
    }
    const reason = holderConcentration(
      largest.map((a) => ({ address: String(a.address), amount: a.amount })),
      new Set<string>([baseVault]),
      mintVerdict.supply,
      this.maxBps,
    );
    return reason ? { ok: false, reason } : mintVerdict;
  }
}
