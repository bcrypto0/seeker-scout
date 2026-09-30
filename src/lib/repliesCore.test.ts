// src/lib/repliesCore.test.ts: `npm run test:app` (node --test; Node 24 strips the types).
// Lounge chat replies on the phone: tolerant parsing of reply_to / reply (an older
// server sends neither), the quote a bubble shows, the highlight rule (the worker's
// /chat/replies rule), GET /chat/replies with a fake fetch and with a fake XMLHttpRequest
// (the background task's transport), and the one reply alert.
// No network, no clock reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as r from './repliesCore.ts';
import type { RepliesPage } from './repliesCore.ts';

const ROCKET = String.fromCodePoint(0x1f680); // two UTF-16 units
const ELLIPSIS = String.fromCharCode(0x2026);

test('parseReplyTo: a positive safe integer, else null', () => {
  assert.equal(r.parseReplyTo(12), 12);
  for (const bad of [undefined, null, 0, -3, 1.5, '12', NaN, Infinity, 2 ** 53, {}]) {
    assert.equal(r.parseReplyTo(bad), null, String(bad));
  }
});

test('parseReplyRef: the two contract shapes, anything else null', () => {
  assert.deepEqual(r.parseReplyRef({ id: 5, number: 68, text: 'gm' }), { id: 5, number: 68, text: 'gm' });
  assert.deepEqual(r.parseReplyRef({ id: 5, hidden: true }), { id: 5, hidden: true });
  // A hidden parent never carries a number or text on the phone, even if sent.
  assert.deepEqual(r.parseReplyRef({ id: 5, hidden: true, number: 68, text: 'x' }), { id: 5, hidden: true });
  for (const bad of [null, undefined, 'x', 5, {}, { id: 0, number: 1, text: 'a' }, { id: 5, number: 68 },
    { id: 5, text: 'a' }, { id: 5, number: '68', text: 'a' }, { id: 5, hidden: 'yes' }]) {
    assert.equal(r.parseReplyRef(bad), null, JSON.stringify(bad));
  }
});

test('withReplyFields: an older server message gets reply_to null and reply null, other fields untouched', () => {
  const old = { id: 3, number: 7, tier: 'member', text: 'hi', created_at: 'x', reactions: { '🔥': 1 } };
  const out = r.withReplyFields(old);
  assert.deepEqual(out, { ...old, reply_to: null, reply: null });
  assert.equal(out.reactions, old.reactions);
});

test('withReplyFields: contract replies, hidden parents, and a reply that names another id', () => {
  assert.deepEqual(r.withReplyFields({ id: 9, reply_to: 4, reply: { id: 4, number: 2, text: 'q' } }), {
    id: 9, reply_to: 4, reply: { id: 4, number: 2, text: 'q' },
  });
  assert.deepEqual(r.withReplyFields({ id: 9, reply_to: 4, reply: { id: 4, hidden: true } }), {
    id: 9, reply_to: 4, reply: { id: 4, hidden: true },
  });
  // reply_to kept, the mismatched or malformed reply dropped (the list may still know the parent).
  assert.deepEqual(r.withReplyFields({ id: 9, reply_to: 4, reply: { id: 5, number: 2, text: 'q' } }).reply, null);
  assert.deepEqual(r.withReplyFields({ id: 9, reply_to: 4, reply: 'junk' }), { id: 9, reply_to: 4, reply: null });
  // No reply_to: any reply is ignored.
  assert.deepEqual(r.withReplyFields({ id: 9, reply_to: null, reply: { id: 4, number: 2, text: 'q' } }).reply, null);
});

test('oneLine: flattens whitespace, cuts on code points with an ellipsis', () => {
  assert.equal(r.oneLine('  hello\n\nthere\tfriend  '), 'hello there friend');
  assert.equal(r.oneLine(undefined), '');
  assert.equal(r.oneLine('abcdef', 6), 'abcdef');
  assert.equal(r.oneLine('abcdefg', 6), 'abcdef' + ELLIPSIS);
  assert.equal(r.oneLine('abc   defg', 4), 'abc' + ELLIPSIS); // no trailing space before the ellipsis
  // 10 rockets cut at 5 code points: 5 whole rockets, never half of one.
  const cut = r.oneLine(ROCKET.repeat(10), 5);
  assert.equal(cut, ROCKET.repeat(5) + ELLIPSIS);
  for (let i = 0; i < cut.length; i++) {
    const c = cut.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) assert.ok(cut.charCodeAt(i + 1) >= 0xdc00, 'high surrogate kept alone');
  }
  assert.equal(Array.from(r.oneLine('x'.repeat(200))).length, r.PREVIEW_CHARS + 1);
});

