// src/lib/vouchCore.test.ts: `npm run test:app` (node --test; Node 24 strips the types).
// The pure half of Scout Vouch: message bytes, note rules, parsers, the
// sentence for every worker answer, UI copy, the flags last-good copy, the
// answer cache, and the sign-once retry loop against a scripted fetch. No
// network, no wallet. Parity with the worker's own file is in
// vouchCore.parity.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from './vouchCore.ts';
import type { KV, VouchResult } from './vouchCore.ts';

const W = 'GZaWCBQgqGhhEEHQmmmJxDd98kSUbgLkjWf2iMUPj9jT';
const M = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
const TS = '2026-09-29T10:02:11.120Z';
const NL = '\n';

test('vouch message: nine lines, the U+2014 header, tags in bit order', () => {
  const msg = v.vouchMessage({
    wallet: W, mint: M, ts: TS, package: 'ag.jup.jupiter.android',
    verdict: 'works', tags: ['crashes', 'wallet_ok', 'wallet_ok'], note: 'Swap fine.',
  });
  assert.equal(msg, [
    'Seeker Scout \u2014 Vouch', 'purpose: vouch-v1', `wallet: ${W}`, `mint: ${M}`,
    'package: ag.jup.jupiter.android', 'verdict: works', 'tags: wallet_ok,crashes', 'note: Swap fine.', `ts: ${TS}`,
  ].join(NL));
  // 'Seeker Scout ' is 13 bytes, so U+2014 (E2 80 94) sits at bytes 13..15.
  assert.equal(new TextEncoder().encode(msg).slice(13, 16).join(','), '226,128,148');
});

test('empty tags and note render as "-", never a trailing space', () => {
  const msg = v.vouchMessage({ wallet: W, mint: M, ts: TS, package: 'x.place', verdict: 'broken', tags: [], note: '' });
  assert.ok(msg.includes(`${NL}tags: -${NL}note: -${NL}ts: `));
  assert.ok(!msg.includes(` ${NL}`));
  assert.equal(v.canonicalTags(undefined), '-');
  assert.deepEqual(v.orderedTags(['needs_update', 'bogus', 'constructor', 'wallet_ok', 7, null]), ['wallet_ok', 'needs_update']);
});

test('normalizeNote strips links, collapses whitespace, caps at 140', () => {
  const s = v.normalizeNote('  great   app  see https://evil.ru/x or t.me/abc or 1.2.3.4:80 ');
  assert.equal(s, 'great app see [link removed] or [link removed] or [link removed]');
  assert.equal(v.normalizeNote(s), s);
  assert.equal(v.normalizeNote('a'.repeat(200)).length, 140);
  assert.equal(v.normalizeNote('U.S. rate 3.5 fine'), 'U.S. rate 3.5 fine');
  assert.equal(v.normalizeNote(42), '');
  assert.equal(v.normalizeNote('-'), '-'); // byte-identical to the worker, dash included
});

test('prepareNote reaches a fixed point and drops a lone dash', () => {
  // The worker's documented corner: one pass is not a fixed point here.
  assert.equal(v.normalizeNote('x.io1.2.3.4'), '[link removed]1.2.3.4');
  assert.equal(v.prepareNote('x.io1.2.3.4'), '[link removed][link removed]');
  const p = v.prepareNote('x.io1.2.3.4');
  assert.equal(v.normalizeNote(p), p);
  assert.equal(v.prepareNote('-'), '');
  assert.equal(v.prepareNote(`  -${NL} `), '');
  assert.equal(v.prepareNote('--'), '--');
  assert.equal(v.prepareNote('Works great, signs fast.'), 'Works great, signs fast.');
  // Link removal lengthens the note past 140 and the cut lands inside an emoji:
  // the lone first half is dropped, so what is signed is what D1 stores and shows.
  const rocket = String.fromCodePoint(0x1f680);
  const typed = 'x.io ' + 'a'.repeat(106) + rocket.repeat(10);
  assert.equal(typed.length, 131);
  const cut = v.normalizeNote(typed);
  assert.equal(cut.length, 140);
  assert.equal(cut.charCodeAt(139), 0xd83d); // one pass leaves half an emoji
  const prepared = v.prepareNote(typed);
  assert.equal(prepared, '[link removed] ' + 'a'.repeat(106) + rocket.repeat(9));
  assert.equal(v.normalizeNote(prepared), prepared);
});

test('the local note check refuses bidi controls only (never stricter than the worker)', () => {
  assert.equal(v.noteBlockedLocally('join ' + String.fromCharCode(0x202e) + 'cba/em.t'), true);
  assert.equal(v.noteBlockedLocally('a' + String.fromCharCode(0x2066) + 'b'), true);
  assert.equal(v.noteBlockedLocally('jupdrop' + String.fromCharCode(0x3002) + 'com'), false); // the worker refuses it
  assert.equal(v.noteBlockedLocally('Works on my Seeker'), false);
});

test('notePreview speaks only when signing changes the note', () => {
  assert.equal(v.notePreview('fine,   just  fine'), null);
  assert.equal(v.notePreview('see https://x.io now'), 'Links are removed. Your note will read: “see [link removed] now”');
  assert.equal(v.notePreview('-'), 'A lone dash means no note, so none is sent.');
  assert.equal(v.notePreview(''), null);
});

test('base58 matches the known encodings', () => {
  assert.equal(v.base58Encode(new Uint8Array(32)), '1'.repeat(32));
  assert.equal(v.base58Encode(new Uint8Array([0, 1])), '12');
  assert.equal(v.base58Encode(new Uint8Array([0xff])), '5Q');
});

