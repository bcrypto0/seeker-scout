// src/lib/vouchCore.parity.test.ts: `npm run test:app`. The app's signed
// message and note rules against the LIVE worker's own file
// (lounge-worker/src/vouch-lib.js, imported as is): the same bytes for the
// fixtures and for a seeded random corpus of notes (non-ASCII, links,
// look-alikes, whitespace, bidi, long), tag lists and fields. A difference
// here is a 401 or a 400 on a real phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from './vouchCore.ts';
import * as w from '../../lounge-worker/src/vouch-lib.js';

const CORPUS_SIZE = 6000;
const SEED = 0x5eec3;

/** mulberry32: small, seeded, the same corpus on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ch = (...cps: number[]) => String.fromCodePoint(...cps);
const BS = String.fromCharCode(92);

const PIECES: string[] = [
  // prose and punctuation
  'Works', 'great', 'on', 'my', 'Seeker', 'swap', 'fine', 'crashes', 'after', 'update', 'U.S.', '3.5', 'v2.1',
  'e.g.', 'ok.', 'crashed...then', '-', '--', '[', ']', '(', ')', ',', ':', '/', '//', '.', '..', '?', '!', '#', '@',
  '"', "'", BS, '*', '_', '~', '%', '&',
  // whitespace of every kind the worker's whitespace class collapses, and some it does not
  ' ', '  ', ch(9), ch(10), ch(13), ch(11), ch(12), ch(0xa0), ch(0x1680), ch(0x2000), ch(0x200a), ch(0x2028),
  ch(0x2029), ch(0x202f), ch(0x205f), ch(0x3000), ch(0xfeff), ch(0x180e), ch(0x85),
  // links and link-shaped text
  'https://evil.ru/x', 'http://a.b', 'HTTPS://X.IO/Y', 'ftp://f.tp', 'tg://resolve', 'solana:abc', 'solana://pay',
  'www.site', 'WWW.x.y', 't.me/abc', 'jup.ag', 'x.io', 'x.io1.2.3.4', '1.2.3.4', '10.0.0.1:80', '255.255.255.255/p',
  'a-b.co.uk', 'bit.ly/z', 'foo.bar1', 'a.b.c.d', 'mail@x.com', 'x.com/', '[link removed]',
  // look-alike separators, zero-width, combining, fullwidth, bidi (hasHiddenLink's territory)
  ch(0x3002), ch(0xff0e), ch(0xff61), ch(0x2024), ch(0x22c5), ch(0x00b7), ch(0x2215), ch(0x2044), ch(0xa789),
  ch(0xff1a), ch(0x200b), ch(0x200c), ch(0x200d), ch(0x2060), ch(0x0301), ch(0x0307), ch(0x0130), ch(0xff41),
  ch(0xff4a, 0xff55, 0xff50), ch(0x202e), ch(0x202a), ch(0x2066), ch(0x2069), ch(0x115f), ch(0x3164), ch(0x2800),
  'jupdrop' + ch(0x3002) + 'com', 'x' + ch(0x200b) + '.io', 'caf' + ch(0xe9) + '.io',
  // other scripts, emoji, a lone surrogate
  'すごく良い', 'تطبيق رائع', 'Привет', '日本語テキスト', 'ñandú', ch(0x1f680), ch(0x1f44d, 0x1f3fd), ch(0xd83d),
  ch(0x1f1f8, 0x1f1e6),
];

function note(r: () => number): string {
  const n = 1 + Math.floor(r() * 14);
  let s = '';
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(r() * PIECES.length)];
  if (r() < 0.08) s = s.repeat(2 + Math.floor(r() * 12)); // past 140
  if (r() < 0.05) s = ' '.repeat(Math.floor(r() * 4)) + '-' + ' '.repeat(Math.floor(r() * 4));
  return s;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const key = (r: () => number) => Array.from({ length: 43 + Math.floor(r() * 2) }, () => B58[Math.floor(r() * 58)]).join('');
const PACKAGES = ['ag.jup.jupiter.android', 'x.place', 'com.storj_mobile', 'fun.cfl.www.twa', 'com.bilal.seekerscout'];
const TAG_POOL: unknown[] = ['wallet_ok', 'crashes', 'needs_update', 'bogus', 'constructor', '__proto__', 'toString', 1, null, ''];
function tags(r: () => number): unknown[] | undefined {
  if (r() < 0.05) return undefined;
  return Array.from({ length: Math.floor(r() * 6) }, () => TAG_POOL[Math.floor(r() * TAG_POOL.length)]);
}
const ts = (r: () => number) => new Date(Date.UTC(2026, 0, 1) + Math.floor(r() * 3e10)).toISOString();

const FIXTURES = [
  '', ' ', '-', ' - ', 'a', 'Works great on my Seeker.', '  great   app  see https://evil.ru/x or t.me/abc or 1.2.3.4:80 ',
  'U.S. rate 3.5 fine', 'x.io1.2.3.4', 'a'.repeat(200), 'b '.repeat(100), 'crashed...then worked', 'see jup.ag for more',
  'www.example', 'jupdrop' + ch(0x3002) + 'com', 'join ' + ch(0x202e) + 'cba/em.t', 'caf' + ch(0xe9) + '.io',
  ch(0x3000) + 'full width space' + ch(0x3000), 'line1' + ch(10) + 'line2', 'tab' + ch(9) + 'sep', ch(0x1f680).repeat(80),
];

/** True when every surrogate is paired (what D1 can store and give back unchanged). */
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const x = s.charCodeAt(i);
    if (x >= 0xd800 && x <= 0xdbff) {
      const y = s.charCodeAt(i + 1);
      if (!(y >= 0xdc00 && y <= 0xdfff)) return false;
      i++;
    } else if (x >= 0xdc00 && x <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** The regex lines of a function's source, trimmed: both copies must carry the same passes. */
function passes(fn: (...a: never[]) => unknown): string[] {
  return fn.toString().split(ch(10)).map((l) => l.trim()).filter((l) => l.includes('.replace(') || l.startsWith('const R ='));
}

test('source: normalizeNote carries the worker sanitizeNote passes line for line, and the same header escape', () => {
  const mine = passes(c.normalizeNote);
  assert.equal(mine.length, 7); // const R, the first collapse, four link passes, the final collapse and cut
  assert.deepEqual(mine, passes(w.sanitizeNote));
  const header = (fn: (...a: never[]) => unknown) => fn.toString().split(ch(10)).map((l) => l.trim()).filter((l) => l.includes('Seeker Scout'));
  assert.deepEqual(header(c.vouchMessage), header(w.vouchMessage));
  assert.equal(header(c.vouchMessage)[0], "'Seeker Scout " + BS + "u2014 Vouch',");
});

test('fixtures: normalizeNote === sanitizeNote, vouchMessage bytes identical, prepared notes pass the worker', () => {
  const W = 'GZaWCBQgqGhhEEHQmmmJxDd98kSUbgLkjWf2iMUPj9jT';
  const M = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
  for (const s of FIXTURES) {
    assert.equal(c.normalizeNote(s), w.sanitizeNote(s), JSON.stringify(s));
    const f = { wallet: W, mint: M, ts: '2026-09-29T10:02:11.120Z', package: 'x.place', verdict: 'works', tags: ['crashes', 'wallet_ok'], note: c.prepareNote(s) };
    assert.equal(c.vouchMessage(f), w.vouchMessage(f));
  }
  for (const x of [undefined, null, 42, {}, []]) assert.equal(c.normalizeNote(x), w.sanitizeNote(x));
});

test(`seeded corpus of ${CORPUS_SIZE}: identical bytes, accepted notes, a local check never stricter than the worker`, () => {
  const r = rng(SEED);
  const enc = new TextEncoder();
  let nonAscii = 0;
  let links = 0;
  let notFixed = 0;
  let workerHidden = 0;
  let clientBlocked = 0;
  for (let i = 0; i < CORPUS_SIZE; i++) {
    const raw = note(r);
    if (/[^ -~]/.test(raw)) nonAscii += 1;
    const n = c.normalizeNote(raw);
    assert.equal(n, w.sanitizeNote(raw), `normalizeNote #${i} ${JSON.stringify(raw)}`);
    if (n.includes('[link removed]')) links += 1;
    if (w.sanitizeNote(n) !== n) notFixed += 1;

    const t = tags(r);
    assert.equal(c.canonicalTags(t), w.canonicalTags(t), `tags #${i} ${JSON.stringify(t)}`);

    const p = c.prepareNote(raw);
    if (wellFormed(raw)) assert.ok(wellFormed(p), `lone surrogate #${i} ${JSON.stringify(raw)}`);
    // What the worker's parseVouchBody checks, in its order.
    assert.ok(p.length <= 140 && !p.includes(ch(10)) && !p.includes(ch(13)), `shape #${i}`);
    assert.notEqual(p, '-', `reserved #${i}`);
    assert.equal(w.sanitizeNote(p), p, `fixed point #${i} ${JSON.stringify(raw)}`);
    const hidden = w.hasHiddenLink(p);
    if (hidden) workerHidden += 1;
    if (c.noteBlockedLocally(p)) {
      clientBlocked += 1;
      assert.ok(hidden, `local check stricter than the worker #${i} ${JSON.stringify(p)}`);
    }

    const f = {
      wallet: key(r), mint: key(r), ts: ts(r), package: PACKAGES[Math.floor(r() * PACKAGES.length)],
      verdict: r() < 0.5 ? 'works' : 'broken', tags: t, note: r() < 0.5 ? p : n,
    };
    const a = c.vouchMessage(f);
    const b = w.vouchMessage(f);
    assert.equal(a, b, `message #${i}`);
    assert.deepEqual(enc.encode(a), enc.encode(b));
  }
  console.log(`corpus ${CORPUS_SIZE} (seed ${SEED}): ${nonAscii} with non-ASCII, ${links} with a stripped link, ` +
    `${notFixed} where one sanitize pass was not a fixed point (prepareNote fixed all), ` +
    `${workerHidden} prepared notes the worker's hasHiddenLink refuses, ${clientBlocked} of them caught locally, 0 caught locally that the worker accepts`);
  assert.ok(nonAscii > 1000 && links > 1000 && workerHidden > 100 && clientBlocked > 50, 'the corpus reaches every class');
});

test('links + emoji cut at 140: one sanitize pass can leave half an emoji, prepareNote never does, and the worker accepts it', () => {
  const EMOJI = [ch(0x1f680), ch(0x1f44d), ch(0x1f1f8)];
  let notes = 0;
  let halfCut = 0;
  for (let k = 0; k < 20; k++) {
    for (let j = 0; j < 140; j++) {
      for (const e of EMOJI) {
        for (const sep of [' ', '', 'x']) {
          const typed = ('x.io' + sep).repeat(k) + 'a'.repeat(j) + e.repeat(20);
          if (typed.length > 140) continue;
          notes += 1;
          if (!wellFormed(w.sanitizeNote(typed))) halfCut += 1;
          const p = c.prepareNote(typed);
          assert.ok(wellFormed(p), `lone surrogate ${JSON.stringify(typed)}`);
          assert.equal(w.sanitizeNote(p), p, `fixed point ${JSON.stringify(typed)}`);
          assert.equal(w.hasHiddenLink(p), false, `hidden link ${JSON.stringify(typed)}`);
        }
      }
    }
  }
  console.log(`link+emoji notes ${notes}: ${halfCut} where one sanitize pass leaves half an emoji; prepareNote: 0 lone surrogates, all accepted by the worker`);
  assert.ok(halfCut > 100, 'the generator reaches the cut');
});
