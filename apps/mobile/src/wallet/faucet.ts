// The project's own devnet test SOL faucet (services/link): one POST per wallet, answered in plain
// words. Pure TypeScript (no React Native imports): the response parser and the request run under
// node:test with a fake fetch.
//
// Contract:  POST <FAUCET_API>  {"address":"<base58>"}
//   200 {"ok":true,"signature":"...","lamports":200000000}
//   4xx/5xx {"ok":false,"error":"bad_address|already_funded|rate_limited|faucet_empty|unavailable","message":"..."}

export type FaucetErrorCode = 'bad_address' | 'already_funded' | 'rate_limited' | 'faucet_empty' | 'unavailable';

export type FaucetOutcome =
  | { ok: true; signature: string | null; lamports: bigint }
  | {
      ok: false;
      code: FaucetErrorCode;
      /** What the player reads (our own words per code, never the server's text). */
      message: string;
      /** Show the other ways to get test SOL (AIRDROP 1 SOL, faucet.solana.com): this faucet cannot help right now. */
      fallbacks: boolean;
    };

const CODES: readonly FaucetErrorCode[] = ['bad_address', 'already_funded', 'rate_limited', 'faucet_empty', 'unavailable'];

/** The sentence per code. Only the three "try another way" codes send the player to the fallbacks. */
export const FAUCET_TEXT: Record<FaucetErrorCode, { message: string; fallbacks: boolean }> = {
  bad_address: { message: 'The faucet did not accept this wallet address. Reconnect your wallet and try again.', fallbacks: false },
  already_funded: { message: 'Your wallet already has devnet SOL.', fallbacks: false },
  rate_limited: { message: 'The test SOL faucet is busy. Try again in a minute, or use another way below.', fallbacks: true },
  faucet_empty: { message: 'The test SOL faucet is empty right now. Use another way below.', fallbacks: true },
  unavailable: { message: 'The test SOL faucet is not answering. Use another way below.', fallbacks: true },
};

const failure = (code: FaucetErrorCode): FaucetOutcome => ({ ok: false, code, ...FAUCET_TEXT[code] });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A transaction signature as the faucet sends it: base58, 64 to 100 characters. Anything else is not trusted. */
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;

function lamportsOf(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d{1,19}$/.test(value)) return BigInt(value);
  return null;
}

/**
 * Reads one faucet answer. A success needs the "ok" flag and an amount; the signature is used to wait
 * for the confirmation and is dropped (the wait is replaced by a short pause) when it is missing or odd.
 * Anything that is not a clear answer counts as "unavailable" - never a crash, never a raw server text.
 */
export function parseFaucetResponse(status: number, body: unknown): FaucetOutcome {
  if (isRecord(body) && body.ok === true && status >= 200 && status < 300) {
    const lamports = lamportsOf(body.lamports);
    if (lamports === null) return failure('unavailable');
    const signature = typeof body.signature === 'string' && SIGNATURE.test(body.signature) ? body.signature : null;
    return { ok: true, signature, lamports };
  }
  if (isRecord(body) && body.ok === false && typeof body.error === 'string' && (CODES as readonly string[]).includes(body.error)) {
    return failure(body.error as FaucetErrorCode);
  }
  // No usable body: the status alone says a little.
  if (status === 429) return failure('rate_limited');
  return failure('unavailable');
}

/** Thrown by the wallet action so the one failure path (humanError) shows the faucet's sentence as it is. */
export class FaucetError extends Error {
  readonly code: FaucetErrorCode;
  readonly fallbacks: boolean;
  constructor(outcome: Extract<FaucetOutcome, { ok: false }>) {
    super(outcome.message);
    this.name = 'FaucetError';
    this.code = outcome.code;
    this.fallbacks = outcome.fallbacks;
  }
}

export const isFaucetError = (error: unknown): error is FaucetError => (error as { name?: unknown } | null)?.name === 'FaucetError';

type FetchLike = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  status: number;
  json: () => Promise<unknown>;
}>;

/**
 * Asks the faucet for test SOL for `address`. Gives up after `timeoutMs` (the player then sees the
 * fallback ways); a network error or a body that is not JSON is "unavailable".
 */
export async function requestFaucet(
  address: string,
  opts: { url: string; timeoutMs: number; fetchImpl?: FetchLike },
): Promise<FaucetOutcome> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetchImpl(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ address }),
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return parseFaucetResponse(res.status, body);
  } catch {
    return failure('unavailable');
  } finally {
    clearTimeout(timer);
  }
}
