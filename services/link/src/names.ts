// Seeker ID names for the app's player rows: wallet address -> .skr name (AllDomains ANS, Solana mainnet).
//
//   GET /v1/names?a=<addr>,<addr>,...   {"names": {"<addr>": "oxbla.skr" | null}}
//
// Up to 20 distinct base58 addresses and at most 10 getProgramAccounts calls (fallbacks included) per
// request. null: the address has no .skr name. An address left out of "names": its lookup failed (RPC
// down, slow or rate limited) or the request ran out of getProgramAccounts calls, ask again later.
//
// OPTIONAL: the app resolves .skr names itself on mainnet (apps/mobile/src/chain/skr.ts) and does not
// call this route. It stays for other clients; every cache miss is one getProgramAccounts on the keyed
// MAINNET_RPC, which is why the limits above exist.
//
// The reads are the ones @onsol/tldparser makes for getParsedAllUserDomainsFromTld(owner, 'skr'),
// done with plain JSON-RPC so the Worker carries no Solana SDK:
//   1. getProgramAccounts on the ANS program: name records under the .skr TLD (parent at offset 8)
//      owned by the address (owner at offset 40);
//   2. getMultipleAccounts on each record's reverse lookup account, a PDA of the record address under
//      the .skr TLD house; its data after the 200-byte record header is the name.
// Several names: sorted the way tldparser sorts them, the first one is shown.
// tldparser also looks for names wrapped as NFTs: .skr names are non-transferable, none is wrapped.
// Always mainnet, although the game runs on devnet: Seeker IDs live there.
//
// RPC: MAINNET_RPC first, then the public endpoints. A deployed Worker cannot do step 1 on the public
// ones: api.mainnet-beta.solana.com refuses Worker traffic (it blocks the CF-Worker header Cloudflare
// adds to every subrequest) and publicnode wants a personal token for getProgramAccounts. So production
// needs MAINNET_RPC (a keyed provider); the public endpoints still serve local runs and step 2.

export interface NamesEnv {
  /** Mainnet RPC URL that allows getProgramAccounts (a keyed provider). Tried first; needed once deployed. */
  MAINNET_RPC?: string;
}

type Ctx = { waitUntil(promise: Promise<unknown>): void };

const ANS_PROGRAM = 'ALTNSZ46uaAUU7XUV6awvdorLGqAsPwa9shm7h4uP2FK';
/** Name record of the .skr TLD: ANS PDA of [hash('.skr'), zero class, the ANS origin record]. */
export const SKR_PARENT = 'F3A8kuikEiu6k2399oSJ1PWfcJYDHqpwoQ2e8psSDNuF';
/** TLD house of .skr: PDA of the TLD House program over ['tld_house', '.skr']; class of every reverse lookup. */
export const SKR_TLD_HOUSE = '4RKP4BEMu5sXBfXSH7xN2owtQrnAJvhhwtBBmj9JEYkA';
/** Name record header: discriminator, parent, owner, class, expiry, creation, flags, padding. */
const HEADER_BYTES = 200;

const MAINNET_BETA = 'https://api.mainnet-beta.solana.com';
/** Refuses getProgramAccounts without a personal token (403), so it only serves plain account reads. */
const PUBLICNODE = 'https://solana-rpc.publicnode.com';

const MAX_ADDRESSES = 20;
/**
 * getProgramAccounts calls one request may make, every try at a fallback endpoint counted: one cache
 * miss costs one on a keyed provider, so a request with 20 misses must not cost 20 (and 40 with a
 * failing first endpoint). The addresses left over are answered by a later request.
 */
