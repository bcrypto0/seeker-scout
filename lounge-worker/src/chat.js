/**
 * Owners' Lounge chat — Genesis-gated posting, public read, HTTP-based.
 *
 * Auth model: a member proves Genesis ownership ONCE (signed message, same
 * verification as /claim) and receives a short-lived bearer token (HMAC over
 * {number, wallet, exp}), so posting needs no per-message Seed Vault prompt.
 *
 * Endpoints (routed from index.js):
 *   POST /chat/auth   {wallet, mint, ts, signature}      -> {token, number, tier}
 *   GET  /chat/messages?since=<id>                        -> {messages:[...]}
 *   POST /chat/send   Bearer token, {text}               -> {message}
 *   POST /chat/report Bearer token, {messageId}          -> {ok}
 *
 * Moderation: max length, link-stripping (drainer defense), per-wallet rate
 * limit, report-based auto-hide, and a per-wallet block flag.
 */

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LEN = 400;
const RATE_MS = 4000; // one message per wallet per 4s
const HIDE_AT_REPORTS = 3; // auto-hide after N distinct reporters
const PAGE = 50;

const enc = new TextEncoder();

const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlToBytes = (s) => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '==='.slice((pad.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

/** token = base64url(payloadJson).base64url(hmac) */
async function issueToken(secret, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

async function verifyToken(secret, token) {
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
    return payload; // {number, wallet, tier, exp}
  } catch {
    return null;
  }
}

/** Strip URLs and collapse whitespace — the core drainer-link defense. */
function sanitize(raw) {
  if (typeof raw !== 'string') return '';
  let t = raw.replace(/\s+/g, ' ').trim();
  // Remove anything URL-shaped (http(s), www., bare domains, wallet-drainer
  // patterns) — chat is for talk, not links.
  t = t.replace(/\b((https?:\/\/|www\.)\S+|\S+\.(xyz|com|io|fun|app|net|org|gg|to|link|click|co)\b\S*)/gi, '[link removed]');
  return t.slice(0, MAX_LEN);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', ...CORS },
  });

/**
 * @param verifyClaim async ({wallet,mint,ts,signature}) => {number,tier} | {error,status}
 *   Reuses index.js's full claim verification (fresh sig + Genesis + holder +
 *   must already have a claimed number).
 */
export async function handleChat(request, env, url, verifyClaim) {
  const secret = env.CHAT_SECRET || 'dev-insecure-secret-set-CHAT_SECRET';
  const path = url.pathname;

  // --- auth: prove Genesis once, get a posting token ---
  if (request.method === 'POST' && path === '/chat/auth') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
    const res = await verifyClaim(body);
    if (res.error) return json({ error: res.error }, res.status || 403);
    // Blocked members can't get a token.
    const m = await env.DB.prepare('SELECT blocked FROM chat_members WHERE wallet = ?')
      .bind(body.wallet).first();
    if (m?.blocked) return json({ error: 'account blocked' }, 403);
    const payload = { number: res.number, wallet: body.wallet, tier: res.tier, exp: Date.now() + TOKEN_TTL_MS };
    return json({ token: await issueToken(secret, payload), number: res.number, tier: res.tier });
  }

  // --- read: public ---
  if (request.method === 'GET' && path === '/chat/messages') {
    const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const rows = await env.DB.prepare(
      'SELECT id, number, tier, text, created_at FROM messages WHERE hidden = 0 AND id > ? ORDER BY id DESC LIMIT ?',
    ).bind(since, PAGE).all();
    return json({ messages: (rows.results ?? []).reverse() });
  }

  // --- send / report: require a valid token ---
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const claims = await verifyToken(secret, token);
  if (!claims) return json({ error: 'not authenticated' }, 401);

  if (request.method === 'POST' && path === '/chat/send') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
    const text = sanitize(body?.text);
    if (!text || text === '[link removed]') return json({ error: 'empty message' }, 400);

    // Block + rate-limit check.
    const m = await env.DB.prepare('SELECT last_post_at, blocked FROM chat_members WHERE wallet = ?')
      .bind(claims.wallet).first();
    if (m?.blocked) return json({ error: 'account blocked' }, 403);
    if (m?.last_post_at && Date.now() - Date.parse(m.last_post_at) < RATE_MS) {
      return json({ error: 'slow down' }, 429);
    }
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO messages (number, wallet, tier, text, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(claims.number, claims.wallet, claims.tier, text, now).run();
    await env.DB.prepare(
      'INSERT INTO chat_members (wallet, last_post_at) VALUES (?, ?) ON CONFLICT(wallet) DO UPDATE SET last_post_at = ?',
    ).bind(claims.wallet, now, now).run();
    const row = await env.DB.prepare(
      'SELECT id, number, tier, text, created_at FROM messages WHERE wallet = ? ORDER BY id DESC LIMIT 1',
    ).bind(claims.wallet).first();
    return json({ message: row });
  }

  if (request.method === 'POST' && path === '/chat/report') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
    const mid = parseInt(body?.messageId, 10);
    if (!mid) return json({ error: 'messageId required' }, 400);
    // Dedup: one report per reporter per message.
    const ins = await env.DB.prepare(
      'INSERT OR IGNORE INTO reports (message_id, reporter) VALUES (?, ?)',
    ).bind(mid, claims.wallet).run();
    if (ins.meta?.changes) {
      await env.DB.prepare('UPDATE messages SET reports = reports + 1 WHERE id = ?').bind(mid).run();
      await env.DB.prepare('UPDATE messages SET hidden = 1 WHERE id = ? AND reports >= ?')
        .bind(mid, HIDE_AT_REPORTS).run();
    }
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}
