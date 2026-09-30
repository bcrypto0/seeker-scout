// src/lib/vouchStamp.test.ts: `npm run test:app` (node --test; Node 24 strips the types).
// The app's side of the catalog vouch stamps: the Works on Seeker chip, the
// app page header's live-over-stamp rule, and the Discover hero's owners'
// pick. The first tests run the real stamper (indexer/enrich-vouches.mjs)
// and read its output here, so the field names cannot drift apart. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as s from './vouchStamp.ts';
import { stampVouches, VOUCH_FIELDS } from '../../indexer/enrich-vouches.mjs';

type App = {
  id: string;
  name: string;
  vouchVoices?: unknown;
  vouchWorksPct?: unknown;
  vouchRank?: unknown;
  worksOnSeeker?: unknown;
  seedVaultNative?: boolean;
};

// A string path: the app's tsconfig types URL from the DOM lib, which node:fs does not take.
const FIXTURE = fileURLToPath(new URL('../../indexer/test/aggregate-live-2026-09-30.json', import.meta.url).href);
const LIVE = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const DAY = 86_400_000;
const NOW = new Date('2026-09-30T13:00:00.000Z');

const app = (id: string, extra: Partial<App> = {}): App => ({ id, name: id, ...extra });
const row = (pkg: string, voices: number, works: number, chip: boolean) => ({
  package: pkg, voices, works_voices: works, broken_voices: voices - works,
  works_pct: Math.round((works * 100) / voices), wallet_ok_voices: 0,
  last_vouch_at: '2026-09-30T10:00:00.000Z', works_on_seeker: chip,
});
// The app reads the hosted JSON with a bare cast, so the tests do too.
const pick = (apps: unknown[], now = NOW) => s.ownersPick(apps as never[], now) as App | undefined;
const chips = (apps: unknown[]) => (apps as App[]).filter((a) => s.hasWorksChip(a as never)).map((a) => a.id);

test('the app reads exactly the fields the stamper writes', () => {
  assert.deepEqual([...s.STAMP_FIELDS].sort(), [...VOUCH_FIELDS].sort());
});

test('today (live copy 2026-09-30): one voice on Seeker Scout, no chip anywhere, the hero stays the Scout Pick', () => {
  const catalog = [app('ag.jup.jupiter.android', { seedVaultNative: true }), app(s.SELF_ID), app('x.place')];
  const out = stampVouches(catalog, LIVE).catalog;
  assert.deepEqual(chips(out), []);
  assert.equal(pick(out), undefined);
  const self = out[1] as App;
  assert.equal(s.vouchVoicesOf(self as never), 1);
  assert.equal(s.vouchRankOf(self as never), 1);
  assert.equal(s.ownersLine(self as never), '1 owner vouched · 100% say it works');
});

test('no stamps at all (offline seed, skipped stamp, unreachable worker): no chip, no owners pick', () => {
  const seed = [app('ag.jup.jupiter.android', { seedVaultNative: true }), app('app.phantom')];
  assert.deepEqual(chips(seed), []);
  assert.equal(pick(seed), undefined);
  assert.equal(pick([]), undefined);
  const unstamped = stampVouches(seed, null).catalog;
  assert.deepEqual(chips(unstamped), []);
  assert.equal(pick(unstamped), undefined);
});

test('many stamped apps: the pick is one of the five best-ranked chip apps, rotating by UTC day', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `app.n${String(i).padStart(2, '0')}`);
  const catalog = [app(s.SELF_ID), ...ids.map((id) => app(id)), app('quiet.app')];
  // Worker order: self first, a raw id the catalog lacks, then n00..n39; odd ones miss the chip.
  const agg = {
    apps: [
      row(s.SELF_ID, 9, 9, true),
      row('www.some-site.com', 8, 8, true),
      ...ids.map((id, i) => row(id, 7, i % 2 ? 4 : 7, i % 2 === 0)),
    ],
  };
  const out = stampVouches(catalog, agg).catalog as App[];
  assert.equal(out.length, catalog.length, 'the stamper never adds an app');
  assert.equal(chips(out).length, 21, 'self + the 20 even apps');
  const top5 = ['app.n00', 'app.n02', 'app.n04', 'app.n06', 'app.n08'];
  const seen = new Set<string>();
  for (let d = 0; d < 5; d += 1) {
    const p = pick(out, new Date(NOW.getTime() + d * DAY));
    assert.ok(p && top5.includes(p.id), `day ${d}: ${p?.id}`);
    seen.add(p!.id);
  }
  assert.equal(seen.size, 5, 'five days show five different apps');
  assert.equal(pick(out, new Date(NOW.getTime() + 5 * DAY))?.id, pick(out)?.id, 'the rotation repeats every 5 days');
  // Same UTC day, any hour: the same pick on every device.
  const dayStart = new Date('2026-09-30T00:00:00.000Z');
  const dayEnd = new Date('2026-09-30T23:59:59.999Z');
  assert.equal(pick(out, dayStart)?.id, pick(out, dayEnd)?.id);
  assert.notEqual(pick(out, dayEnd)?.id, pick(out, new Date(dayEnd.getTime() + 1))?.id);
  const p = pick(out)!;
  assert.equal(s.ownersLine(p as never), '7 owners vouched · 100% say it works');
});