test('quoteFor: server parent, hidden parent, list fallback, locally reported parent, none', () => {
  const none = () => undefined;
  const no = () => false;
  assert.equal(r.quoteFor({ reply_to: null, reply: null }, none, no), null);
  assert.equal(r.quoteFor({}, none, no), null);
  assert.deepEqual(r.quoteFor({ reply_to: 4, reply: { id: 4, number: 68, text: 'a\nb' } }, none, no), {
    kind: 'shown', number: 68, preview: 'a b',
  });
  assert.deepEqual(r.quoteFor({ reply_to: 4, reply: { id: 4, hidden: true } }, none, no), { kind: 'hidden' });
  // No reply field (an optimistic copy from an older answer): the parent in the list.
  const list = new Map([[4, { number: 12, text: 'from the list' }]]);
  assert.deepEqual(r.quoteFor({ reply_to: 4, reply: null }, (id) => list.get(id), no), {
    kind: 'shown', number: 12, preview: 'from the list',
  });
  assert.equal(r.quoteFor({ reply_to: 5, reply: null }, (id) => list.get(id), no), null);
  // A parent this phone reported reads as hidden, whatever the server said.
  assert.deepEqual(
    r.quoteFor({ reply_to: 4, reply: { id: 4, number: 68, text: 'a' } }, none, (id) => id === 4),
    { kind: 'hidden' },
  );
});

test('repliesToMe: a visible parent by me, written by someone else', () => {
  const mine = { kind: 'shown', number: 7, preview: 'p' } as const;
  assert.equal(r.repliesToMe(68, mine, 7), true);
  assert.equal(r.repliesToMe(7, mine, 7), false); // answering yourself
  assert.equal(r.repliesToMe(68, { kind: 'shown', number: 8, preview: 'p' }, 7), false);
  assert.equal(r.repliesToMe(68, { kind: 'hidden' }, 7), false); // /chat/replies skips hidden parents too
  assert.equal(r.repliesToMe(68, null, 7), false);
  assert.equal(r.repliesToMe(68, mine, null), false); // number unknown: nothing highlighted
});

test('parseRepliesPage: newest first, ids above since only, count at least the list, capped', () => {
  const body = {
    latestId: 30,
    count: 3,
    replies: [
      { id: 20, number: 5, text: 'b', created_at: 't2', reply_to: 2 },
      { id: 30, number: 6, text: 'c', created_at: 't3', reply_to: 3 },
      { id: 10, number: 4, text: 'a', created_at: 't1', reply_to: 1 }, // at since: dropped
      { id: 25, number: 0, text: 'bad number' },
      null,
      'junk',
    ],
  };
  const p = r.parseRepliesPage(body, 10)!;
  assert.deepEqual(p.replies.map((x) => x.id), [30, 20]);
  assert.equal(p.latestId, 30);
  assert.equal(p.count, 3);
  assert.deepEqual(r.parseRepliesPage({ latestId: 7, count: 0, replies: [] }, 7), { latestId: 7, count: 0, replies: [] });
  // A latestId past the newest reply is not trusted: it would skip unshown replies.
  assert.equal(r.parseRepliesPage({ latestId: 999, count: 1, replies: [{ id: 12, number: 3, text: 'x' }] }, 10)!.latestId, 12);
  assert.equal(r.parseRepliesPage({ latestId: 999, count: 0, replies: [] }, 10)!.latestId, 10);
  // count below the list length, missing, or over the cap.
  assert.equal(r.parseRepliesPage({ count: 0, replies: [{ id: 12, number: 3, text: 'x' }] }, 0)!.count, 1);
  assert.equal(r.parseRepliesPage({ count: 5000, replies: [] }, 0)!.count, r.REPLIES_COUNT_CAP);
  // Missing optional fields.
  assert.deepEqual(r.parseRepliesPage({ replies: [{ id: 12, number: 3, text: 'x' }] }, 0)!.replies[0], {
    id: 12, number: 3, text: 'x', created_at: '', reply_to: 0,
  });
  for (const bad of [null, 'x', {}, { replies: 'no' }, { error: 'not authenticated' }]) {
    assert.equal(r.parseRepliesPage(bad, 0), null, JSON.stringify(bad));
  }
});

