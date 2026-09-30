/**
 * Owners' Lounge chat: Genesis-gated posting, public read, HTTP-based.
 *
 * Auth model: a member proves Genesis ownership ONCE (signed message, same
 * verification as /claim) and receives a short-lived bearer token (HMAC over
 * {number, wallet, exp}), so posting needs no per-message Seed Vault prompt.
 *
 * Endpoints (routed from index.js):
 *   POST /chat/auth   {wallet, mint, ts, signature}      -> {token, number, tier}
 *   GET  /chat/messages?since=<id>                        -> {messages:[...]}
 *   POST /chat/send   Bearer token, {text, reply_to?}     -> {message}
 *   POST /chat/report Bearer token, {messageId}          -> {ok}
 *   GET  /chat/latest?since=<id>                          -> {latestId, newCount}
 *   POST /chat/react  Bearer token, {messageId, emoji}    -> {messageId, reactions, mine}
 *   GET  /chat/replies?to=<number>&since=<id>             -> {latestId, count, replies:[...]}
 *
 * Replies (migrations/003_chat_replies.sql): messages.reply_to is the id of
 * the message a post answers, or NULL. Every message read carries reply_to
 * and `reply`: null, {id, number, text} with the parent's text cut to
 * REPLY_SNIPPET, or {id, hidden: true} once the parent is hidden (or gone).
 * Readings of the contract this file implements:
 *  - "cut to 100 characters" is 100 UTF-16 units (like MAX_LEN), never half a
 *    surrogate pair, with no mark that the text was cut: a quote of 80 emoji
 *    carries 50 of them and nothing says 30 were dropped.
 *  - POST /chat/send: reply_to absent or null is a plain message. A reply_to
 *    of the wrong type from a blocked member still gets 403 'account blocked'
 *    (the block check comes first, as before replies).
 *  - GET /chat/replies: `to` and `since` are both required. Only replies
 *    among the REPLIES_WINDOW newest message ids count: `since` is raised to
 *    (newest message id - REPLIES_WINDOW) when it is lower, so `count` is the
 *    qualifying replies with id > max(since, newest id - REPLIES_WINDOW).
 *    latestId stays the newest listed reply's id, else the since asked with.
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
// Replies: the parent's text is quoted at most this long (UTF-16 units, like
// MAX_LEN), /chat/replies lists at most REPLIES_PAGE and counts up to
// REPLIES_COUNT_CAP, and `to` is a founding number up to MAX_NUMBER.
export const REPLY_SNIPPET = 100;
const REPLIES_PAGE = 20;
const REPLIES_COUNT_CAP = 99;
const MAX_NUMBER = 1_000_000;
// /chat/replies looks only at the newest REPLIES_WINDOW message ids. One call
// reads a row per message it walks plus one per reply's parent, so about
// 2 * REPLIES_WINDOW rows at most, however long the chat gets or how low
// `since` is.
export const REPLIES_WINDOW = 1000;

/**
 * `text` cut to REPLY_SNIPPET UTF-16 units, never inside a surrogate pair: when
 * the cut would keep only the first half of an emoji, that half goes too
 * (the app's dropTrailingHighSurrogate rule), so the result is well formed.
 */
export function replySnippet(text) {
  if (typeof text !== 'string') return '';
  const t = text.slice(0, REPLY_SNIPPET);
  const last = t.length ? t.charCodeAt(t.length - 1) : 0;
  return last >= 0xd800 && last <= 0xdbff ? t.slice(0, -1) : t;
}

/**
 * The `reply` field of a message read with the parent's columns joined in as
 * p_id / p_number / p_text / p_hidden. A parent that is hidden, or no longer
 * there, reads as {id, hidden: true}: its number and text never leave.
 */
export function replyOf(row) {
  if (row.reply_to === null || row.reply_to === undefined) return null;
  if (row.p_id === null || row.p_id === undefined || row.p_hidden) return { id: row.reply_to, hidden: true };
  return { id: row.p_id, number: row.p_number, text: replySnippet(row.p_text) };
}

