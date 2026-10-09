// Local notifications ("did your call win?"), behind a thin wrapper that never throws. The native module
// (expo-notifications) came in after the first dev client build, so it is required only after checking
// that its native side is present, like lib/nativeOptional.ts does for the other late modules; without
// it every call here does nothing and the game plays on. What to schedule and when is decided in
// state/reminders.ts (pure, tested); this file only talks to the system.
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo';
import { permissionStep, type PermissionState, type Reminder } from '../state/reminders';
import type { Face } from '../face/faceModel';
import { notificationFace } from './notificationFace';

type Notifications = typeof import('expo-notifications');

/** The Android channel the result reminders use; its name is what the system settings list. */
export const RESULT_CHANNEL_ID = 'round-results';
export const RESULT_CHANNEL_NAME = 'Round results';
/** Set once the permission dialog was shown, so a refusal is never nagged about. */
const ASKED_KEY = 'ftm.notifAsked.v1';

let cached: Notifications | null | undefined;

/** expo-notifications, or null when this build has no notification module (or it fails to load). */
function notifications(): Notifications | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    if (requireOptionalNativeModule('ExpoNotificationScheduler') != null && requireOptionalNativeModule('ExpoNotificationPermissionsModule') != null) {
      const module = require('expo-notifications') as Notifications;
      // A reminder that fires while the app is on screen shows nothing: the result is on screen itself.
      module.setNotificationHandler({
        handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false }),
      });
      cached = module;
    }
  } catch (error) {
    console.warn('[ftm] notifications are not available in this build', error);
    cached = null;
  }
  return cached;
}

/** The Android channel (created once, harmless to repeat); other platforms have none. */
async function ensureChannel(n: Notifications): Promise<void> {
  if (Platform.OS !== 'android') return;
  await n.setNotificationChannelAsync(RESULT_CHANNEL_ID, {
    name: RESULT_CHANNEL_NAME,
    importance: n.AndroidImportance.HIGH,
    vibrationPattern: [0, 200, 120, 200],
    lightColor: '#b46cff',
  });
}

/** What the system says now, or null without a notification module. */
export async function notificationPermission(): Promise<PermissionState> {
  const n = notifications();
  if (!n) return null;
  try {
    const p = await n.getPermissionsAsync();
    return { granted: p.granted, canAskAgain: p.canAskAgain };
  } catch {
    return null;
  }
}

/**
 * Shows the system permission dialog (Android 13 and newer) once per install, when the permission is
 * still undecided. Called after the first confirmed bet; a refusal changes nothing in the game.
 */
export async function askNotificationPermissionOnce(): Promise<void> {
  try {
    const n = notifications();
    if (!n) return;
    const asked = (await AsyncStorage.getItem(ASKED_KEY).catch(() => null)) === '1';
    if (permissionStep(await notificationPermission(), asked) !== 'ask') return;
    await AsyncStorage.setItem(ASKED_KEY, '1').catch(() => undefined);
    // Android shows the dialog only once the app has a channel.
    await ensureChannel(n);
    await n.requestPermissionsAsync();
  } catch (error) {
    console.warn('[ftm] notification permission request failed', error);
  }
}

/** Each call replaces the one before: a late step of an older call must not schedule after a newer one cancelled. */
let generation = 0;

/** Replaces every scheduled reminder with `list` (nothing is scheduled without the permission). */
export async function scheduleReminders(list: readonly Reminder[], face?: Face): Promise<void> {
  const mine = ++generation;
  try {
    const n = notifications();
    if (!n) return;
    await n.cancelAllScheduledNotificationsAsync();
    if (list.length === 0 || mine !== generation) return;
    const state = await notificationPermission();
    if (!state?.granted || mine !== generation) return;
    await ensureChannel(n);
    for (const r of list) {
      if (mine !== generation) return;
      await n.scheduleNotificationAsync({
        identifier: r.key,
        content: { title: r.title, body: r.body, data: { roundId: r.roundId.toString(), ...(face ? { ftmFacePixels: notificationFace(face) } : {}) } },
        trigger: { type: n.SchedulableTriggerInputTypes.DATE, date: new Date(r.fireAtMs), channelId: RESULT_CHANNEL_ID },
      });
    }
  } catch (error) {
    console.warn('[ftm] scheduling the result reminder failed', error);
  }
}

/** Cancels every scheduled reminder (the app is back on screen, or starting: the results show themselves). */
export async function cancelReminders(): Promise<void> {
  generation++;
  try {
    const n = notifications();
    if (n) await n.cancelAllScheduledNotificationsAsync();
  } catch (error) {
    console.warn('[ftm] cancelling the result reminders failed', error);
  }
}
