// End-to-end check of a running attestor with live data; nothing is ever sent to a chain.
//
//   node scripts/smoke.ts [attestor URL] [--allow-live]     default http://127.0.0.1:8787 (wrangler dev)
//
// Run it against `wrangler dev`, not against the deployed attestor: the attestor signs one sample
// set per round and window (already_signed), so the signature this script asks for would lock the
// round it picked, and the real keeper's samples for that round would be refused. A URL other than
// localhost needs --allow-live, which accepts losing that one round (it ends through refund_expired).
//
// Waits for the next devnet round's strike window, samples the round's pool on mainnet once a
// second the way the keeper does (the client's observePrice and windowMean), then builds the
// set_strike the keeper would (a throwaway key stands in for the price authority) and asks the
// attestor to co-sign it. Passes when a copy with prices 5% off is refused (slot_price_mismatch or
// price_mismatch; asked first, since after a signature any other set is already_signed) and the
// signature of the real one verifies against the message. The attestor's log line shows
// how many samples sat at a slot it read too (sharedSlots). Env: DEVNET_RPC, MAINNET_RPC (defaults:
// public RPCs).
import {
  PROGRAM_ID,
  RoundStatus,
  configAddress,
  decodeConfig,
  decodeRound,
  loadPool,
  observePrice,
  roundAddress,
  setStrike,
  windowMean,
  type PriceObservation,
  type PriceSample,
  type RoundAccount,
} from '@flipthememe/client';
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getPublicKeyFromAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
  type Address,
  type Blockhash,
} from '@solana/kit';

const base = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'http://127.0.0.1:8787').replace(/\/$/, '');
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base) && !process.argv.includes('--allow-live')) {
  console.error(
    `${base} is not a local attestor. The smoke test would get a signature for the next real round and lock it ` +
      '(one sample set is signed per round and window), so the keeper would be refused as already_signed. ' +
      'Run it against wrangler dev, or add --allow-live to accept losing that round.',
  );
  process.exit(2);
}
const devnet = createSolanaRpc(process.env.DEVNET_RPC ?? 'https://api.devnet.solana.com');
const mainnet = createSolanaRpc(process.env.MAINNET_RPC ?? 'https://solana-rpc.publicnode.com');
const sleep = (ms: number) => new Promise((wake) => setTimeout(wake, Math.max(0, ms)));
const bytes = (data: readonly [string, string]) => new Uint8Array(getBase64Encoder().encode(data[0]));

async function nextRound(): Promise<RoundAccount> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const { value: configAccount } = await devnet.getAccountInfo(await configAddress(), { encoding: 'base64' }).send();
    if (!configAccount) throw new Error('no Config account on devnet');
    const next = decodeConfig(bytes(configAccount.data)).nextRoundId;
    const ids = [next - 1n, next - 2n, next - 3n].filter((id) => id >= 0n);
    const { value } = await devnet.getMultipleAccounts(await Promise.all(ids.map((id) => roundAddress(id))), { encoding: 'base64' }).send();
    const rounds = value.flatMap((a) => (a && a.owner === PROGRAM_ID ? [decodeRound(bytes(a.data))] : []));
    const ahead = rounds
      .filter((r) => r.status === RoundStatus.Open && Number(r.strikeStart) * 1000 - Date.now() > 3_000)
      .sort((a, b) => Number(a.strikeStart - b.strikeStart))[0];
    if (ahead) return ahead;
    console.log('no round ahead yet, waiting for the keeper');
    await sleep(10_000);
  }
  throw new Error('the keeper created no round in two minutes');
}

async function attest(tx: string): Promise<{ status: number; body: { signature?: string; attestor?: string; reason?: string; error?: string } }> {
  const res = await fetch(`${base}/v1/attest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx }) });
  return { status: res.status, body: (await res.json()) as never };
}

const health = (await (await fetch(`${base}/v1/attestor`)).json()) as { attestor: Address | null; keyError?: string };
if (!health.attestor) throw new Error(`the attestor has no key: ${health.keyError ?? 'unknown'}`);
const attestor = address(health.attestor);
console.log(`attestor ${attestor} at ${base}`);

const round = await nextRound();
const startMs = Number(round.strikeStart) * 1000;
const endMs = Number(round.strikeEnd) * 1000;
console.log(`round ${round.id}: strike window ${new Date(startMs).toISOString()}, pool ${round.pool}`);
const ref = await loadPool(mainnet, round.pool);

const observations: PriceObservation[] = [];
await sleep(startMs + 300 - Date.now());
while (Date.now() < endMs) {
  const tickAt = Date.now();
  try {
    observations.push(await observePrice(mainnet, ref));
  } catch (error) {
    console.log(`read failed: ${error instanceof Error ? error.message : error}`);
  }
  await sleep(tickAt + 1_000 - Date.now());
}
const mean = windowMean(observations, startMs, endMs);
if (!mean) throw new Error(`only ${observations.length} reads in the window`);
const samples: PriceSample[] = mean.samples.map((o) => ({ slot: o.slot, price: o.price }));
console.log(`keeper side: ${samples.length} samples, mean ${mean.price}`);
await sleep(endMs + 300 - Date.now());

const priceAuthority = await generateKeyPairSigner();
const build = async (list: PriceSample[]) => {
  const ix = await setStrike({ priceAuthority, roundId: round.id, samples: list, attestor });
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(priceAuthority.address, m),
    // Never sent, so any 32 bytes do as the blockhash.
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 0n }, m),
    (m) => appendTransactionMessageInstructions([ix], m),
  );
  return compileTransaction(message);
};

// At a slot both sides read, the exact-price rule catches it first; otherwise the mean check does.
// Asked before the real one: once a set is signed for the round, any other is already_signed.
const off = await build(samples.map((s) => ({ ...s, price: (s.price * 105n) / 100n })));
const refused = await attest(getBase64EncodedWireTransaction(off));
if (refused.status !== 422 || !['slot_price_mismatch', 'price_mismatch'].includes(refused.body.reason ?? '')) {
  throw new Error(`prices 5% off were not refused: ${JSON.stringify(refused)}`);
}
console.log(`prices 5% off refused (${refused.body.reason}): ${refused.body.error}`);

const good = await build(samples);
const signed = await attest(getBase64EncodedWireTransaction(good));
if (signed.status !== 200 || !signed.body.signature) throw new Error(`refused: ${signed.status} ${JSON.stringify(signed.body)}`);
const signature = new Uint8Array(getBase58Encoder().encode(signed.body.signature));
const valid = await verifySignature(await getPublicKeyFromAddress(attestor), signature as never, good.messageBytes);
if (!valid) throw new Error('the signature does not verify against the message');
console.log(`co-signed, signature verifies: ${signed.body.signature}`);
console.log('smoke test passed');