/** A decimal query value as an integer in [min, max], else null (no sign, no fraction, no exponent). */
function intParam(raw, min, max) {
  if (typeof raw !== 'string' || !/^\d{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

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
 * Strip anything link-shaped: the core drainer-link defense. Blocklist by
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
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', ...CORS, ...extra },
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
    // The parent of a reply comes in by primary key in the same query.
    const rows = await env.DB.prepare(
      `SELECT m.id, m.number, m.tier, m.text, m.created_at, m.reply_to,
              p.id AS p_id, p.number AS p_number, p.text AS p_text, p.hidden AS p_hidden
       FROM messages m LEFT JOIN messages p ON p.id = m.reply_to
       WHERE m.hidden = 0 AND m.id > ? ORDER BY m.id DESC LIMIT ?`,
    ).bind(since, PAGE).all();
    const messages = (rows.results ?? []).reverse().map((r) => ({
      id: r.id, number: r.number, tier: r.tier, text: r.text, created_at: r.created_at,
      reply_to: r.reply_to ?? null, reply: replyOf(r),
    }));
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

  // Replies to one member's messages, for the app's badge and background
  // check. Public, with no token: the chat is public, but this is NOT a
  // subset of /chat/messages, which serves only the newest PAGE visible
  // messages. Here anyone can list, per founding number, up to REPLIES_PAGE
  // older replies (author number, created_at, first REPLY_SNIPPET units) from
  // the newest REPLIES_WINDOW message ids. Hidden replies, and replies to
  // hidden messages, stay out.
  // A reply counts when it and its parent are both visible, the parent's
  // author is `to` and the reply's is not (answering yourself is no news).
  // One query: newest first by primary key down to max(since, newest id -
  // REPLIES_WINDOW) (one bound, so the walk stops there: a second `r.id >`
  // term would only filter), each parent by primary key, stopping at
  // REPLIES_COUNT_CAP hits. It reads every message in that range until then,
  // so a caller that passes the newest message id it has seen keeps each
  // check to a few rows. idx_messages_reply_to (003) is not used by this or
  // any other query today: the cost follows the messages walked, not the
  // replies found.
  if (request.method === 'GET' && path === '/chat/replies') {
    const to = intParam(url.searchParams.get('to'), 1, MAX_NUMBER);
    if (to === null) return json({ error: 'bad to' }, 400);
    const since = intParam(url.searchParams.get('since'), 0, Number.MAX_SAFE_INTEGER);
    if (since === null) return json({ error: 'bad since' }, 400);
    const rows = await env.DB.prepare(
      `SELECT r.id, r.number, r.text, r.created_at, r.reply_to
       FROM messages r JOIN messages p ON p.id = r.reply_to
       WHERE r.id > max(?2, COALESCE((SELECT MAX(id) FROM messages), 0) - ?4)
         AND r.hidden = 0 AND r.number <> ?1 AND p.number = ?1 AND p.hidden = 0
       ORDER BY r.id DESC LIMIT ?3`,
    ).bind(to, since, REPLIES_COUNT_CAP, REPLIES_WINDOW).all();
    const hits = rows.results ?? [];
    const replies = hits.slice(0, REPLIES_PAGE).map((r) => ({
      id: r.id, number: r.number, text: replySnippet(r.text), created_at: r.created_at, reply_to: r.reply_to,
    }));
    return json(
      { latestId: replies.length ? replies[0].id : since, count: hits.length, replies },
      200,
      { 'Cache-Control': 'public, max-age=30' },
    );
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

    // reply_to: absent (or null) for a plain message, else the id of a
    // visible message. Checked after the block check (a blocked member gets
    // 403 whatever reply_to says) and before the rate-limit slot, so a
    // refused reply does not cost the sender a post.
    const replyTo = body?.reply_to ?? null;
    if (replyTo !== null && !(Number.isSafeInteger(replyTo) && replyTo > 0)) {
      return json({ error: 'bad reply' }, 400);
    }
    let parent = null;
    if (replyTo !== null) {
      parent = await env.DB.prepare('SELECT id, number, text FROM messages WHERE id = ? AND hidden = 0')
        .bind(replyTo).first();
      if (!parent) return json({ error: 'bad reply' }, 400);
    }

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
      'INSERT INTO messages (number, wallet, tier, text, created_at, reply_to) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(claims.number, claims.wallet, claims.tier, text, now, replyTo).run();
    const row = await env.DB.prepare(
      'SELECT id, number, tier, text, created_at, reply_to FROM messages WHERE wallet = ? ORDER BY id DESC LIMIT 1',
    ).bind(claims.wallet).first();
    if (row) {
      row.reply_to = row.reply_to ?? null;
      row.reply = parent && row.reply_to === parent.id
        ? { id: parent.id, number: parent.number, text: replySnippet(parent.text) }
        : null;
    }
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
