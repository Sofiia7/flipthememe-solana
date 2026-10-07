/**
 * A read-only census of the devnet program: how many wallets ever opened a vault, the sessions, the rounds that
 * are still on the chain, the positions on them and how many real people those positions are. Nothing is signed or
 * sent, no key is read.
 *
 *   node services/keeper/scripts/census.ts
 *
 * Env: DEVNET_RPC (default https://api.devnet.solana.com; a dedicated endpoint is kinder to it).
 *
 * The chain forgets: the keeper closes positions a day after their round and rounds after their last position
 * (rent goes back), so this counts what is there now. Vault accounts are never closed, so their number is the
 * wallets that ever put SOL into the game. For the history of played rounds use scripts/stats.ts, which reads the
 * keeper's rounds.jsonl. A position is a house position when its is_house byte (OFFSETS.positionIsHouse) is 1.
 */
import {
  OFFSETS,
  Outcome,
  POSITION_ACCOUNT_SIZE,
  PROGRAM_ID,
  RefundReason,
  RoundStatus,
  decodePosition,
  decodeRound,
  decodeSession,
  decodeVault,
  roundAddress,
} from '@flipthememe/client';
import { getBase58Decoder, getBase64Encoder, type Address, type Base58EncodedBytes } from '@solana/kit';
import { ROUND_ACCOUNT_SIZE, VAULT_ACCOUNT_SIZE, isRateLimited } from '../src/chain.ts';
import { DEFAULT_DEVNET_RPC } from '../src/config.ts';
import { hostOf } from '../src/log.ts';
import { makeRpc, shortError, type SolanaRpc } from '../src/rpc.ts';

/** 8-byte discriminator + Session::INIT_SPACE (authority, vault, signer, expiry, max_per_bet, session_cap, spent, revoked, bump). */
const SESSION_ACCOUNT_SIZE = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1;

const base64 = getBase64Encoder();
const base58 = getBase58Decoder();
const bytesOf = (data: readonly [string, 'base64'] | [string, 'base64']): Uint8Array => base64.encode(data[0]) as Uint8Array;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sol = (lamports: bigint): string => (Number(lamports) / 1e9).toFixed(4);
const nameOf = (map: Record<string, number>, value: number): string => Object.entries(map).find(([, v]) => v === value)?.[0] ?? String(value);

/** One getProgramAccounts call, asked again after a pause when the public endpoint answers 429. */
async function withRetry<T>(what: string, call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= 4 || !isRateLimited(error)) throw new Error(`${what}: ${shortError(error)}`);
      await sleep(2_000 * attempt);
    }
  }
}

async function accountsOfSize(rpc: SolanaRpc, dataSize: number, extra: { offset: number; byte: number }[] = [], slice?: { offset: number; length: number }) {
  const filters = [
    { dataSize: BigInt(dataSize) },
    ...extra.map((f) => ({ memcmp: { offset: BigInt(f.offset), bytes: base58.decode(new Uint8Array([f.byte])) as Base58EncodedBytes, encoding: 'base58' as const } })),
  ];
  return withRetry(`getProgramAccounts size ${dataSize}`, () =>
    rpc
      .getProgramAccounts(PROGRAM_ID, { encoding: 'base64', commitment: 'confirmed', filters, ...(slice ? { dataSlice: slice } : {}) })
      .send(),
  );
}

async function main(): Promise<void> {
  const url = process.env.DEVNET_RPC?.trim() || DEFAULT_DEVNET_RPC;
  const rpc = makeRpc(url, 60_000);
  console.log(`devnet ${hostOf(url)}  program ${PROGRAM_ID}\n`);

  const vaults = await accountsOfSize(rpc, VAULT_ACCOUNT_SIZE);
  let total = 0n;
  let funded = 0;
  for (const v of vaults) {
    const vault = decodeVault(bytesOf(v.account.data));
    total += vault.available + vault.locked;
    if (vault.available + vault.locked > 0n) funded++;
  }
  console.log(`vault accounts (wallets that ever put SOL in):  ${vaults.length}`);
  console.log(`  with a balance now: ${funded}   SOL held in vaults: ${sol(total)}`);

  const sessions = await accountsOfSize(rpc, SESSION_ACCOUNT_SIZE);
  const nowSecs = BigInt(Math.floor(Date.now() / 1000));
  const live = sessions.filter((s) => {
    const session = decodeSession(bytesOf(s.account.data));
    return !session.revoked && session.expiry > nowSecs;
  });
  console.log(`session accounts: ${sessions.length}   not expired and not revoked: ${live.length}\n`);

  const rounds = (await accountsOfSize(rpc, ROUND_ACCOUNT_SIZE)).map((r) => decodeRound(bytesOf(r.account.data)));
  const withBets = rounds.filter((r) => r.positionCount > 0 || r.rawUp + r.rawDown > 0n);
  console.log(`round accounts still on the chain: ${rounds.length}   with bets: ${withBets.length}`);
  const byOutcome: Record<string, number> = {};
  for (const r of withBets) {
    const key = `${nameOf(RoundStatus, r.status)}/${nameOf(Outcome, r.outcome)}/${nameOf(RefundReason, r.refundReason)}`;
    byOutcome[key] = (byOutcome[key] ?? 0) + 1;
  }
  console.log(`  by status/outcome/reason: ${JSON.stringify(byOutcome)}`);
  if (withBets.length > 0) {
    const opened = withBets.map((r) => Number(r.opensAt)).sort((a, b) => a - b);
    console.log(`  first / last round with bets: ${new Date((opened[0] ?? 0) * 1000).toISOString()}  ${new Date((opened[opened.length - 1] ?? 0) * 1000).toISOString()}`);
  }

  // Human positions are asked for with a memcmp on is_house = 0; the house's are only counted (an empty data slice).
  const humans = (await accountsOfSize(rpc, POSITION_ACCOUNT_SIZE, [{ offset: OFFSETS.positionIsHouse, byte: 0 }])).map((p) => decodePosition(bytesOf(p.account.data)));
  const houseCount = (await accountsOfSize(rpc, POSITION_ACCOUNT_SIZE, [{ offset: OFFSETS.positionIsHouse, byte: 1 }], { offset: 0, length: 0 })).length;
  const wallets = new Map<string, number>();
  for (const p of humans) wallets.set(p.authority, (wallets.get(p.authority) ?? 0) + 1);
  console.log(`\nposition accounts on the chain: ${humans.length + houseCount}   human: ${humans.length}   house: ${houseCount}`);
  console.log(`  distinct human wallets: ${wallets.size}`);

  const perRound = new Map<string, Set<string>>();
  for (const p of humans) {
    const set = perRound.get(p.round) ?? new Set<string>();
    set.add(p.authority);
    perRound.set(p.round, set);
  }
  const addressOf = new Map<Address, (typeof rounds)[number]>();
  for (const r of rounds) addressOf.set(await roundAddress(r.id), r);
  const priced = (r?: (typeof rounds)[number]) => r !== undefined && (r.outcome === Outcome.Up || r.outcome === Outcome.Down);
  const roundsWithPeople = [...perRound.entries()];
  console.log(`  rounds with 1+ human wallets (still on the chain): ${roundsWithPeople.length}`);
  console.log(`  rounds with 2+ human wallets:                      ${roundsWithPeople.filter(([, s]) => s.size >= 2).length}`);
  console.log(`  of those, priced (up or down):                     ${roundsWithPeople.filter(([a, s]) => s.size >= 2 && priced(addressOf.get(a as Address))).length}`);
}

main().catch((error: unknown) => {
  console.error(`census failed: ${shortError(error)}`);
  process.exit(1);
});
