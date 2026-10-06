/**
 * A stand-in for the attestor service: it reads the transaction it is sent and, depending on
 * `mode`, signs its message like the real service, signs something else, refuses or is down.
 */
import {
  generateKeyPair,
  getAddressFromPublicKey,
  getBase58Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  signBytes,
  type Address,
} from '@solana/kit';
import type { FetchLike } from '../src/attest.ts';

export type FakeAttestor = {
  address: Address;
  fetch: FetchLike;
  /** Request bodies, in order. */
  seen: string[];
  mode: 'sign' | 'forge' | 'refuse' | 'down';
  /** What mode 'refuse' answers: the HTTP status and the reason code of the JSON body. */
  refusal: { status: number; reason: string };
};

export const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

export async function fakeAttestor(): Promise<FakeAttestor> {
  const keys = await generateKeyPair();
  const attestor: FakeAttestor = {
    address: await getAddressFromPublicKey(keys.publicKey),
    seen: [],
    mode: 'sign',
    refusal: { status: 422, reason: 'samples disagree' },
    fetch: async () => reply(500, {}),
  };
  attestor.fetch = async (_url, init) => {
    attestor.seen.push(init.body);
    if (attestor.mode === 'refuse') return reply(attestor.refusal.status, { reason: attestor.refusal.reason });
    if (attestor.mode === 'down') return reply(503, { error: 'unavailable' });
    const { tx } = JSON.parse(init.body) as { tx: string };
    const message = getTransactionDecoder().decode(getBase64Encoder().encode(tx)).messageBytes;
    const signed = await signBytes(keys.privateKey, attestor.mode === 'forge' ? new Uint8Array(message).reverse() : message);
    return reply(200, { signature: getBase58Decoder().decode(signed) });
  };
  return attestor;
}
