// The token check at pool selection, on mint accounts built byte by byte as the SPL Token and Token-2022
// programs lay them out: 82 bytes of mint (mint authority COption @0, supply @36, decimals @44, is_initialized
// @45, freeze authority COption @46), and for Token-2022 padding to 165, the account type @165 and a TLV list.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Address } from '@solana/kit';
import type { SolanaRpc } from '../src/rpc.ts';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, TokenChecker, holderConcentration, inspectMint } from '../src/tokencheck.ts';
import { testAddress } from './pool-fixtures.ts';

const SUPPLY = 1_000_000_000_000_000n; // 1B tokens at 6 decimals, like a pump.fun mint

function mintBytes(opts: { mintAuthority?: boolean; freezeAuthority?: boolean; supply?: bigint; initialized?: boolean } = {}): Uint8Array {
  const data = new Uint8Array(82);
  const view = new DataView(data.buffer);
  if (opts.mintAuthority) {
    view.setUint32(0, 1, true);
    data.fill(7, 4, 36);
  }
  view.setBigUint64(36, opts.supply ?? SUPPLY, true);
  data[44] = 6;
  data[45] = opts.initialized === false ? 0 : 1;
  if (opts.freezeAuthority) {
    view.setUint32(46, 1, true);
    data.fill(9, 50, 82);
  }
  return data;
}

type Extension = { type: number; value?: number[] };

/** A Token-2022 mint: the 82 bytes, zero padding to 165, account type 1, then the TLV entries. */
function token2022(base: Uint8Array, extensions: Extension[], opts: { accountType?: number; trailingZeros?: number } = {}): Uint8Array {
  const tlv: number[] = [];
  for (const e of extensions) {
    const value = e.value ?? [];
    tlv.push(e.type & 0xff, e.type >> 8, value.length & 0xff, value.length >> 8, ...value);
  }
  const out = new Uint8Array(166 + tlv.length + (opts.trailingZeros ?? 0));
  out.set(base, 0);
  out[165] = opts.accountType ?? 1;
  out.set(tlv, 166);
  return out;
}

const T22 = { TransferFeeConfig: 1, DefaultAccountState: 6, NonTransferable: 9, PermanentDelegate: 12, TransferHook: 14, MetadataPointer: 18, TokenMetadata: 19, Pausable: 26 };

