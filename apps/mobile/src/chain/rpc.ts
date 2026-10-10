import {
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  isSolanaError,
  type Rpc,
  type RpcTransport,
  type SolanaRpcApi,
} from '@solana/kit';
import { DEVNET_RPCS, MAINNET_RPCS, RPC_COOL_DOWN } from '../config';
import { createCoolDown, retryAfterMs } from '../lib/limits';
import { countRequest, recordLatency } from '../lib/requestLog';

export type SolanaRpc = Rpc<SolanaRpcApi>;

/**
 * Reads the poll loops repeat. After an HTTP 429 they are held back from that endpoint until its
 * cool-down ends; everything a user action needs (blockhash, send, status, block height, balance,
 * rent, airdrop) always goes out.
 */
const POLLED_METHODS = new Set(['getAccountInfo', 'getMultipleAccounts', 'getProgramAccounts', 'getSlot', 'getBlockTime']);

/** Thrown instead of a request while every endpoint for it is cooling down after HTTP 429. */
export class RateLimitedError extends Error {
  readonly retryInMs: number;

  constructor(retryInMs: number) {
    super(`RPC rate limited (HTTP 429), next try in ${Math.ceil(retryInMs / 1000)} s`);
    this.name = 'RateLimitedError';
    this.retryInMs = retryInMs;
  }
}

function methodOf(payload: unknown): string {
  const method = (payload as { method?: unknown } | null)?.method;
  return typeof method === 'string' ? method : 'rpc';
}

function rateLimitedBy(error: unknown): { retryAfter: number | null } | null {
  if (!isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) || Number(error.context.statusCode) !== 429) return null;
  return { retryAfter: retryAfterMs(error.context.headers?.get('retry-after'), Date.now()) };
}

/**
 * How long a poll loop should wait after this error: the cool-down left when the RPC is rate
 * limiting, null for any other error.
 */
export function rateLimitWaitMs(error: unknown): number | null {
  if (error instanceof RateLimitedError) return error.retryInMs;
  return rateLimitedBy(error) ? RPC_COOL_DOWN.baseMs : null;
}

/**
 * Every request gets a deadline, so one hung socket on a phone never freezes a poll loop. A 429
 * puts the endpoint on cool-down (see POLLED_METHODS); dev builds count each request sent.
 */
function transportWithTimeout(url: string, timeoutMs: number, network: 'devnet' | 'mainnet'): RpcTransport {
  const base = createDefaultRpcTransport({ url });
  const coolDown = createCoolDown(RPC_COOL_DOWN.baseMs, RPC_COOL_DOWN.maxMs);
  const transport = async <T,>(config: Readonly<{ payload: unknown; signal?: AbortSignal }>): Promise<T> => {
    const method = methodOf(config.payload);
    const wait = coolDown.left(Date.now());
    if (wait > 0 && POLLED_METHODS.has(method)) throw new RateLimitedError(wait);
    countRequest(network, method);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const outer = config.signal;
    const onOuterAbort = () => controller.abort();
    if (outer) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener('abort', onOuterAbort);
    }
    try {
      const result = await base<T>({ payload: config.payload, signal: controller.signal });
      coolDown.ok();
      return result;
    } catch (error) {
      const limited = rateLimitedBy(error);
      if (limited) coolDown.hit(Date.now(), limited.retryAfter);
      throw error;
    } finally {
      recordLatency(network === 'devnet' ? 'rpc_devnet' : 'rpc_mainnet', Date.now() - startedAt);
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    }
  };
  return transport as RpcTransport;
}

/** The error to report after every endpoint failed: a single RateLimitedError when all of them are cooling down. */
function finalError(errors: readonly unknown[], fallback: string): unknown {
  if (errors.length === 0) return new Error(fallback);
  if (errors.every((e) => e instanceof RateLimitedError)) {
    return new RateLimitedError(Math.min(...errors.map((e) => (e as RateLimitedError).retryInMs)));
  }
  return [...errors].reverse().find((e) => !(e instanceof RateLimitedError));
}

/**
 * Tries the endpoint that answered last, then the others, on network and HTTP failures only
 * (JSON-RPC errors such as a failed simulation are answers and are not retried elsewhere).
 * Resending the same signed transaction to a second endpoint is safe: it carries the same signature.
 */
function failoverTransport(urls: readonly string[], timeoutMs: number): RpcTransport {
  const transports = urls.map((url) => transportWithTimeout(url, timeoutMs, 'devnet'));
  let preferred = 0;
  const transport = async <T,>(config: Readonly<{ payload: unknown; signal?: AbortSignal }>): Promise<T> => {
    const errors: unknown[] = [];
    for (let attempt = 0; attempt < transports.length; attempt++) {
      const index = (preferred + attempt) % transports.length;
      try {
        const result = await transports[index]<T>(config);
        preferred = index;
        return result;
      } catch (error) {
        errors.push(error);
        if (config.signal?.aborted) throw error;
      }
    }
    throw finalError(errors, 'no devnet RPC configured');
  };
  return transport as RpcTransport;
}

export const devnetRpc: SolanaRpc = createSolanaRpcFromTransport(failoverTransport(DEVNET_RPCS, 15_000)) as SolanaRpc;

const mainnetRpcs: SolanaRpc[] = MAINNET_RPCS.map(
  (url) => createSolanaRpcFromTransport(transportWithTimeout(url, 6_000, 'mainnet')) as SolanaRpc,
);
let mainnetIndex = 0;

/** Runs `fn` against the mainnet endpoint that worked last, failing over to the next on error. */
export async function withMainnet<T>(fn: (rpc: SolanaRpc) => Promise<T>): Promise<T> {
  const errors: unknown[] = [];
  for (let attempt = 0; attempt < mainnetRpcs.length; attempt++) {
    const index = (mainnetIndex + attempt) % mainnetRpcs.length;
    try {
      const result = await fn(mainnetRpcs[index]);
      mainnetIndex = index;
      return result;
    } catch (error) {
      errors.push(error);
    }
  }
  throw finalError(errors, 'no mainnet RPC configured');
}
