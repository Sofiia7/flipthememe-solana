// Devnet test SOL faucet for the app: POST /v1/faucet {"address": "<base58 wallet>"}.
//
//   200 {"ok": true, "signature": "<base58>", "lamports": 200000000}
//   4xx/5xx {"ok": false, "error": "<code>", "message": "<short text>"}, with the code one of
//     bad_address     400  not a wallet address: not base58, not 32 bytes, not on the ed25519 curve
//                          (a PDA), or an address that is never funded (System Program, our program, ...)
//     already_funded  409  the wallet holds 0.1 SOL or more on devnet already, or was just sent some
//     rate_limited    429  one request per 60 s per IP and per address (Workers rate limit binding)
//     faucet_empty    503  sending would take the faucet below its 1 SOL reserve
//     unavailable     503  no key, wrong key, no RPC answered or the transfer was refused
//   and, for requests that are not the app's: method_not_allowed 405, unsupported_media_type 415,
//   body_too_large 413 (the same shape).
//
// The Worker signs one System Program transfer of FAUCET_LAMPORTS (0.2 SOL by default) from the faucet
// key to the wallet on devnet. It keeps no state: the protection is the checks above, in this order -
// request shape, address, rate limit, key, balances, transfer - plus a short memory per isolate of the
// wallets it just sent to, so a double tap cannot pay twice before the balance shows it.
//
// Secrets and vars (see wrangler.jsonc): FAUCET_KEY, base58 of the faucet's 64-byte secret key
// (scripts/secret.ts makes it); DEVNET_RPC, a keyed devnet URL tried first (optional);
// EXPECTED_FAUCET_ADDRESS, the faucet's public address, which the key must give or the faucet says
// "unavailable"; FAUCET_LAMPORTS, the amount per call. Binding FAUCET_LIMITER (optional).
//
// RPC: DEVNET_RPC, then OnFinality's public devnet endpoint, then api.devnet.solana.com. The public
// ones may answer a Worker with 403 or 429; each failure moves on to the next, 3 s at most per endpoint.

import { base58Decode, base58Encode, isOnCurve } from './names.ts';

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface FaucetEnv {
  /** Base58 of the 64-byte secret key (32-byte seed, then the 32-byte public key) of the faucet. */
  FAUCET_KEY?: string;
  /** Devnet RPC URL (a keyed provider), tried before the public endpoints. */
  DEVNET_RPC?: string;
  /** The faucet's public address. The key must give exactly this one, or nothing is sent. */
  EXPECTED_FAUCET_ADDRESS?: string;
  /** Lamports per call, whole number up to 1 SOL; unset means 0.2 SOL. */
  FAUCET_LAMPORTS?: string;
  /** Workers rate limit binding (wrangler.jsonc `ratelimits`): 1 request per 60 s per key. Optional. */
  FAUCET_LIMITER?: RateLimiter;
}

export const DEFAULT_LAMPORTS = 200_000_000;
const MAX_LAMPORTS = 1_000_000_000;
/** A wallet holding this much already does not need the faucet: 0.1 SOL. */
export const ALREADY_FUNDED_LAMPORTS = 100_000_000;
/** The faucet keeps this much: it sends only while its balance after the transfer stays at or above it. */
export const RESERVE_LAMPORTS = 1_000_000_000;
export const MAX_BODY_BYTES = 512;
/** Per endpoint. */
const RPC_TIMEOUT_MS = 3_000;
/** All RPC calls of one request together; the app gives up after 12 s. */
const BUDGET_MS = 9_000;
/** A wallet just sent to is refused for this long in the same isolate. */
const RECENT_MS = 5 * 60_000;
const MAX_RECENT = 500;
export const DEVNET_RPCS = ['https://solana-devnet.api.onfinality.io/public', 'https://api.devnet.solana.com'];

/** Programs and sinks that are never funded, whatever the curve check says (the all-zero System Program is on the curve). */
export const UNFUNDABLE = new Set([
  '11111111111111111111111111111111', // System Program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Account
  'ComputeBudget111111111111111111111111111111',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  'Stake11111111111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111',
  'BPFLoaderUpgradeab1e11111111111111111111111',
  'BPFLoader2111111111111111111111111111111111',
  'NativeLoader1111111111111111111111111111111',
  'AddressLookupTab1e1111111111111111111111111',
  'Ed25519SigVerify111111111111111111111111111',
  'KeccakSecp256k11111111111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
  '1nc1nerator11111111111111111111111111111111', // burns what it receives
  '5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz', // FlipTheMeme program
  'A6k9oP8NT249nCM1g6DupAKgVT7dHLyGwbFn5VLbA8RQ', // its Config PDA
  'EMXqXiGXcuzvf9ZD1P6B4HjDVF7earLVNJqah7YLwDZ1', // its OracleConfig PDA
  'DED8cZ5zo5yFSEgNAuGD4tFvrkd8se6t6i42SwWKgomp', // the faucet itself
]);

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SYSTEM_PROGRAM = new Uint8Array(32);

