// lounge-worker/test/chat.test.js. node:test, in-memory D1 (node:sqlite), no network.
// Chat replies (migrations/003_chat_replies.sql): the schema and the migration agree,
// POST /chat/send reply_to, the `reply` field of GET /chat/messages, GET /chat/replies,
// and the chat routes that did not change. Tokens are signed here with a throwaway
// secret made for this run; nothing reads a real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { handleChat, replySnippet, REPLY_SNIPPET, REPLIES_WINDOW } from '../src/chat.js';
import { issueToken } from '../src/token.js';
import worker from '../src/index.js';
import { hasLoneSurrogate } from '../src/vouch-lib.js';
import { makeD1 } from './d1.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const SCHEMA = ['../schema.sql', '../migrations/001_vouches.sql', '../migrations/002_skr_cache.sql'].map(here);
const MIGRATION_003 = readFileSync(here('../migrations/003_chat_replies.sql'), 'utf8');
const SECRET = `test-only-${crypto.randomUUID()}`;
const ROCKET = String.fromCodePoint(0x1f680); // two UTF-16 units

// The messages table as schema.sql created it before 003 (what production holds today).
const MESSAGES_BEFORE_003 = `CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  tier TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reports INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id);`;

const columns = (db) => db.prepare('PRAGMA table_info(messages)').all()
  .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value, pk: c.pk }));
const indexCols = (db, name) => db.prepare(`PRAGMA index_info(${name})`).all().map((c) => c.name);

