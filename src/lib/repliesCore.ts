/**
 * Lounge chat replies, the pure half: tolerant parsing of the reply fields,
 * the quote a bubble shows, the one-line preview, GET /chat/replies with
 * its transport injected (fetch in the open app, XMLHttpRequest in the
 * background task), and the reply alert's text.
 *
 * No React Native import and no relative import, so `npm run test:app`
 * loads it with Node's type stripping (like vouchCore.ts and skr.ts).
 *
 * Contract: the worker's src/chat.js and migrations/003_chat_replies.sql.
 * - Every message read carries reply_to (an id or null) and reply: null,
 *   {id, number, text} (the parent's text cut to 100 UTF-16 units) or
 *   {id, hidden: true} once the parent is hidden.
 * - POST /chat/send takes {text, reply_to?}; a reply_to that is not a
 *   visible message's id answers 400 {"error":"bad reply"}.
 * - GET /chat/replies?to=<number>&since=<id> (public) answers {latestId,
 *   count (capped at 99), replies: up to 20, newest first}.
 * An older server sends none of the reply fields and answers 401 on
 * /chat/replies, so every reader here treats a missing field as "no reply"
 * and a failed call as "nothing to show", never as an error on screen.
 */

export type ReplyRef =
  | { id: number; hidden: true }
  | { id: number; hidden?: false; number: number; text: string };

export type ReplyItem = {
  id: number;
  number: number;
  text: string;
  created_at: string;
  reply_to: number;
};

export type RepliesPage = {
  /** The newest reply id in this answer, or the `since` asked with. */
  latestId: number;
  /** Replies newer than `since`, at most REPLIES_COUNT_CAP. */
  count: number;
  /** Newest first, at most 20. */
  replies: ReplyItem[];
};

/** What a replied message shows above its text. */
export type Quote = { kind: 'hidden' } | { kind: 'shown'; number: number; preview: string };

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const MAX_LOUNGE_NUMBER = 1_000_000;
export const REPLIES_COUNT_CAP = 99;
/** Code points in a quote or a composer preview. */
export const PREVIEW_CHARS = 60;
/** Code points in a notification's preview. */
export const ALERT_PREVIEW_CHARS = 80;
export const REPLIES_TIMEOUT_MS = 8_000;

const isPosInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** A founding number the worker's /chat/replies accepts (1..1,000,000). */
export function isLoungeNumber(n: unknown): n is number {
  return isPosInt(n) && n <= MAX_LOUNGE_NUMBER;
}

/** messages[].reply_to: a positive id, else null (older servers send nothing). */
export function parseReplyTo(raw: unknown): number | null {
  return isPosInt(raw) ? raw : null;
}

/** messages[].reply: {id, number, text}, {id, hidden: true} or null; anything else is null. */
export function parseReplyRef(raw: unknown): ReplyRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isPosInt(r.id)) return null;
  if (r.hidden === true) return { id: r.id, hidden: true };
  if (!isPosInt(r.number) || typeof r.text !== 'string') return null;
  return { id: r.id, number: r.number, text: r.text };
}

/**
 * A message as read from the server, with reply_to and reply normalised:
 * reply_to is an id or null, and reply is kept only when it describes that
 * same id. Every other field passes through untouched.
 */
export function withReplyFields<T extends object>(
  raw: T,
): T & { reply_to: number | null; reply: ReplyRef | null } {
  const r = raw as Record<string, unknown>;
  const replyTo = parseReplyTo(r.reply_to);
  const ref = replyTo === null ? null : parseReplyRef(r.reply);
  return { ...raw, reply_to: replyTo, reply: ref && ref.id === replyTo ? ref : null };
}

/**
 * `text` on one line (every run of whitespace, newlines included, becomes
 * one space) and at most `max` code points, with an ellipsis when cut. It
 * cuts between code points, so an emoji is never split in half.
 */
export function oneLine(text: unknown, max: number = PREVIEW_CHARS): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const cps = Array.from(flat);
  if (cps.length <= max) return flat;
  return cps.slice(0, Math.max(1, max)).join('').trimEnd() + '…';
}

type ReplyFields = { reply_to?: number | null; reply?: ReplyRef | null };

/**
 * The quote above a reply. The parent the server described wins; without
 * one (an older answer, an optimistic copy) a parent still in the list is
 * used. A parent this phone reported (and so hid) reads as hidden, like a
 * parent the server hid. No reply_to, or nothing known about the parent:
 * no quote.
 */
export function quoteFor(
  msg: ReplyFields,
  localParent: (id: number) => { number: number; text: string } | undefined,
  hiddenHere: (id: number) => boolean,
): Quote | null {
  const id = msg.reply_to;
  if (typeof id !== 'number') return null;
  if (hiddenHere(id)) return { kind: 'hidden' };
  const ref = msg.reply;
  if (ref && ref.hidden) return { kind: 'hidden' };
  if (ref && !ref.hidden) return { kind: 'shown', number: ref.number, preview: oneLine(ref.text) };
  const p = localParent(id);
  return p ? { kind: 'shown', number: p.number, preview: oneLine(p.text) } : null;
}

/**
 * True when `msg` answers a visible message by `me` and was not written by
 * `me` (the worker's /chat/replies rule, so the highlight and the badge
 * agree).
 */
