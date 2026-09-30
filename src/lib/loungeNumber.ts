import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isLoungeNumber } from './repliesCore';

/**
 * This phone's Lounge number, kept so the reply badge and the background
 * reply check know whose replies to ask for. Before replies the number was
 * only read out of the sign-in token (claimFromToken), which expires after
 * a day, and the claim screen's state, which lives until the app closes.
 *
 * Written whenever the app learns it: a claim, a claimed-number lookup on
 * the Lounge tab, a Lounge sign-in (any token the app holds). A number is
 * permanent per Genesis Token, so nothing clears it; a sign-in with another
 * Genesis Token replaces it. Local only, like the watchlist.
 */
const KEY = 'seekerscout.lounge.number.v1';

let mine: number | null | undefined; // undefined: not read yet
const listeners = new Set<(n: number | null) => void>();

export async function getMyNumber(): Promise<number | null> {
  if (mine !== undefined) return mine;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const n = raw === null ? NaN : Number(raw);
    mine = isLoungeNumber(n) ? n : null;
  } catch {
    return null; // read again next time
  }
  return mine;
}

/** Remember `n` if it is a Lounge number; anything else is ignored. */
export async function rememberMyNumber(n: unknown): Promise<void> {
  if (!isLoungeNumber(n) || mine === n) return;
  mine = n;
  try {
    await AsyncStorage.setItem(KEY, String(n));
  } catch {
    /* kept for this session */
  }
  listeners.forEach((l) => l(n));
}

export function onMyNumberChange(fn: (n: number | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The number, re-rendering when it is learned or replaced. Null while unknown. */
export function useMyNumber(): number | null {
  const [n, setN] = useState<number | null>(mine ?? null);
  useEffect(() => {
    let live = true;
    getMyNumber().then((v) => live && setN(v));
    const off = onMyNumberChange((v) => live && setN(v));
    return () => {
      live = false;
      off();
    };
  }, []);
  return n;
}