describe('inspectMint: the mint account', () => {
  test('a pump.fun style mint (both authorities revoked) passes and reports its supply', () => {
    assert.deepEqual(inspectMint(TOKEN_PROGRAM_ID, mintBytes()), { ok: true, supply: SUPPLY });
  });

  test('a mint authority or a freeze authority refuses it', () => {
    assert.deepEqual(inspectMint(TOKEN_PROGRAM_ID, mintBytes({ mintAuthority: true })), { ok: false, reason: 'mint authority is not revoked' });
    assert.deepEqual(inspectMint(TOKEN_PROGRAM_ID, mintBytes({ freezeAuthority: true })), { ok: false, reason: 'freeze authority is not revoked' });
    assert.equal(inspectMint(TOKEN_PROGRAM_ID, mintBytes({ mintAuthority: true, freezeAuthority: true })).ok, false);
  });

  test('not a mint at all: wrong owner, too short, uninitialized, a corrupt authority tag, no supply', () => {
    assert.match(String((inspectMint('11111111111111111111111111111111', mintBytes()) as { reason: string }).reason), /not owned by a token program/);
    assert.match(String((inspectMint(TOKEN_PROGRAM_ID, new Uint8Array(81)) as { reason: string }).reason), /81 bytes/);
    assert.deepEqual(inspectMint(TOKEN_PROGRAM_ID, mintBytes({ initialized: false })), { ok: false, reason: 'mint is not initialized' });
    const corrupt = mintBytes();
    corrupt[0] = 2; // a COption tag is 0 or 1
    assert.deepEqual(inspectMint(TOKEN_PROGRAM_ID, corrupt), { ok: false, reason: 'mint authority fields are malformed' });
    assert.deepEqual(inspectMint(TOKEN_PROGRAM_ID, mintBytes({ supply: 0n })), { ok: false, reason: 'supply is zero' });
  });

  test('Token-2022 without extensions (82 bytes) and with harmless ones (metadata) is fine', () => {
    assert.equal(inspectMint(TOKEN_2022_PROGRAM_ID, mintBytes()).ok, true);
    const withMetadata = token2022(mintBytes(), [
      { type: T22.MetadataPointer, value: new Array<number>(64).fill(3) },
      { type: T22.TokenMetadata, value: new Array<number>(120).fill(4) },
    ]);
    assert.deepEqual(inspectMint(TOKEN_2022_PROGRAM_ID, withMetadata), { ok: true, supply: SUPPLY });
    assert.equal(inspectMint(TOKEN_2022_PROGRAM_ID, token2022(mintBytes(), [], { trailingZeros: 10 })).ok, true, 'zero padding after the last entry ends the list');
  });

  test('Token-2022 with TransferFee, TransferHook, PermanentDelegate, NonTransferable or Pausable is refused, wherever it sits in the list', () => {
    const filler: Extension = { type: T22.MetadataPointer, value: new Array<number>(64).fill(3) };
    const reasonOf = (type: number) => (inspectMint(TOKEN_2022_PROGRAM_ID, token2022(mintBytes(), [filler, { type, value: [1, 2, 3, 4] }])) as { ok: false; reason: string }).reason;
    assert.equal(reasonOf(T22.TransferFeeConfig), 'transfer fee extension');
    assert.equal(reasonOf(T22.TransferHook), 'transfer hook extension');
    assert.equal(reasonOf(T22.PermanentDelegate), 'permanent delegate extension');
    assert.equal(reasonOf(T22.NonTransferable), 'non-transferable extension');
    assert.equal(reasonOf(T22.Pausable), 'pausable extension');
  });

  test('DefaultAccountState: frozen is refused, initialized is fine', () => {
    const state = (value: number) => inspectMint(TOKEN_2022_PROGRAM_ID, token2022(mintBytes(), [{ type: T22.DefaultAccountState, value: [value] }]));
    assert.deepEqual(state(2), { ok: false, reason: 'default account state is frozen' });
    assert.equal(state(1).ok, true);
  });

  test('a Token-2022 account that is not a mint, or whose extension list is cut short, is refused; so is a Token-2022 mint with an authority', () => {
    const notMint = token2022(mintBytes(), [], { accountType: 2 });
    assert.deepEqual(inspectMint(TOKEN_2022_PROGRAM_ID, notMint), { ok: false, reason: 'token-2022 account type is not a mint' });
    const cut = token2022(mintBytes(), [{ type: T22.TokenMetadata, value: new Array<number>(40).fill(1) }]).slice(0, 166 + 10); // length says 40, 6 bytes are left
    assert.deepEqual(inspectMint(TOKEN_2022_PROGRAM_ID, cut), { ok: false, reason: 'token-2022 extension list is malformed' });
    assert.deepEqual(inspectMint(TOKEN_2022_PROGRAM_ID, token2022(mintBytes({ freezeAuthority: true }), [])), { ok: false, reason: 'freeze authority is not revoked' });
    assert.match(String((inspectMint(TOKEN_2022_PROGRAM_ID, new Uint8Array(100).map((_, i) => (i >= 36 && i < 44 ? 1 : i === 45 ? 1 : 0))) as { reason: string }).reason), /shorter than its account type byte/);
  });
});