export const MAX_GPA_CALLS = 10;
const CALL_MS = 4_000;
/** Whole request: cache reads, lookups and fallbacks together. */
const BUDGET_MS = 7_000;
/** Workers keep at most six subrequests waiting for headers anyway. */
const CONCURRENCY = 5;
/** getProgramAccounts starts at most this often: Helius' free tier allows 5 a second, bursts get 429. */
const GPA_GAP_MS = 220;
const FOUND_TTL_S = 12 * 3600;
const NONE_TTL_S = 3600;
const CACHE_PREFIX = 'https://sol.flipthememe.com/__names/';

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** One label of letters, digits, marks, hyphens or underscores (.skr names seen on chain: a-z, 0-9, hyphen).
 *  Anything else (dots, spaces, control or invisible characters) is not shown. */
const LABEL = /^[\p{L}\p{N}\p{M}_-]{1,63}$/u;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const digit = ALPHABET.indexOf(c);
    if (digit < 0) return null;
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  for (; n > 0n; n >>= 8n) bytes.push(Number(n & 255n));
  for (let i = 0; i < s.length && s[i] === '1'; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  for (; n > 0n; n /= 58n) s = ALPHABET[Number(n % 58n)] + s;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) s = '1' + s;
  return s;
}

/** Distinct addresses from "a,b,c", or null when anything is off. Strict: the app sends exactly this. */
export function parseAddresses(raw: string | null): string[] | null {
  if (!raw || raw.length > 4096) return null;
  const list = [...new Set(raw.split(','))];
  if (list.length > MAX_ADDRESSES) return null;
  return list.every((a) => ADDRESS.test(a) && base58Decode(a)?.length === 32) ? list : null;
}

// ed25519 point check: a PDA is a hash that is not a valid public key, i.e. no x satisfies
// -x^2 + y^2 = 1 + d x^2 y^2 for the y its 32 bytes encode. The answers of web3.js and @solana/addresses,
// from a Legendre symbol instead of a square root: a sixth of the CPU time, which Workers Free caps at 10 ms.
const P = 2n ** 255n - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const mod = (a: bigint) => ((a % P) + P) % P;

/** Jacobi symbol (a/n) for odd n, by the binary algorithm; for the prime p it is the Legendre symbol. */
function jacobi(a: bigint, n: bigint): number {
  let t = 1;
  a %= n;
  while (a !== 0n) {
    while ((a & 1n) === 0n) {
      a >>= 1n;
      const r = n & 7n;
      if (r === 3n || r === 5n) t = -t;
    }
    [a, n] = [n, a];
    if ((a & 3n) === 3n && (n & 3n) === 3n) t = -t;
    a %= n;
  }
  return n === 1n ? t : 0;
}

export function isOnCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n); // never 0: -1/d is not a square
  if (u === 0n) return (bytes[31] & 0x80) === 0; // x = 0 cannot carry a sign bit
  return jacobi(mod(u * v), P) === 1; // x^2 = u/v has a root exactly when u*v is a square
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', all));
}

/** The name hash every ANS seed uses. */
export const hashedName = (name: string) => sha256(new TextEncoder().encode(`ALT Name Service${name}`));

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

/** findProgramAddress: the first bump from 255 down whose hash is off the curve. */
export async function findPda(seeds: Uint8Array[], program: string): Promise<string> {
  const programBytes = base58Decode(program)!;
  for (let bump = 255; bump > 0; bump--) {
    const hash = await sha256(...seeds, Uint8Array.of(bump), programBytes, PDA_MARKER);
    if (!isOnCurve(hash)) return base58Encode(hash);
  }
  throw new Error('no PDA bump');
}

/** Reverse lookup account of a .skr name record; its data after the header is the name. */
export async function reverseLookup(record: string): Promise<string> {
  return findPda([await hashedName(record), base58Decode(SKR_TLD_HOUSE)!, new Uint8Array(32)], ANS_PROGRAM);
}

type Account = { data?: unknown; owner?: unknown } | null;

