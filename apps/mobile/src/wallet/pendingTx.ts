// Money actions from the Wallet tab and the top up sheet (top up, renew, withdraw, revoke, close,
// return key funds) whose transaction was signed and sent but whose outcome is not known yet. The
// signature and its blockhash expiry are stored before sending, so a closed app, a dropped
// connection or a timeout is settled from the chain on the next start or tap (chain/txStatus.ts),
// never by sending again blind. Pure TypeScript: storage is injected, so node tests use a fake.
import type { KeyValueStorage } from '../lib/boolStore.ts';

export type GuardedAction = 'topup' | 'renew' | 'withdraw' | 'revoke' | 'close' | 'sweep';

const ACTIONS: readonly GuardedAction[] = ['topup', 'renew', 'withdraw', 'revoke', 'close', 'sweep'];

export type PendingTx = {
  action: GuardedAction;
  owner: string;
  signature: string;
  lastValidBlockHeight: bigint;
  /** Local ms when it was signed. */
  at: number;
  /** What the app says once a later check finds it confirmed. */
  done: string;
  /** Device keys whose sessions a revoke or a close covers (empty for the other actions). */
  targets: string[];
};

type Stored = Omit<PendingTx, 'lastValidBlockHeight'> & { lastValidBlockHeight: string };

/** Storage entry per wallet; v1 is the format below. */
const PREFIX = 'ftm.pendingTx.v1.';
export const pendingTxEntry = (owner: string) => `${PREFIX}${owner}`;

/** A sanity bound; one action can hold at most one unknown transaction through the UI. */
export const PENDING_TX_CAP = 20;

export function serializePendingTxs(list: readonly PendingTx[]): string {
  const rows: Stored[] = list.map((t) => ({ ...t, lastValidBlockHeight: t.lastValidBlockHeight.toString() }));
  return JSON.stringify({ v: 1, txs: rows });
}

export function parsePendingTxs(raw: string | null, owner: string): PendingTx[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as { v?: unknown; txs?: unknown };
    if (data?.v !== 1 || !Array.isArray(data.txs)) return [];
    const out: PendingTx[] = [];
    for (const row of data.txs as Partial<Stored>[]) {
      if (
        !row ||
        typeof row.signature !== 'string' ||
        row.owner !== owner ||
        !ACTIONS.includes(row.action as GuardedAction) ||
        typeof row.lastValidBlockHeight !== 'string' ||
        !/^\d{1,20}$/.test(row.lastValidBlockHeight)
      ) {
        continue;
      }
      out.push({
        action: row.action as GuardedAction,
        owner,
        signature: row.signature,
        lastValidBlockHeight: BigInt(row.lastValidBlockHeight),
        at: Number(row.at) || 0,
        done: typeof row.done === 'string' ? row.done : 'Done.',
        targets: Array.isArray(row.targets) ? row.targets.filter((t): t is string => typeof t === 'string') : [],
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** True while `action` has a transaction of unknown outcome (for revoke and close: one covering `target`, when given). */
export function isChecking(list: readonly PendingTx[], action: GuardedAction, target?: string): boolean {
  return list.some((t) => t.action === action && (target === undefined || t.targets.includes(target)));
}

/** Records per wallet. Writes run one at a time, so a put and a remove never overwrite each other. */
export function createPendingTxStore(storage: KeyValueStorage) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const read = async (owner: string) => parsePendingTxs(await storage.getItem(pendingTxEntry(owner)), owner);
  return {
    load: (owner: string) => serial(() => read(owner)),
    put: (tx: PendingTx) =>
      serial(async () => {
        const list = (await read(tx.owner)).filter((t) => t.signature !== tx.signature);
        list.push(tx);
        await storage.setItem(pendingTxEntry(tx.owner), serializePendingTxs(list.slice(-PENDING_TX_CAP)));
      }),
    remove: (owner: string, signature: string) =>
      serial(async () => {
        const list = await read(owner);
        const rest = list.filter((t) => t.signature !== signature);
        if (rest.length !== list.length) await storage.setItem(pendingTxEntry(owner), serializePendingTxs(rest));
      }),
  };
}

export type PendingTxStore = ReturnType<typeof createPendingTxStore>;
