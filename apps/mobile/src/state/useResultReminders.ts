// The hooks that wire the result reminders (state/reminders.ts) to the app: schedule when the app goes
// to the background with a round of mine in play, cancel when it is back, and ask for the notification
// permission once, after the first bet that is confirmed.
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { chainToLocalMs } from '../chain/useChainClock';
import { askNotificationPermissionOnce, cancelReminders, scheduleReminders } from '../lib/notify';
import type { BetPhase } from '../session/useBetting';
import { planReminders, type InPlayCall } from './reminders';
import type { Face } from '../face/faceModel';

/** The pause after the bet is confirmed before the system dialog appears, so the YOU'RE IN card is seen first. */
const PERMISSION_DELAY_MS = 1_500;

/**
 * While my calls are in play and the app is on screen nothing is scheduled. When it goes to the
 * background, one reminder per call is scheduled for 15 s after its exit window ends; when it comes
 * back (or starts) they are all cancelled: the results show themselves.
 */
export function useResultReminders(calls: readonly InPlayCall[], offsetSec: number, face: Face): void {
  const latest = useRef({ calls, offsetSec, face });
  latest.current = { calls, offsetSec, face };
  useEffect(() => {
    // Reminders left over from before the app was closed would arrive for results already seen.
    void cancelReminders();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void cancelReminders();
      } else if (state === 'background') {
        const { calls: inPlay, offsetSec: offset, face: reminderFace } = latest.current;
        void scheduleReminders(planReminders({ calls: inPlay, nowMs: Date.now(), toLocalMs: (sec) => chainToLocalMs(sec, offset) }), reminderFace);
      }
    });
    return () => subscription.remove();
  }, []);
}

/** Asks for the notification permission after the first confirmed bet of this run (the dialog itself appears once per install). */
export function useAskPermissionAfterFirstBet(phase: BetPhase): void {
  const asked = useRef(false);
  useEffect(() => {
    if (phase !== 'confirmed' || asked.current) return;
    asked.current = true;
    // Not cleared on re-render: the app-wide provider outlives every screen.
    setTimeout(() => void askNotificationPermissionOnce(), PERMISSION_DELAY_MS);
  }, [phase]);
}
