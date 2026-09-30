import AsyncStorage from '@react-native-async-storage/async-storage';
import { CHAT_BASE } from './chat';
import { getMyNumber } from './loungeNumber';
import { fetchRepliesWith } from './repliesCore';
import { getChatSeen } from './unread';

/**
 * "Replies to you" for the Lounge, a count kept apart from the unread
 * badge (unread.ts): GET /chat/replies?to=<my number>&since=<last seen>.
 *
 * Rules:
 *  - Only when the app knows this phone's Lounge number (loungeNumber.ts);
 *    without one there is no request and the count is 0.
 *  - The first check starts from the newest message the chat has shown
 *    (unread.ts), so replies already read are not counted. With no chat
 *    history either, it starts at the newest reply and counts nothing,
 *    like the unread badge's first run.
 *  - Opening the chat marks every reply up to the newest message as seen.
 *  - A failed check keeps the count as it was.
 */
const SEEN_KEY = 'seekerscout.chat.replySeen.v1';

let count = 0;
let lastSeen: number | null = null;
/** The newest reply id any check has seen (seeds the background check's start). */
let latestKnown = 0;
let running = false;
const listeners = new Set<(n: number) => void>();
const emit = () => listeners.forEach((fn) => fn(count));

function setCount(n: number) {
  if (n === count) return;
  count = n;
  emit();
}

export function onRepliesChange(fn: (n: number) => void): () => void {
  listeners.add(fn);
  fn(count);
  return () => {
    listeners.delete(fn);
  };
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

/** The newest reply id the chat has shown, or null before the first check. */
export const getRepliesSeen = (): Promise<number | null> => loadSeen();

/** The newest reply id a check has returned this session (0 if none). */
export const latestKnownReplyId = (): number => latestKnown;

/** Refresh the count. One small request, and none at all without a Lounge number. */
export async function checkReplies(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const me = await getMyNumber();
    if (me === null) {
      setCount(0);
      return;
    }
    let seen = await loadSeen();
    if (seen === null) {
      const chatSeen = await getChatSeen();
      if (chatSeen !== null) {
        await saveSeen(chatSeen);
        seen = chatSeen;
      }
    }
    const page = await fetchRepliesWith(fetch, CHAT_BASE, me, seen ?? 0);
    if (!page) return; // unreachable or an older server: keep the count
    latestKnown = Math.max(latestKnown, page.latestId);
    if (seen === null) {
      if (lastSeen === null) await saveSeen(page.latestId);
      setCount(0);
      return;
    }
    if (lastSeen !== seen) return; // the chat was read while this was in flight
    setCount(page.count);
  } finally {
    running = false;
  }
}

/** The chat was shown up to message `id`: every reply up to it is seen. */
export async function markRepliesSeen(id: number): Promise<void> {
  if (Number.isSafeInteger(id) && id > 0) {
    const seen = await loadSeen();
    if (seen === null || id > seen) await saveSeen(id);
  }
  setCount(0);
}
