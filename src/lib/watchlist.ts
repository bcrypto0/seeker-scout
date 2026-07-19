import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Local watchlist — star apps to follow. Persisted in AsyncStorage; no
 * account needed. Drives the Discover "Watching" filter and the change
 * notifications (see notify.ts).
 */
const KEY = 'seekerscout.watchlist.v1';

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

export async function getWatchlist(): Promise<string[]> {
  return [...(await load())];
}

export async function isWatched(id: string): Promise<boolean> {
  return (await load()).has(id);
}

export async function toggleWatch(id: string): Promise<boolean> {
  const set = await load();
  if (set.has(id)) set.delete(id);
  else set.add(id);
  await persist(set);
  return set.has(id);
}

/** Subscribe to watchlist changes (returns an unsubscribe fn). */
export function onWatchlistChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