describe('holderConcentration: the biggest holder outside the pool', () => {
  const vault = 'VAULT';
  const accounts = (...amounts: [string, bigint][]) => amounts.map(([address, amount]) => ({ address, amount: amount.toString() }));
  const check = (list: { address: string; amount: string }[], maxBps = 2000) => holderConcentration(list, new Set([vault]), SUPPLY, maxBps);

  test('the pool vault does not count, however much it holds', () => {
    assert.equal(check(accounts([vault, 600_000_000_000_000n], ['A', 150_000_000_000_000n], ['B', 50_000_000_000_000n])), null);
  });

  test('20 % is allowed, anything above it is refused and named', () => {
    assert.equal(check(accounts([vault, 400_000_000_000_000n], ['A', 200_000_000_000_000n])), null);
    assert.equal(check(accounts(['A', 200_000_000_001_000n])) === null, false, 'a hair above 20 %');
    assert.equal(check(accounts([vault, 100_000_000_000_000n], ['A', 315_000_000_000_000n])), 'top holder A has 31.5% of the supply (limit 20%)');
  });

  test('the limit comes from HOLDER_MAX_PCT', () => {
    const list = accounts(['A', 120_000_000_000_000n]);
    assert.equal(check(list, 2000), null);
    assert.match(String(check(list, 1000)), /top holder A has 12% of the supply \(limit 10%\)/);
  });

  test('nobody but the vault: nothing to refuse', () => {
    assert.equal(check(accounts([vault, SUPPLY])), null);
    assert.equal(check([]), null);
  });
});

/** An RPC stand-in that answers the two reads the checker makes. */
function fakeRpc(opts: {
  owner?: string;
  data?: Uint8Array | null;
  largest?: { address: Address; amount: string }[];
  failWith?: Error;
  /** Only getTokenLargestAccounts fails (the public RPCs rate limit or block it). */
  failLargestWith?: Error;
}) {
  const calls = { account: 0, largest: 0 };
  const rpc = {
    getAccountInfo: () => ({
      send: async () => {
        calls.account++;
        if (opts.failWith) throw opts.failWith;
        if (opts.data === null) return { value: null };
        return { value: { owner: opts.owner ?? TOKEN_PROGRAM_ID, data: [Buffer.from(opts.data ?? mintBytes()).toString('base64'), 'base64'] } };
      },
    }),
    getTokenLargestAccounts: () => ({
      send: async () => {
        calls.largest++;
        if (opts.failWith) throw opts.failWith;
        if (opts.failLargestWith) throw opts.failLargestWith;
        return { value: opts.largest ?? [] };
      },
    }),
  } as unknown as SolanaRpc;
  const mainnet = { call: async <T>(_what: string, fn: (rpc: SolanaRpc) => Promise<T>): Promise<T> => fn(rpc) };
  return { calls, mainnet };
}

