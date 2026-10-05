import type { SolanaRpc } from './rpc';

/**
 * Wraps an RPC so `onSent` fires once the first `sendTransaction` has been accepted (preflight
 * passed). The client's `sendAndConfirm` stays the single implementation of send + confirm;
 * this only lets the UI switch from "sending" to "confirming" at the right moment.
 */
export function observeSend(rpc: SolanaRpc, onSent: () => void): SolanaRpc {
  let fired = false;
  return new Proxy(rpc, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== 'sendTransaction' || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const request = (value as (...a: unknown[]) => { send: (options?: unknown) => Promise<unknown> })(...args);
        return {
          ...request,
          send: async (options?: unknown) => {
            const result = await request.send(options);
            if (!fired) {
              fired = true;
              onSent();
            }
            return result;
          },
        };
      };
    },
  });
}
