import { useCallback, useEffect, useRef, useState } from 'react';
import { readStake } from './skrRead';
import type { StakeRead } from './skr';

/** A focus this soon after the last finished read keeps that read instead of reading again. */
export const FOCUS_REREAD_MS = 60_000;

export type StakeState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; read: StakeRead };

/**
 * Why a read starts: 'focus' (the Profile tab came back into view; skipped
 * within FOCUS_REREAD_MS of the last read or while one is running), 'pull'
 * (pull to refresh; drives the spinner), 'tap' (the card's Refresh or
 * Retry). A new wallet reads once by itself.
 */
export type StakeTrigger = 'focus' | 'pull' | 'tap';

/**
 * The connected wallet's staked SKR for the Profile card. Reads only on a
 * wallet change, a focus, a pull or a tap: no timer, no loop. A read that
 * finishes after the wallet changed (disconnect, another connect) is
 * dropped. A failed refresh replaces the old numbers with the error state
 * rather than leaving numbers on screen the app could not just confirm.
 */
export function useStakeRead(address: string | undefined) {
  const [state, setState] = useState<StakeState>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [pulling, setPulling] = useState(false);
  const addrRef = useRef(address);
  addrRef.current = address;
  const seq = useRef(0);
  const running = useRef(false);
  const lastDone = useRef(0);
  const hasRead = useRef(false);

  const start = useCallback((why: StakeTrigger | 'wallet') => {
    const wallet = addrRef.current;
    if (!wallet) return;
    if (why === 'focus' && (running.current || Date.now() - lastDone.current < FOCUS_REREAD_MS)) return;
    const mine = ++seq.current;
    running.current = true;
    setBusy(true);
    if (why === 'pull') setPulling(true);
    // A first read, or a retry after an error, shows the skeleton; a refresh keeps the numbers until it lands.
    if (!hasRead.current) setState({ kind: 'loading' });
    readStake(wallet).then((read) => {
      if (seq.current !== mine || addrRef.current !== wallet) return;
      running.current = false;
      lastDone.current = Date.now();
      hasRead.current = read.status !== 'unknown';
      setState({ kind: 'done', read });
      setBusy(false);
      setPulling(false);
    });
  }, []);

  useEffect(() => {
    seq.current += 1;
    running.current = false;
    lastDone.current = 0;
    hasRead.current = false;
    setBusy(false);
    setPulling(false);
    if (!address) {
      setState({ kind: 'idle' });
      return;
    }
    start('wallet');
  }, [address, start]);

  return { state, busy, pulling, refresh: start as (why: StakeTrigger) => void };
}
