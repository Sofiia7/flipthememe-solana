/**
 * Mainnet price source: PumpSwap (pump.fun AMM) pools quoted in wSOL.
 *
 * - `loadPool` reads the pool account once and finds its two token vaults.
 * - `observePrice` reads both vaults in one `getMultipleAccounts` call (commitment `confirmed`) and
 *   returns the integer price together with the mainnet slot of the read.
 * - `windowMean` turns the observations of one window into the strike or exit price.
 * - `discoverPumpSwapPools` + `passesGate` rank candidate pools from the free GeckoTerminal API;
 *   the SOL depth gate stays on chain (`quoteReserveLamports`).
 * - `fetchNewPumpSwapPools` (the network-wide `new_pools` list, newest first, filtered to PumpSwap),
 *   `fetchPumpSwapPoolsByAddress` (`pools/multi`, up to 30 pools) and `fetchTopPumpSwapPools` (one
 *   page by 24 h transactions) are single GeckoTerminal requests for callers that track fresh pools
 *   over time. GeckoTerminal has no creation-time sort for one dex: `dexes/pumpswap/pools` accepts
 *   only `h24_tx_count_desc` and `h24_volume_usd_desc` (HTTP 400 otherwise, checked 2026-10-05).
 *
 * Units: base amounts are raw base-token units (pump.fun tokens use 6 decimals), quote amounts are
 * wSOL lamports, and `price = quote * PRICE_SCALE / base`, i.e. lamports per raw base unit scaled
 * by 10^12. All amount and price math is bigint.
 */
import {
  address,
  getAddressDecoder,
  getBase64Encoder,
  getU64Decoder,
  isAddress,
  type AccountInfoBase,
  type AccountInfoWithBase64EncodedData,
  type Address,
  type GetAccountInfoApi,
  type GetMultipleAccountsApi,
  type ReadonlyUint8Array,
  type Rpc,
} from '@solana/kit';

export const PUMPSWAP_PROGRAM_ID = address('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const WSOL_MINT = address('So11111111111111111111111111111111111111112');
export const PRICE_SCALE = 10n ** 12n;

const TOKEN_PROGRAM_ID = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const U64_MAX = (1n << 64n) - 1n;

// PumpSwap `Pool` account (301 bytes on mainnet). Anchor discriminator = sha256("account:Pool")[0..8].
const POOL_DISCRIMINATOR: readonly number[] = [241, 154, 109, 4, 17, 177, 109, 188];
const POOL_BASE_MINT_OFFSET = 43;
const POOL_QUOTE_MINT_OFFSET = 75;
const POOL_BASE_VAULT_OFFSET = 139;
const POOL_QUOTE_VAULT_OFFSET = 171;
const POOL_MIN_LENGTH = POOL_QUOTE_VAULT_OFFSET + 32; // 203: everything up to the quote vault

// SPL Token and Token-2022 token accounts share the first 165 bytes: mint @0, owner @32, amount @64.
const TOKEN_ACCOUNT_LENGTH = 165;
const TOKEN_ACCOUNT_MINT_OFFSET = 0;
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;

const WINDOW_MIN_SAMPLES = 5;
const WINDOW_MAX_SAMPLES = 16;

const GECKOTERMINAL_SOLANA_URL = 'https://api.geckoterminal.com/api/v2/networks/solana';
const GECKOTERMINAL_POOLS_URL = `${GECKOTERMINAL_SOLANA_URL}/dexes/pumpswap/pools`;
const GECKOTERMINAL_NEW_POOLS_URL = `${GECKOTERMINAL_SOLANA_URL}/new_pools`;
const GECKOTERMINAL_MULTI_URL = `${GECKOTERMINAL_SOLANA_URL}/pools/multi`;
// GeckoTerminal pins the response format to an API version through the Accept header.
const GECKOTERMINAL_ACCEPT = 'application/json;version=20230203';
const DISCOVERY_PAGES = [1, 2];
const GECKOTERMINAL_SOLANA_PREFIX = 'solana_';
const GECKOTERMINAL_PUMPSWAP_DEX = 'pumpswap';
/** Pools per `pools/multi` request on the free API. */
export const GECKOTERMINAL_MULTI_LIMIT = 30;
/** Pages beyond 10 need a paid plan; every list endpoint serves 20 pools per page. */
export const GECKOTERMINAL_MAX_PAGE = 10;
// Rows whose pool_created_at lies further in the future than this are treated as malformed.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const addressDecoder = getAddressDecoder();
const u64Decoder = getU64Decoder(); // little-endian
const base64Encoder = getBase64Encoder(); // base64 string -> bytes

export type DecodedPumpSwapPool = {
  baseMint: Address;
  quoteMint: Address;
  baseVault: Address;
  quoteVault: Address;
};

export type PoolRef = {
  pool: Address;
  baseMint: Address;
  quoteMint: Address;
  baseVault: Address;
  quoteVault: Address;
};

export type PriceObservation = {
  /** Local wall clock (ms) when the RPC response arrived. */
  atMs: number;
  /** Mainnet slot of the read (response context). */
  slot: bigint;
  baseAmount: bigint;
  quoteAmount: bigint;
  price: bigint;
};

export type WindowMean = { price: bigint; samples: PriceObservation[] };

export type PoolCandidate = {
  pool: Address;
  baseMint: Address;
  name: string;
  reserveUsd: number;
  createdAtMs: number;
  /** Buys + sells over the last 5 minutes. */
  txM5: number;
  volumeH1Usd: number;
};

export type PoolGateOptions = { maxAgeMs: number; minTxM5: number };

export const DEFAULT_POOL_GATE: Readonly<PoolGateOptions> = Object.freeze({
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  minTxM5: 20,
});

/** The subset of `fetch` that discovery needs; the global `fetch` satisfies it. */
export type GeckoTerminalFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * A GeckoTerminal request answered with a non-2xx status. 429 means rate limited (the free API
 * allows about 30 calls per minute per IP).
 */
export class GeckoTerminalHttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(url: string, status: number) {
    super(`GeckoTerminal ${url} answered HTTP ${status}`);
    this.name = 'GeckoTerminalHttpError';
    this.status = status;
    this.url = url;
  }
}

