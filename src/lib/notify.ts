import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { DappEntry } from './types';
import { getWatchlist } from './watchlist';

/**
 * Watchlist change notifications. On each app open we diff the current
 * catalog against a stored snapshot of the user's watched apps and fire a
 * local notification per meaningful change (big rank climb, Stale→Active
 * revival, new version, freshly listed). No backend — reliable and private.
 * Server push is a future upgrade on the same diff logic.
 */
const SNAP_KEY = 'seekerscout.watch.snapshot.v1';
const RANK_JUMP = 5; // notify on a climb of >= this many ranks
/**
 * Rank movement is only meaningful once an app has enough reviews to hold a
 * stable position — thin-tail apps shuffle on tiny score changes, so alerting
 * on them trains users to mute us. (Before the indexer's rounding fix this
 * was far worse: tied scores reshuffled daily and "climbs" were pure noise.)
 * Kept at 20 to match RATING_MIN_REVIEWS — high enough to kill the churn,
 * low enough that starring a small app still earns real alerts.
 */
const RANK_ALERT_MIN_REVIEWS = 20;

type Snap = Record<string, { rank?: number; version?: string; fresh?: string }>;

export async function requestNotifPermission(): Promise<boolean> {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status === 'granted') return true;
    const req = await Notifications.requestPermissionsAsync();
    return req.status === 'granted';
  } catch {
    return false;
  }
}

/** Whether notification permission is granted now, without asking. */
export async function hasNotifPermission(): Promise<boolean> {
  try {
    return (await Notifications.getPermissionsAsync()).status === 'granted';
  } catch {
    return false;
  }
}

/**
 * Reply alerts (replyAlerts.ts) post on their own Android channel, so they
 * can be muted in system settings without muting watchlist alerts.
 */
export const REPLY_CHANNEL_ID = 'lounge-replies';
/** The `data.kind` a reply alert carries; App.tsx opens the chat on a tap. */
export const REPLY_ALERT_KIND = 'lounge-reply';

export async function ensureReplyChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(REPLY_CHANNEL_ID, {
      name: 'Lounge replies',
      description: 'Replies to your messages in the Lounge chat',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  } catch {
    /* best-effort: Android then posts on the default channel */
  }
}

/** Post one reply alert now. Never throws; false when it could not be posted. */
export async function fireReplyAlert(title: string, body: string): Promise<boolean> {
  try {
    await ensureReplyChannel();
    await Notifications.scheduleNotificationAsync({
      // One fixed identifier: a newer reply alert replaces the one still in the shade.
      identifier: REPLY_ALERT_KIND,
      content: { title, body, data: { kind: REPLY_ALERT_KIND } },
      trigger: Platform.OS === 'android' ? { channelId: REPLY_CHANNEL_ID } : null,
    });
    return true;
  } catch {
    return false;
  }
}

async function fire(title: string, body: string) {
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger: null, // immediate
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Diff watched apps vs the stored snapshot; fire notifications for changes
 * and return a short in-app summary. Ranks passed in are 1-based (by the
 * caller's current sort); lower = better.
 */
export async function checkWatchlist(
  ranked: DappEntry[],
): Promise<string[]> {
  const watched = new Set(await getWatchlist());
  if (!watched.size) return [];

  const rankOf = new Map<string, number>();
  ranked.forEach((a, i) => rankOf.set(a.id, i + 1));

  let snap: Snap = {};
  try {
    const raw = await AsyncStorage.getItem(SNAP_KEY);
    snap = raw ? JSON.parse(raw) : {};
  } catch {
    snap = {};
  }

  const summary: string[] = [];
  const next: Snap = {};
  const firstRun = Object.keys(snap).length === 0;

  for (const app of ranked) {
    if (!watched.has(app.id)) continue;
    const prev = snap[app.id];
    const rank = rankOf.get(app.id);
    const fresh = app.lastUpdated;
    next[app.id] = { rank, version: app.version, fresh };
    if (firstRun || !prev) continue; // seed silently

    if (
      prev.rank &&
      rank &&
      prev.rank - rank >= RANK_JUMP &&
      (app.reviews ?? 0) >= RANK_ALERT_MIN_REVIEWS
    ) {
      const msg = `${app.name} climbed ${prev.rank - rank} to #${rank}`;
      summary.push(msg);
      fire('📈 Climbing', msg);
    }
    if (prev.version && app.version && prev.version !== app.version) {
      const msg = `${app.name} shipped ${app.version}`;
      summary.push(msg);
      fire('🆕 New version', msg);
    }
  }

  try {
    await AsyncStorage.setItem(SNAP_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
  return summary;
}
