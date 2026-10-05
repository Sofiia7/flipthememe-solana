// A persisted on/off setting with listeners (sound mute, live chatter, "how it works" seen).
// Pure TypeScript: storage is injected, so node tests run it with a fake.

export type KeyValueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type BoolStore = {
  get(): boolean;
  /** Changes the value at once and persists it in the background. */
  set(value: boolean): void;
  toggle(): void;
  /** Reads the stored value once; later calls return the same promise. A set() before it resolves wins. */
  load(): Promise<boolean>;
  isLoaded(): boolean;
  /** A primitive that changes whenever the value or the loaded flag changes (for useSyncExternalStore). */
  snapshot(): number;
  subscribe(listener: () => void): () => void;
};

export function createBoolStore(storage: KeyValueStorage, key: string, initial: boolean): BoolStore {
  let value = initial;
  let loaded = false;
  let setBeforeLoad = false;
  let loading: Promise<boolean> | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  const set = (next: boolean) => {
    if (!loaded) setBeforeLoad = true;
    const changed = next !== value;
    value = next;
    if (changed) emit();
    void storage.setItem(key, next ? '1' : '0').catch(() => undefined);
  };

  return {
    get: () => value,
    set,
    toggle: () => set(!value),
    load: () => {
      if (!loading) {
        loading = storage
          .getItem(key)
          .then((raw) => {
            if (!setBeforeLoad && (raw === '1' || raw === '0')) value = raw === '1';
          })
          .catch(() => undefined)
          .then(() => {
            loaded = true;
            emit();
            return value;
          });
      }
      return loading;
    },
    isLoaded: () => loaded,
    snapshot: () => (value ? 1 : 0) + (loaded ? 2 : 0),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