/** One page of the network-wide `new_pools` list: its PumpSwap pools plus the time span of the page. */
export type NewPoolsPage = {
  /** PumpSwap pools quoted in wSOL, in API order (newest first). */
  pumpSwap: PoolCandidate[];
  /** Rows on the page, every dex. */
  rows: number;
  /** Newest and oldest `pool_created_at` on the page, every dex (null when no row carries a valid date). */
  newestCreatedAtMs: number | null;
  oldestCreatedAtMs: number | null;
};

type Base64Account = AccountInfoBase & AccountInfoWithBase64EncodedData;

/** Decodes the four keys the price source needs from raw PumpSwap `Pool` account data. */
export function decodePumpSwapPool(data: ReadonlyUint8Array): DecodedPumpSwapPool {
  if (data.length < POOL_MIN_LENGTH) {
    throw new Error(
      `PumpSwap pool data is ${data.length} bytes, expected at least ${POOL_MIN_LENGTH} (mainnet pools are 301)`,
    );
  }
  for (let i = 0; i < POOL_DISCRIMINATOR.length; i++) {
    if (data[i] !== POOL_DISCRIMINATOR[i]) {
      throw new Error('account data does not start with the PumpSwap Pool discriminator');
    }
  }
  return {
    baseMint: addressDecoder.decode(data, POOL_BASE_MINT_OFFSET),
    quoteMint: addressDecoder.decode(data, POOL_QUOTE_MINT_OFFSET),
    baseVault: addressDecoder.decode(data, POOL_BASE_VAULT_OFFSET),
    quoteVault: addressDecoder.decode(data, POOL_QUOTE_VAULT_OFFSET),
  };
}

/** Reads `amount` (u64 LE @64) from SPL Token or Token-2022 token account data. */
export function readTokenAmount(data: ReadonlyUint8Array): bigint {
  if (data.length < TOKEN_ACCOUNT_LENGTH) {
    throw new Error(
      `token account data is ${data.length} bytes, expected at least ${TOKEN_ACCOUNT_LENGTH}`,
    );
  }
  return u64Decoder.decode(data, TOKEN_ACCOUNT_AMOUNT_OFFSET);
}

/**
 * Integer pool price: `floor(quoteAmount * PRICE_SCALE / baseAmount)`.
 * Throws when the base reserve is not positive or the result does not fit in u64 (the program
 * stores prices as u64).
 */
export function priceOf(baseAmount: bigint, quoteAmount: bigint): bigint {
  if (baseAmount <= 0n) {
    throw new Error(`priceOf: base amount must be positive, got ${baseAmount}`);
  }
  if (quoteAmount < 0n) {
    throw new Error(`priceOf: quote amount must not be negative, got ${quoteAmount}`);
  }
  const price = (quoteAmount * PRICE_SCALE) / baseAmount;
  if (price > U64_MAX) {
    throw new Error(`priceOf: price ${price} does not fit in u64`);
  }
  return price;
}