// ---- harness ------------------------------------------------------------------
function makeEnv() {
  return { CHAT_SECRET: SECRET, DB: makeD1(SCHEMA) };
}
let nextWallet = 0;
async function member(number, tier = 'founding') {
  const wallet = `W${String(++nextWallet).padStart(43, '0')}`;
  const token = await issueToken(SECRET, { number, wallet, tier, exp: Date.now() + 60_000 });
  return { number, wallet, tier, token };
}
async function call(env, method, path, { body, token } = {}) {
  const request = new Request(`http://lounge.test${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const res = await handleChat(request, env, new URL(request.url), async () => ({ error: 'unused', status: 500 }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
/** POST /chat/send with the member's rate-limit slot freed first (the 4 s rule has its own test). */
async function send(env, m, body) {
  env.DB.raw.prepare('UPDATE chat_members SET last_post_at = NULL WHERE wallet = ?').run(m.wallet);
  return call(env, 'POST', '/chat/send', { body, token: m.token });
}
async function post(env, m, text, replyTo) {
  const r = await send(env, m, replyTo === undefined ? { text } : { text, reply_to: replyTo });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.message;
}
const hide = (env, id) => env.DB.raw.prepare('UPDATE messages SET hidden = 1 WHERE id = ?').run(id);
const messages = async (env, since = 0, token) => (await call(env, 'GET', `/chat/messages?since=${since}`, { token })).body.messages;
const replies = (env, to, since) => call(env, 'GET', `/chat/replies?to=${to}${since === undefined ? '' : `&since=${since}`}`);

// ---- schema and migration -----------------------------------------------------
test('schema.sql creates messages.reply_to (nullable INTEGER, no default) and idx_messages_reply_to', () => {
  const env = makeEnv();
  const col = columns(env.DB.raw).find((c) => c.name === 'reply_to');
  assert.deepEqual(col, { name: 'reply_to', type: 'INTEGER', notnull: 0, dflt: null, pk: 0 });
  assert.deepEqual(indexCols(env.DB.raw, 'idx_messages_reply_to'), ['reply_to']);
});

test('003 on the pre-003 messages table gives the same columns and index as a fresh schema.sql; old rows read NULL', () => {
  const fresh = makeEnv().DB.raw;
  const old = new DatabaseSync(':memory:');
  old.exec(MESSAGES_BEFORE_003);
  old.prepare("INSERT INTO messages (number, wallet, tier, text, created_at) VALUES (1, 'w', 'founding', 'before', 't')").run();
  old.exec(MIGRATION_003);
  assert.deepEqual(columns(old), columns(fresh));
  assert.deepEqual(indexCols(old, 'idx_messages_reply_to'), ['reply_to']);
  assert.equal(old.prepare('SELECT reply_to FROM messages').get().reply_to, null);
});

test('003 is not idempotent: a second run, or a run on a fresh schema.sql database, fails on the duplicate column', () => {
  const old = new DatabaseSync(':memory:');
  old.exec(MESSAGES_BEFORE_003);
  old.exec(MIGRATION_003);
  assert.throws(() => old.exec(MIGRATION_003), /duplicate column name: reply_to/);
  assert.throws(() => makeEnv().DB.raw.exec(MIGRATION_003), /duplicate column name: reply_to/);
  assert.match(MIGRATION_003, /NOT IDEMPOTENT/);
  assert.match(MIGRATION_003, /PRAGMA table_info\(messages\)/);
});

test('re-running schema.sql on a pre-003 database fails only at its last statement, the reply_to index', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(MESSAGES_BEFORE_003);
  const schema = readFileSync(SCHEMA[0], 'utf8');
  const last = schema.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean).pop();
  assert.equal(last, 'CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to)');
  assert.throws(() => db.exec(schema), /no such column: reply_to/);
  db.exec(MIGRATION_003);
  db.exec(schema); // after 003 the whole file runs again
});

// ---- replySnippet -------------------------------------------------------------
test('replySnippet: at most 100 UTF-16 units, never half an emoji', () => {
  assert.equal(REPLY_SNIPPET, 100);
  assert.equal(replySnippet('short'), 'short');
  assert.equal(replySnippet('a'.repeat(400)), 'a'.repeat(100));
  const straddle = 'a'.repeat(99) + ROCKET + 'tail'; // the emoji spans units 99 and 100
  assert.equal(replySnippet(straddle), 'a'.repeat(99));
  const fits = 'a'.repeat(98) + ROCKET + 'tail';
  assert.equal(replySnippet(fits), 'a'.repeat(98) + ROCKET);
  const emojis = ROCKET.repeat(60);
  assert.equal(replySnippet(emojis), ROCKET.repeat(50));
  for (const s of [straddle, fits, emojis, 'b' + emojis]) {
    const t = replySnippet(s);
    assert.ok(t.length <= 100 && !hasLoneSurrogate(t), JSON.stringify(t));
  }
  assert.equal(replySnippet(undefined), '');
  assert.equal(replySnippet(null), '');
});

// ---- POST /chat/send ----------------------------------------------------------
test('send without reply_to (or with null) -> reply_to null, reply null; with one -> reply {id, number, text}', async () => {
  const env = makeEnv();
  const a = await member(7);
  const b = await member(8, 'early');
  const plain = await post(env, a, 'gm');
  assert.deepEqual(Object.keys(plain), ['id', 'number', 'tier', 'text', 'created_at', 'reply_to', 'reply']);
  assert.equal(plain.reply_to, null);
  assert.equal(plain.reply, null);
  const viaNull = await post(env, a, 'still plain', null);
  assert.equal(viaNull.reply_to, null);
  assert.equal(viaNull.reply, null);
  const rep = await post(env, b, 'gm back', plain.id);
  assert.equal(rep.number, 8);
  assert.equal(rep.tier, 'early');
  assert.equal(rep.reply_to, plain.id);
  assert.deepEqual(rep.reply, { id: plain.id, number: 7, text: 'gm' });
  const stored = env.DB.raw.prepare('SELECT reply_to FROM messages WHERE id = ?').get(rep.id);
  assert.equal(stored.reply_to, plain.id);
});

test('send quotes a long parent cut to 100 units on a character boundary', async () => {
  const env = makeEnv();
  const a = await member(1);
  const b = await member(2);
  const long = await post(env, a, 'a'.repeat(99) + ROCKET + ' and more text after the cut');
  const rep = await post(env, b, 'reply', long.id);
  assert.equal(rep.reply.text, 'a'.repeat(99));
  const long2 = await post(env, a, 'x'.repeat(300));
  assert.equal((await post(env, b, 'reply 2', long2.id)).reply.text, 'x'.repeat(100));
});

test("send: a reply_to that is not a positive integer, or names a hidden or missing message -> 400 'bad reply', no row, no slot spent", async () => {
  const env = makeEnv();
  const a = await member(3);
  const b = await member(4);
  const parent = await post(env, a, 'parent');
  const hidden = await post(env, a, 'will be hidden');
  hide(env, hidden.id);
  const before = env.DB.raw.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  for (const bad of [0, -1, 1.5, `${parent.id}`, true, false, {}, [parent.id], 'x', Number.MAX_SAFE_INTEGER + 2,
    hidden.id, parent.id + 1000]) {
    env.DB.raw.prepare('UPDATE chat_members SET last_post_at = ? WHERE wallet = ?').run(null, b.wallet);
    const r = await call(env, 'POST', '/chat/send', { body: { text: 'hi', reply_to: bad }, token: b.token });
    assert.equal(r.status, 400, `reply_to ${JSON.stringify(bad)}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body, { error: 'bad reply' });
  }
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM messages').get().n, before);
  // A refused reply costs no slot: the next valid post goes straight through (no slot reset here).
  const ok = await call(env, 'POST', '/chat/send', { body: { text: 'hi', reply_to: parent.id }, token: b.token });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('send: auth, empty text, block and the 4 s rate limit behave as before with reply_to present', async () => {
  const env = makeEnv();
  const a = await member(5);
  const b = await member(6);
  const parent = await post(env, a, 'parent');
  let r = await call(env, 'POST', '/chat/send', { body: { text: 'hi', reply_to: parent.id } });
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: 'not authenticated' });
  const forged = await issueToken('another-secret', { number: 6, wallet: b.wallet, tier: 'founding', exp: Date.now() + 60_000 });
  r = await call(env, 'POST', '/chat/send', { body: { text: 'hi', reply_to: parent.id }, token: forged });
  assert.equal(r.status, 401);
  r = await send(env, b, { text: '   ', reply_to: 'not checked first' });
  assert.deepEqual([r.status, r.body], [400, { error: 'empty message' }]);
  r = await send(env, b, { text: 'see t.me/x', reply_to: parent.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.message.text, 'see [link removed]');
  r = await call(env, 'POST', '/chat/send', { body: { text: 'again', reply_to: parent.id }, token: b.token });
  assert.deepEqual([r.status, r.body], [429, { error: 'slow down' }]);
  env.DB.raw.prepare('UPDATE chat_members SET blocked = 1 WHERE wallet = ?').run(b.wallet);
  r = await send(env, b, { text: 'blocked', reply_to: parent.id });
  assert.deepEqual([r.status, r.body], [403, { error: 'account blocked' }]);
  r = await send(env, b, { text: 'blocked', reply_to: parent.id + 99 });
  assert.deepEqual([r.status, r.body], [403, { error: 'account blocked' }]);
  // The block check comes before the reply_to check, as it came before any reply existed.
  for (const bad of [0, 'x', 1.5, {}]) {
    r = await send(env, b, { text: 'blocked', reply_to: bad });
    assert.deepEqual([r.status, r.body], [403, { error: 'account blocked' }], `reply_to ${JSON.stringify(bad)}`);
  }
  r = await call(env, 'POST', '/chat/send', { body: 'not json', token: a.token });
  assert.deepEqual([r.status, r.body], [400, { error: 'bad json' }]);
});

