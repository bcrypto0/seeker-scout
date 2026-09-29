import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalTags, finishAggregate, hasHiddenLink, isCanonicalTs, isoWeek, isPackageId, previousWeek, sanitizeNote,
  settingOn, sharedStakeWeight, supersedes, tagsToMask, vouchMessage, weekBounds, weightFor,
} from '../src/vouch-lib.js';

const W = 'GZaWCBQgqGhhEEHQmmmJxDd98kSUbgLkjWf2iMUPj9jT';
const M = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
const TS = '2026-09-14T10:02:11.120Z';

test('vouch message bytes are exactly the documented lines', () => {
  const msg = vouchMessage({ wallet: W, mint: M, ts: TS, package: 'ag.jup.jupiter.android',
    verdict: 'works', tags: ['crashes', 'wallet_ok', 'wallet_ok'], note: 'Swap fine.' });
  assert.equal(msg,
    'Seeker Scout \u2014 Vouch\npurpose: vouch-v1\n' +
    `wallet: ${W}\nmint: ${M}\npackage: ag.jup.jupiter.android\nverdict: works\n` +
    'tags: wallet_ok,crashes\nnote: Swap fine.\n' + `ts: ${TS}`);
  // 'Seeker Scout ' is 13 bytes, so the U+2014 (E2 80 94) occupies bytes 13..15.
  assert.equal(new TextEncoder().encode(msg).slice(13, 16).join(','), '226,128,148');
});
test('empty tags and note render as "-" and never leave a trailing space', () => {
  const msg = vouchMessage({ wallet: W, mint: M, ts: TS, package: 'x.place', verdict: 'broken', tags: [], note: '' });
  assert.match(msg, /\ntags: -\nnote: -\nts: /);
  assert.ok(!/ \n/.test(msg));
});
test('tags canonicalise through the bitmask', () => {
  assert.equal(tagsToMask(['needs_update', 'bogus', 'wallet_ok']), 5);
  assert.equal(canonicalTags(['needs_update', 'wallet_ok']), 'wallet_ok,needs_update');
  assert.equal(canonicalTags(undefined), '-');
});
test('package ids', () => {
  for (const ok of ['x.place', 'com.storj_mobile', 'fun.cfl.www.twa', 'com.bluntbrain.NearMe']) assert.ok(isPackageId(ok), ok);
  for (const bad of ['jupiter', '.a.b', 'a..b', 'a.b/c', '1a.b', 'a.b\n', 'x'.repeat(170) + '.y']) assert.ok(!isPackageId(bad), bad);
});
test('ts must be the canonical toISOString form', () => {
  assert.ok(isCanonicalTs('2026-09-14T10:02:11.120Z'));
  for (const bad of ['2026-09-14T10:02:11Z', '2026-09-14T10:02:11.120+00:00', '2026-09-14 10:02:11.120Z',
                     '2026-13-45T10:02:11.120Z', '2026-09-14T10:02:11.1200Z', 42, undefined,
                     // TS_RE-shaped, but Date.parse rolls them forward, so string order would lie
                     '2026-02-30T00:00:00.000Z', '2026-04-31T23:59:00.000Z', '2026-09-11T24:00:00.000Z']) {
    assert.ok(!isCanonicalTs(bad), String(bad));
  }
});
test('sanitizeNote strips links, collapses whitespace, is idempotent, caps at 140', () => {
  const s = sanitizeNote('  great   app  see https://evil.ru/x or t.me/abc or 1.2.3.4:80 ');
  assert.equal(s, 'great app see [link removed] or [link removed] or [link removed]');
  assert.equal(sanitizeNote(s), s);
  assert.equal(sanitizeNote('a'.repeat(200)).length, 140);
  assert.equal(sanitizeNote('U.S. rate 3.5 fine'), 'U.S. rate 3.5 fine'); // chat.js:39-41 rule
  assert.equal(sanitizeNote(42), '');
});
test('hasHiddenLink sees the links the ASCII passes miss and leaves real prose alone', () => {
  const wide = (s) => [...s].map((ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join('');
  const c = (cp) => String.fromCodePoint(cp);
  // Every look-alike separator on its own: Unicode's confusables (17.0.0) for FULL STOP, MIDDLE DOT,
  // SOLIDUS and COLON, the forms NFKD folds included, plus the table's additions.
  const dots = [0x3002, 0xff61, 0xfe12, 0xff0e, 0xfe52, 0x2024, 0x06d4, 0x2e33, 0x0660, 0x06f0, 0x0701, 0x0702,
    0xa4f8, 0xa60e, 0x10a50, 0x1d16d, 0x00b7, 0x0387, 0x1427, 0x16eb, 0x2022, 0x2027, 0x2219, 0x22c5, 0x2e31,
    0x30fb, 0xff65, 0xa78f, 0x10101];
  const slashes = [0x1735, 0x2041, 0x2044, 0x2215, 0x2571, 0x27cb, 0x29f8, 0x1d23a, 0x31d3, 0x3033, 0x2cc6,
    0x2cc7, 0x30ce, 0x4e3f, 0x2f03, 0xff0f];
  const colons = [0x02d0, 0x02f8, 0x0589, 0x05c3, 0x0703, 0x0704, 0x0903, 0x0a83, 0x16ec, 0x1803, 0x1809,
    0x205a, 0x2236, 0xa4fd, 0xa789, 0x11dd9, 0x1361, 0x1804, 0xff1a, 0xfe13, 0xfe55];
  for (const note of [
    'v2 moved to jupdrop\u034f\u3002com',  // a combining mark next to U+3002, on either side
    'v2 moved to jupdrop\u3002\u034fcom',
    'v2 moved to jupdrop\ufe0f\u3002com',  // a variation selector, also a mark
    'v2 moved to jupdrop\u3002\ufe0fcom',
    'v2 moved to jupdrop\u1160\u3002com',  // a Hangul filler next to U+3002
    'v2 moved to jupdrop\u3002\u3164com',
    'v2 moved to jupdrop\u3002\u3002com',  // two U+3002 in a row
    'v2 moved to jupdrop\u3002com',        // U+3002 alone
    'v2 moved to jupdrop\uff61\u034fcom',  // halfwidth ideographic full stop and a mark
    'v2 moved to jupdrop\u200b.com',       // a zero-width space inside the domain
    'v2 moved to jup\u200bdrop\u3002com',
    'v2 moved to jupdrop\uff0ecom',        // fullwidth full stop
    `go to ${wide('jupdrop')}.com`,        // fullwidth letters
    'v2 moved to jupdrop\u2024com',        // one dot leader
    'claim at https:\u2215\u2215jupdrop',  // division slashes for '//'
    'node at \uff11.2.3.4',                // a fullwidth digit in an IPv4 address
    'v2 live at jupdrop\u22c5com try it',  // dot operator
    'claim at t\u2219me now',              // bullet operator in a two-letter domain
    'node 1\u22c52\u22c53\u22c54:80',      // dot operators in an IPv4 address
    'https\ua789//jupdrop\u22c5com',       // modifier-letter colon and a dot operator
    'https\u2236\u2571\u2571jupdrop\u22c5com', // ratio, box-drawing slashes, dot operator
    'moved to jupdrop\u0301.com',          // an accent NFKC would fold into the p before the dot
    'moved to jupdro\u1e55.com',           // the same letter, precomposed
    'join \u202ecba/em.t',             // a right-to-left override reverses a one-letter TLD into view
    'x \u2066fine\u2069',                  // bidi isolates: refused on sight, link or not
    ...dots.map((cp) => `moved to jupdrop${c(cp)}com`),
    ...slashes.map((cp) => `claim at https:${c(cp)}${c(cp)}jupdrop`),
    ...colons.map((cp) => `claim at https${c(cp)}//jupdrop`),
  ]) {
    assert.equal(sanitizeNote(note), note, `the ASCII passes already catch ${JSON.stringify(note)}`);
    assert.equal(hasHiddenLink(note), true, JSON.stringify(note));
  }
  for (const note of [
    'U.S. rate 3.5 fine', 'v2.1 works', 'e.g. swap is fine.', '[link removed] then fine',
    // Japanese: a sentence ends in U+3002 and more Japanese follows
    '\u826f\u3044\u30a2\u30d7\u30ea\u3067\u3059\u3002\u30b9\u30ef\u30c3\u30d7\u3082\u901f\u3044\u3002',
    // Chinese: U+3002, then Latin
    '\u5f88\u597d\u7528\u3002Jupiter swap works',
    // Korean with U+3002
    '\uc798 \ub3fc\uc694\u3002\ucd94\ucc9c\ud569\ub2c8\ub2e4',
    // Arabic, one sentence with a tanween mark and one word with harakat
    '\u064a\u0639\u0645\u0644 \u062c\u064a\u062f\u064b\u0627 \u0639\u0644\u0649 \u0633\u064a\u0643\u0631',
    '\u0645\u064e\u0631\u062d\u064e\u0628\u0627 5',
    // Urdu with its full stop (U+06D4) before a space; Arabic-Indic digits with a zero (U+0660)
    '\u06cc\u06c1 \u0627\u06cc\u067e \u0627\u0686\u06be\u06cc \u06c1\u06d2\u06d4 \u0634\u06a9\u0631\u06cc\u06c1',
    '\u0662\u0660\u0662\u0666 \u0645\u0645\u062a\u0627\u0632',
    // bullets between spaced words; accented letters before a full stop and a space
    'Swap \u2022 stake \u2022 send', 'Tr\u00e8s bien. Merci', 'Est\u00e1 bien. Gracias',
    // emoji with a ZWJ, emoji with a variation selector
    '\ud83d\udc68\u200d\ud83d\udcbb works great', '\u2764\ufe0f works',
    // the ellipsis character, before a space and between two words
    'Fast\u2026 but the swap screen lags', 'Loads\u2026then works',
    // Arabic with a right-to-left MARK (U+200F), which is not an override
    '\u0634\u0643\u0631\u0627 \u200fok',
    // Vietnamese, fullwidth OK
    'Ti\u1ebfng Vi\u1ec7t ok', '\uff2f\uff2b on my Seeker',
  ]) {
    assert.equal(sanitizeNote(note), note, `sanitizeNote changed ${JSON.stringify(note)}`);
    assert.equal(hasHiddenLink(note), false, JSON.stringify(note));
  }
  for (const other of [42, null, undefined, '']) assert.equal(hasHiddenLink(other), false);
  // Printable ASCII: every fixed point of the ASCII passes is also clean for hasHiddenLink.
  const pool = ['a', 'Z', '7', '.', ' ', '/', ':', '-', 'e', 'www', 'http://', 'com', '2.3', 'io', 'U.S.', '...', '[', ']'];
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  let checked = 0;
  for (let i = 0; i < 3000; i++) {
    let s = '';
    for (let j = 0, n = Math.floor(rnd() * 60); j < n; j++) s += pool[Math.floor(rnd() * pool.length)];
    const once = sanitizeNote(s);
    if (sanitizeNote(once) !== once) continue; // the corner sanitizeNote's comment names; the worker 400s it
    checked += 1;
    assert.equal(hasHiddenLink(once), false, JSON.stringify(once));
  }
  assert.ok(checked > 2900, `only ${checked} fixed points`);
});
test('weight curve reference points', () => {
  const table = [[0, 1], [100, 1.3], [1000, 2.04], [10000, 3], [11355.88, 3.06], [99900, 4], [1e9, 4]];
  for (const [skr, w] of table) assert.equal(weightFor(skr), w, String(skr));
  for (const bad of [null, undefined, NaN, -5, 'x', Infinity]) assert.equal(weightFor(bad), 1);
});
test('one stake backs one voice: n Genesis Tokens in one wallet split the stake', () => {
  assert.equal(sharedStakeWeight(99900, 1), 4);
  assert.equal(sharedStakeWeight(99900, 2), 3.7);      // 2 x 3.70 = 7.40, not 8.00
  assert.equal(sharedStakeWeight(99900, 4), 3.4);      // weightFor(24975)
  assert.equal(sharedStakeWeight(11355.88, 1), 3.06);  // the demo wallet
  assert.equal(sharedStakeWeight(11355.88, 0), 3.06);  // n <= 0 counts as 1
  assert.equal(sharedStakeWeight(null, 3), 1);
});
test('chip thresholds: no amount of SKR passes alone', () => {
  const row = (voices, works_voices, weight_works, weight_broken = 0) =>
    finishAggregate({ package: 'p', voices, works_voices, weight_works, weight_broken, wallet_ok_voices: 0 });
  assert.equal(row(1, 1, 4).works_on_seeker, false);       // one 4x whale
  assert.equal(row(2, 2, 8).works_on_seeker, false);       // two whales
  assert.equal(row(3, 3, 3).works_on_seeker, true);        // three 1x owners
  assert.equal(row(3, 2, 2, 4).works_on_seeker, false);    // weight 2, pct 67
  assert.equal(row(4, 3, 3, 4).works_on_seeker, false);    // pct 75 (head count)
  assert.equal(row(5, 4, 4, 4).works_on_seeker, true);     // pct 80
  assert.equal(row(4, 3, 3, 4).works_pct, 75);
});
test('ISO weeks in UTC', () => {
  const t = [['2026-09-10T12:00:00Z', '2026-W37'], ['2026-09-13T23:59:59Z', '2026-W37'], ['2026-09-14T00:00:00Z', '2026-W38'],
             ['2026-09-28T00:00:00Z', '2026-W40'], ['2026-10-04T23:59:59Z', '2026-W40'], ['2026-10-05T00:00:00Z', '2026-W41'],
             ['2026-01-01T00:00:00Z', '2026-W01'], ['2026-12-31T00:00:00Z', '2026-W53']];
  for (const [iso, wk] of t) assert.equal(isoWeek(new Date(iso)), wk, iso);
  assert.deepEqual(weekBounds(new Date('2026-09-30T15:00:00Z')), { start: '2026-09-28T00:00:00.000Z', end: '2026-10-05T00:00:00.000Z' });
  assert.equal(previousWeek(new Date('2026-10-05T09:00:00Z')), '2026-W40');
});
test('monotonic guard is the same string compare SQLite makes', () => {
  assert.ok(supersedes('2026-09-14T10:02:12.000Z', '2026-09-14T10:02:11.000Z'));
  assert.ok(!supersedes('2026-09-14T10:02:11.000Z', '2026-09-14T10:02:11.000Z'));
  assert.ok(!supersedes('2026-09-14T10:02:10.000Z', '2026-09-14T10:02:11.000Z'));
  assert.ok(supersedes('2026-09-14T10:02:10.000Z', 'garbage'));
  assert.ok(!supersedes('2026-09-14T10:02:12Z', '2026-09-14T10:02:11.000Z')); // non-canonical never supersedes
});
test('one reading of a settings row for the kill switch and GET /flags', () => {
  assert.equal(settingOn('1', false), true);
  for (const off of ['0', 'false', 'off', 'true', '', ' 1']) assert.equal(settingOn(off, true), false, off);
  assert.equal(settingOn(undefined, true), true);
  assert.equal(settingOn(null, false), false);
});
// The vote message and tally tests join this file with the vote commit (SPEC 8.5).