/**
 * Reads a pool account (base64, commitment `confirmed`) and checks that it is a PumpSwap pool
 * quoted in wSOL.
 */
export async function loadPool(rpc: Rpc<GetAccountInfoApi>, pool: Address): Promise<PoolRef> {
  const { value: account } = await rpc
    .getAccountInfo(pool, { encoding: 'base64', commitment: 'confirmed' })
    .send();
  if (account === null) {
    throw new Error(`PumpSwap pool ${pool} not found`);
  }
  if (account.owner !== PUMPSWAP_PROGRAM_ID) {
    throw new Error(
      `account ${pool} is owned by ${account.owner}, not by the PumpSwap program ${PUMPSWAP_PROGRAM_ID}`,
    );
  }
  const keys = decodePumpSwapPool(base64Encoder.encode(account.data[0]));
  if (keys.quoteMint !== WSOL_MINT) {
    throw new Error(
      `PumpSwap pool ${pool} is quoted in ${keys.quoteMint}, not in wSOL ${WSOL_MINT}`,
    );
  }
  return { pool, ...keys };
}

/**
 * One price observation: both vaults in a single `getMultipleAccounts` call, so the two amounts
 * come from the same slot. `atMs` is taken from `now()` when the response arrives.
 */
export async function observePrice(
  rpc: Rpc<GetMultipleAccountsApi>,
  ref: PoolRef,
  now: () => number = () => Date.now(),
): Promise<PriceObservation> {
  const { context, value } = await rpc
    .getMultipleAccounts([ref.baseVault, ref.quoteVault], {
      encoding: 'base64',
      commitment: 'confirmed',
    })
    .send();
  const atMs = now();
  if (value.length !== 2) {
    throw new Error(`getMultipleAccounts returned ${value.length} accounts for 2 pool vaults`);
  }
  const baseAmount = readVault(value[0], ref.baseVault, ref.baseMint, 'base');
  const quoteAmount = readVault(value[1], ref.quoteVault, ref.quoteMint, 'quote');
  return { atMs, slot: context.slot, baseAmount, quoteAmount, price: priceOf(baseAmount, quoteAmount) };
}

/** SOL depth of the pool: the wSOL amount in the quote vault, in lamports. */
export async function quoteReserveLamports(
  rpc: Rpc<GetAccountInfoApi>,
  ref: PoolRef,
): Promise<bigint> {
  const { value } = await rpc
    .getAccountInfo(ref.quoteVault, { encoding: 'base64', commitment: 'confirmed' })
    .send();
  return readVault(value, ref.quoteVault, ref.quoteMint, 'quote');
}

/**
 * Strike / exit price of one window. Takes the observations with `startMs <= atMs < endMs`, keeps
 * the first observation per slot (array order), sorts them by slot and keeps at most the first 16.
 * Returns null with fewer than 5 samples, otherwise `floor(sum(price) / n)` and the samples used.
 *
 * Mirrors the program's `mean_price`, which rejects the whole instruction when slots are not
 * strictly increasing, there are more than 16 samples, or any price is 0. Zero prices (a drained
 * quote side) are therefore dropped here, so they can only lead to "no price", never to a
 * rejected `set_strike` / `settle`.
 */
export function windowMean(
  observations: readonly PriceObservation[],
  startMs: number,
  endMs: number,
): WindowMean | null {
  const seenSlots = new Set<bigint>();
  const unique: PriceObservation[] = [];
  for (const o of observations) {
    if (o.atMs < startMs || o.atMs >= endMs || o.price <= 0n || seenSlots.has(o.slot)) continue;
    seenSlots.add(o.slot);
    unique.push(o);
  }
  unique.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  const samples = unique.slice(0, WINDOW_MAX_SAMPLES);
  if (samples.length < WINDOW_MIN_SAMPLES) return null;
  let sum = 0n;
  for (const s of samples) sum += s.price;
  return { price: sum / BigInt(samples.length), samples };
}

/**
 * Candidate pools from GeckoTerminal (pages 1 and 2 of PumpSwap pools by 24h transactions),
 * de-duplicated by pool and sorted by 5-minute transactions, most active first (ties keep the API
 * order). Rows that are malformed, not quoted in wSOL, or dated more than 5 minutes after `nowMs`
 * are skipped. Throws when a page request fails or its body has no `data` array.
 */