/** "<label>.skr" from a reverse lookup account, or null when it is missing or does not hold a plain label. */
export function nameOf(account: Account): string | null {
  if (!account || account.owner !== ANS_PROGRAM || !Array.isArray(account.data) || typeof account.data[0] !== 'string') {
    return null;
  }
  try {
    const bytes = Uint8Array.from(atob(account.data[0]), (c) => c.charCodeAt(0));
    const label = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(HEADER_BYTES)).split('\0')[0];
    return LABEL.test(label) ? `${label}.skr` : null;
  } catch {
    return null;
  }
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** tldparser's order (numeric, case-blind), ties broken by code point so RPC order never changes the pick. */
export function pickName(found: string[]): string | null {
  return [...found].sort((a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0))[0] ?? null;
}

type Rpc = { own: string[]; down: Set<string>; deadline: number; gpaLeft: number };

/** Endpoints still worth a try in this request; `indexed`: the call is getProgramAccounts. */
const endpoints = (rpc: Rpc, indexed: boolean) =>
  [...rpc.own, MAINNET_BETA, ...(indexed ? [] : [PUBLICNODE])].filter((url) => !rpc.down.has(url));

/** One JSON-RPC call, endpoint by endpoint. An endpoint that fails is skipped for the rest of the request. */
async function call<T>(rpc: Rpc, indexed: boolean, method: string, params: unknown[]): Promise<T> {
  for (const url of endpoints(rpc, indexed)) {
    const left = rpc.deadline - Date.now();
    if (left <= 0) break;
    if (rpc.down.has(url)) continue; // dropped by a parallel call meanwhile
    if (indexed) {
      if (rpc.gpaLeft <= 0) break;
      rpc.gpaLeft--;
    }
    // Only the host is logged: a keyed MAINNET_RPC carries its key in the URL.
    const host = new URL(url).host;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(Math.min(CALL_MS, left)),
      });
      const body = (await res.json()) as { result?: T; error?: { message?: string } };
      if (res.ok && body.result !== undefined && body.result !== null) return body.result;
      console.warn(`names: ${method} on ${host}: ${res.status} ${body.error?.message ?? 'no result'}`);
    } catch (e) {
      console.warn(`names: ${method} on ${host}: ${e instanceof Error ? e.message : e}`);
    }
    rpc.down.add(url);
  }
  throw new Error(`${method}: no RPC answered`);
}

/** Addresses of the .skr name records `owner` holds. */
async function records(rpc: Rpc, owner: string): Promise<string[]> {
  const found = await call<{ pubkey?: unknown }[]>(rpc, true, 'getProgramAccounts', [
    ANS_PROGRAM,
    {
      encoding: 'base64',
      dataSlice: { offset: 0, length: 0 },
      filters: [{ memcmp: { offset: 8, bytes: SKR_PARENT } }, { memcmp: { offset: 40, bytes: owner } }],
    },
  ]);
  if (!Array.isArray(found) || !found.every((a) => typeof a.pubkey === 'string' && ADDRESS.test(a.pubkey))) {
    throw new Error('getProgramAccounts: unexpected result');
  }
  return found.map((a) => a.pubkey as string);
}

/** The name in each record's reverse lookup account, in order (null where there is none). */
async function reverseNames(rpc: Rpc, recordKeys: string[]): Promise<(string | null)[]> {
  const keys = await Promise.all(recordKeys.map(reverseLookup));
  const labels: (string | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const got = await call<{ value?: unknown }>(rpc, false, 'getMultipleAccounts', [chunk, { encoding: 'base64' }]);
    if (!Array.isArray(got.value) || got.value.length !== chunk.length) throw new Error('getMultipleAccounts: unexpected result');
    labels.push(...(got.value as Account[]).map(nameOf));
  }
  return labels;
}

function ownRpc(url: string | undefined): string[] {
  if (!url) return [];
  try {
    if (new URL(url).protocol === 'https:') return [url];
  } catch {
    // reported below
  }
  console.warn('names: MAINNET_RPC is not an https URL, using the public RPCs');
  return [];
}

