/**
 * The Profile card's stake read on the phone (SPEC-skr-final 2.2): skr.ts's
 * readStakeOnce wired to the RPC the app already uses for its on-device
 * chain reads, wallet.ts RPC_URL (the public mainnet endpoint the Genesis
 * Token check calls; no key in the bundle). One getMultipleAccounts per
 * read, a 10 s timeout, one retry on 429, 5xx or a dropped connection.
 * Read only: nothing here signs or sends.
 *
 * Reads that overlap for the same wallet share one request, so a focus read
 * and a pull that land together cost one call. Nothing is persisted: the
 * last read lives in the Profile's state for this app session only.
 *
 * Inside a signed vouch the phone never reads the stake itself: the worker
 * reads it and answers with the weight (vouchCore.ts weightLine).
 */
import { RPC_URL } from './wallet';
import { readStakeOnce, unknownRead } from './skr';
import type { StakeRead } from './skr';

let inflight: { wallet: string; p: Promise<StakeRead> } | null = null;

/** Never rejects: any failure is a StakeRead with status 'unknown'. */
export function readStake(wallet: string): Promise<StakeRead> {
  if (inflight && inflight.wallet === wallet) return inflight.p;
  const p: Promise<StakeRead> = readStakeOnce({ rpcUrl: RPC_URL }, wallet)
    .catch(() => unknownRead('internal', Date.now()))
    .finally(() => {
      if (inflight?.p === p) inflight = null;
    });
  inflight = { wallet, p };
  return p;
}
