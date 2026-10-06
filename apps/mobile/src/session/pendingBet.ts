import AsyncStorage from '@react-native-async-storage/async-storage';

const STORE_KEY = 'ftm.pendingBet.v1';

/** A bet that was signed and sent but not yet seen as a Position account. */
export type PendingBet = {
  owner: string;
  roundId: bigint;
  side: number;
  amount: bigint;
  signature: string;
  /** Local ms when it was sent. */
  at: number;
  /** Last block height its blockhash can land at; null for bets saved by older builds. */
  lastValidBlockHeight: bigint | null;
};

type Stored = Omit<PendingBet, 'roundId' | 'amount' | 'lastValidBlockHeight'> & {
  roundId: string;
  amount: string;
  lastValidBlockHeight?: string | null;
};

export async function savePendingBet(bet: PendingBet): Promise<void> {
  const stored: Stored = {
    ...bet,
    roundId: bet.roundId.toString(),
    amount: bet.amount.toString(),
    lastValidBlockHeight: bet.lastValidBlockHeight === null ? null : bet.lastValidBlockHeight.toString(),
  };
  await AsyncStorage.setItem(STORE_KEY, JSON.stringify(stored));
}

export async function loadPendingBet(): Promise<PendingBet | null> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Stored>;
    if (typeof s.owner !== 'string' || typeof s.signature !== 'string' || typeof s.roundId !== 'string' || typeof s.amount !== 'string') {
      return null;
    }
    return {
      owner: s.owner,
      roundId: BigInt(s.roundId),
      side: Number(s.side) === 1 ? 1 : 0,
      amount: BigInt(s.amount),
      signature: s.signature,
      at: Number(s.at) || Date.now(),
      lastValidBlockHeight: typeof s.lastValidBlockHeight === 'string' && /^\d{1,20}$/.test(s.lastValidBlockHeight) ? BigInt(s.lastValidBlockHeight) : null,
    };
  } catch {
    return null;
  }
}

/** Forgets the stored bet; with `signature`, only when it is still that bet (a newer one stays). */
export async function clearPendingBet(signature?: string): Promise<void> {
  if (signature !== undefined) {
    const stored = await loadPendingBet();
    if (stored && stored.signature !== signature) return;
  }
  await AsyncStorage.removeItem(STORE_KEY);
}