// ---- GET /chat/messages -------------------------------------------------------
test('messages: every row carries reply_to and reply; a hidden or missing parent reads {id, hidden: true}; reactions and mine unchanged', async () => {
  const env = makeEnv();
  const a = await member(11);
  const b = await member(12);
  const p1 = await post(env, a, 'first');
  const p2 = await post(env, a, 'second, to be hidden');
  const p3 = await post(env, a, 'third, to be deleted');
  const r1 = await post(env, b, 'on first', p1.id);
  const r2 = await post(env, b, 'on second', p2.id);
  const r3 = await post(env, b, 'on third', p3.id);
  hide(env, p2.id);
  env.DB.raw.prepare('DELETE FROM messages WHERE id = ?').run(p3.id);
  const react = await call(env, 'POST', '/chat/react', { body: { messageId: r1.id, emoji: '🔥' }, token: a.token });
  assert.equal(react.status, 200);

  const list = await messages(env, 0, a.token);
  assert.deepEqual(list.map((m) => m.id), [p1.id, r1.id, r2.id, r3.id]); // p2 hidden, p3 gone
  for (const m of list) {
    assert.deepEqual(Object.keys(m), ['id', 'number', 'tier', 'text', 'created_at', 'reply_to', 'reply', 'reactions', 'mine']);
  }
  const byId = new Map(list.map((m) => [m.id, m]));
  assert.equal(byId.get(p1.id).reply_to, null);
  assert.equal(byId.get(p1.id).reply, null);
  assert.deepEqual(byId.get(r1.id).reply, { id: p1.id, number: 11, text: 'first' });
  assert.deepEqual(byId.get(r2.id).reply, { id: p2.id, hidden: true });
  assert.deepEqual(byId.get(r3.id).reply, { id: p3.id, hidden: true });
  assert.equal(byId.get(r2.id).reply_to, p2.id);
  assert.deepEqual(byId.get(r1.id).reactions, { '🔥': 1 });
  assert.deepEqual(byId.get(r1.id).mine, ['🔥']);

  const anon = await messages(env, r1.id);
  assert.deepEqual(anon.map((m) => m.id), [r2.id, r3.id]);
  assert.ok(anon.every((m) => !('mine' in m)));
  // A hidden parent's text and author leave through no field.
  const raw = JSON.stringify(anon);
  assert.ok(!raw.includes('second, to be hidden') && !raw.includes('third, to be deleted'), raw);
});

