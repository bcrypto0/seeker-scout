import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo';
import { CHAT_BASE } from './chat';
import { getMyNumber } from './loungeNumber';
import { fireReplyAlert, hasNotifPermission, requestNotifPermission } from './notify';
import { getRepliesSeen, latestKnownReplyId } from './replies';
import { alertSince, fetchRepliesXhr, replyAlertText } from './repliesCore';
import type { XhrLike } from './repliesCore';

/**
 * Reply alerts: an opt-in background check for replies to this phone's
 * Lounge number, so a reply is seen without opening the app.
 *
 * - Off by default. On only after the person turns it on (the Lounge
 *   switch, or the one-time offer after their first chat message) and
 *   grants notification permission.
 * - When on, expo-background-task runs replyTask.ts at most once every
 *   15 minutes; Android picks the exact time and needs a network.
 * - The check sends only the Lounge number and the last reply id already
 *   notified or shown (GET /chat/replies, public, no token). Off, without a
 *   number or without permission it makes no request at all.
 * - New replies make ONE notification on the "Lounge replies" channel;
 *   the newest id is stored first, so the same reply is never notified twice.
 * - One check at a time. The request goes over XMLHttpRequest with a
 *   native timeout, because React Native's fetch waits on JS timers, and
 *   those do not run in a background task.
 * - Never throws, never retries, never loops.
 *
 * The native modules came after the dev client of 2026-09-29. On a build
 * without them this file loads nothing native, `replyAlertsSupported` is
 * false, the switch and the offer stay hidden, and the reply badge still
 * works while the app is open.
 */
export const REPLY_TASK = 'seekerscout-lounge-replies';
export const REPLY_CHECK_MINUTES = 15;
const ON_KEY = 'seekerscout.replyAlerts.on.v1';
const NOTIFIED_KEY = 'seekerscout.replyAlerts.notified.v1';
const OFFERED_KEY = 'seekerscout.replyAlerts.offered.v1';

// ---- copy: the Lounge switch and the chat's one-time offer ----
export const REPLY_ALERTS_NO_PERMISSION =
  'Notifications are not allowed for Seeker Scout. You can allow them in Android settings.';
export const REPLY_ALERTS_FAILED = "Couldn't turn on reply alerts right now.";
export const REPLY_ALERTS_OFFER_TITLE = 'Reply alerts';
export const REPLY_ALERTS_OFFER_BODY =
  `Get a notification when a member replies to you? The app checks in the background, at most once every ${REPLY_CHECK_MINUTES} minutes. You can turn this off on the Lounge tab.`;

type BackgroundTaskModule = typeof import('expo-background-task');
type TaskManagerModule = typeof import('expo-task-manager');
export type BackgroundModules = { BackgroundTask: BackgroundTaskModule; TaskManager: TaskManagerModule };

/**
 * Both JS packages call requireNativeModule when they load, which throws on
 * a build without them, so they are required only after the native side
 * answered. Metro evaluates a require() when it runs, not at bundle load.
 */
function loadBackgroundModules(): BackgroundModules | null {
  try {
    if (!requireOptionalNativeModule('ExpoTaskManager')) return null;
    if (!requireOptionalNativeModule('ExpoBackgroundTask')) return null;
    return {
      TaskManager: require('expo-task-manager') as TaskManagerModule,
      BackgroundTask: require('expo-background-task') as BackgroundTaskModule,
    };
  } catch {
    return null;
  }
}

export const bg: BackgroundModules | null = loadBackgroundModules();
export const replyAlertsSupported = bg !== null;

// ---- the stored switch ----
let on: boolean | null = null;
const listeners = new Set<(v: boolean) => void>();

export async function getReplyAlertsOn(): Promise<boolean> {
  if (on !== null) return on;
  try {
    on = (await AsyncStorage.getItem(ON_KEY)) === '1';
  } catch {
    return false; // unreadable: treat as off, read again next time
  }
  return on;
}

async function saveOn(v: boolean) {
  on = v;
  await AsyncStorage.setItem(ON_KEY, v ? '1' : '0').catch(() => {});
  listeners.forEach((l) => l(v));
}

