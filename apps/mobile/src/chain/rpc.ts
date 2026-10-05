import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type Rpc,
  type RpcTransport,
  type SolanaRpcApi,
} from '@solana/kit';
import { DEVNET_RPC, MAINNET_RPCS } from '../config';

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

export const devnetRpc: SolanaRpc = createSolanaRpcFromTransport(transportWithTimeout(DEVNET_RPC, 15_000)) as SolanaRpc;

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
