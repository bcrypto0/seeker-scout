import AsyncStorage from '@react-native-async-storage/async-storage';
import { BASE as PROD_BASE } from './alpha';
import { signMessageBytes } from './wallet';
import {
  cachedResult,
  cachedWeight,
  fetchAppVouches,
  fetchMyVouches,
  fetchTopVouched,
  latestCachedResult,
  postVouch,
  rememberResult,
} from './vouchCore';
import type {
  AppVouches,
  MyVouch,
  PendingSigned,
  PendingStore,
  SubmitStage,
  TopWeek,
  VouchDeps,
  VouchInput,
  VouchResult,
} from './vouchCore';

export * from './vouchCore';

/**
 * Scout Vouch on the phone: the pure calls in vouchCore.ts wired to Seed
 * Vault (MWA signMessages) and AsyncStorage. The worker is the same one the
 * Lounge and Alpha use.
 *
 * Dev clients may point at a local `wrangler dev` so device testing never
 * writes to production: `adb reverse tcp:8787 tcp:8787`, then
 * EXPO_PUBLIC_LOUNGE_URL=http://127.0.0.1:8787 npx expo start --dev-client.
 * Release builds ignore the variable: __DEV__ is false there. GET /flags
 * follows the same base (catalog.ts), so a dev client reads the kill switch
 * of the worker it actually posts to.
 */
export const VOUCH_BASE: string =
  __DEV__ && typeof process.env.EXPO_PUBLIC_LOUNGE_URL === 'string' && process.env.EXPO_PUBLIC_LOUNGE_URL
    ? process.env.EXPO_PUBLIC_LOUNGE_URL
    : PROD_BASE;

const deps: VouchDeps = { base: VOUCH_BASE };

/**
 * React Native's Android HTTP stack keeps a disk cache (OkHttp, 10 MB), and
 * the worker marks /vouch/app max-age 60 and /vouch/top max-age 120. After a
 * vouch in this session, reads of that app (and of the weekly list) carry
 * the vouch's updated_at as a throwaway query the worker ignores, so
 * reopening the page a few seconds later cannot show the numbers from
 * before it. Everything else keeps the cache.
 */
const vouchedAt = new Map<string, string>();
let lastVouchAt: string | undefined;

export const getAppVouches = (pkg: string, bust?: string): Promise<AppVouches | null> =>
  fetchAppVouches(deps, pkg, bust ?? vouchedAt.get(pkg));

export const getMyVouches = (mint: string): Promise<MyVouch[] | null> => fetchMyVouches(deps, mint);

export const getTopVouched = (): Promise<TopWeek | null> => fetchTopVouched(deps, lastVouchAt);

/** Changes whenever a vouch lands in this app session: the Lounge card re-reads the week when it moved. */
export const lastVouchStamp = (): string | undefined => lastVouchAt;

/**
 * The last signed payload that did not get a final answer (network, 5xx,
 * busy, 429). Module state, never persisted: a signature is only worth 10
 * minutes to the worker, and the same vouch tapped again inside that re-posts
 * it with no second Seed Vault prompt (vouchCore.postVouch).
 */
let pendingSigned: PendingSigned | null = null;
const pending: PendingStore = {
  get: () => pendingSigned,
  set: (p) => {
    pendingSigned = p;
  },
};

export const getCachedResult = (mint: string, pkg: string): Promise<VouchResult | null> =>
  cachedResult(AsyncStorage, mint, pkg);

export const getLatestResult = (mint: string): Promise<VouchResult | null> =>
  latestCachedResult(AsyncStorage, mint);

export const getCachedWeight = (mint: string, pkg: string): Promise<number | null> =>
  cachedWeight(AsyncStorage, mint, pkg);

/**
 * At most one Seed Vault prompt, then the same signed payload through every
 * retry and, after a failure a later try can pass, through the next tap too
 * (vouchCore.postVouch). The signed answer is cached per (mint, package)
 * because it is the only place the owner's tags, note and weight come back.
 * Throws a VouchError whose message is the sentence to show, or the wallet's
 * own error (no status) when the prompt is dismissed.
 */
export async function submitVouch(
  session: { address: string; authToken: string; mint: string },
  input: VouchInput,
  onStage?: (stage: SubmitStage, info?: { resumeAt: number }) => void,
): Promise<VouchResult> {
  const result = await postVouch(deps, {
    wallet: session.address,
    mint: session.mint,
    input,
    sign: (message) => signMessageBytes(session.address, session.authToken, message),
    onStage,
    pending,
  });
  const stamp = result.vouch.updatedAt || new Date().toISOString();
  vouchedAt.set(result.vouch.package, stamp);
  lastVouchAt = stamp;
  await rememberResult(AsyncStorage, session.mint, result);
  return result;
}
