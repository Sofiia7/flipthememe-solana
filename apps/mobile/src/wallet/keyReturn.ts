// The SOL on this phone's device key (bet fees) and how it goes back to the wallet after WITHDRAW ALL.
// The key signs and pays the fee itself, so there is no wallet popup. Pure TypeScript for node:test.
import { sol } from '../lib/format.ts';
import { NETWORK_FEE } from './topUpPlan.ts';

/** What returning the key's SOL moves: everything above the fee of that transfer; 0 when the key holds no more than a fee. */
export function keyReturnAmount(balance: bigint, fee: bigint = NETWORK_FEE): bigint {
  return balance > fee ? balance - fee : 0n;
}

/** After WITHDRAW ALL the key's SOL follows, only when it holds more than a fee and no bet of this phone is in flight. */
export function shouldReturnKey(input: { keyLamports: bigint; betInFlight: boolean }): boolean {
  return !input.betInFlight && keyReturnAmount(input.keyLamports) > 0n;
}

/** How the second step of a withdraw ended. It is best effort: none of these turns the withdraw into an error. */
export type KeyReturn =
  | { kind: 'returned'; amount: bigint }
  /** Nothing worth returning, or no device key. */
  | { kind: 'empty' }
  | { kind: 'busy' }
  /** Sent, outcome not known yet; the RETURN TO WALLET button shows CHECKING until the chain answers. */
  | { kind: 'checking' }
  | { kind: 'failed' };

/** The withdraw's own message first, then a neutral note about the device key when there is one. */
export function withdrawMessage(done: string, key: KeyReturn): string {
  switch (key.kind) {
    case 'returned':
      return `${done} The device key's ${sol(key.amount, { maxDecimals: 5 })} came back too.`;
    case 'busy':
      return `${done} The device key keeps its fee money while a bet is landing.`;
    case 'checking':
      return `${done} The device key's SOL is on its way - check the balance in a minute.`;
    case 'failed':
      return `${done} The device key's SOL stays on this phone; RETURN TO WALLET under ADVANCED sends it.`;
    default:
      return done;
  }
}