test('messages: a parent quoted in a reply is cut to 100 units', async () => {
  const env = makeEnv();
  const a = await member(13);
  const b = await member(14);
  const p = await post(env, a, ROCKET.repeat(80));
  const r = await post(env, b, 'nice', p.id);
  const got = (await messages(env)).find((m) => m.id === r.id);
  assert.deepEqual(got.reply, { id: p.id, number: 13, text: ROCKET.repeat(50) });
  assert.equal((await messages(env)).find((m) => m.id === p.id).text, ROCKET.repeat(80)); // the parent row itself is whole
});

// ---- GET /chat/replies --------------------------------------------------------
/** Rows straight into D1: [number, text, reply_to, hidden]. Returns the ids. */
function seed(env, rows) {
  const ins = env.DB.raw.prepare('INSERT INTO messages (number, wallet, tier, text, created_at, reply_to, hidden) VALUES (?, ?, ?, ?, ?, ?, ?)');
  return rows.map(([number, text, replyTo = null, hidden = 0], i) =>
    Number(ins.run(number, `w${number}`, 'founding', text, `2026-09-30T00:00:${String(i % 60).padStart(2, '0')}.000Z`, replyTo, hidden).lastInsertRowid));
}

test("replies: only others' visible replies to the member's visible messages, newest first, with exactly the contract fields", async () => {
  const env = makeEnv();
  const [mine1, mine2, mineHidden, theirs] = seed(env, [[21, 'mine 1'], [21, 'mine 2'], [21, 'mine hidden', null, 1], [22, 'theirs']]);
  const [r1, self, r2, onHidden, onTheirs, hiddenReply, r3] = seed(env, [
    [22, 'reply one', mine1],
    [21, 'answering myself', mine1],
    [23, 'reply two', mine2],
    [22, 'on a hidden one', mineHidden],
    [23, 'on theirs', theirs],
    [23, 'hidden reply', mine1, 1],
    [22, 'x'.repeat(250), mine2],
  ]);
  void self; void onHidden; void onTheirs; void hiddenReply;
  const r = await replies(env, 21, 0);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=30');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(Object.keys(r.body), ['latestId', 'count', 'replies']);
  assert.equal(r.body.count, 3);
  assert.equal(r.body.latestId, r3);
  assert.deepEqual(r.body.replies.map((x) => x.id), [r3, r2, r1]);
  for (const x of r.body.replies) assert.deepEqual(Object.keys(x), ['id', 'number', 'text', 'created_at', 'reply_to']);
  assert.deepEqual(r.body.replies[1], { id: r2, number: 23, text: 'reply two', created_at: r.body.replies[1].created_at, reply_to: mine2 });
  assert.equal(r.body.replies[0].text, 'x'.repeat(100));
  // Member 22 sees the reply on its message, not its own replies to 21.
  const t = await replies(env, 22, 0);
  assert.deepEqual([t.body.count, t.body.replies.map((x) => x.id)], [1, [onTheirs]]);
  // Nobody replied to 99.
  const none = await replies(env, 99, 0);
  assert.deepEqual(none.body, { latestId: 0, count: 0, replies: [] });
});

