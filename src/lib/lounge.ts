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
 * Anonymous app-open ping — fire-and-forget on launch. No wallet, no device
 * id, no PII; just bumps a per-day counter so we can quote a real
 * opens/impressions number (ad-sales metric). Never throws, never blocks.
 */
export function pingOpen(): void {
  // x-ss (= versionCode) is the worker's spam gate: pings without it are
  // accepted but not counted, so curl loops can't inflate the ad metric.
  fetch(`${LOUNGE_URL}/ping`, {
    method: 'POST',
    headers: { 'x-ss': '6' },
  }).catch(() => {});
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
