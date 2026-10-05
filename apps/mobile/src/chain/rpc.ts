import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type Rpc,
  type RpcTransport,
  type SolanaRpcApi,
} from '@solana/kit';
import { DEVNET_RPCS, MAINNET_RPCS } from '../config';

export type SolanaRpc = Rpc<SolanaRpcApi>;

/** Every request gets a deadline, so one hung socket on a phone never freezes a poll loop. */
function transportWithTimeout(url: string, timeoutMs: number): RpcTransport {
  const base = createDefaultRpcTransport({ url });
  const transport = async <T,>(config: Readonly<{ payload: unknown; signal?: AbortSignal }>): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const outer = config.signal;
    const onOuterAbort = () => controller.abort();
    if (outer) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener('abort', onOuterAbort);
    }
    try {
      return await base<T>({ payload: config.payload, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    }
  };
  return transport as RpcTransport;
}

/**
 * Tries the endpoint that answered last, then the others, on network and HTTP failures only
 * (JSON-RPC errors such as a failed simulation are answers and are not retried elsewhere).
 * Resending the same signed transaction to a second endpoint is safe: it carries the same signature.
 */
function failoverTransport(urls: readonly string[], timeoutMs: number): RpcTransport {
  const transports = urls.map((url) => transportWithTimeout(url, timeoutMs));
  let preferred = 0;
  const transport = async <T,>(config: Readonly<{ payload: unknown; signal?: AbortSignal }>): Promise<T> => {
    let lastError: unknown = new Error('no devnet RPC configured');
    for (let attempt = 0; attempt < transports.length; attempt++) {
      const index = (preferred + attempt) % transports.length;
      try {
        const result = await transports[index]<T>(config);
        preferred = index;
        return result;
      } catch (error) {
        lastError = error;
        if (config.signal?.aborted) throw error;
      }
    }
    throw lastError;
  };
  return transport as RpcTransport;
}

export const devnetRpc: SolanaRpc = createSolanaRpcFromTransport(failoverTransport(DEVNET_RPCS, 15_000)) as SolanaRpc;

const mainnetRpcs: SolanaRpc[] = MAINNET_RPCS.map(
  (url) => createSolanaRpcFromTransport(transportWithTimeout(url, 6_000)) as SolanaRpc,
);
let mainnetIndex = 0;

/** Runs `fn` against the mainnet endpoint that worked last, failing over to the next on error. */
export async function withMainnet<T>(fn: (rpc: SolanaRpc) => Promise<T>): Promise<T> {
  let lastError: unknown = new Error('no mainnet RPC configured');
  for (let attempt = 0; attempt < mainnetRpcs.length; attempt++) {
    const index = (mainnetIndex + attempt) % mainnetRpcs.length;
    try {
      const result = await fn(mainnetRpcs[index]);
      mainnetIndex = index;
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
