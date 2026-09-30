import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * "Not for me" list, asked for by a founding member in the Lounge: "a simple
 * red x to cross off dapps we've already tried and didn't like". Apps on it
 * are left out of the Discover feed, Top climbers and the hero picks
 * (notForMeFilter.ts); Search still finds them and marks them. Independent of
 * the watchlist and the try list: marking an app here changes neither. Same
 * storage pattern as trylist.ts: local, no account, wallet not required.
 *
 * Ids stay stored even when the catalog in hand does not list them (the
 * offline seed, a delisted app): the Hidden chip counts only the ones the
 * catalog holds, and nothing prunes the rest.
 */
const KEY = 'seekerscout.notforme.v1';

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

export async function getNotForMe(): Promise<string[]> {
  return [...(await load())];
}

export async function isNotForMe(id: string): Promise<boolean> {
  return (await load()).has(id);
}

export async function toggleNotForMe(id: string): Promise<boolean> {
  const set = await load();
  if (set.has(id)) set.delete(id);
  else set.add(id);
  await persist(set);
  return set.has(id);
}

/** Subscribe to "Not for me" changes (returns an unsubscribe fn). */
export function onNotForMeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