const APP = {
  package: 'x.place', voices: 3, works_voices: 3, broken_voices: 0, weight_works: 3, weight_broken: 0,
  works_pct: 100, wallet_ok_voices: 2, last_vouch_at: TS, works_on_seeker: true,
};
function okBody(over: Record<string, unknown> = {}, vouch: Record<string, unknown> = {}) {
  return {
    ok: true, replayed: false, number: 12, tier: 'founding',
    vouch: {
      id: 7, package: 'x.place', verdict: 'works', tags: ['wallet_ok'], note: 'Fine.', weight: 1,
      staked_skr: null, signed_ts: TS, updated_at: TS, note_hidden: false, excluded: false, ...vouch,
    },
    weight: 1, staked_skr: null, weight_source: 'stub', mints_in_wallet: 1, app: APP, ...over,
  };
}

test('parsers keep good rows, drop bad ones, and read /vouch/mine as four fields', () => {
  const s = v.parseSummary(APP)!;
  // weight_works / weight_broken in the body are not kept: head counts only.
  assert.deepEqual(s, {
    package: 'x.place', voices: 3, worksVoices: 3, brokenVoices: 0,
    worksPct: 100, walletOkVoices: 2, worksOnSeeker: true, lastVouchAt: TS,
  });
  assert.equal(v.parseSummary({ voices: 3 }), null);
  const a = v.parseAppVouches({
    app: APP,
    recent: [
      { id: 1, verdict: 'works', tags: ['crashes', 'x'], note: 'ok', weight: 1, number: 3, tier: 'founding', updated_at: TS },
      { id: 'two', verdict: 'works' }, { id: 3, verdict: 'meh' }, null,
      { id: 4, verdict: 'broken', tags: 5, note: 9, number: null, tier: 'boss', updated_at: TS },
    ],
  })!;
  assert.equal(a.recent.length, 2);
  assert.deepEqual(a.recent[0].tags, ['crashes']);
  assert.deepEqual(
    [a.recent[1].note, a.recent[1].number, a.recent[1].tier, a.recent[1].tags],
    ['', null, null, []],
  );
  // The worker drops weight from public notes; an older worker still sends it. Neither is kept.
  assert.deepEqual(a.recent.map((n) => 'weight' in n), [false, false]);
  assert.equal(v.parseAppVouches({ recent: [] }), null);

  assert.deepEqual(
    v.parseMine({ vouches: [
      { package: 'x.place', verdict: 'works', note_hidden: false, excluded: false },
      { package: 'a.b', verdict: 'broken', note_hidden: true, excluded: 1 },
      { package: '', verdict: 'works' }, { verdict: 'works' },
    ] }),
    [
      { package: 'x.place', verdict: 'works', noteHidden: false, excluded: false },
      { package: 'a.b', verdict: 'broken', noteHidden: true, excluded: true },
    ],
  );
  assert.equal(v.parseMine({ vouches: 'x' }), null);
  assert.equal(v.parseMine(null), null);

  const top = v.parseTop({ week: '2026-W40', start: 'a', end: 'b', apps: [
    { ...APP, voices_week: 3, weight_works_week: 3 }, { ...APP, package: 'y.z', voices_week: 0 }, { voices_week: 2 },
  ] })!;
  assert.equal(top.week, '2026-W40');
  assert.deepEqual(top.apps.map((r) => [r.package, r.voicesWeek]), [['x.place', 3]]);
  assert.ok(top.apps.every((r) => !Object.keys(r).some((k) => /weight/i.test(k))), 'a weighted total was kept');
  assert.equal(v.parseTop({ apps: 'no' }), null);

  const r = v.parseResult(okBody())!;
  assert.equal(r.vouch.verdict, 'works');
  assert.equal(r.weightSource, 'stub');
  assert.equal(r.stakedSkr, null);
  assert.equal(r.number, 12);
  assert.equal(r.tier, 'founding');
  assert.equal(v.parseResult(okBody({ weight_source: 'magic', mints_in_wallet: 0 }))!.weightSource, 'unknown');
  assert.equal(v.parseResult(okBody({ weight_source: 'magic', mints_in_wallet: 0 }))!.mintsInWallet, 1);
  assert.equal(v.parseResult({ ok: true, vouch: { id: 1 } }), null);

  assert.deepEqual(v.parseFlags({ vouch: false, vote: true, stake: true, skr_read: true, withdraw: false }),
    { vouch: false, vote: true, stake: true, skrRead: true, withdraw: false });
  assert.deepEqual(v.parseFlags({ vouch: true }), { ...v.FLAG_DEFAULTS });
  assert.deepEqual(v.parseFlags({ vouch: true, withdraw: 'yes' })!.withdraw, false);
  assert.equal(v.parseFlags({ vouch: '1' }), null);
  assert.equal(v.parseFlags('<html>'), null);
});