test("replies: since filters by reply id, latestId falls back to since, and a missing or empty since -> 400 'bad since'", async () => {
  const env = makeEnv();
  const [p] = seed(env, [[31, 'parent']]);
  const [a, b, c] = seed(env, [[32, 'a', p], [33, 'b', p], [32, 'c', p]]);
  let r = await replies(env, 31, a);
  assert.deepEqual([r.body.count, r.body.latestId, r.body.replies.map((x) => x.id)], [2, c, [c, b]]);
  r = await replies(env, 31, c);
  assert.deepEqual(r.body, { latestId: c, count: 0, replies: [] });
  r = await replies(env, 31, c + 500);
  assert.deepEqual(r.body, { latestId: c + 500, count: 0, replies: [] });
  r = await replies(env, 31, 0);
  assert.deepEqual([r.body.count, r.body.latestId], [3, c]);
  r = await replies(env, 31);
  assert.deepEqual([r.status, r.body], [400, { error: 'bad since' }]);
  r = await call(env, 'GET', '/chat/replies?to=31&since=');
  assert.deepEqual([r.status, r.body], [400, { error: 'bad since' }]);
});

test('replies: only the REPLIES_WINDOW newest message ids count; a lower since is raised to that edge, latestId still falls back to the since asked', async () => {
  assert.equal(REPLIES_WINDOW, 1000);
  const env = makeEnv();
  // ids: 1 parent, 2 a reply just outside the window, 3 a reply just inside it,
  // 4..1001 plain messages, 1002 the newest reply. Newest id 1002, edge 1002 - 1000 = 2.
  const [p, out, inside] = seed(env, [[61, 'parent'], [62, 'outside', 1], [63, 'inside', 1]]);
  seed(env, Array.from({ length: 998 }, (_, i) => [64, `plain ${i}`]));
  const [newest] = seed(env, [[62, 'newest', p]]);
  assert.deepEqual([p, out, inside, newest], [1, 2, 3, 1002]);
  let r = await replies(env, 61, 0);
  assert.deepEqual([r.body.count, r.body.latestId, r.body.replies.map((x) => x.id)], [2, newest, [newest, inside]]);
  r = await replies(env, 61, 1);
  assert.deepEqual([r.body.count, r.body.replies.map((x) => x.id)], [2, [newest, inside]]);
  r = await replies(env, 61, inside); // a since above the edge works as before
  assert.deepEqual([r.body.count, r.body.replies.map((x) => x.id)], [1, [newest]]);
  // Hidden rows still move the edge: it follows ids, not visible messages.
  seed(env, [[64, 'hidden plain', null, 1]]); // id 1003, edge 3: the reply at id 3 is out
  r = await replies(env, 61, 0);
  assert.deepEqual([r.body.count, r.body.latestId, r.body.replies.map((x) => x.id)], [1, newest, [newest]]);
  // A thousand newer messages push every reply to 61 out: nothing counts, and
  // latestId is the since asked with, not the edge.
  seed(env, Array.from({ length: REPLIES_WINDOW }, (_, i) => [64, `later ${i}`]));
  r = await replies(env, 61, 0);
  assert.deepEqual(r.body, { latestId: 0, count: 0, replies: [] });
  r = await replies(env, 61, inside);
  assert.deepEqual(r.body, { latestId: inside, count: 0, replies: [] });
});

test('replies: count stops at 99 and the list at the 20 newest', async () => {
  const env = makeEnv();
  const [p] = seed(env, [[41, 'popular']]);
  const ids = seed(env, Array.from({ length: 130 }, (_, i) => [42 + (i % 3), `r${i}`, p]));
  let r = await replies(env, 41, 0);
  assert.equal(r.body.count, 99);
  assert.equal(r.body.replies.length, 20);
  assert.equal(r.body.latestId, ids.at(-1));
  assert.deepEqual(r.body.replies.map((x) => x.id), ids.slice(-20).reverse());
  r = await replies(env, 41, ids.at(-51)); // 50 newer than since
  assert.deepEqual([r.body.count, r.body.replies.length, r.body.latestId], [50, 20, ids.at(-1)]);
});

