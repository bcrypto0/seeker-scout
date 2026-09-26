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
 *   GET  /chat/latest?since=<id>                          -> {latestId, newCount}
 *   POST /chat/react  Bearer token, {messageId, emoji}    -> {messageId, reactions, mine}
 *
 * Moderation: max length, link-stripping (drainer defense), per-wallet rate
 * limit, report-based auto-hide, and a per-wallet block flag.
 */
import { issueToken, verifyToken } from './token.js';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LEN = 400;
const RATE_MS = 4000; // one message per wallet per 4s
const HIDE_AT_REPORTS = 3; // auto-hide after N distinct reporters
const PAGE = 50;
// A closed set: free-form emoji would make reactions a second, unmoderated
// message channel.
const REACTIONS = ['👍', '🔥', '😂', '👀', '❤️'];

/** {messageId: {emoji: count}} (+ the caller's own, when signed in). */
async function reactionsFor(env, ids, number) {
  const out = {};
  const mine = {};
  if (!ids.length) return { out, mine };
  const marks = ids.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT message_id, emoji, COUNT(*) AS n FROM reactions
     WHERE message_id IN (${marks}) GROUP BY message_id, emoji`,
  ).bind(...ids).all();
  for (const r of rows.results ?? []) {
    (out[r.message_id] ??= {})[r.emoji] = r.n;
  }
  if (number) {
    const own = await env.DB.prepare(
      `SELECT message_id, emoji FROM reactions WHERE number = ? AND message_id IN (${marks})`,
    ).bind(number, ...ids).all();
    for (const r of own.results ?? []) (mine[r.message_id] ??= []).push(r.emoji);
  }
  return { out, mine };
}

/**
 * Strip anything link-shaped — the core drainer-link defense. Blocklist by
 * SHAPE, not an allowlist of TLDs (which misses t.me, .cash, .ru, IPs, …).
 * Over-stripping in chat is fine; safety beats the rare false positive.
 */
function sanitize(raw) {
  if (typeof raw !== 'string') return '';
  let t = raw.replace(/\s+/g, ' ').trim();
  const R = '[link removed]';
  // 1. Explicit schemes / user-info @ / www.
  t = t.replace(/\b(?:https?|ftp|tg|solana):\/\/\S+/gi, R);
  t = t.replace(/\bwww\.\S+/gi, R);
  // 2. IPv4 (optionally with port/path).
  t = t.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?:[:/]\S*)?/g, R);
  // 3. Any domain: label(.label)*.<tld≥2 letters> with an optional path.
  //    TLD requires ≥2 LETTERS so decimals (3.5) and initialisms (e.g., U.S.)
  //    survive, while t.me / dab.cash / discord.gg / evil.ru get stripped.
  t = t.replace(
    /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?/gi,
    R,
  );
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

  // --- read: public (a bearer, if sent, only adds which reactions are yours) ---
  if (request.method === 'GET' && path === '/chat/messages') {
    const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const rows = await env.DB.prepare(
      'SELECT id, number, tier, text, created_at FROM messages WHERE hidden = 0 AND id > ? ORDER BY id DESC LIMIT ?',
    ).bind(since, PAGE).all();
    const messages = (rows.results ?? []).reverse();
    const rauth = request.headers.get('authorization') || '';
    const viewer = rauth.startsWith('Bearer ') ? await verifyToken(secret, rauth.slice(7)) : null;
    const { out, mine } = await reactionsFor(env, messages.map((m) => m.id), viewer?.number);
    for (const m of messages) {
      m.reactions = out[m.id] ?? {};
      if (viewer) m.mine = mine[m.id] ?? [];
    }
    return json({ messages });
  }

  // Cheap poll for the Lounge tab's unread badge: no message bodies.
  if (request.method === 'GET' && path === '/chat/latest') {
    const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const row = await env.DB.prepare(
      'SELECT MAX(id) AS latest, SUM(CASE WHEN id > ? THEN 1 ELSE 0 END) AS fresh FROM messages WHERE hidden = 0',
    ).bind(since).first();
    return json({ latestId: row?.latest ?? 0, newCount: row?.fresh ?? 0 });
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

    // Block check.
    const m = await env.DB.prepare('SELECT blocked FROM chat_members WHERE wallet = ?')
      .bind(claims.wallet).first();
    if (m?.blocked) return json({ error: 'account blocked' }, 403);

    // Atomic rate-limit claim: ensure the row exists, then conditionally
    // UPDATE last_post_at only if it's stale. D1 serializes writes, so
    // concurrent sends can't both win the slot (fixes the TOCTOU race).
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - RATE_MS).toISOString();
    await env.DB.prepare('INSERT OR IGNORE INTO chat_members (wallet) VALUES (?)')
      .bind(claims.wallet).run();
    const claim = await env.DB.prepare(
      'UPDATE chat_members SET last_post_at = ? WHERE wallet = ? AND (last_post_at IS NULL OR last_post_at < ?)',
    ).bind(now, claims.wallet, cutoff).run();
    if (!claim.meta?.changes) return json({ error: 'slow down' }, 429);

    await env.DB.prepare(
      'INSERT INTO messages (number, wallet, tier, text, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(claims.number, claims.wallet, claims.tier, text, now).run();
    const row = await env.DB.prepare(
      'SELECT id, number, tier, text, created_at FROM messages WHERE wallet = ? ORDER BY id DESC LIMIT 1',
    ).bind(claims.wallet).first();
    return json({ message: row });
  }

  if (request.method === 'POST' && path === '/chat/react') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
    const mid = parseInt(body?.messageId, 10);
    const emoji = body?.emoji;
    if (!mid) return json({ error: 'messageId required' }, 400);
    if (!REACTIONS.includes(emoji)) return json({ error: 'unsupported reaction' }, 400);
    const m = await env.DB.prepare('SELECT blocked FROM chat_members WHERE wallet = ?')
      .bind(claims.wallet).first();
    if (m?.blocked) return json({ error: 'account blocked' }, 403);
    const exists = await env.DB.prepare('SELECT id FROM messages WHERE id = ? AND hidden = 0')
      .bind(mid).first();
    if (!exists) return json({ error: 'message not found' }, 404);
    // Toggle: a second tap on the same emoji takes it back.
    const del = await env.DB.prepare(
      'DELETE FROM reactions WHERE message_id = ? AND number = ? AND emoji = ?',
    ).bind(mid, claims.number, emoji).run();
    if (!del.meta?.changes) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO reactions (message_id, number, emoji, created_at) VALUES (?, ?, ?, ?)',
      ).bind(mid, claims.number, emoji, new Date().toISOString()).run();
    }
    const { out, mine } = await reactionsFor(env, [mid], claims.number);
    return json({ messageId: mid, reactions: out[mid] ?? {}, mine: mine[mid] ?? [] });
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