export async function discoverPumpSwapPools(
  fetchFn: GeckoTerminalFetch = fetch,
  nowMs: number = Date.now(),
): Promise<PoolCandidate[]> {
  const byPool = new Map<Address, PoolCandidate>();
  for (const page of DISCOVERY_PAGES) {
    for (const candidate of await fetchTopPumpSwapPools(fetchFn, page, nowMs)) {
      if (!byPool.has(candidate.pool)) {
        byPool.set(candidate.pool, candidate);
      }
    }
  }
  return [...byPool.values()].sort((a, b) => b.txM5 - a.txM5);
}

/**
 * One page (1..10) of PumpSwap pools by 24 h transactions, in API order. Rows that are malformed,
 * not quoted in wSOL, or dated more than 5 minutes after `nowMs` are skipped. Throws
 * `GeckoTerminalHttpError` on an HTTP error and an `Error` when the body has no `data` array.
 */
export async function fetchTopPumpSwapPools(
  fetchFn: GeckoTerminalFetch = fetch,
  page: number = 1,
  nowMs: number = Date.now(),
): Promise<PoolCandidate[]> {
  const rows = await geckoRows(fetchFn, `${GECKOTERMINAL_POOLS_URL}?page=${checkPage(page)}&sort=h24_tx_count_desc`);
  return uniqueCandidates(rows, nowMs, () => true);
}

/**
 * One page (1..10) of GeckoTerminal `new_pools` for Solana: the newest pools of every dex, newest
 * first, 20 per page (cached up to 60 s by the API). Keeps the PumpSwap pools quoted in wSOL and
 * reports the creation-time span of the whole page, so a caller can tell whether consecutive reads
 * overlap. Errors as in `fetchTopPumpSwapPools`.
 */
export async function fetchNewPumpSwapPools(
  fetchFn: GeckoTerminalFetch = fetch,
  page: number = 1,
  nowMs: number = Date.now(),
): Promise<NewPoolsPage> {
  const rows = await geckoRows(fetchFn, `${GECKOTERMINAL_NEW_POOLS_URL}?page=${checkPage(page)}`);
  let newest: number | null = null;
  let oldest: number | null = null;
  for (const row of rows) {
    const createdAtMs = createdAtOf(row, nowMs);
    if (createdAtMs === null) continue;
    if (newest === null || createdAtMs > newest) newest = createdAtMs;
    if (oldest === null || createdAtMs < oldest) oldest = createdAtMs;
  }
  return {
    pumpSwap: uniqueCandidates(rows, nowMs, (row) => dexOf(row) === GECKOTERMINAL_PUMPSWAP_DEX),
    rows: rows.length,
    newestCreatedAtMs: newest,
    oldestCreatedAtMs: oldest,
  };
}

/**
 * Current GeckoTerminal data of up to 30 pools in one `pools/multi` request, in the order asked
 * (duplicates asked once). Pools that GeckoTerminal does not return, lists under another dex, or
 * that are not quoted in wSOL are left out. No request for an empty list. Errors as in
 * `fetchTopPumpSwapPools`; more than 30 distinct pools throw a `RangeError`.
 */
export async function fetchPumpSwapPoolsByAddress(
  fetchFn: GeckoTerminalFetch = fetch,
  pools: readonly Address[],
  nowMs: number = Date.now(),
): Promise<PoolCandidate[]> {
  const wanted = [...new Set(pools)];
  if (wanted.length === 0) return [];
  if (wanted.length > GECKOTERMINAL_MULTI_LIMIT) {
    throw new RangeError(`pools/multi takes at most ${GECKOTERMINAL_MULTI_LIMIT} pools, got ${wanted.length}`);
  }
  const rows = await geckoRows(fetchFn, `${GECKOTERMINAL_MULTI_URL}/${wanted.join(',')}`);
  // A row without dex information is kept: the pool was asked for by address, and the caller
  // checks the PumpSwap owner on chain anyway.
  const found = new Map<Address, PoolCandidate>();
  for (const c of uniqueCandidates(rows, nowMs, (row) => (dexOf(row) ?? GECKOTERMINAL_PUMPSWAP_DEX) === GECKOTERMINAL_PUMPSWAP_DEX)) {
    found.set(c.pool, c);
  }
  return wanted.flatMap((pool) => found.get(pool) ?? []);
}

/**
 * Age and activity gate (pool younger than `maxAgeMs`, at least `minTxM5` transactions in 5
 * minutes). The SOL depth gate is checked on chain by the caller.
 */
export function passesGate(
  c: PoolCandidate,
  nowMs: number,
  opts: PoolGateOptions = DEFAULT_POOL_GATE,
): boolean {
  const ageMs = nowMs - c.createdAtMs;
  return ageMs < opts.maxAgeMs && c.txM5 >= opts.minTxM5;
}