test('every error string the worker returns has its own sentence, never raw server text', () => {
  const codes: [number, string][] = [
    [503, 'vouching is paused'], [503, 'busy, try again in a minute'], [429, 'slow down'],
    [409, 'superseded by a newer vouch from this Seeker'], [403, 'vouch limit reached'],
    [403, 'not a Seeker Genesis Token'], [403, 'wallet does not hold this token'], [403, 'account blocked'],
    [400, 'note contains a link or is not normalised'], [400, 'note reserved'],
    [400, 'note must be one line of at most 140 characters'], [400, 'verdict must be works or broken'],
    [400, 'tags must be an array'], [400, 'bad package id'], [400, 'bad wallet or mint'],
    [400, 'bad signature length'], [400, 'bad key or signature length'], [400, 'bad encoding'],
    [401, 'signature verification failed'], [400, 'bad ts'], [400, 'stale message'], [400, 'missing fields'],
    [400, 'bad json'], [400, 'bad body'], [413, 'body too large'], [500, 'storage error'],
    [500, 'vouch service error'], [404, 'not found'], [502, 'chain check unavailable'],
    [502, 'chain check unavailable: rpc 503'], [0, 'network'], [200, 'unexpected response'],
  ];
  for (const [status, code] of codes) {
    const m = v.vouchErrorMessage(status, code);
    assert.ok(m.length > 20 && m !== code && /[.]$/.test(m) && !m.includes(String.fromCharCode(0x2014)), `${code}: ${m}`);
    const e = v.vouchError(status, code);
    assert.equal(v.vouchErrorStatus(e), status);
    assert.equal(v.vouchErrorCode(e), code);
    assert.equal(e.message, m);
  }
  assert.equal(v.vouchErrorMessage(503, 'vouching is paused'), 'Vouching is paused. Try again later.');
  // An error page with no JSON code: the status picks the sentence, never "your vouch was sent".
  assert.equal(v.vouchErrorMessage(522, ''), 'The vouch service is busy. Try again in a minute.');
  assert.equal(v.vouchErrorMessage(429, ''), 'One vouch every 10 seconds. Give it a moment, then try again.');
  assert.equal(v.vouchErrorMessage(403, 'vouch limit reached'),
    'This Seeker has vouched for 50 apps, the most one Genesis Token can. You can still change the vouches you already made.');
  assert.equal(v.vouchErrorMessage(403, 'something new'), "This wallet can't vouch right now.");
  assert.equal(v.vouchErrorMessage(400, 'constructor'), 'Something went wrong sending your vouch. Try again.');
  assert.equal(v.vouchErrorMessage(418, ''), "Your vouch didn't go through (error 418). Try again.");
  assert.equal(v.vouchErrorStatus(new Error('x')), undefined);
});

function result(over: Partial<VouchResult> = {}): VouchResult {
  return { ...v.parseResult(okBody())!, ...over };
}

test('weight copy is honest in every state the worker answers', () => {
  const UNREAD = 'Your voice counts 1.00x because your SKR stake was not read.';
  const lines: [string, string][] = [
    // Before any signed answer: how weight works, no number of its own.
    [v.weightLine(null), 'Staked SKR can raise your voice up to 4x. Your stake is read when you sign.'],
    // 'stub': only a worker without the reader answers it.
    [v.weightLine(result()), UNREAD],
    [v.weightLine(result({ weightSource: 'chain', weight: 3.06, stakedSkr: 11355.88 })),
      'Your voice counts 3.06x on 11,355.88 SKR staked.'],
    [v.weightLine(result({ weightSource: 'cache', weight: 3.7, stakedSkr: 99900, mintsInWallet: 2 })),
      'Your voice counts 3.70x on 99,900.00 SKR staked, shared by 2 Seekers.'],
    [v.weightLine(result({ weightSource: 'chain', weight: 1, stakedSkr: 5 })), 'Your voice counts 1.00x on 5.00 SKR staked.'],
    // Nothing staked (SKR in an unstake cooldown reads as 0 too).
    [v.weightLine(result({ weightSource: 'chain', weight: 1, stakedSkr: 0 })), 'Your voice counts 1.00x with no SKR staked.'],
    [v.weightLine(result({ weightSource: 'cache', weight: 1, stakedSkr: 0, mintsInWallet: 3 })),
      'Your voice counts 1.00x with no SKR staked.'],
    [v.weightLine(result({ weightSource: 'chain', weight: 1, stakedSkr: null })), 'Your voice counts 1.00x.'],
    // About the vouch it served, never a forecast: the sheet shows it again above the next signature.
    [v.weightLine(result({ weightSource: 'error' })),
      "Your last vouch counts 1.00x: your SKR stake couldn't be read. Vouching again retries the read."],
    // A replay from D1 of a row no stake was read for (written before the reader, or a failed read).
    [v.weightLine(result({ weightSource: 'stored', weight: 1, stakedSkr: null })), `${UNREAD} Vouching again reads it.`],
    [v.weightLine(result({ weightSource: 'stored', weight: 2.04, stakedSkr: 1000 })), 'Your voice counts 2.04x.'],
    [v.weightLine(result({ weightSource: 'stored', weight: 2.04 })), 'Your voice counts 2.04x.'],
    [v.weightLine(result({ weightSource: 'stored', weight: 1, stakedSkr: 0 })), 'Your voice counts 1.00x.'],
    [v.weightLine(result({ weightSource: 'unknown', weight: 1.5, stakedSkr: 300 })), 'Your voice counts 1.50x.'],
  ];
  for (const [got, want] of lines) assert.equal(got, want);

  // One caption for every app: one that changed with the app's weights would say, on an
  // app with one voice, whether that owner stakes SKR.
  const captions: [string, string][] = [
    [v.WEIGHT_CAPTION,
      'Staked SKR, read when an owner vouches, can weigh a voice up to 4x in rankings. The numbers above count each Genesis Token once.'],
  ];
  for (const [got, want] of captions) assert.equal(got, want);
  assert.equal('weightCaption' in v || 'isFlatWeight' in v, false);

  // Plain copy: no em dash, no forward promise.
  for (const [got] of [...lines, ...captions]) {
    assert.equal(got.includes(String.fromCharCode(0x2014)), false, got);
    assert.doesNotMatch(got, /until|ships|never|guarantee|soon/i);
  }
});