test('the hero never picks Seeker Scout itself, even as the only chip app', () => {
  const out = stampVouches([app(s.SELF_ID), app('a.app')], { apps: [row(s.SELF_ID, 5, 5, true)] }).catalog;
  assert.deepEqual(chips(out), [s.SELF_ID], 'the chip itself still shows on its card');
  assert.equal(pick(out), undefined);
});

test('fewer than five chip apps: the pool is just those, in rank order', () => {
  const out = stampVouches(
    [app('c.app'), app('a.app'), app('b.app')],
    { apps: [row('b.app', 3, 3, true), row('a.app', 4, 3, false), row('c.app', 3, 3, true)] },
  ).catalog;
  const days = [0, 1, 2, 3].map((d) => pick(out, new Date(NOW.getTime() + d * DAY))?.id);
  assert.deepEqual(new Set(days), new Set(['b.app', 'c.app']));
  assert.notEqual(days[0], days[1]);
});

test('a hand-edited or old catalog: only a real true is a chip; bad ranks sort last; junk rows are skipped', () => {
  const apps = [
    app('str.app', { worksOnSeeker: 'true', vouchRank: 1 }),
    app('one.app', { worksOnSeeker: 1, vouchRank: 1 }),
    app('norank.app', { worksOnSeeker: true }),
    app('badrank.app', { worksOnSeeker: true, vouchRank: '2' }),
    app('zero.app', { worksOnSeeker: true, vouchRank: 0 }),
    app('frac.app', { worksOnSeeker: true, vouchRank: 1.5 }),
    app('ranked.app', { worksOnSeeker: true, vouchRank: 9 }),
    null,
  ];
  assert.deepEqual(chips(apps.filter(Boolean)), ['norank.app', 'badrank.app', 'zero.app', 'frac.app', 'ranked.app']);
  // The pool, in order: the one valid rank first, then the rest by id. The
  // pick on day k is pool[k mod 5], with k the UTC day number scoutPick uses.
  const pool = ['ranked.app', 'badrank.app', 'frac.app', 'norank.app', 'zero.app'];
  const day0 = Math.floor(Date.UTC(2026, 8, 30) / DAY);
  for (let d = 0; d < 5; d += 1) {
    assert.equal(pick(apps, new Date(NOW.getTime() + d * DAY))?.id, pool[(day0 + d) % 5], `day ${d}`);
  }
  assert.equal(s.vouchRankOf({ vouchRank: '2' } as never), null);
  assert.equal(s.vouchRankOf({ vouchRank: 0 } as never), null);
  assert.equal(s.vouchRankOf({ vouchRank: 3 }), 3);
  assert.equal(s.vouchVoicesOf({ vouchVoices: -1 }), null);
  assert.equal(s.hasWorksChip(null), false);
  assert.equal(s.hasWorksChip(undefined), false);
  assert.equal(s.hasWorksChip({ worksOnSeeker: false }), false);
});

test('app page header: the live read wins over the stamp both ways, the stamp stands until then', () => {
  const stamped = { worksOnSeeker: true };
  const plain = {};
  assert.equal(s.worksChipShown(stamped, null), true);
  assert.equal(s.worksChipShown(plain, null), false);
  assert.equal(s.worksChipShown(stamped, { worksOnSeeker: false }), false, 'a day-old chip gives way to the live answer');
  assert.equal(s.worksChipShown(plain, { worksOnSeeker: true }), true, 'earned today, before the next stamp');
  assert.equal(s.worksChipShown(null, undefined), false);
});

test('owners line: plural, and no number it cannot back', () => {
  assert.equal(s.ownersLine({ vouchVoices: 1, vouchWorksPct: 100 }), '1 owner vouched · 100% say it works');
  assert.equal(s.ownersLine({ vouchVoices: 3, vouchWorksPct: 80 }), '3 owners vouched · 80% say it works');
  assert.equal(s.ownersLine({ vouchVoices: 4 }), '4 owners vouched');
  assert.equal(s.ownersLine({ vouchVoices: 4, vouchWorksPct: 101 }), '4 owners vouched');
  assert.equal(s.ownersLine({}), null);
  assert.equal(s.ownersLine({ vouchVoices: 0, vouchWorksPct: 0 }), null);
  assert.equal(s.ownersLine({ vouchVoices: 2.5, vouchWorksPct: 50 }), null);
});
