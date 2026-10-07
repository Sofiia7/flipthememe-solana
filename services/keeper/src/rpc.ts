import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type Rpc,
  type RpcTransport,
  type SolanaRpcApi,
} from '@solana/kit';
import { hostOf, redact, type Logger } from './log.ts';

export type SolanaRpc = Rpc<SolanaRpcApi>;

/** A kit RPC whose every request is aborted after `timeoutMs`, so no loop can hang on a socket. */
export function makeRpc(url: string, timeoutMs: number): SolanaRpc {
  const base = createDefaultRpcTransport({ url });
  const transport: RpcTransport = (config) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return base({ ...config, signal: config.signal ? AbortSignal.any([config.signal, timeout]) : timeout });
  };
  return createSolanaRpcFromTransport(transport);
}

type Endpoint = { url: string; host: string; rpc: SolanaRpc; failures: number; retryAtMs: number };

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

/** Exponential backoff after `failures` consecutive errors: 1 s, 2 s, 4 s ... capped at 60 s. */
export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(failures - 1, 16)));
}

/**
 * True for errors that say something about the endpoint (kit RPC errors such as HTTP 429 or a
 * JSON-RPC error, network failures, timeouts). A plain `Error` comes from validating the data
 * (wrong pool owner, mint mismatch, empty reserve) and would fail the same way on any endpoint.
 */
export function isEndpointFailure(error: unknown): boolean {
  return !(error instanceof Error && error.constructor === Error);
}

/**
 * Mainnet reads across several RPC endpoints. A failing endpoint (HTTP 429, timeout, JSON-RPC
 * error) backs off exponentially and the call moves on to the next one; endpoints are tried in
 * the configured order, so the first one is preferred again as soon as its backoff ends. Data
 * validation errors are thrown straight through without blaming the endpoint.
 */
export class FailoverRpc {
  private readonly endpoints: Endpoint[];
  private readonly logger: Logger;
  private readonly now: () => number;
  lastHost: string | null = null;

  constructor(urls: string[], logger: Logger, opts: { timeoutMs?: number; now?: () => number } = {}) {
    if (urls.length === 0) throw new Error('FailoverRpc needs at least one URL');
    const timeoutMs = opts.timeoutMs ?? 5_000;
    this.endpoints = urls.map((url) => ({ url, host: hostOf(url), rpc: makeRpc(url, timeoutMs), failures: 0, retryAtMs: 0 }));
    this.logger = logger;
    this.now = opts.now ?? (() => Date.now());
  }

  async call<T>(what: string, fn: (rpc: SolanaRpc) => Promise<T>): Promise<T> {
    let lastError: unknown = null;
    for (const endpoint of this.endpoints) {
      if (endpoint.retryAtMs > this.now()) continue;
      try {
        const result = await fn(endpoint.rpc);
        endpoint.failures = 0;
        this.lastHost = endpoint.host;
        return result;
      } catch (error) {
        if (!isEndpointFailure(error)) throw error;
        lastError = error;
        endpoint.failures++;
        const wait = backoffMs(endpoint.failures);
        endpoint.retryAtMs = this.now() + wait;
        this.logger({ event: 'mainnet_rpc_error', host: endpoint.host, what, error: shortError(error), backoffMs: wait });
      }
    }
    if (lastError !== null) throw lastError;
    throw new Error('every mainnet RPC endpoint is backing off');
  }
}

/**
 * A short description of an error for the log: the HTTP status when there is one, else the message
 * with every URL and key in it removed (redact) and cut to 300 characters. The cut comes last, so a
 * URL cannot be left half way through it.
 */
export function shortError(error: unknown): string {
  const ctx = (error as { context?: { statusCode?: number } } | null)?.context;
  if (ctx && typeof ctx.statusCode === 'number') return `HTTP ${ctx.statusCode}`;
  const message = redact(error instanceof Error ? error.message : String(error));
  return message.length > 300 ? `${message.slice(0, 300)}...` : message;
}
