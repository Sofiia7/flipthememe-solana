import { attestedPriceInstructions, priceMessage, type PriceKind, type RoundAccount } from '@flipthememe/client';
import { getBase58Encoder, getPublicKeyFromAddress, type Address } from '@solana/kit';

/** Public relaying needs neither ATTEST_TOKEN nor the keeper/price-authority secret. */
export async function certificateInstructions(url: string, round: RoundAccount, kind: PriceKind, attestor: Address, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`${url.replace(/\/+$/, '')}/v1/attestation?round=${round.id}&kind=${kind}`, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`certificate HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty price certificate');
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > 8192) throw new Error('price certificate too large');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  const packet = JSON.parse(new TextDecoder().decode(bytes));
  if (packet.roundId !== round.id.toString() || packet.kind !== kind || packet.attestor !== attestor || typeof packet.signature !== 'string' || !Array.isArray(packet.samples) || packet.samples.length > 16) throw new Error('price certificate context mismatch');
  const samples = packet.samples.map((s: { slot?: unknown; price?: unknown }) => {
    if (typeof s?.slot !== 'string' || typeof s.price !== 'string' || !/^\d{1,20}$/.test(s.slot) || !/^\d{1,20}$/.test(s.price)) throw new Error('invalid price sample');
    return { slot: BigInt(s.slot), price: BigInt(s.price) };
  });
  const message = await priceMessage(round, kind, samples);
  const signature = new Uint8Array(getBase58Encoder().encode(packet.signature));
  if (signature.length !== 64 || !await crypto.subtle.verify('Ed25519', await getPublicKeyFromAddress(attestor), signature, new Uint8Array(message))) throw new Error('price certificate signature invalid');
  return attestedPriceInstructions(round, kind, samples, attestor, packet.signature);
}
