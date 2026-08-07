import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * "Try later" list — v0.7, asked for verbatim by reviewer redacted.skr:
 * "Maybe add another list for marking apps you want to try out in addition
 * to bookmarking favorites?" Distinct from the ★ watchlist on purpose: the
 * star means "follow this app's progress" (and drives notifications); the
 * pin means "I haven't tried this yet". Same storage pattern as
 * watchlist.ts — local, no account, wallet not required.
 */
const KEY = 'seekerscout.trylist.v1';

let cache: Set<string> | null = null;
const listeners = new Set<() => void>();

async function load(): Promise<Set<string>> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cache = new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    cache = new Set();
  }
  return cache;
}

async function persist(set: Set<string>) {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    /* best-effort */
  }
  listeners.forEach((l) => l());
}

export async function getTryList(): Promise<string[]> {
  return [...(await load())];
}

export async function isOnTryList(id: string): Promise<boolean> {
  return (await load()).has(id);
}

export async function toggleTry(id: string): Promise<boolean> {
  const set = await load();
  if (set.has(id)) set.delete(id);
  else set.add(id);
  await persist(set);
  return set.has(id);
}

/** Subscribe to try-list changes (returns an unsubscribe fn). */
export function onTryListChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