export function repliesToMe(msgNumber: number, quote: Quote | null, me: number | null): boolean {
  return me !== null && msgNumber !== me && quote?.kind === 'shown' && quote.number === me;
}

/** The GET /chat/replies answer, or null when it is not one. Replies at or below `since` are dropped. */
export function parseRepliesPage(body: unknown, since: number): RepliesPage | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.replies)) return null;
  const replies: ReplyItem[] = [];
  for (const raw of b.replies) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (!isPosInt(r.id) || r.id <= since || !isPosInt(r.number) || typeof r.text !== 'string') continue;
    replies.push({
      id: r.id,
      number: r.number,
      text: r.text,
      created_at: typeof r.created_at === 'string' ? r.created_at : '',
      reply_to: isPosInt(r.reply_to) ? r.reply_to : 0,
    });
  }
  replies.sort((a, b2) => b2.id - a.id);
  const told = typeof b.count === 'number' && Number.isSafeInteger(b.count) && b.count >= 0 ? b.count : 0;
  const count = Math.min(REPLIES_COUNT_CAP, Math.max(told, replies.length));
  // Worked out from the replies themselves: a latestId past the newest
  // reply would skip replies nobody was shown.
  const latestId = replies.length ? Math.max(since, replies[0].id) : since;
  return { latestId, count, replies };
}

const validAsk = (to: number, since: number) =>
  isLoungeNumber(to) && Number.isSafeInteger(since) && since >= 0;
const repliesUrl = (base: string, to: number, since: number) =>
  `${base}/chat/replies?to=${to}&since=${since}`;

/**
 * GET /chat/replies?to=&since= with one timeout, for the open app (the
 * badge). Never throws and never retries: any failure (network, timeout,
 * an older server's 401, a body that is not the contract) is null.
 */
export async function fetchRepliesWith(
  f: FetchLike,
  base: string,
  to: number,
  since: number,
  timeoutMs: number = REPLIES_TIMEOUT_MS,
): Promise<RepliesPage | null> {
  if (!validAsk(to, since)) return null;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await f(repliesUrl(base, to, since), { signal: c.signal });
    if (!res.ok) return null;
    return parseRepliesPage(await res.json(), since);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

type XhrHandler = ((ev: never) => unknown) | null;

/** The part of XMLHttpRequest that fetchRepliesXhr uses (tests pass a fake). */
export type XhrLike = {
  timeout: number;
  readonly status: number;
  readonly responseText: string;
  onload: XhrHandler;
  onerror: XhrHandler;
  ontimeout: XhrHandler;
  onabort: XhrHandler;
  open(method: string, url: string, async: boolean): void;
  send(): void;
};

/**
 * The same GET for the background task, over a bare XMLHttpRequest.
 * React Native's fetch settles its promise inside setTimeout(0), and JS
 * timers do not run while Android runs a background task with the app
 * closed, so a fetch there stalls until the app is next opened. XHR events
 * come straight from the native side and xhr.timeout is enforced there
 * (OkHttp's call timeout), so this path uses no JS timer at all.
 * Never throws and never retries: any failure is null.
 */
export function fetchRepliesXhr(
  makeXhr: () => XhrLike,
  base: string,
  to: number,
  since: number,
  timeoutMs: number = REPLIES_TIMEOUT_MS,
): Promise<RepliesPage | null> {
  if (!validAsk(to, since)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (p: RepliesPage | null) => {
      if (settled) return;
      settled = true;
      resolve(p);
    };
    const fail = () => done(null);
    try {
      const x = makeXhr();
      x.onload = () => {
        if (x.status < 200 || x.status > 299) return fail();
        try {
          done(parseRepliesPage(JSON.parse(x.responseText), since));
        } catch {
          fail();
        }
      };
      x.onerror = fail;
      x.ontimeout = fail;
      x.onabort = fail;
      x.open('GET', repliesUrl(base, to, since), true);
      x.timeout = timeoutMs;
      x.send();
    } catch {
      fail();
    }
  });
}

/** Where the background check starts: after the last reply it notified and after what the chat already showed. */
export function alertSince(notified: number | null, seen: number | null): number {
  return Math.max(0, notified ?? 0, seen ?? 0);
}

/** One notification for a page of new replies, or null when there is nothing new. */
export function replyAlertText(page: RepliesPage): { title: string; body: string } | null {
  const n = Math.max(page.count, page.replies.length);
  if (n < 1 || !page.replies.length) return null;
  if (n === 1) {
    const r = page.replies[0];
    return { title: 'The Lounge', body: `#${r.number} replied to you: ${oneLine(r.text, ALERT_PREVIEW_CHARS)}` };
  }
  const shown = n >= REPLIES_COUNT_CAP ? `${REPLIES_COUNT_CAP}+` : String(n);
  return { title: 'The Lounge', body: `${shown} new replies to you in the Lounge` };
}

/** "1 reply to you" / "3 replies to you" / "99+ replies to you". */
export function repliesLabel(count: number): string {
  if (count === 1) return '1 reply to you';
  return `${count >= REPLIES_COUNT_CAP ? `${REPLIES_COUNT_CAP}+` : count} replies to you`;
}