async function getNotified(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(NOTIFIED_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

async function saveNotified(id: number) {
  await AsyncStorage.setItem(NOTIFIED_KEY, String(id)).catch(() => {});
}

// ---- the background check (replyTask.ts runs it) ----
export type CheckOutcome =
  | 'off' | 'no-number' | 'no-permission' | 'foreground' | 'busy' | 'failed' | 'none' | 'notified';

/**
 * When the check in flight started (Date.now()), or null. Android can start
 * a run while an earlier one in the same JS runtime is still going; the
 * later one then returns 'busy'. A check older than CHECK_STALE_MS no longer
 * blocks, and the re-read before posting keeps a late one from posting twice.
 */
let checkStartedAt: number | null = null;
const CHECK_STALE_MS = 60_000;

const makeXhr = (): XhrLike => new XMLHttpRequest();
/** Read fresh each time: the app can come to the front while a check waits. */
const inFront = () => AppState.currentState === 'active';

/** One check at a time. Never throws; every early exit before the request makes none. */
export async function runReplyCheck(): Promise<CheckOutcome> {
  const started = Date.now();
  if (checkStartedAt !== null && Math.abs(started - checkStartedAt) < CHECK_STALE_MS) return 'busy';
  checkStartedAt = started;
  try {
    return await checkOnce();
  } finally {
    if (checkStartedAt === started) checkStartedAt = null;
  }
}

async function checkOnce(): Promise<CheckOutcome> {
  try {
    if (!(await getReplyAlertsOn())) return 'off';
    const me = await getMyNumber();
    if (me === null) return 'no-number';
    if (!(await hasNotifPermission())) return 'no-permission';
    // The badge covers an open app.
    if (inFront()) return 'foreground';
    const since = alertSince(await getNotified(), await getRepliesSeen());
    // XHR, not fetch: fetch needs JS timers, which do not run in a background task.
    const page = await fetchRepliesXhr(makeXhr, CHAT_BASE, me, since);
    if (!page) return 'failed';
    const text = replyAlertText(page);
    if (!text || page.latestId <= since) return 'none';
    // Read again after the request: the switch may be off by now, the app
    // may be in front, or the chat or another run may have covered these.
    if (!(await getReplyAlertsOn())) return 'off';
    if (inFront()) return 'foreground';
    if (alertSince(await getNotified(), await getRepliesSeen()) >= page.latestId) return 'none';
    // Stored before posting, and kept even if posting fails: a reply is never notified twice.
    await saveNotified(page.latestId);
    await fireReplyAlert(text.title, text.body);
    return 'notified';
  } catch {
    return 'failed';
  }
}

// ---- turning it on and off ----
async function isRegistered(m: BackgroundModules): Promise<boolean> {
  try {
    return await m.TaskManager.isTaskRegisteredAsync(REPLY_TASK);
  } catch {
    return false;
  }
}

async function register(m: BackgroundModules): Promise<boolean> {
  try {
    if ((await m.BackgroundTask.getStatusAsync()) !== m.BackgroundTask.BackgroundTaskStatus.Available) return false;
    if (!m.TaskManager.isTaskDefined(REPLY_TASK)) return false; // replyTask.ts was not loaded
    await m.BackgroundTask.registerTaskAsync(REPLY_TASK, { minimumInterval: REPLY_CHECK_MINUTES });
    return isRegistered(m);
  } catch {
    return false;
  }
}

async function unregister(m: BackgroundModules): Promise<void> {
  try {
    if (await isRegistered(m)) await m.BackgroundTask.unregisterTaskAsync(REPLY_TASK);
  } catch {
    /* the task checks the switch first, so a leftover registration sends nothing */
  }
}

export type EnableResult = 'on' | 'no-permission' | 'unsupported' | 'failed';

/** Turn reply alerts on: permission first (the existing helper), then the task. */
export async function enableReplyAlerts(): Promise<EnableResult> {
  if (!bg) return 'unsupported';
  if (!(await requestNotifPermission())) return 'no-permission';
  // Start after everything this phone already knows about, so turning it on
  // never notifies replies the badge or the chat already showed.
  const start = alertSince(
    alertSince(await getNotified(), await getRepliesSeen()),
    latestKnownReplyId(),
  );
  await saveNotified(start);
  if (!(await register(bg))) return 'failed';
  await saveOn(true);
  return 'on';
}

/** Turn reply alerts off: the switch first (the task then sends nothing), then unregister. */
export async function disableReplyAlerts(): Promise<void> {
  await saveOn(false);
  if (bg) await unregister(bg);
}

/**
 * On launch: make the registration match the switch (a restore, a failed
 * unregister, or a build that lost the module). Never throws.
 */
export async function syncReplyAlerts(): Promise<void> {
  try {
    if (!bg) return;
    const want = await getReplyAlertsOn();
    const have = await isRegistered(bg);
    if (want && !have) {
      if (!(await register(bg))) await saveOn(false);
    } else if (!want && have) {
      await unregister(bg);
    }
  } catch {
    /* next launch tries again */
  }
}

/**
 * The one-time offer after the first message this phone sends: true once,
 * and only when alerts can run, are off, and the Lounge number is known.
 */
export async function takeReplyAlertsOffer(): Promise<boolean> {
  try {
    if (!bg || (await getReplyAlertsOn()) || (await getMyNumber()) === null) return false;
    if ((await AsyncStorage.getItem(OFFERED_KEY)) === '1') return false;
    await AsyncStorage.setItem(OFFERED_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/** The switch's state for a screen, re-rendering when any screen changes it. */
export function useReplyAlerts(): boolean {
  const [v, setV] = useState(on ?? false);
  useEffect(() => {
    let live = true;
    getReplyAlertsOn().then((x) => live && setV(x));
    const fn = (x: boolean) => live && setV(x);
    listeners.add(fn);
    return () => {
      live = false;
      listeners.delete(fn);
    };
  }, []);
  return v;
}