type Code = 'bad_address' | 'already_funded' | 'rate_limited' | 'faucet_empty' | 'unavailable' | 'method_not_allowed' | 'unsupported_media_type' | 'body_too_large';

const FAILURES: Record<Code, { status: number; message: string }> = {
  bad_address: { status: 400, message: 'That is not a valid wallet address.' },
  already_funded: { status: 409, message: 'This wallet already has devnet SOL.' },
  rate_limited: { status: 429, message: 'Too many requests. Try again in a minute.' },
  faucet_empty: { status: 503, message: 'The faucet is empty right now.' },
  unavailable: { status: 503, message: 'The faucet is not available right now. Try again in a minute.' },
  method_not_allowed: { status: 405, message: 'POST only.' },
  unsupported_media_type: { status: 415, message: 'Send application/json.' },
  body_too_large: { status: 413, message: `The body is limited to ${MAX_BODY_BYTES} bytes.` },
};

const respond = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

function refuse(code: Code, message?: string): Response {
  const { status, message: text } = FAILURES[code];
  const headers: Record<string, string> = {};
  if (code === 'method_not_allowed') headers.allow = 'POST';
  if (code === 'rate_limited') headers['retry-after'] = '60';
  return respond({ ok: false, error: code, message: message ?? text }, status, headers);
}

/** The log line says what is wrong (for the operator), the answer only says "unavailable". Never a secret in it. */
function unavailable(reason: string): Response {
  console.error(JSON.stringify({ event: 'faucet_unavailable', reason }));
  return refuse('unavailable');
}

/** The body, or null as soon as it passes `max` bytes (declared or actually sent). */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** A wallet address from the request: 32 bytes of base58 that are a point on the curve and not an unfundable address. */
export function walletBytes(raw: unknown): Uint8Array | null {
  if (typeof raw !== 'string' || !ADDRESS.test(raw) || UNFUNDABLE.has(raw)) return null;
  const bytes = base58Decode(raw);
  if (bytes?.length !== 32 || !isOnCurve(bytes)) return null;
  return bytes;
}

// ---- the faucet key ----------------------------------------------------------------------------

/** PKCS#8 prefix of an Ed25519 private key; the 32-byte seed follows. */
const PKCS8_ED25519 = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20);

type FaucetKey = { address: string; publicKey: Uint8Array; sign(message: Uint8Array): Promise<Uint8Array> };

/** A problem with FAUCET_KEY or EXPECTED_FAUCET_ADDRESS; the text is safe to log and holds no part of the secret. */
class KeyProblem extends Error {}

/**
 * The faucet key from FAUCET_KEY: base58 of 64 bytes, the seed then its public key. The pair is
 * checked by signing and verifying a probe, and the address must be EXPECTED_FAUCET_ADDRESS.
 */
export async function loadFaucetKey(secret: string | undefined, expected: string | undefined): Promise<FaucetKey> {
  const text = secret?.trim();
  if (!text) throw new KeyProblem('FAUCET_KEY is not set');
  const wanted = expected?.trim();
  if (!wanted) throw new KeyProblem('EXPECTED_FAUCET_ADDRESS is not set');
  const bytes = base58Decode(text);
  if (!bytes || bytes.length !== 64) {
    bytes?.fill(0);
    throw new KeyProblem('FAUCET_KEY is not base58 of a 64-byte secret key');
  }
  const publicKey = bytes.slice(32);
  const pkcs8 = new Uint8Array(PKCS8_ED25519.length + 32);
  pkcs8.set(PKCS8_ED25519, 0);
  pkcs8.set(bytes.subarray(0, 32), PKCS8_ED25519.length);
  bytes.fill(0);
  let privateKey: CryptoKey;
  let verifier: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
    verifier = await crypto.subtle.importKey('raw', publicKey, 'Ed25519', false, ['verify']);
  } catch {
    throw new KeyProblem('FAUCET_KEY is not a usable Ed25519 key');
  } finally {
    pkcs8.fill(0);
  }
  const probe = new TextEncoder().encode('faucet key check');
  const ok = await crypto.subtle.verify('Ed25519', verifier, await crypto.subtle.sign('Ed25519', privateKey, probe), probe);
  if (!ok) throw new KeyProblem('FAUCET_KEY: its last 32 bytes are not the public key of its first 32');
  const address = base58Encode(publicKey);
  if (address !== wanted) throw new KeyProblem(`FAUCET_KEY gives ${address}, but EXPECTED_FAUCET_ADDRESS is ${wanted}`);
  return { address, publicKey, sign: async (message) => new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, message)) };
}