test('chip hint, labels and the owner state merge', () => {
  const s = v.parseSummary(APP)!;
  assert.equal(v.chipHint(s), null);
  assert.equal(v.chipHint({ ...s, voices: 1, worksOnSeeker: false }), 'Needs 2 more owners to earn the Works on Seeker chip.');
  assert.equal(v.chipHint({ ...s, voices: 2, worksOnSeeker: false }), 'Needs 1 more owner to earn the Works on Seeker chip.');
  assert.equal(v.chipHint({ ...s, voices: 4, worksPct: 75, worksOnSeeker: false }),
    'The Works on Seeker chip needs 80% of owners saying it works.');
  assert.equal(v.tierLabel(12, 'founding'), 'Founder #12');
  assert.equal(v.tierLabel(140, 'early'), 'Pioneer #140');
  assert.equal(v.tierLabel(600, 'member'), 'Member #600');
  assert.equal(v.tierLabel(null, null), 'Seeker owner');
  assert.deepEqual(v.walletChip(1), { text: 'Wallet connect worked · 1', a11y: 'Wallet connect worked for 1 owner' });
  // works_pct is all-time on /vouch/top, so the row names its base.
  assert.equal(v.topRowMeta({ ...s, voicesWeek: 1 }), '1 owner this week · 100% of 3 owners say it works');
  assert.equal(v.topRowMeta({ ...s, voices: 2, worksPct: 50, voicesWeek: 2 }),
    '2 owners this week · 50% say it works'); // every vouch is this week's: the base is the same
  assert.equal(v.busyRetryLabel(10_500, 1_000), 'Busy right now. Retrying in 10 s…');
  assert.equal(v.busyRetryLabel(1_000, 1_000), 'Retrying…');
  assert.equal(v.busyRetryLabel(null), 'Retrying…');
  assert.equal(v.LIMIT_SENTENCE, v.vouchErrorMessage(403, 'vouch limit reached'));
  assert.equal(v.tagLabels(['needs_update', 'wallet_ok']), 'Wallet connect worked · Needs an update');

  const r = result();
  const row = { package: 'x.place', verdict: 'works' as const, noteHidden: false, excluded: false };
  assert.deepEqual(v.ownState([], r, 'x.place'), { kind: 'none' }); // the server read is the authority
  assert.equal(v.ownState([{ ...row, excluded: true }], r, 'x.place').kind, 'excluded');
  const mine = v.ownState([row], r, 'x.place');
  assert.ok(mine.kind === 'mine' && mine.detail?.note === 'Fine.');
  const older = v.ownState([{ ...row, verdict: 'broken' }], r, 'x.place');
  assert.ok(older.kind === 'mine' && older.verdict === 'broken' && older.detail === null);
  const offline = v.ownState(null, r, 'x.place');
  assert.ok(offline.kind === 'mine' && offline.detail !== null);
  assert.deepEqual(v.ownState(null, null, 'x.place'), { kind: 'none' });
  assert.deepEqual(v.ownState(null, r, 'other.app'), { kind: 'none' });
});

test('Lounge rows are catalog apps only, ranked after the filter; the 50-app check; the done copy', () => {
  const s = v.parseSummary(APP)!;
  const row = (pkg: string) => ({ ...s, package: pkg, voicesWeek: 1 });
  const catalog = new Map([['x.place', 'XPlace'], ['ag.jup.jupiter.android', 'Jupiter'], ['a.b', 'AB']]);
  const top = [row('www.claimseeker.com'), row('x.place'), row('jup.ag'), row('ag.jup.jupiter.android'), row('a.b')];
  assert.deepEqual(v.knownTopRows(top, (id) => catalog.get(id), 2).map((r) => [r.row.package, r.entry]),
    [['x.place', 'XPlace'], ['ag.jup.jupiter.android', 'Jupiter']]);
  assert.deepEqual(v.knownTopRows(top, () => undefined, 5), []);

  const mine = Array.from({ length: 50 }, (_, i) => ({ package: `p.a${i}`, verdict: 'works' as const, noteHidden: false, excluded: i === 0 }));
  assert.equal(v.atVouchLimit(mine, 'x.place'), true); // excluded rows count, as in the worker
  assert.equal(v.atVouchLimit(mine, 'p.a7'), false); // changing an existing vouch is always allowed
  assert.equal(v.atVouchLimit(mine.slice(1), 'x.place'), false);
  assert.equal(v.atVouchLimit(null, 'x.place'), false);

  const r = result();
  assert.deepEqual(v.vouchDoneCopy(r), { title: 'Recorded.', counts: true, lines: [v.weightLine(r)] });
  const excluded = result({ vouch: { ...r.vouch, excluded: true } });
  assert.deepEqual(v.vouchDoneCopy(excluded), { title: 'Saved.', counts: false,
    lines: ['Your vouch is saved but does not count: it was removed by the operator.'] });
  const hidden = result({ vouch: { ...r.vouch, noteHidden: true } });
  assert.deepEqual(v.vouchDoneCopy(hidden).lines,
    [v.weightLine(hidden), 'Your note stays hidden by moderation; your verdict counts.']);
});