test("replies: bad to or since -> 400 'bad to' / 'bad since', no query", async () => {
  const env = makeEnv();
  const q0 = env.DB.stats.queries;
  for (const qs of ['', 'to=', 'to=0', 'to=-1', 'to=1000001', 'to=abc', 'to=1.5', 'to=1e3', 'to=+5', 'to=%205', 'to=0x10', 'since=3']) {
    const r = await call(env, 'GET', `/chat/replies?${qs}`);
    assert.deepEqual([r.status, r.body], [400, { error: 'bad to' }], qs);
  }
  for (const qs of ['', 'since=', 'since=-1', 'since=abc', 'since=1.5', 'since=1e3', 'since=99999999999999999', 'since=%201']) {
    const r = await call(env, 'GET', `/chat/replies?to=5${qs ? `&${qs}` : ''}`);
    assert.deepEqual([r.status, r.body], [400, { error: 'bad since' }], qs);
  }
  assert.equal(env.DB.stats.queries, q0);
  for (const qs of ['to=1&since=0', 'to=1000000&since=0', 'to=007&since=0', 'to=5&since=9007199254740991']) {
    assert.equal((await call(env, 'GET', `/chat/replies?${qs}`)).status, 200, qs);
  }
});

test('replies: one query, searched by primary key (no full scan of messages, one lower bound on r.id); public (no token needed)', async () => {
  const env = makeEnv();
  const seen = [];
  const prepare = env.DB.prepare;
  env.DB.prepare = (sql) => { seen.push(sql); return prepare(sql); };
  const q0 = env.DB.stats.queries;
  const r = await replies(env, 5, 10);
  assert.equal(r.status, 200);
  assert.equal(env.DB.stats.queries - q0, 1);
  const plan = env.DB.raw.prepare(`EXPLAIN QUERY PLAN ${seen[0]}`).all(5, 10, 99, REPLIES_WINDOW).map((x) => x.detail);
  assert.ok(plan.every((d) => !/^SCAN /.test(d)), plan.join(' | '));
  assert.ok(plan.some((d) => /SEARCH r USING INTEGER PRIMARY KEY \(rowid>\?\)/.test(d)), plan.join(' | '));
  assert.ok(plan.some((d) => /SEARCH p USING INTEGER PRIMARY KEY \(rowid=\?\)/.test(d)), plan.join(' | '));
  // A second `r.id >` term would leave the walk bounded by since alone (the window only
  // filtering), so since and the window meet in one max() bound.
  assert.equal((seen[0].match(/r\.id >/g) ?? []).length, 1, seen[0]);
});

// ---- routing and the routes that did not change --------------------------------
test('index.js routes GET /chat/replies without auth; /chat/latest, /chat/report and /stats answer as before', async () => {
  const env = makeEnv();
  const a = await member(51);
  const b = await member(52);
  const [c, d] = [await member(53), await member(54)];
  const p = await post(env, a, 'parent');
  const r = await post(env, b, 'reply', p.id);
  const via = await worker.fetch(new Request(`http://lounge.test/chat/replies?to=51&since=0`), env);
  assert.equal(via.status, 200);
  assert.deepEqual((await via.json()).replies.map((x) => x.id), [r.id]);
  const latest = await call(env, 'GET', `/chat/latest?since=${p.id}`);
  assert.deepEqual(latest.body, { latestId: r.id, newCount: 1 });
  for (const m of [a, c, d]) {
    const rep = await call(env, 'POST', '/chat/report', { body: { messageId: r.id }, token: m.token });
    assert.deepEqual([rep.status, rep.body], [200, { ok: true }]);
  }
  assert.equal(env.DB.raw.prepare('SELECT hidden FROM messages WHERE id = ?').get(r.id).hidden, 1);
  assert.deepEqual((await replies(env, 51, 0)).body, { latestId: 0, count: 0, replies: [] }); // the hidden reply left
  assert.deepEqual((await messages(env)).map((m) => m.id), [p.id]);
  const stats = await worker.fetch(new Request('http://lounge.test/stats'), env);
  assert.deepEqual(await stats.json(), { total: 0, founding: 0 });
  const unknown = await call(env, 'GET', '/chat/nope', { token: a.token });
  assert.deepEqual([unknown.status, unknown.body], [404, { error: 'not found' }]);
  const noToken = await call(env, 'GET', '/chat/nope');
  assert.equal(noToken.status, 401);
});
