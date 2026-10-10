import type { LeaderboardEnv } from './leaderboard.ts';
type Store = { getValue(): Promise<string | null>; putValue(value: string): Promise<void> };
export type LeaderboardStorageEnv = LeaderboardEnv & { LEADERBOARD_STORE?: { getByName(name: string): Store } };
/** New writes use SQLite-backed objects; existing KV archives migrate when read. */
export function withLeaderboardStorage<T extends LeaderboardStorageEnv>(env: T): T {
  if (!env.LEADERBOARD_STORE) return env;
  const namespace = env.LEADERBOARD_STORE, legacy = env.LEADERBOARD;
  return { ...env, LEADERBOARD: {
    async get(key: string) {
      const store = namespace.getByName(key);
      const value = await store.getValue();
      if (value !== null) return value;
      const old = await legacy?.get(key) ?? null;
      if (old !== null) { await store.putValue(old); return await store.getValue(); }
      return null;
    },
    async put(key: string, value: string) { await namespace.getByName(key).putValue(value); },
  } };
}