function memKV(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, val) => {
      data.set(k, val);
    },
  };
}
const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('flags: live answer saved; a failed fetch returns the last good copy; defaults only on a first run', async () => {
  const kv = memKV();
  const first = await v.loadRemoteFlags({ base: 'http://x', fetch: async () => { throw new TypeError('offline'); } }, kv);
  assert.deepEqual(first, { flags: v.FLAG_DEFAULTS, source: 'defaults' });
  const live = await v.loadRemoteFlags({ base: 'http://x', fetch: async (u) => {
    assert.equal(u, 'http://x/flags');
    return jsonRes(200, { vouch: false, vote: true, stake: true, skr_read: true, withdraw: false });
  } }, kv);
  assert.deepEqual(live, { flags: { vouch: false, vote: true, stake: true, skrRead: true, withdraw: false }, source: 'live' });
  const offline = await v.loadRemoteFlags({ base: 'http://x', fetch: async () => { throw new TypeError('offline'); } }, kv);
  assert.deepEqual(offline, { flags: { vouch: false, vote: true, stake: true, skrRead: true, withdraw: false }, source: 'last-good' });
  const proxy = await v.loadRemoteFlags({ base: 'http://x', fetch: async () => new Response('<html>', { status: 200 }) }, kv);
  assert.equal(proxy.source, 'last-good');
  const err500 = await v.loadRemoteFlags({ base: 'http://x', fetch: async () => jsonRes(500, { error: 'storage error' }) }, kv);
  assert.equal(err500.source, 'last-good');
  kv.data.set(v.FLAGS_KEY, '{not json');
  const broken = await v.loadRemoteFlags({ base: 'http://x', fetch: async () => { throw new TypeError('offline'); } }, kv);
  assert.equal(broken.source, 'defaults');
  // The read right before a wallet prompt carries a throwaway query past the phone's HTTP cache.
  const seen: string[] = [];
  const forced = await v.loadRemoteFlags({ base: 'http://x', fetch: async (u) => {
    seen.push(u);
    return jsonRes(200, { vouch: false });
  } }, kv, '1759140131120');
  assert.deepEqual(seen, ['http://x/flags?r=1759140131120']);
  assert.equal(forced.flags.vouch, false);
});

test('answer cache: per (mint, package), newest across apps, survives junk', async () => {
  const kv = memKV();
  const a = result();
  const b = result({ vouch: { ...a.vouch, package: 'a.b', verdict: 'broken' } });
  await v.rememberResult(kv, M, a, 1000);
  await v.rememberResult(kv, M, b, 2000);
  assert.equal((await v.cachedResult(kv, M, 'x.place'))?.vouch.verdict, 'works');
  assert.equal(await v.cachedResult(kv, W, 'x.place'), null); // another Genesis Token on the same phone
  assert.equal((await v.latestCachedResult(kv, M))?.vouch.package, 'a.b');
  for (let i = 0; i < 130; i++) {
    await v.rememberResult(kv, M, result({ vouch: { ...a.vouch, package: `p.a${i}` } }), 3000 + i);
  }
  const kept = Object.keys(JSON.parse(kv.data.get(v.MY_VOUCH_KEY)!));
  assert.equal(kept.length, 120);
  assert.ok(!kept.includes(`${M}|x.place`)); // the oldest go first
  kv.data.set(v.MY_VOUCH_KEY, 'garbage');
  assert.equal(await v.cachedResult(kv, M, 'x.place'), null);
});

test("the card's weight follows the worker's re-stamp, and agrees with the sheet's line", async () => {
  const base = result();
  const on = (pkg: string, over: Partial<VouchResult>) =>
    result({ ...over, vouch: { ...base.vouch, package: pkg, weight: over.weight ?? 1 } });
  const A = 'x.place';
  const B = 'a.b';
  const staked = { weightSource: 'chain' as const, weight: 3.06, stakedSkr: 11355.88 };
  const sheetNumber = async (kv: KV) => /(\d+\.\d\d)x/.exec(v.weightLine(await v.latestCachedResult(kv, M)))?.[1];

  // A under the stub (1.00x), then B with 11,355.88 SKR staked: the read re-stamps A too.
  let kv = memKV();
  await v.rememberResult(kv, M, on(A, { weightSource: 'stub', weight: 1 }), 1000);
  await v.rememberResult(kv, M, on(B, staked), 2000);
  assert.equal(await v.cachedWeight(kv, M, A), 3.06);
  assert.equal((await v.cachedWeight(kv, M, A))?.toFixed(2), await sheetNumber(kv));
  assert.equal(await v.cachedWeight(kv, M, B), 3.06);

  // A at 3.06x, the owner unstakes, then B reads 0 staked: A drops to 1.00x with it.
  kv = memKV();
  await v.rememberResult(kv, M, on(A, staked), 1000);
  await v.rememberResult(kv, M, on(B, { weightSource: 'cache', weight: 1, stakedSkr: 0 }), 2000);
  assert.equal(await v.cachedWeight(kv, M, A), 1);
  assert.equal((await v.cachedWeight(kv, M, A))?.toFixed(2), await sheetNumber(kv));

  // A failed read on B stamps only B; a replay of B writes nothing: A keeps 3.06x.
  for (const other of [{ weightSource: 'error' as const, weight: 1, stakedSkr: null },
    { weightSource: 'stored' as const, weight: 1, stakedSkr: null }]) {
    kv = memKV();
    await v.rememberResult(kv, M, on(A, staked), 1000);
    await v.rememberResult(kv, M, on(B, other), 2000);
    assert.equal(await v.cachedWeight(kv, M, A), 3.06, other.weightSource);
    assert.equal(await v.cachedWeight(kv, M, B), 1, other.weightSource);
  }

  // This app's own answer wins when it is the newer one, whatever its source.
  kv = memKV();
  await v.rememberResult(kv, M, on(B, staked), 1000);
  await v.rememberResult(kv, M, on(A, { weightSource: 'error', weight: 1, stakedSkr: null }), 2000);
  assert.equal(await v.cachedWeight(kv, M, A), 1);

  // Another Genesis Token on the same phone, or no answer at all: nothing to print.
  assert.equal(await v.cachedWeight(kv, W, A), null);
  assert.equal(await v.cachedWeight(memKV(), M, A), null);
});

/* ------------------------ the sign-once retry loop ------------------------ */

type Step =
  | { status: number; body?: unknown; date?: string; html?: boolean }
  | 'network' | 'badjson';
