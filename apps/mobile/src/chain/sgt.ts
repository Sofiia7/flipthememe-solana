// Seeker Genesis Token check for the connected wallet: "is this wallet a verified Seeker owner?".
// One mainnet read per wallet per session (the phone asks mainnet itself, like chain/skr.ts): the
// wallet's Token-2022 accounts, then the mints of the non-empty ones, 100 per call. A verified
// result is kept 24 h on the phone, "none" 1 h; a failed read is simply tried again on a later look.
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { address } from '@solana/kit';
import { withMainnet } from './rpc';
import { TOKEN_2022_PROGRAM, firstSeekerGenesis, heldMints, type SeekerGenesis } from './sgtCheck';

const VERIFIED_MS = 24 * 3_600_000;
const NONE_MS = 3_600_000;
const STORE_PREFIX = 'ftm.sgt.v1.';
/** A wallet with hundreds of Token-2022 accounts: look at the first 300 non-empty mints at most. */
const MAX_MINTS = 300;

export type SeekerStatus = { state: 'unknown' } | { state: 'none' } | { state: 'verified'; sgt: SeekerGenesis };

type Entry = { sgt: SeekerGenesis | null; at: number };
const memory = new Map<string, Entry>();
const listeners = new Set<() => void>();
const pending = new Set<string>();

const fresh = (e: Entry | undefined, now = Date.now()) => !!e && now - e.at < (e.sgt ? VERIFIED_MS : NONE_MS);
const notify = () => listeners.forEach((on) => on());

async function lookup(owner: string): Promise<SeekerGenesis | null> {
  const accounts = await withMainnet((rpc) =>
    rpc.getTokenAccountsByOwner(address(owner), { programId: address(TOKEN_2022_PROGRAM) }, { encoding: 'jsonParsed' }).send(),
  );
  const mints = heldMints(accounts.value).slice(0, MAX_MINTS);
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    const { value } = await withMainnet((rpc) => rpc.getMultipleAccounts(chunk.map((m) => address(m)), { encoding: 'jsonParsed' }).send());
    const found = firstSeekerGenesis(chunk, value);
    if (found) return found;
  }
  return null;
}

async function request(owner: string): Promise<void> {
  if (pending.has(owner) || fresh(memory.get(owner))) return;
  pending.add(owner);
  try {
    try {
      const raw = await AsyncStorage.getItem(STORE_PREFIX + owner);
      const stored = raw ? (JSON.parse(raw) as Entry) : undefined;
      if (stored && fresh(stored)) {
        memory.set(owner, stored);
        notify();
        return;
      }
    } catch {
      // A broken entry is looked up again.
    }
    const entry: Entry = { sgt: await lookup(owner), at: Date.now() };
    memory.set(owner, entry);
    AsyncStorage.setItem(STORE_PREFIX + owner, JSON.stringify(entry)).catch(() => undefined);
    notify();
  } catch {
    // Rate limited or offline: nothing is stored, a later look asks again.
  } finally {
    pending.delete(owner);
  }
}

/** Seeker Genesis Token status of this wallet, as far as known; asks mainnet in the background. */
export function useSeekerStatus(owner: string | null): SeekerStatus {
  const [, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    listeners.add(on);
    if (owner) void request(owner);
    return () => {
      listeners.delete(on);
    };
  }, [owner]);
  const entry = owner ? memory.get(owner) : undefined;
  if (!entry) return { state: 'unknown' };
  return entry.sgt ? { state: 'verified', sgt: entry.sgt } : { state: 'none' };
}