/** .skr name per owner: a name, or null for none. Owners whose lookup failed are left out. */
export async function lookupNames(owners: string[], env: NamesEnv, deadline: number): Promise<Map<string, string | null>> {
  const rpc: Rpc = { own: ownRpc(env.MAINNET_RPC), down: new Set(), deadline, gpaLeft: MAX_GPA_CALLS };

  const held: (string[] | undefined)[] = new Array(owners.length);
  let next = 0;
  let slot = 0;
  const worker = async () => {
    while (next < owners.length) {
      const i = next++;
      const at = Math.max(slot, Date.now());
      if (at >= deadline || rpc.gpaLeft <= 0 || !endpoints(rpc, true).length) continue; // left out: asked again later
      slot = at + GPA_GAP_MS;
      if (at > Date.now()) await new Promise((wake) => setTimeout(wake, at - Date.now()));
      held[i] = await records(rpc, owners[i]).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, owners.length) }, worker));
  if (!rpc.own.length && held.includes(undefined)) {
    console.warn('names: MAINNET_RPC is not set, and the public RPCs refuse getProgramAccounts to a deployed Worker');
  }

  const all = held.flatMap((r) => r ?? []);
  const labels = all.length ? await reverseNames(rpc, all).catch(() => undefined) : [];
  const nameByRecord = new Map(labels ? all.map((r, i) => [r, labels[i]]) : []);

  const out = new Map<string, string | null>();
  owners.forEach((owner, i) => {
    const mine = held[i];
    if (!mine || (mine.length > 0 && !labels)) return;
    out.set(owner, pickName(mine.map((r) => nameByRecord.get(r)).filter((n): n is string => !!n)));
  });
  return out;
}

const cacheKey = (address: string) => `${CACHE_PREFIX}${address}`;

function edgeCache(): Cache | undefined {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default;
}

/** Cached name: a string, null for "has none", undefined when not cached. */
async function cached(cache: Cache | undefined, address: string): Promise<string | null | undefined> {
  try {
    const hit = await cache?.match(cacheKey(address));
    if (!hit) return undefined;
    const { name } = (await hit.json()) as { name?: unknown };
    return typeof name === 'string' || name === null ? name : undefined;
  } catch {
    return undefined;
  }
}

async function remember(cache: Cache | undefined, address: string, name: string | null): Promise<void> {
  const ttl = name ? FOUND_TTL_S : NONE_TTL_S;
  const entry = new Response(JSON.stringify({ name }), {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` },
  });
  try {
    await cache?.put(cacheKey(address), entry);
  } catch (e) {
    console.warn(`names: cache put: ${e instanceof Error ? e.message : e}`);
  }
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export async function names(request: Request, env: NamesEnv = {}, ctx?: Ctx): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, { allow: 'GET' });
  const owners = parseAddresses(new URL(request.url).searchParams.get('a'));
  if (!owners) return json({ error: `a: 1 to ${MAX_ADDRESSES} comma-separated base58 addresses` }, 400);

  const deadline = Date.now() + BUDGET_MS;
  const cache = edgeCache();
  const known = new Map<string, string | null>();
  const hits = await Promise.all(owners.map((a) => cached(cache, a)));
  owners.forEach((a, i) => {
    const hit = hits[i];
    if (hit !== undefined) known.set(a, hit);
  });

  const misses = owners.filter((a) => !known.has(a));
  if (misses.length) {
    const fresh = await lookupNames(misses, env, deadline);
    // Workers Free counts cache writes against its 50 subrequests: names first, they cost the most to redo.
    const writes = [...fresh].sort(([, a], [, b]) => Number(b !== null) - Number(a !== null));
    const saving = Promise.all(writes.map(([a, name]) => remember(cache, a, name)));
    if (ctx) ctx.waitUntil(saving);
    else await saving;
    for (const [a, name] of fresh) known.set(a, name);
  }

  const out: Record<string, string | null> = {};
  for (const a of owners) if (known.has(a)) out[a] = known.get(a)!;
  const complete = known.size === owners.length;
  return json({ names: out }, 200, { 'cache-control': complete ? 'public, max-age=300' : 'no-store' });
}