function readVault(
  account: Base64Account | null,
  vault: Address,
  expectedMint: Address,
  side: 'base' | 'quote',
): bigint {
  if (account === null) {
    throw new Error(`PumpSwap ${side} vault ${vault} not found`);
  }
  if (account.owner !== TOKEN_PROGRAM_ID && account.owner !== TOKEN_2022_PROGRAM_ID) {
    throw new Error(`PumpSwap ${side} vault ${vault} is owned by ${account.owner}, not a token program`);
  }
  const data = base64Encoder.encode(account.data[0]);
  const amount = readTokenAmount(data);
  const mint = addressDecoder.decode(data, TOKEN_ACCOUNT_MINT_OFFSET);
  if (mint !== expectedMint) {
    throw new Error(`PumpSwap ${side} vault ${vault} holds mint ${mint}, expected ${expectedMint}`);
  }
  return amount;
}

async function geckoRows(fetchFn: GeckoTerminalFetch, url: string): Promise<unknown[]> {
  const res = await fetchFn(url, { headers: { accept: GECKOTERMINAL_ACCEPT } });
  if (!res.ok) {
    throw new GeckoTerminalHttpError(url, res.status);
  }
  const rows = field(await res.json(), 'data');
  if (!Array.isArray(rows)) {
    throw new Error(`GeckoTerminal ${url} returned no data array`);
  }
  return rows;
}

function checkPage(page: number): number {
  if (!Number.isSafeInteger(page) || page < 1 || page > GECKOTERMINAL_MAX_PAGE) {
    throw new RangeError(`GeckoTerminal page must be 1..${GECKOTERMINAL_MAX_PAGE}, got ${page}`);
  }
  return page;
}

/** Parsed candidates of the rows that `keep` accepts, first occurrence of each pool, API order. */
function uniqueCandidates(rows: readonly unknown[], nowMs: number, keep: (row: unknown) => boolean): PoolCandidate[] {
  const seen = new Set<Address>();
  const out: PoolCandidate[] = [];
  for (const row of rows) {
    if (!keep(row)) continue;
    const candidate = parseCandidate(row, nowMs);
    if (candidate === null || seen.has(candidate.pool)) continue;
    seen.add(candidate.pool);
    out.push(candidate);
  }
  return out;
}

function dexOf(row: unknown): string | null {
  const id = field(row, 'relationships', 'dex', 'data', 'id');
  return typeof id === 'string' ? id : null;
}

function createdAtOf(row: unknown, nowMs: number): number | null {
  const createdAt = field(row, 'attributes', 'pool_created_at');
  const createdAtMs = typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN;
  return Number.isFinite(createdAtMs) && createdAtMs <= nowMs + MAX_CLOCK_SKEW_MS ? createdAtMs : null;
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function solanaMint(id: unknown): Address | null {
  if (typeof id !== 'string' || !id.startsWith(GECKOTERMINAL_SOLANA_PREFIX)) return null;
  const mint = id.slice(GECKOTERMINAL_SOLANA_PREFIX.length);
  return isAddress(mint) ? mint : null;
}

function txCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// GeckoTerminal sends USD figures as decimal strings ("157418.2123").
function usdAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) return Number(value);
  return null;
}

function parseCandidate(row: unknown, nowMs: number): PoolCandidate | null {
  const pool = field(row, 'attributes', 'address');
  if (typeof pool !== 'string' || !isAddress(pool)) return null;
  const baseMint = solanaMint(field(row, 'relationships', 'base_token', 'data', 'id'));
  const quoteMint = solanaMint(field(row, 'relationships', 'quote_token', 'data', 'id'));
  if (baseMint === null || baseMint === WSOL_MINT || quoteMint !== WSOL_MINT) return null;
  const name = field(row, 'attributes', 'name');
  if (typeof name !== 'string') return null;
  const createdAtMs = createdAtOf(row, nowMs);
  if (createdAtMs === null) return null;
  const buys = txCount(field(row, 'attributes', 'transactions', 'm5', 'buys'));
  const sells = txCount(field(row, 'attributes', 'transactions', 'm5', 'sells'));
  if (buys === null || sells === null) return null;
  const reserveUsd = usdAmount(field(row, 'attributes', 'reserve_in_usd'));
  const volumeH1Usd = usdAmount(field(row, 'attributes', 'volume_usd', 'h1'));
  if (reserveUsd === null || volumeH1Usd === null) return null;
  return { pool, baseMint, name, reserveUsd, createdAtMs, txM5: buys + sells, volumeH1Usd };
}
