// Live X chatter about the arena token, served by the ftm-chatter Worker (services/chatter).
// Every item is a real tweet; each one is shown once.
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { CHATTER_URL } from '../config';
import { countRequest } from '../lib/requestLog';
import { appInForeground } from '../lib/usePolling';

/** Tweets change slowly and each bubble stays up for seconds: one read every 90 s is plenty (and a lot less radio and battery). */
const POLL_MS = 90_000;
/** On the first load only the newest few tweets start the rain. */
const FIRST_BATCH = 3;

export type ChatterMood = 'moon' | 'scam' | 'neutral';
export type ChatterItem = {
  id: string;
  author: string;
  name: string;
  followers: number;
  text: string;
  createdAt: string;
  url: string;
  mood: ChatterMood;
};

/**
 * Tweets not shown yet: `next` is the oldest of them, `drop()` removes it once it is on screen. The lane lives
 * only on the Arena screen, so reads run only while it is mounted; and only while the app is on screen: the
 * timer is stopped in the background and a read follows at once on the way back.
 */
export function useChatter(symbol: string | null, mint: string | null, enabled: boolean) {
  const [queue, setQueue] = useState<ChatterItem[]>([]);
  const seen = useRef(new Set<string>());
  const first = useRef(true);

  useEffect(() => {
    seen.current = new Set();
    first.current = true;
    setQueue([]);
  }, [symbol, mint]);

  useEffect(() => {
    if (!enabled || !symbol) return;
    let cancelled = false;
    const load = async () => {
      if (!appInForeground()) return;
      try {
        countRequest('http', 'chatter');
        const params = `symbol=${encodeURIComponent(symbol)}${mint ? `&mint=${encodeURIComponent(mint)}` : ''}`;
        const res = await fetch(`${CHATTER_URL}?${params}`);
        if (!res.ok) return;
        const body = (await res.json()) as { items?: ChatterItem[] };
        if (cancelled) return;
        const fresh = (body.items ?? []).filter((it) => !seen.current.has(it.id));
        const batch = first.current ? fresh.slice(0, FIRST_BATCH) : fresh;
        for (const it of body.items ?? []) seen.current.add(it.id);
        first.current = false;
        // Oldest first, so the rain follows the order people posted in.
        if (batch.length) setQueue((q) => [...q, ...batch.reverse()].slice(-12));
      } catch {
        // Chatter is decoration: a failed poll just means no new bubbles.
      }
    };
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(load, POLL_MS);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    if (appInForeground()) {
      void load();
      start();
    }
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void load();
        stop();
        start();
      } else {
        stop();
      }
    });
    return () => {
      cancelled = true;
      stop();
      subscription.remove();
    };
  }, [symbol, mint, enabled]);

  return { next: queue[0] ?? null, drop: () => setQueue((q) => q.slice(1)) };
}

/** "2m", "1h", "3d" from an ISO time. */
export function ago(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
