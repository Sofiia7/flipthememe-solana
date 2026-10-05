// Seeker ID names (.skr, AllDomains ANS on Solana mainnet) for player rows: wallet -> "oxbla.skr".
//
// The reads @onsol/tldparser makes for getParsedAllUserDomainsFromTld(owner, 'skr'), as in
// services/link/src/names.ts:
//   1. getProgramAccounts on the ANS program: name records under the .skr TLD (parent at offset 8)
//      owned by the wallet (owner at offset 40);
//   2. getMultipleAccounts on each record's reverse lookup account (a PDA of the record under the
//      .skr TLD house): the name follows the 200-byte record header.
// The phone asks mainnet itself: the public RPC refuses these reads to Cloudflare Workers, not to
// phones. Lookups run one at a time with a gap (bursts of getProgramAccounts get 429). Names are
// kept 12 h on the phone, "no name" 1 h; a failed lookup is simply tried again on a later look.
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  address,
  getAddressEncoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  type Address,
  type Base58EncodedBytes,
} from '@solana/kit';
import { withMainnet } from './rpc';
import { nameFromRecord, pickName } from './skrName';

const ANS_PROGRAM = address('ALTNSZ46uaAUU7XUV6awvdorLGqAsPwa9shm7h4uP2FK');
/** Name record of the .skr TLD (see services/link/src/names.ts for the derivation). */
const SKR_PARENT = 'F3A8kuikEiu6k2399oSJ1PWfcJYDHqpwoQ2e8psSDNuF' as Base58EncodedBytes;
/** TLD house of .skr: the class of every reverse lookup account. */
const SKR_TLD_HOUSE = address('4RKP4BEMu5sXBfXSH7xN2owtQrnAJvhhwtBBmj9JEYkA');
const FOUND_MS = 12 * 3_600_000;
const NONE_MS = 3_600_000;
const GAP_MS = 400;
const STORE_PREFIX = 'ftm.skr.v1.';

type Entry = { name: string | null; at: number };
const memory = new Map<string, Entry>();
const listeners = new Set<() => void>();
const pending = new Set<string>();
const queue: string[] = [];
let running = false;

const fresh = (e: Entry | undefined, now = Date.now()) => !!e && now - e.at < (e.name ? FOUND_MS : NONE_MS);
const notify = () => listeners.forEach((on) => on());

async function reverseLookup(record: string): Promise<Address> {
  const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ALT Name Service${record}`)));
  const [pda] = await getProgramDerivedAddress({
    programAddress: ANS_PROGRAM,
    seeds: [hashed, getAddressEncoder().encode(SKR_TLD_HOUSE), new Uint8Array(32)],
  });
  return pda;
}

async function lookup(owner: string): Promise<string | null> {
  const rows = await withMainnet((rpc) =>
    rpc
      .getProgramAccounts(ANS_PROGRAM, {
        encoding: 'base64',
        dataSlice: { offset: 0, length: 0 },
        filters: [
          { memcmp: { offset: 8n, bytes: SKR_PARENT, encoding: 'base58' } },
          { memcmp: { offset: 40n, bytes: owner as Base58EncodedBytes, encoding: 'base58' } },
        ],
      })
      .send(),
  );
  if (rows.length === 0) return null;
  const reverse = await Promise.all(rows.map((r) => reverseLookup(r.pubkey)));
  const { value } = await withMainnet((rpc) => rpc.getMultipleAccounts(reverse, { encoding: 'base64' }).send());
  const b64 = getBase64Encoder();
  const names: string[] = [];
  for (const account of value) {
    if (!account || account.owner !== ANS_PROGRAM) continue;
    const name = nameFromRecord(new Uint8Array(b64.encode(account.data[0])));
    if (name) names.push(name);
  }
  return pickName(names);
}

function remember(owner: string, name: string | null): void {
  const entry = { name, at: Date.now() };
  memory.set(owner, entry);
  AsyncStorage.setItem(STORE_PREFIX + owner, JSON.stringify(entry)).catch(() => undefined);
  notify();
}

async function work(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (let owner = queue.shift(); owner; owner = queue.shift()) {
      try {
        remember(owner, await lookup(owner));
      } catch {
        // Rate limited or offline: nothing is stored, a later look asks again.
      }
      pending.delete(owner);
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
  } finally {
    running = false;
  }
}

async function request(owners: readonly string[]): Promise<void> {
  for (const owner of owners) {
    if (pending.has(owner) || fresh(memory.get(owner))) continue;
    pending.add(owner);
    try {
      const raw = await AsyncStorage.getItem(STORE_PREFIX + owner);
      const stored = raw ? (JSON.parse(raw) as Entry) : undefined;
      if (stored && fresh(stored)) {
        memory.set(owner, stored);
        pending.delete(owner);
        notify();
        continue;
      }
    } catch {
      // A broken entry is looked up again.
    }
    queue.push(owner);
  }
  void work();
}

/** .skr names of these wallets, as far as known; looks up the rest in the background. */
export function useSkrNames(owners: readonly string[]): ReadonlyMap<string, string> {
  const [, setTick] = useState(0);
  const key = [...new Set(owners)].sort().join(',');
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    listeners.add(on);
    if (key) void request(key.split(','));
    return () => {
      listeners.delete(on);
    };
  }, [key]);
  const out = new Map<string, string>();
  for (const owner of key ? key.split(',') : []) {
    const name = memory.get(owner)?.name;
    if (name) out.set(owner, name);
  }
  return out;
}
