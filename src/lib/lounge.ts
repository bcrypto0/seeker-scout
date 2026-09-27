import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { signMessageBytes } from './wallet';

/**
 * Owners' Lounge founding-number claims (lounge-worker on Cloudflare).
 * Message format MUST match the worker's claimMessage() exactly.
 */
const LOUNGE_URL = 'https://seeker-lounge.bcrypto-eth.workers.dev';

export type LoungeTier = 'founding' | 'early' | 'member';
export type LoungeClaim = { number: number; tier: LoungeTier };
export type LoungeStats = { total: number; founding: number };

const base58Encode = (bytes: Uint8Array): string => {
  const ALPHABET =
    '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
};

/**
 * Anonymous app-open ping, fire-and-forget on launch. No wallet, no device
 * id, no PII. It bumps a per-day counter (the opens/impressions number for
 * ad sales) and, at most once a day, adds two coarse facts so we can see
 * where installs drop off: how many days ago the app was installed (as a
 * bucket, worked out here on the phone) and whether this is its first
 * launch ever. The install date itself never leaves the phone. Never
 * throws, never blocks.
 */
export function pingOpen(): void {
  void sendPing();
}

const AGE_DAY_KEY = 'seekerscout.ping.ageDay.v1'; // local day the age was last sent
const FIRST_KEY = 'seekerscout.ping.first.v1'; // set once the first launch is counted

/** Must match the worker's AGE_BUCKETS exactly; anything else is dropped. */
export function ageBucket(days: number): string {
  if (days <= 3) return String(Math.max(0, days));
  if (days <= 7) return '4-7';
  if (days <= 14) return '8-14';
  if (days <= 30) return '15-30';
  return '31+';
}

const localDay = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

async function sendPing(): Promise<void> {
  // x-ss (= versionCode) is the worker's spam gate: pings without it are
  // accepted but not counted, so curl loops can't inflate the opens metric.
  // Read from the native build so it can never go stale against app.json.
  const headers: Record<string, string> = { 'x-ss': Constants.nativeBuildVersion ?? '0' };
  const now = new Date();
  let firstLaunch = false;
  try {
    const [lastDay, seen] = await Promise.all([
      AsyncStorage.getItem(AGE_DAY_KEY),
      AsyncStorage.getItem(FIRST_KEY),
    ]);
    if (lastDay !== localDay(now)) {
      // Android's first-install time survives app updates, so a v0.9 user
      // updating reports their real age, not "installed today".
      const installed = await Application.getInstallationTimeAsync();
      // Calendar days, not 24h blocks: "came back the next day" is day 1.
      const days = Math.round((dayStart(now) - dayStart(installed)) / 86_400_000);
      if (Number.isFinite(days)) {
        headers['x-age'] = ageBucket(days);
        firstLaunch = !seen;
        if (firstLaunch) headers['x-first'] = '1';
      }
    }
  } catch {
    // No age this time; the plain open still counts.
  }
  try {
    const res = await fetch(`${LOUNGE_URL}/ping`, { method: 'POST', headers });
    // Only mark the day as sent once the server has it, so an offline
    // launch tries again on the next one.
    if (res.ok && headers['x-age']) {
      await AsyncStorage.setItem(AGE_DAY_KEY, localDay(now));
      if (firstLaunch) await AsyncStorage.setItem(FIRST_KEY, '1');
    }
  } catch {
    /* fire-and-forget */
  }
}

export async function getLoungeStats(): Promise<LoungeStats | null> {
  try {
    const res = await fetch(`${LOUNGE_URL}/stats`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function getLoungeStatus(
  mint: string,
): Promise<LoungeClaim | null> {
  try {
    const res = await fetch(
      `${LOUNGE_URL}/status?mint=${encodeURIComponent(mint)}`,
    );
    if (!res.ok) return null;
    const body = await res.json();
    return body.claimed ? { number: body.number, tier: body.tier } : null;
  } catch {
    return null;
  }
}

async function postClaim(
  wallet: string,
  mint: string,
  ts: string,
  signature: string,
): Promise<{ ok: boolean; status: number; body: any }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${LOUNGE_URL}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet, mint, ts, signature }),
      signal: controller.signal,
    });
    let body: any = {};
    try {
      body = await res.json();
    } catch {
      body = { error: 'unexpected response' };
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sign + submit a founding-number claim. One Seed Vault prompt, then the
 * SAME signed payload is retried through transient failures (the worker's
 * freshness window is 10 minutes — no re-signing needed). Wallets differ in
 * whether signMessages returns the bare signature or signature‖message, so
 * a signature rejection retries the alternate slice.
 */
export async function claimFounderNumber(
  address: string,
  authToken: string,
  mint: string,
): Promise<LoungeClaim> {
  const ts = new Date().toISOString();
  const message = `Seeker Scout — Owners' Lounge claim\nwallet: ${address}\nmint: ${mint}\nts: ${ts}`;
  const signed = await signMessageBytes(address, authToken, message);

  const candidates: Uint8Array[] =
    signed.length === 64
      ? [signed]
      : [signed.slice(0, 64), signed.slice(-64)];

  let lastError = 'claim failed';
  for (const sig of candidates) {
    const encoded = base58Encode(sig);
    // Up to 3 attempts per candidate on transient (network/5xx) failures.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(1500 * attempt);
      let res;
      try {
        res = await postClaim(address, mint, ts, encoded);
      } catch {
        lastError = 'network problem — your signature is fine, try again';
        continue;
      }
      if (res.ok) return res.body as LoungeClaim;
      if (res.status === 401) {
        lastError = 'signature rejected';
        break; // try the alternate signature slice
      }
      if (res.status >= 500) {
        lastError = 'claim service is busy — try again in a minute';
        continue; // transient: same payload, no re-sign
      }
      throw new Error(res.body?.error ?? `claim failed (${res.status})`);
    }
    if (lastError !== 'signature rejected') {
      // Transient failures exhausted — don't burn the second candidate.
      throw new Error(lastError);
    }
  }
  throw new Error(lastError);
}