let loaded: { secret: string; expected: string; key: FaucetKey } | null = null;

/** Loads the key once per isolate (a changed secret loads again); a bad key is reported on every request. */
async function faucetKey(env: FaucetEnv): Promise<FaucetKey> {
  const secret = env.FAUCET_KEY?.trim() ?? '';
  const expected = env.EXPECTED_FAUCET_ADDRESS?.trim() ?? '';
  if (loaded && loaded.secret === secret && loaded.expected === expected) return loaded.key;
  const key = await loadFaucetKey(secret, expected);
  loaded = { secret, expected, key };
  return key;
}

/** FAUCET_LAMPORTS: whole lamports from 1 to 1 SOL; unset means 0.2 SOL. Anything else is a misconfiguration. */
export function parseLamports(raw: string | undefined): number | null {
  const text = raw?.trim();
  if (!text) return DEFAULT_LAMPORTS;
  if (!/^\d{1,10}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= MAX_LAMPORTS ? n : null;
}

// ---- the transaction -----------------------------------------------------------------------------

const u64le = (n: bigint) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
};

/** The legacy message of one System Program transfer: payer pays and sends `lamports` to `to`. */
export function transferMessage(payer: Uint8Array, to: Uint8Array, lamports: bigint, blockhash: Uint8Array): Uint8Array {
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true); // SystemInstruction::Transfer
  data.set(u64le(lamports), 4);
  const parts = [
    Uint8Array.of(1, 0, 1), // one signature; no read-only signer; one read-only unsigned account (the program)
    Uint8Array.of(3), // three accounts
    payer,
    to,
    SYSTEM_PROGRAM,
    blockhash,
    Uint8Array.of(1), // one instruction
    Uint8Array.of(2, 2, 0, 1, data.length), // program index 2, two accounts (0, 1), data length
    data,
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The wire transaction: signature count, the signature, the message. */
export function wireTransaction(signature: Uint8Array, message: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + 64 + message.length);
  out[0] = 1;
  out.set(signature, 1);
  out.set(message, 65);
  return out;
}

const toBase64 = (bytes: Uint8Array) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

// ---- RPC -----------------------------------------------------------------------------------------

type Rpc = { urls: string[]; deadline: number };

function rpcFor(env: FaucetEnv): Rpc {
  const urls: string[] = [];
  for (const url of [env.DEVNET_RPC?.trim(), ...DEVNET_RPCS]) {
    if (!url || urls.includes(url)) continue;
    try {
      if (new URL(url).protocol === 'https:') urls.push(url);
    } catch {
      // not a URL: skipped
    }
  }
  return { urls, deadline: Date.now() + BUDGET_MS };
}

/**
 * One JSON-RPC call, endpoint by endpoint. A failure (HTTP error, timeout, a JSON-RPC error) moves on
 * to the next; none left, or the budget spent, is "no RPC answered". Only hosts are logged: a keyed
 * DEVNET_RPC carries its key in the URL.
 */
async function call<T>(rpc: Rpc, method: string, params: unknown[]): Promise<T> {
  for (const url of rpc.urls) {
    const left = rpc.deadline - Date.now();
    if (left <= 0) break;
    const host = new URL(url).host;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(Math.min(RPC_TIMEOUT_MS, left)),
      });
      const body = (await res.json()) as { result?: T; error?: { message?: string } };
      if (res.ok && body.result !== undefined && body.result !== null) return body.result;
      console.warn(`faucet: ${method} on ${host}: ${res.status} ${body.error?.message?.slice(0, 120) ?? 'no result'}`);
    } catch (error) {
      console.warn(`faucet: ${method} on ${host}: ${error instanceof Error ? error.message.slice(0, 120) : 'failed'}`);
    }
  }
  throw new Error(`${method}: no RPC answered`);
}

// ---- the handler ---------------------------------------------------------------------------------

