import AsyncStorage from '@react-native-async-storage/async-storage';
import { signMessageBytes } from './wallet';

/**
 * Owners' Lounge chat client. Members prove Genesis ownership once (signed
 * message, same format as the claim) to get a 24h bearer token — then post
 * without re-signing. Read is public.
 */
const BASE = 'https://seeker-lounge.bcrypto-eth.workers.dev';
const TOKEN_KEY = 'seekerscout.chat.token.v1';

export type ChatMessage = {
  id: number;
  number: number;
  tier: 'founding' | 'early' | 'member';
  text: string;
  created_at: string;
  /** emoji -> count (v0.10 server; absent on an older server). */
  reactions?: Record<string, number>;
  /** The emojis the signed-in viewer added (only when a token was sent). */
  mine?: string[];
};

/**
 * The reaction set, identical to the worker's REACTIONS. Exact strings
 * matter: '❤️' is U+2764 + U+FE0F, and a bare U+2764 is rejected.
 */
export const REACTIONS = ['👍', '🔥', '😂', '👀', '❤️'] as const;

// One token for the whole Lounge: verifying in the chat also unlocks the
// games and vice versa, so every screen hears when it changes.
const tokenListeners = new Set<(t: string | null) => void>();
export function onTokenChange(fn: (t: string | null) => void): () => void {
  tokenListeners.add(fn);
  return () => tokenListeners.delete(fn);
}
const emitToken = (t: string | null) => tokenListeners.forEach((fn) => fn(t));

/** Forget an expired or rejected token everywhere. */
export async function clearToken(): Promise<void> {
  await AsyncStorage.removeItem(TOKEN_KEY).catch(() => {});
  emitToken(null);
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58Encode = (bytes: Uint8Array): string => {
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

async function withTimeout(url: string, opts: RequestInit, ms = 12_000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Cached token if still valid (we store exp alongside). */
export async function cachedToken(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const { token, exp } = JSON.parse(raw);
    return exp && Date.now() < exp - 60_000 ? token : null;
  } catch {
    return null;
  }
}

/** Sign once → get + cache a posting token. */
export async function authChat(
  address: string,
  authToken: string,
  mint: string,
): Promise<string> {
  const ts = new Date().toISOString();
  const message = `Seeker Scout — Owners' Lounge claim\nwallet: ${address}\nmint: ${mint}\nts: ${ts}`;
  const signed = await signMessageBytes(address, authToken, message);
  const candidates = signed.length === 64 ? [signed] : [signed.slice(0, 64), signed.slice(-64)];

  let lastErr = 'auth failed';
  for (const sig of candidates) {
    const res = await withTimeout(`${BASE}/chat/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: address, mint, ts, signature: base58Encode(sig) }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.token) {
      await AsyncStorage.setItem(
        TOKEN_KEY,
        JSON.stringify({ token: body.token, exp: Date.now() + 23 * 60 * 60 * 1000 }),
      );
      emitToken(body.token);
      return body.token;
    }
    lastErr = body.error || `auth failed (${res.status})`;
    if (res.status !== 401) break; // only signature-shape issues retry
  }
  throw new Error(lastErr);
}

/**
 * Read is public. Passing the token only adds which reactions are yours, so
 * a missing or expired token still reads fine.
 */
export async function fetchMessages(since = 0, token?: string | null): Promise<ChatMessage[]> {
  try {
    const res = await withTimeout(
      `${BASE}/chat/messages?since=${since}`,
      token ? { headers: { authorization: `Bearer ${token}` } } : {},
      10_000,
    );
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body.messages) ? body.messages : [];
  } catch {
    return [];
  }
}

export async function sendMessage(token: string, text: string): Promise<ChatMessage> {
  const res = await withTimeout(`${BASE}/chat/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `send failed (${res.status})`);
  return body.message;
}

/** Toggle a reaction; resolves with the message's fresh counts and yours. */
export async function reactToMessage(
  token: string,
  messageId: number,
  emoji: string,
): Promise<{ reactions: Record<string, number>; mine: string[] }> {
  const res = await withTimeout(`${BASE}/chat/react`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ messageId, emoji }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `reaction failed (${res.status})`);
  return { reactions: body.reactions ?? {}, mine: body.mine ?? [] };
}

/** Newest message id + how many arrived after `since`. Null if unreachable. */
export async function fetchLatest(
  since: number,
): Promise<{ latestId: number; newCount: number } | null> {
  try {
    const res = await withTimeout(`${BASE}/chat/latest?since=${since}`, {}, 8_000);
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.latestId === 'number'
      ? { latestId: body.latestId, newCount: Number(body.newCount) || 0 }
      : null;
  } catch {
    return null;
  }
}

export async function reportMessage(token: string, messageId: number): Promise<void> {
  await withTimeout(`${BASE}/chat/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ messageId }),
  }).catch(() => {});
}