function scripted(steps: Step[]) {
  const posts: Record<string, unknown>[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    assert.equal(url, 'http://w/vouch');
    posts.push(JSON.parse(String(init?.body)));
    const s = steps.shift();
    if (!s) throw new Error('script ran out');
    if (s === 'network') throw new TypeError('Network request failed');
    if (s === 'badjson') return new Response('<html>', { status: 200 });
    if (s.html) return new Response('<html>error</html>', { status: s.status, headers: { 'content-type': 'text/html' } });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (s.date) headers.date = s.date;
    return new Response(JSON.stringify(s.body ?? {}), { status: s.status, headers });
  };
  return { fetch, posts, left: () => steps.length, add: (more: Step[]) => steps.push(...more) };
}
/** Module state on the phone (vouch.ts); a plain holder here. */
function memPending(): v.PendingStore & { value: v.PendingSigned | null } {
  const box = {
    value: null as v.PendingSigned | null,
    get: () => box.value,
    set: (p: v.PendingSigned | null) => {
      box.value = p;
    },
  };
  return box;
}
function harness(
  steps: Step[],
  signedBytes?: (message: string) => Uint8Array,
  opts: { pending?: v.PendingStore; now?: () => Date; note?: string } = {},
) {
  const net = scripted(steps);
  const slept: number[] = [];
  const signed: string[] = [];
  const stages: string[] = [];
  const resumes: number[] = [];
  const deps = { base: 'http://w', fetch: net.fetch, sleep: async (ms: number) => { slept.push(ms); }, now: opts.now ?? (() => new Date(TS)) };
  const run = () => v.postVouch(deps, {
    wallet: W, mint: M,
    input: { package: 'x.place', verdict: 'works', tags: ['crashes', 'wallet_ok', 'crashes'], note: opts.note ?? ' see  https://x.io ' },
    sign: async (message) => {
      signed.push(message);
      return signedBytes ? signedBytes(message) : new Uint8Array(64).fill(7);
    },
    onStage: (s, info) => {
      stages.push(s);
      if (info) resumes.push(info.resumeAt);
    },
    pending: opts.pending,
  });
  return { run, net, slept, signed, stages, resumes };
}
const SIG7 = v.base58Encode(new Uint8Array(64).fill(7));

test('200: one signature, the exact payload, the parsed answer', async () => {
  const h = harness([{ status: 200, body: okBody() }]);
  const r = await h.run();
  assert.equal(r.vouch.package, 'x.place');
  assert.equal(h.signed.length, 1);
  assert.deepEqual(h.stages, ['signing', 'sending']);
  assert.deepEqual(h.net.posts[0], {
    wallet: W, mint: M, ts: TS, signature: SIG7, package: 'x.place', verdict: 'works',
    tags: ['wallet_ok', 'crashes'], note: 'see [link removed]',
  });
  assert.equal(h.signed[0], v.vouchMessage({ wallet: W, mint: M, ts: TS, package: 'x.place', verdict: 'works',
    tags: ['wallet_ok', 'crashes'], note: 'see [link removed]' }));
});

test('signature followed by the message: a 401 on the first 64 bytes tries the last 64, no second prompt', async () => {
  const sigAtEnd = (m: string) => {
    const msg = new TextEncoder().encode(m);
    const out = new Uint8Array(msg.length + 64);
    out.set(msg, 0);
    out.set(new Uint8Array(64).fill(9), msg.length);
    return out;
  };
  const h = harness([{ status: 401, body: { error: 'signature verification failed' } }, { status: 200, body: okBody() }], sigAtEnd);
  await h.run();
  assert.equal(h.signed.length, 1);
  assert.equal(h.net.posts.length, 2);
  assert.equal(h.net.posts[1].signature, v.base58Encode(new Uint8Array(64).fill(9)));
  assert.notEqual(h.net.posts[0].signature, h.net.posts[1].signature);
});

test('a bare 64-byte signature that gets 401 stops with the signature sentence', async () => {
  const h = harness([{ status: 401, body: { error: 'signature verification failed' } }]);
  await assert.rejects(h.run(), (e: unknown) => v.vouchErrorStatus(e) === 401 &&
    (e as Error).message === v.vouchErrorMessage(401, 'signature verification failed'));
  assert.equal(h.net.posts.length, 1);
});

test('429 waits RATE_MS + 500 once and resends the same payload; a second 429 is final', async () => {
  const ok = harness([{ status: 429, body: { error: 'slow down' } }, { status: 200, body: okBody() }]);
  await ok.run();
  assert.deepEqual(ok.slept, [10_500]);
  assert.deepEqual(ok.net.posts[0], ok.net.posts[1]);
  assert.equal(ok.signed.length, 1);
  const twice = harness([{ status: 429, body: { error: 'slow down' } }, { status: 429, body: { error: 'slow down' } }]);
  await assert.rejects(twice.run(), (e: unknown) => v.vouchErrorStatus(e) === 429 &&
    (e as Error).message === 'One vouch every 10 seconds. Give it a moment, then try again.');
  assert.equal(twice.signed.length, 1);
});

test('busyWaitMs: until the server minute turns, from the Date header; the longest wait without one', () => {
  assert.equal(v.busyWaitMs('Tue, 29 Sep 2026 15:10:23 GMT'), 38_000);
  assert.equal(v.busyWaitMs('Tue, 29 Sep 2026 15:10:00 GMT'), 61_000);
  assert.equal(v.busyWaitMs('Tue, 29 Sep 2026 15:10:59 GMT'), 2_000);
  assert.equal(v.busyWaitMs(null), v.BUSY_MAX_WAIT_MS);
  assert.equal(v.busyWaitMs('not a date'), 61_000);
});

