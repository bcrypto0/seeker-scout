/**
 * Shared bearer-token primitives for /chat/* and /alpha/*.
 *
 *   token = base64url(payloadJson) "." base64url(HMAC-SHA-256(secret, body))
 *
 * Lifted verbatim out of chat.js so both routers share ONE crypto
 * implementation. The payload encoding and the signing input are UNCHANGED —
 * chat tokens already issued to devices keep verifying byte-for-byte.
 */

const enc = new TextEncoder();

export const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const b64urlToBytes = (s) => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '==='.slice((pad.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

/** token = base64url(payloadJson).base64url(hmac) */
export async function issueToken(secret, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verifyToken(secret, token) {
  // Fully defensive: any malformed token → null (never throws → never a 1101).
  try {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    if (!payload?.exp || Date.now() > payload.exp) return null;
    return payload; // {number, wallet, tier, exp} (+ {alpha, alphaExp} on alpha tokens)
  } catch {
    return null;
  }
}
