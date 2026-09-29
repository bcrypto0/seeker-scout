import { useEffect, useState } from 'react';
import type { VerifyResult } from './wallet';

/**
 * The connected wallet, shared across screens for this app session only.
 * Before Scout Vouch every screen kept its own { address, authToken, mint },
 * so a vouch from an app page would have cost a second wallet authorize right
 * after the user connected on Profile or verified in the Lounge. Profile, the
 * Lounge (its Verify button and the chat/games sign-in) and the vouch sheet
 * write it; the vouch card and sheet read it.
 *
 * Module state, never persisted (the catalogCache idea in catalog.ts): a
 * stale authToken is harmless because signMessageBytes falls back to a fresh
 * authorize. `mint` is set only once findGenesisToken verified the wallet;
 * `genesis` records that check's answer so the vouch UI can tell "not
 * checked yet" from "checked, no Genesis Token".
 */
export type WalletSession = {
  address: string;
  authToken: string;
  mint?: string;
  genesis?: VerifyResult;
};

let current: WalletSession | null = null;
const listeners = new Set<(s: WalletSession | null) => void>();

export const getSession = (): WalletSession | null => current;

export function setSession(s: WalletSession | null): void {
  current = s;
  listeners.forEach((l) => l(s));
}

export function onSessionChange(l: (s: WalletSession | null) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The current session, re-rendering whenever any screen changes it. */
export function useWalletSession(): WalletSession | null {
  const [s, setS] = useState<WalletSession | null>(current);
  useEffect(() => {
    setS(current);
    return onSessionChange(setS);
  }, []);
  return s;
}
