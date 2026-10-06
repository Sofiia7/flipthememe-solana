/**
 * Solana JSON-RPC with failover, for the Durable Object: endpoints in order; one that fails (HTTP
 * error, timeout, JSON-RPC error) backs off 1 s, 2 s, 4 s ... up to 60 s and the call moves on.
 * A plain Error comes from the client's decoders and would fail the same way anywhere: it is
 * thrown straight through. Endpoints from secrets are named by the secret, never by their URL or
 * host, since a keyed URL carries its key.
 */
import { createDefaultRpcTransport, createSolanaRpcFromTransport, type Rpc, type RpcTransport, type SolanaRpcApi } from '@solana/kit';

export type SolanaRpc = Rpc<SolanaRpcApi>;
export type Endpoint = { name: string; rpc: SolanaRpc };

const BACKOFF_MAX_MS = 60_000;

/** A kit RPC whose requests are aborted after `timeoutMs`. */
export function httpRpc(url: string, timeoutMs: number): SolanaRpc {
  const base = createDefaultRpcTransport({ url });
  const transport: RpcTransport = (config) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return base({ ...config, signal: config.signal ? AbortSignal.any([config.signal, timeout]) : timeout });
  };
  return createSolanaRpcFromTransport(transport);
}

/**
 * Endpoints for the https URLs among `urls`, in order; blanks, other schemes and repeats are
 * dropped. `secret` names an endpoint whose URL came from a secret; others go by their host.
 */
export function endpointsFor(urls: { url: string | undefined; secret?: string }[], timeoutMs: number): Endpoint[] {
  const out: Endpoint[] = [];
  const seen = new Set<string>();
  for (const { url: raw, secret } of urls) {
    const url = raw?.trim();
    if (!url || seen.has(url)) continue;
    let host: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') continue;
      host = parsed.host;
    } catch {
      continue;
    }
    seen.add(url);
    out.push({ name: secret ?? host, rpc: httpRpc(url, timeoutMs) });
  }
  return out;
}

/** True for errors that say something about the endpoint rather than about the data. */
export const isEndpointFailure = (error: unknown): boolean => !(error instanceof Error && error.constructor === Error);

/** A short, URL-free description of an error, safe to log and to show in the health report. */
export function describe(error: unknown): string {
  const status = (error as { context?: { statusCode?: unknown } } | null)?.context?.statusCode;
  if (typeof status === 'number') return `HTTP ${status}`;
  const text = (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/\S+/g, '<url>');
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

/** No endpoint answered. */
export class RpcUnavailable extends Error {
  constructor(what: string, detail: string) {
    super(`${what}: ${detail}`);
    this.name = 'RpcUnavailable';
  }
}

export class Failover {
  private readonly endpoints: (Endpoint & { failures: number; retryAtMs: number; lastError: string })[];
  private readonly now: () => number;

  constructor(endpoints: Endpoint[], now: () => number = () => Date.now()) {
    if (endpoints.length === 0) throw new Error('Failover needs at least one endpoint');
    this.endpoints = endpoints.map((e) => ({ ...e, failures: 0, retryAtMs: 0, lastError: '' }));
    this.now = now;
  }

  get names(): string[] {
    return this.endpoints.map((e) => e.name);
  }

  async call<T>(what: string, fn: (rpc: SolanaRpc) => Promise<T>): Promise<T> {
    const errors: string[] = [];
    for (const endpoint of this.endpoints) {
      if (endpoint.retryAtMs > this.now()) continue;
      try {
        const result = await fn(endpoint.rpc);
        endpoint.failures = 0;
        return result;
      } catch (error) {
        if (!isEndpointFailure(error)) throw error;
        endpoint.failures++;
        endpoint.retryAtMs = this.now() + Math.min(BACKOFF_MAX_MS, 1_000 * 2 ** Math.min(endpoint.failures - 1, 16));
        endpoint.lastError = describe(error);
        errors.push(`${endpoint.name}: ${endpoint.lastError}`);
      }
    }
    if (errors.length > 0) throw new RpcUnavailable(what, errors.join('; '));
    const last = this.endpoints.map((e) => `${e.name}: ${e.lastError}`).join('; ');
    throw new RpcUnavailable(what, `every endpoint is backing off after errors (${last})`);
  }
}