const BUSY = { status: 503, body: { error: 'busy, try again in a minute' }, date: 'Tue, 29 Sep 2026 10:02:23 GMT' };

test('503 busy waits for the next server minute once, with a visible waiting stage; the kill switch 503 stops at once', async () => {
  const busy = harness([BUSY, { status: 200, body: okBody() }]);
  await busy.run();
  assert.deepEqual(busy.slept, [38_000]);
  assert.deepEqual(busy.stages, ['signing', 'sending', 'waiting', 'sending']);
  assert.deepEqual(busy.resumes, [Date.parse(TS) + 38_000]);
  assert.deepEqual(busy.net.posts[0], busy.net.posts[1]);
  const busy2 = harness([BUSY, BUSY]);
  await assert.rejects(busy2.run(), (e: unknown) => (e as Error).message ===
    'Lots of Seeker owners are checking in right now. Try again in a minute.');
  assert.equal(busy2.net.posts.length, 2);
  const paused = harness([{ status: 503, body: { error: 'vouching is paused' } }]);
  await assert.rejects(paused.run(), (e: unknown) => (e as Error).message === v.PAUSED_SENTENCE);
  assert.equal(paused.net.posts.length, 1);
  assert.deepEqual(paused.slept, []);
});

test('a second submit of the same vouch after busy or a dead network re-posts the signed payload: 0 new prompts', async () => {
  const pending = memPending();
  const first = harness([BUSY, BUSY], undefined, { pending });
  await assert.rejects(first.run(), (e: unknown) => v.vouchErrorCode(e) === 'busy, try again in a minute');
  assert.equal(first.signed.length, 1);
  assert.equal(pending.value?.signatures.length, 1);
  const again = harness([{ status: 200, body: okBody({ replayed: false }) }], undefined, { pending });
  await again.run();
  assert.equal(again.signed.length, 0); // no Seed Vault prompt
  assert.deepEqual(again.stages, ['sending']);
  assert.deepEqual(again.net.posts[0], first.net.posts[0]); // the same signed payload, ts included
  assert.equal(pending.value, null); // a 200 ends it

  const offline = harness(['network', 'network', 'network'], undefined, { pending });
  await assert.rejects(offline.run(), (e: unknown) => v.vouchErrorStatus(e) === 0);
  const back = harness([{ status: 200, body: okBody({ replayed: true }) }], undefined, { pending });
  assert.equal((await back.run()).replayed, true);
  assert.equal(offline.signed.length + back.signed.length, 1);
});

test('the kept payload is only reused for the same vouch, while fresh, and a final 4xx ends it', async () => {
  const pending = memPending();
  await assert.rejects(harness(['network', 'network', 'network'], undefined, { pending }).run());
  const kept = pending.value;
  assert.ok(kept);
  // Another note: another vouch, a new prompt, and it replaces the kept one.
  const other = harness([{ status: 200, body: okBody() }], undefined, { pending, note: 'different' });
  await other.run();
  assert.equal(other.signed.length, 1);
  assert.equal(pending.value, null);
  // Older than REUSE_SIGNED_MS on this clock: signed afresh.
  pending.set(kept);
  const later = () => new Date(Date.parse(TS) + v.REUSE_SIGNED_MS + 1);
  const late = harness([{ status: 200, body: okBody() }], undefined, { pending, now: later });
  await late.run();
  assert.equal(late.signed.length, 1);
  assert.notEqual(late.net.posts[0].ts, TS);
  // A final answer (403) ends it: the next tap asks the wallet again.
  pending.set(kept);
  const refused = harness([{ status: 403, body: { error: 'wallet does not hold this token' } }], undefined, { pending });
  await assert.rejects(refused.run());
  assert.equal(refused.signed.length, 0);
  assert.equal(pending.value, null);
});

test('a reused payload the server calls stale is signed afresh once (a phone clock far behind)', async () => {
  const pending = memPending();
  await assert.rejects(harness(['network', 'network', 'network'], undefined, { pending }).run());
  const h = harness([{ status: 400, body: { error: 'stale message' } }, { status: 200, body: okBody() }], undefined, { pending });
  await h.run();
  assert.equal(h.signed.length, 1);
  assert.deepEqual(h.stages, ['sending', 'signing', 'sending']);
});

test('409 after a try whose answer was lost: one re-post of the same payload, answered from D1', async () => {
  const h = harness(['network', { status: 409, body: { error: 'superseded by a newer vouch from this Seeker' } },
    { status: 200, body: okBody({ replayed: true }) }]);
  const r = await h.run();
  assert.equal(r.replayed, true);
  assert.equal(h.signed.length, 1);
  assert.deepEqual(h.slept, [1500, 1500]);
  assert.deepEqual(h.net.posts[1], h.net.posts[2]);
  const twice = harness([{ status: 502, body: { error: 'chain check unavailable' } },
    { status: 409, body: { error: 'superseded by a newer vouch from this Seeker' } },
    { status: 409, body: { error: 'superseded by a newer vouch from this Seeker' } }]);
  await assert.rejects(twice.run(), (e: unknown) => v.vouchErrorStatus(e) === 409);
  assert.equal(twice.net.posts.length, 3);
});