describe('TokenChecker', () => {
  const MINT = testAddress(1);
  const VAULT = testAddress(2);
  const holder = (i: number, fraction: bigint) => ({ address: testAddress(100 + i), amount: ((SUPPLY * fraction) / 100n).toString() });

  test('a clean mint with a small holder passes; the pool vault is left out of the holder count', async () => {
    const { mainnet, calls } = fakeRpc({ largest: [{ address: VAULT, amount: ((SUPPLY * 60n) / 100n).toString() }, holder(1, 9n), holder(2, 3n)] });
    const checker = new TokenChecker({ mainnet });
    assert.deepEqual(await checker.check(MINT, VAULT), { ok: true, supply: SUPPLY });
    assert.deepEqual(calls, { account: 1, largest: 1 });
  });

  test('a holder above HOLDER_MAX_PCT refuses the token', async () => {
    const { mainnet } = fakeRpc({ largest: [{ address: VAULT, amount: ((SUPPLY * 50n) / 100n).toString() }, holder(1, 25n)] });
    const verdict = await new TokenChecker({ mainnet }).check(MINT, VAULT);
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, /^top holder .* has 25% of the supply \(limit 20%\)$/);
    const loose = await new TokenChecker({ mainnet, holderMaxPct: 30 }).check(MINT, VAULT);
    assert.equal(loose.ok, true);
  });

  test('an authority on the mint refuses it without asking for the holders', async () => {
    const { mainnet, calls } = fakeRpc({ data: mintBytes({ freezeAuthority: true }) });
    assert.deepEqual(await new TokenChecker({ mainnet }).check(MINT, VAULT), { ok: false, reason: 'freeze authority is not revoked' });
    assert.deepEqual(calls, { account: 1, largest: 0 });
  });

  test('a mint account that is not there is refused', async () => {
    const { mainnet } = fakeRpc({ data: null });
    assert.deepEqual(await new TokenChecker({ mainnet }).check(MINT, VAULT), { ok: false, reason: 'mint account not found' });
  });

  test('a Token-2022 mint with a transfer fee is refused, one without extensions passes', async () => {
    const fee = fakeRpc({ owner: TOKEN_2022_PROGRAM_ID, data: token2022(mintBytes(), [{ type: T22.TransferFeeConfig, value: new Array<number>(108).fill(0) }]) });
    assert.deepEqual(await new TokenChecker({ mainnet: fee.mainnet }).check(MINT, VAULT), { ok: false, reason: 'transfer fee extension' });
    const plain = fakeRpc({ owner: TOKEN_2022_PROGRAM_ID, data: mintBytes(), largest: [holder(1, 4n)] });
    assert.equal((await new TokenChecker({ mainnet: plain.mainnet }).check(MINT, VAULT)).ok, true);
  });

  test('the verdict is cached per mint for 30 minutes (a refusal too), then read again', async () => {
    let now = 1_000_000;
    const { mainnet, calls } = fakeRpc({ largest: [holder(1, 4n)] });
    const checker = new TokenChecker({ mainnet, now: () => now });
    await checker.check(MINT, VAULT);
    now += 29 * 60_000;
    await checker.check(MINT, VAULT);
    assert.deepEqual(calls, { account: 1, largest: 1 });
    assert.equal(checker.reads, 1);
    now += 60_000 + 1; // 30 minutes and a millisecond after the read
    await checker.check(MINT, VAULT);
    assert.deepEqual(calls, { account: 2, largest: 2 });
    // Another mint is another read.
    await checker.check(testAddress(5), VAULT);
    assert.equal(calls.account, 3);

    const refused = fakeRpc({ data: mintBytes({ mintAuthority: true }) });
    const again = new TokenChecker({ mainnet: refused.mainnet });
    await again.check(MINT, VAULT);
    await again.check(MINT, VAULT);
    assert.equal(refused.calls.account, 1, 'a refused mint is remembered as long as an accepted one');
  });

  test('the same mint asked about with another pool vault is read again (the vault is excluded from the count)', async () => {
    const { mainnet, calls } = fakeRpc({ largest: [holder(1, 4n)] });
    const checker = new TokenChecker({ mainnet });
    await checker.check(MINT, VAULT);
    await checker.check(MINT, testAddress(3));
    assert.equal(calls.account, 2);
  });

  test('without a holder list (the RPC refuses it) the mint checks decide: the token passes, marked unchecked, and is read again after 5 minutes', async () => {
    let now = 1_000_000;
    const blocked = fakeRpc({ failLargestWith: new Error('Request blocked') });
    const checker = new TokenChecker({ mainnet: blocked.mainnet, now: () => now });
    const verdict = await checker.check(MINT, VAULT);
    assert.equal(verdict.ok, true);
    assert.equal((verdict as { holders?: string }).holders, 'unchecked');
    assert.equal(checker.holderUnchecked, 1);
    await checker.check(MINT, VAULT);
    assert.equal(blocked.calls.account, 1, 'inside 5 minutes: answered from memory');
    now += 5 * 60_000 + 1;
    await checker.check(MINT, VAULT);
    assert.equal(blocked.calls.account, 2, 'after 5 minutes: read again');
    // The mint checks still refuse, holder list or not.
    const withAuthority = fakeRpc({ data: mintBytes({ mintAuthority: true }), failLargestWith: new Error('Request blocked') });
    const refused = await new TokenChecker({ mainnet: withAuthority.mainnet }).check(MINT, VAULT);
    assert.equal(refused.ok, false);
  });

  test('an RPC failure is thrown to the caller and not cached', async () => {
    const down = fakeRpc({ failWith: new TypeError('fetch failed') });
    const checker = new TokenChecker({ mainnet: down.mainnet });
    await assert.rejects(checker.check(MINT, VAULT), /fetch failed/);
    await assert.rejects(checker.check(MINT, VAULT), /fetch failed/);
    assert.equal(down.calls.account, 2, 'asked again, not answered from memory');
  });
});