type Call = { url: string; init?: RequestInit };
const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('fetchRepliesWith: the contract URL, one call, parsed answer', async () => {
  const calls: Call[] = [];
  const f: r.FetchLike = async (url, init) => {
    calls.push({ url, init });
    return jsonRes(200, { latestId: 44, count: 1, replies: [{ id: 44, number: 68, text: 'yo', created_at: 't', reply_to: 40 }] });
  };
  const p = await r.fetchRepliesWith(f, 'https://lounge.test', 7, 40);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://lounge.test/chat/replies?to=7&since=40');
  assert.equal(calls[0].init?.method, undefined); // a plain GET
  assert.equal((calls[0].init?.headers as unknown), undefined); // no token, no extra header
  assert.deepEqual(p, { latestId: 44, count: 1, replies: [{ id: 44, number: 68, text: 'yo', created_at: 't', reply_to: 40 }] });
});

test('fetchRepliesWith: never throws; an older server, a 400, a network error, a bad body and a timeout are null', async () => {
  assert.equal(await r.fetchRepliesWith(async () => jsonRes(401, { error: 'not authenticated' }), 'b', 7, 0), null);
  assert.equal(await r.fetchRepliesWith(async () => jsonRes(400, { error: 'bad to' }), 'b', 7, 0), null);
  assert.equal(await r.fetchRepliesWith(async () => { throw new TypeError('Network request failed'); }, 'b', 7, 0), null);
  assert.equal(await r.fetchRepliesWith(async () => new Response('<html>', { status: 200 }), 'b', 7, 0), null);
  const hang: r.FetchLike = (_url, init) =>
    new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
  const t0 = Date.now();
  assert.equal(await r.fetchRepliesWith(hang, 'b', 7, 0, 30), null);
  assert.ok(Date.now() - t0 < 2000);
});

test('fetchRepliesWith: a bad number or since makes no request', async () => {
  let calls = 0;
  const f: r.FetchLike = async () => {
    calls++;
    return jsonRes(200, { latestId: 0, count: 0, replies: [] });
  };
  for (const [to, since] of [[0, 0], [1_000_001, 0], [1.5, 0], [7, -1], [7, 1.5], [7, NaN]] as const) {
    assert.equal(await r.fetchRepliesWith(f, 'b', to, since), null, `${to} ${since}`);
  }
  assert.equal(calls, 0);
  assert.equal(r.isLoungeNumber(1), true);
  assert.equal(r.isLoungeNumber(r.MAX_LOUNGE_NUMBER), true);
});