test('error pages without JSON: status sentences and retries, never "your vouch was sent"', async () => {
  const cf = harness([{ status: 522, html: true }, { status: 522, html: true }, { status: 522, html: true }]);
  await assert.rejects(cf.run(), (e: unknown) => v.vouchErrorStatus(e) === 522 && v.vouchErrorCode(e) === '' &&
    (e as Error).message === 'The vouch service is busy. Try again in a minute.');
  assert.equal(cf.net.posts.length, 3);
  const waf = harness([{ status: 429, html: true }, { status: 200, body: okBody() }]);
  await waf.run();
  assert.deepEqual(waf.slept, [10_500]);
  const html503 = harness([{ status: 503, html: true }, { status: 200, body: okBody() }]);
  await html503.run(); // not the kill switch (that one carries its code): retried like any 5xx
  assert.deepEqual(html503.slept, [1500]);
});

test('wallet errors get app sentences, never MWA developer text', () => {
  assert.equal(v.walletErrorSentence(Object.assign(new Error('Found no installed wallet'), { code: 'ERROR_WALLET_NOT_FOUND' }), 'sign'),
    'No Solana wallet app was found on this phone.');
  assert.equal(v.walletErrorSentence(new Error('Local association cancelled by user'), 'sign'), 'Signing cancelled. Nothing was sent.');
  assert.equal(v.walletErrorSentence(new Error('Timed out waiting for response'), 'connect'), 'Connection cancelled.');
  assert.equal(v.walletErrorSentence(undefined, 'sign'), 'Signing cancelled. Nothing was sent.');
});

test('5xx and network errors retry the SAME payload without asking the wallet again', async () => {
  const h = harness([{ status: 500, body: { error: 'storage error' } }, 'network', { status: 200, body: okBody({ replayed: true }) }]);
  const r = await h.run();
  assert.equal(r.replayed, true);
  assert.equal(h.signed.length, 1);
  assert.deepEqual(h.slept, [1500, 3000]);
  assert.deepEqual(h.net.posts[0], h.net.posts[2]);
  const down = harness(['network', 'network', 'network']);
  await assert.rejects(down.run(), (e: unknown) => v.vouchErrorStatus(e) === 0 && (e as Error).message === v.OFFLINE_SENTENCE);
  assert.equal(down.signed.length, 1);
  const chain = harness([
    { status: 502, body: { error: 'chain check unavailable' } }, { status: 502, body: { error: 'chain check unavailable' } },
    { status: 502, body: { error: 'chain check unavailable' } },
  ]);
  await assert.rejects(chain.run(), (e: unknown) => (e as Error).message.startsWith("Couldn't reach Solana"));
});

test('final answers: 400 note, 403, 409 come back as their sentences after one post', async () => {
  for (const [status, error] of [[400, 'note contains a link or is not normalised'], [403, 'wallet does not hold this token'],
    [403, 'vouch limit reached'], [409, 'superseded by a newer vouch from this Seeker']] as const) {
    const h = harness([{ status, body: { error } }]);
    await assert.rejects(h.run(), (e: unknown) => v.vouchErrorCode(e) === error && (e as Error).message === v.vouchErrorMessage(status, error));
    assert.equal(h.net.posts.length, 1);
  }
});

test('refused before the wallet opens: bidi note, bad verdict; a dismissed prompt surfaces as is', async () => {
  const deps = { base: 'http://w', fetch: async () => { throw new Error('must not post'); } };
  let prompts = 0;
  const sign = async () => { prompts += 1; return new Uint8Array(64); };
  await assert.rejects(v.postVouch(deps, { wallet: W, mint: M, sign,
    input: { package: 'x.place', verdict: 'works', tags: [], note: 'a' + String.fromCharCode(0x202e) + 'b' } }),
  (e: unknown) => v.vouchErrorStatus(e) === 400);
  await assert.rejects(v.postVouch(deps, { wallet: W, mint: M, sign,
    input: { package: 'x.place', verdict: 'meh' as 'works', tags: [], note: '' } }),
  (e: unknown) => (e as Error).message === 'Pick Works or Broken first.');
  assert.equal(prompts, 0);
  const cancelled = new Error('User rejected the request');
  await assert.rejects(v.postVouch(deps, { wallet: W, mint: M, sign: async () => { throw cancelled; },
    input: { package: 'x.place', verdict: 'works', tags: [], note: '' } }), (e: unknown) => e === cancelled);
});

test('an unreadable 200 is not retried (the vouch may have landed)', async () => {
  const h = harness(['badjson']);
  await assert.rejects(h.run(), (e: unknown) => v.vouchErrorCode(e) === 'unexpected response');
  assert.equal(h.net.posts.length, 1);
});

test('reads: null on failure, parsed on success, the cache-busting query only when asked', async () => {
  const urls: string[] = [];
  const deps = { base: 'http://w', fetch: async (u: string) => {
    urls.push(u);
    if (u.startsWith('http://w/vouch/app/')) return jsonRes(200, { app: APP, recent: [] });
    if (u.startsWith('http://w/vouch/mine')) return jsonRes(200, { vouches: [] });
    return jsonRes(500, { error: 'storage error' });
  } };
  assert.equal((await v.fetchAppVouches(deps, 'x.place'))?.app.voices, 3);
  await v.fetchAppVouches(deps, 'x.place', TS);
  assert.deepEqual(await v.fetchMyVouches(deps, M), []);
  assert.equal(await v.fetchTopVouched(deps), null);
  await v.fetchTopVouched(deps, TS);
  assert.deepEqual(urls, [
    'http://w/vouch/app/x.place', `http://w/vouch/app/x.place?r=${encodeURIComponent(TS)}`,
    `http://w/vouch/mine?mint=${M}`, 'http://w/vouch/top', `http://w/vouch/top?r=${encodeURIComponent(TS)}`,
  ]);
  const offline = { base: 'http://w', fetch: async () => { throw new TypeError('offline'); } };
  assert.equal(await v.fetchAppVouches(offline, 'x.place'), null);
  assert.equal(await v.fetchMyVouches(offline, M), null);
});
