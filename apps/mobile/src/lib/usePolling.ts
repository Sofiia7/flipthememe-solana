import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

/** The app is on screen (an unknown state at start-up counts as on screen). */
export function appInForeground(): boolean {
  return AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
}

/**
 * Runs `task` now and then every `intervalMs` after the previous run finished (never overlapping).
 * A task that returns a number sets the wait before its next run instead, so a loop can slow down
 * while nothing it reads can change, or back off while the RPC is rate limiting.
 * Pauses while the app is in the background and runs at once when it returns.
 * `resetKey` restarts the loop (for example when the wallet changes).
 * Returns `refresh()`, which runs the task as soon as possible.
 */
export function usePolling(task: () => Promise<number | void>, intervalMs: number, enabled = true, resetKey?: unknown): () => void {
  const taskRef = useRef(task);
  taskRef.current = task;
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active = appInForeground();

    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!stopped && active) timer = setTimeout(run, ms);
    };
    const run = async () => {
      timer = null;
      if (stopped) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      let wait = intervalMs;
      try {
        const asked = await taskRef.current();
        if (typeof asked === 'number' && Number.isFinite(asked) && asked >= 0) wait = asked;
      } catch {
        // The task records its own errors; the loop keeps going.
      }
      running = false;
      if (stopped) return;
      if (again) {
        again = false;
        schedule(0);
      } else {
        schedule(wait);
      }
    };
    const subscription = AppState.addEventListener('change', (state) => {
      const nowActive = state === 'active';
      if (nowActive && !active) {
        active = true;
        schedule(0);
      } else if (!nowActive && active) {
        active = false;
        if (timer) clearTimeout(timer);
        timer = null;
      }
    });
    refreshRef.current = () => {
      if (running) again = true;
      else schedule(0);
    };
    void run();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      subscription.remove();
      refreshRef.current = () => undefined;
    };
  }, [enabled, intervalMs, resetKey]);

  return useCallback(() => refreshRef.current(), []);
}

/** Current local time in ms, re-rendering every `everyMs`. */
export function useNow(everyMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
