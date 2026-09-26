import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchLatest } from './chat';

/**
 * Unread count for the Lounge tab badge.
 *
 * Why it exists: the chat only fetched while you were looking at it, so
 * nobody knew when someone posted. A member asked for game recommendations
 * on Sep 15 and it sat unanswered for 8 days. The app is opened ~18 times a
 * day; a badge turns each of those opens into "someone said something".
 *
 * Rules:
 *  - First run records the newest id as already seen, so a fresh install
 *    doesn't open to a badge counting the room's whole history.
 *  - Reading the chat marks everything up to the newest id as seen.
 *  - A failed check leaves the badge as it was rather than clearing it.
 */
const SEEN_KEY = 'seekerscout.chat.lastSeen.v1';

let count = 0;
let lastSeen: number | null = null;
const listeners = new Set<(n: number) => void>();
const emit = () => listeners.forEach((fn) => fn(count));

export function onUnreadChange(fn: (n: number) => void): () => void {
  listeners.add(fn);
  fn(count);
  return () => listeners.delete(fn);
}

async function loadSeen(): Promise<number | null> {
  if (lastSeen !== null) return lastSeen;
  try {
    const raw = await AsyncStorage.getItem(SEEN_KEY);
    lastSeen = raw === null ? null : Number(raw) || 0;
  } catch {
    lastSeen = null;
  }
  return lastSeen;
}

async function saveSeen(id: number) {
  lastSeen = id;
  await AsyncStorage.setItem(SEEN_KEY, String(id)).catch(() => {});
}

/** Refresh the badge. Cheap: the server returns two numbers, no messages. */
export async function checkUnread(): Promise<void> {
  const seen = await loadSeen();
  const latest = await fetchLatest(seen ?? 0);
  if (!latest) return; // unreachable: keep whatever the badge showed
  if (seen === null) {
    await saveSeen(latest.latestId);
    count = 0;
  } else {
    count = latest.newCount;
  }
  emit();
}

/** The chat was read up to `id`: clear the badge. */
export async function markSeen(id: number): Promise<void> {
  const seen = await loadSeen();
  if (seen !== null && id <= seen) {
    if (count !== 0) {
      count = 0;
      emit();
    }
    return;
  }
  await saveSeen(id);
  count = 0;
  emit();
}