/** A stand-in XMLHttpRequest the test drives by hand, as the native side would. */
class FakeXhr {
  timeout = 0;
  status = 0;
  responseText = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  opened: [string, string, boolean] | null = null;
  timeoutAtSend = -1;
  sent = 0;
  open(method: string, url: string, async: boolean) {
    this.opened = [method, url, async];
  }
  send() {
    this.sent++;
    this.timeoutAtSend = this.timeout;
  }
  answer(status: number, body: string) {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

/** The promise's value after only microtasks have run (no timer, no I/O turn), else 'pending'. */
async function afterMicrotasks<T>(p: Promise<T>): Promise<T | 'pending'> {
  let out: T | 'pending' = 'pending';
  p.then((v) => (out = v));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return out;
}

test('fetchRepliesXhr: the contract URL, an async GET with the timeout set before send, settled with no timer', async () => {
  const x = new FakeXhr();
  const p = r.fetchRepliesXhr(() => x, 'https://lounge.test', 7, 40);
  assert.deepEqual(x.opened, ['GET', 'https://lounge.test/chat/replies?to=7&since=40', true]);
  assert.equal(x.sent, 1);
  assert.equal(x.timeoutAtSend, r.REPLIES_TIMEOUT_MS);
  assert.equal(await afterMicrotasks(p), 'pending');
  x.answer(200, JSON.stringify({ latestId: 44, count: 1, replies: [{ id: 44, number: 68, text: 'yo', created_at: 't', reply_to: 40 }] }));
  assert.deepEqual(await afterMicrotasks(p), {
    latestId: 44, count: 1, replies: [{ id: 44, number: 68, text: 'yo', created_at: 't', reply_to: 40 }],
  });
});

test('fetchRepliesXhr: never throws; an older server, a 400, an error, a native timeout, an abort and a bad body are null', async () => {
  const run = async (drive: (x: FakeXhr) => void) => {
    const x = new FakeXhr();
    const p = r.fetchRepliesXhr(() => x, 'b', 7, 0);
    drive(x);
    return afterMicrotasks(p);
  };
  assert.equal(await run((x) => x.answer(401, '{"error":"not authenticated"}')), null);
  assert.equal(await run((x) => x.answer(400, '{"error":"bad to"}')), null);
  assert.equal(await run((x) => x.onerror?.()), null);
  assert.equal(await run((x) => x.ontimeout?.()), null);
  assert.equal(await run((x) => x.onabort?.()), null);
  assert.equal(await run((x) => x.answer(200, '<html>')), null);
  // Settles once: a later event cannot change the answer.
  assert.equal(await run((x) => { x.onerror?.(); x.answer(200, '{"latestId":9,"count":1,"replies":[]}'); }), null);
  // A transport that throws while being set up.
  assert.equal(await r.fetchRepliesXhr(() => { throw new Error('no XMLHttpRequest'); }, 'b', 7, 0), null);
  const opens = new FakeXhr();
  opens.open = () => { throw new Error('bad url'); };
  assert.equal(await r.fetchRepliesXhr(() => opens, 'b', 7, 0), null);
});

test('fetchRepliesXhr: a bad number or since makes no request', async () => {
  let made = 0;
  const make = () => {
    made++;
    return new FakeXhr();
  };
  for (const [to, since] of [[0, 0], [1_000_001, 0], [1.5, 0], [7, -1], [7, 1.5], [7, NaN]] as const) {
    assert.equal(await r.fetchRepliesXhr(make, 'b', to, since), null, `${to} ${since}`);
  }
  assert.equal(made, 0);
});

test('alertSince: the larger of the last notified id and the last seen id', () => {
  assert.equal(r.alertSince(null, null), 0);
  assert.equal(r.alertSince(40, null), 40);
  assert.equal(r.alertSince(null, 55), 55);
  assert.equal(r.alertSince(40, 55), 55);
  assert.equal(r.alertSince(60, 55), 60);
});

const page = (count: number, replies: Array<[number, number, string]>): RepliesPage => ({
  latestId: replies.length ? replies[0][0] : 0,
  count,
  replies: replies.map(([id, number, text]) => ({ id, number, text, created_at: '', reply_to: 1 })),
});

test('replyAlertText: one reply names the member, more are counted, none is null', () => {
  assert.deepEqual(r.replyAlertText(page(1, [[44, 68, 'gm\nfriend']])), {
    title: 'The Lounge', body: '#68 replied to you: gm friend',
  });
  assert.deepEqual(r.replyAlertText(page(3, [[46, 5, 'c'], [45, 6, 'b'], [44, 68, 'a']])), {
    title: 'The Lounge', body: '3 new replies to you in the Lounge',
  });
  assert.equal(r.replyAlertText(page(99, [[46, 5, 'c']]))!.body, '99+ new replies to you in the Lounge');
  assert.equal(r.replyAlertText(page(0, [])), null);
  assert.equal(r.replyAlertText(page(2, [])), null); // a count with no reply to name: nothing to show
  const long = r.replyAlertText(page(1, [[44, 68, 'y'.repeat(150)]]))!.body;
  assert.equal(long, `#68 replied to you: ${'y'.repeat(r.ALERT_PREVIEW_CHARS)}${ELLIPSIS}`);
});

test('repliesLabel', () => {
  assert.equal(r.repliesLabel(1), '1 reply to you');
  assert.equal(r.repliesLabel(4), '4 replies to you');
  assert.equal(r.repliesLabel(99), '99+ replies to you');
});