/** Wallets just sent to, newest last; a repeat inside RECENT_MS is turned away before it costs an RPC call. */
const recent = new Map<string, number>();

function recentlyFunded(address: string, now: number): boolean {
  const at = recent.get(address);
  return at !== undefined && now - at < RECENT_MS;
}

function remember(address: string, now: number): void {
  recent.delete(address);
  recent.set(address, now);
  while (recent.size > MAX_RECENT) recent.delete(recent.keys().next().value as string);
}

/** True when the binding allows this key now; a binding that fails or is not there allows everything. */
async function allowed(env: FaucetEnv, key: string): Promise<boolean> {
  if (!env.FAUCET_LIMITER) return true;
  try {
    return (await env.FAUCET_LIMITER.limit({ key })).success;
  } catch {
    return true;
  }
}

export async function faucet(request: Request, env: FaucetEnv = {}): Promise<Response> {
  // The shape of the request.
  if (request.method !== 'POST') return refuse('method_not_allowed');
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return refuse('unsupported_media_type');
  const raw = await readCapped(request, MAX_BODY_BYTES);
  if (!raw) return refuse('body_too_large');

  // The address.
  let given: unknown;
  try {
    given = (JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw)) as { address?: unknown } | null)?.address;
  } catch {
    return refuse('bad_address', 'The body must be JSON: {"address": "<wallet address>"}.');
  }
  const to = walletBytes(given);
  if (!to) return refuse('bad_address');
  const address = given as string;

  // Rate limits, when the binding is there: per IP and per wallet.
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!(await allowed(env, `ip:${ip}`)) || !(await allowed(env, `wallet:${address}`))) return refuse('rate_limited');

  // The key, the amount, then the chain.
  let key: FaucetKey;
  try {
    key = await faucetKey(env);
  } catch (error) {
    return unavailable(error instanceof KeyProblem ? error.message : 'FAUCET_KEY could not be loaded');
  }
  if (address === key.address) return refuse('bad_address');
  const lamports = parseLamports(env.FAUCET_LAMPORTS);
  if (lamports === null) return unavailable(`FAUCET_LAMPORTS must be whole lamports from 1 to ${MAX_LAMPORTS}`);

  const now = Date.now();
  if (recentlyFunded(address, now)) return refuse('already_funded', 'Devnet SOL is already on its way to this wallet.');
  remember(address, now); // before the first await: two calls in flight cannot both pass
  const rpc = rpcFor(env);
  try {
    const { value } = await call<{ value: ({ lamports: number } | null)[] }>(rpc, 'getMultipleAccounts', [
      [address, key.address],
      { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' },
    ]);
    if (!Array.isArray(value) || value.length !== 2) throw new Error('getMultipleAccounts: unexpected result');
    const [wallet, faucetAccount] = value;
    const walletLamports = wallet?.lamports ?? 0;
    const faucetLamports = faucetAccount?.lamports ?? 0;
    if (typeof walletLamports !== 'number' || typeof faucetLamports !== 'number') throw new Error('getMultipleAccounts: unexpected result');
    if (walletLamports >= ALREADY_FUNDED_LAMPORTS) {
      recent.delete(address);
      return refuse('already_funded');
    }
    if (faucetLamports - lamports < RESERVE_LAMPORTS) {
      recent.delete(address);
      console.error(JSON.stringify({ event: 'faucet_empty', balance: faucetLamports }));
      return refuse('faucet_empty');
    }

    const { value: latest } = await call<{ value: { blockhash?: string } }>(rpc, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const blockhash = latest?.blockhash ? base58Decode(latest.blockhash) : null;
    if (blockhash?.length !== 32) throw new Error('getLatestBlockhash: unexpected result');

    const message = transferMessage(key.publicKey, to, BigInt(lamports), blockhash);
    const signature = await key.sign(message);
    await call<string>(rpc, 'sendTransaction', [
      toBase64(wireTransaction(signature, message)),
      { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3 },
    ]);
    const id = base58Encode(signature);
    console.log(JSON.stringify({ event: 'faucet_sent', address, lamports, signature: id }));
    return respond({ ok: true, signature: id, lamports }, 200);
  } catch (error) {
    recent.delete(address); // nothing was sent that we know of: the wallet may ask again
    return unavailable(error instanceof Error ? error.message.slice(0, 200) : 'the transfer failed');
  }
}

/** For tests: forget the wallets just sent to and the loaded key. */
export function resetFaucetState(): void {
  recent.clear();
  loaded = null;
}
