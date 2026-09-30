// indexer/test/enrich-vouches.test.mjs: `npm run test:app` (node --test).
// The catalog stamper as a unit: the pure stamp over a catalog array and an
// aggregate body, the live/last-good/none loader against a scripted fetch,
// and the file run on a temp catalog. No network: the live fixture is a
// verbatim copy of the public GET /vouch/aggregate taken 2026-09-30.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_CACHE_AGE_MS,
  VOUCH_FIELDS,
  loadAggregate,
  parseAggregate,
  run,
  stampVouches,
} from '../enrich-vouches.mjs';

const LIVE = JSON.parse(readFileSync(new URL('./aggregate-live-2026-09-30.json', import.meta.url), 'utf8'));
const SELF = 'com.bilal.seekerscout';
const NOW = Date.parse('2026-09-30T13:00:00.000Z');

const app = (id, extra = {}) => ({
  id, name: id, subtitle: '', category: 'Other', lastUpdated: '2026-09-01',
  rating: 4.2, reviews: 12, trendScore: 50, ...extra,
});
const row = (pkg, voices, worksVoices, worksOnSeeker, extra = {}) => ({
  package: pkg, voices, works_voices: worksVoices, broken_voices: voices - worksVoices,
  works_pct: voices ? Math.round((worksVoices * 100) / voices) : 0, wallet_ok_voices: 0,
  last_vouch_at: '2026-09-30T10:00:00.000Z', works_on_seeker: worksOnSeeker, ...extra,
});
const vouchKeys = (a) => VOUCH_FIELDS.filter((f) => Object.hasOwn(a, f));
const ids = (list) => list.map((a) => a.id);
const silent = () => {};

test('live copy (2026-09-30): Seeker Scout gets 1 voice, 100%, rank 1 and no chip; nothing else moves', () => {
  const catalog = [app('ag.jup.jupiter.android', { seedVaultNative: true }), app(SELF), app('x.place')];
  const before = structuredClone(catalog);
  const r = stampVouches(catalog, LIVE);
  assert.deepEqual(catalog, before, 'input not mutated');
  assert.equal(r.valid, true);
  assert.equal(r.stamped, 1);
  assert.equal(r.chips, 0);
  assert.equal(r.unknown, 0);
  assert.equal(r.changed, true);
  assert.deepEqual(ids(r.catalog), ids(catalog));
  const self = r.catalog[1];
  assert.equal(self.vouchVoices, 1);
  assert.equal(self.vouchWorksPct, 100);
  assert.equal(self.vouchRank, 1);
  assert.equal(Object.hasOwn(self, 'worksOnSeeker'), false, 'works_on_seeker:false stamps no chip field');
  assert.equal(r.catalog[0], catalog[0], 'an app with no vouch keeps its object');
  assert.equal(r.catalog[0].seedVaultNative, true);
  assert.equal(r.catalog[2], catalog[2]);
});

test('only the four vouch fields are added: no weights, dates, wallet counts or notes', () => {
  const r = stampVouches([app(SELF)], LIVE);
  const added = Object.keys(r.catalog[0]).filter((k) => !Object.hasOwn(app(SELF), k));
  assert.deepEqual(added.sort(), ['vouchRank', 'vouchVoices', 'vouchWorksPct']);
  const chip = stampVouches([app('a.b')], { apps: [row('a.b', 5, 5, true)] }).catalog[0];
  assert.deepEqual(vouchKeys(chip).sort(), [...VOUCH_FIELDS].sort());
  assert.equal(chip.worksOnSeeker, true);
});

test('many rows: the worker order is kept, unknown packages take no rank and are never added', () => {
  const catalog = [app('c.app'), app('a.app'), app('b.app'), app('quiet.app')];
  const agg = {
    apps: [
      row('www.some-site.com', 9, 9, true), // any package-shaped id is accepted by the worker
      row('b.app', 6, 6, true),
      row('a.app', 4, 3, false),
      row('com.unknown.thing', 3, 3, true),
      row('c.app', 3, 3, true),
    ],
  };
  const r = stampVouches(catalog, agg);
  assert.equal(r.catalog.length, catalog.length);
  assert.deepEqual(ids(r.catalog), ids(catalog));
  assert.equal(r.catalog.some((a) => a.id === 'www.some-site.com' || a.id === 'com.unknown.thing'), false);
  const byId = Object.fromEntries(r.catalog.map((a) => [a.id, a]));
  assert.equal(byId['b.app'].vouchRank, 1);
  assert.equal(byId['a.app'].vouchRank, 2);
  assert.equal(byId['c.app'].vouchRank, 3);
  assert.equal(byId['b.app'].worksOnSeeker, true);
  assert.equal(byId['c.app'].worksOnSeeker, true);
  assert.equal(Object.hasOwn(byId['a.app'], 'worksOnSeeker'), false);
  assert.equal(byId['a.app'].vouchWorksPct, 75);
  assert.deepEqual(vouchKeys(byId['quiet.app']), []);
  assert.equal(r.stamped, 3);
  assert.equal(r.chips, 2);
  assert.equal(r.unknown, 2);
});

test('bad rows are dropped whole, never guessed at; a repeated package keeps its first row', () => {
  const good = row('good.app', 3, 3, true);
  const agg = {
    apps: [
      null, [], 'x.y',
      row('s.app', '3', 3, true),
      row('zero.app', 0, 0, false),
      row('neg.app', -1, 0, false),
      row('more.app', 2, 3, false),
      { ...row('pct.app', 3, 3, true), works_pct: 101 },
      { ...row('frac.app', 3, 2, false), works_pct: 66.7 },
      row('str.app', 3, 3, 'true'),
      (({ works_on_seeker, ...rest }) => rest)(row('none.app', 3, 3, true)),
      { ...row('x', 3, 3, true), package: 123 },
      { ...row('x', 3, 3, true), package: '' },
      good,
      row('good.app', 9, 0, false),
    ],
  };
  const parsed = parseAggregate(agg);
  assert.deepEqual(parsed.rows.map((r) => r.package), ['good.app']);
  assert.equal(parsed.dropped, agg.apps.length - 1);
  const names = ['s', 'zero', 'neg', 'more', 'pct', 'frac', 'str', 'none', 'good'].map((n) => app(`${n}.app`));
  const r = stampVouches(names, agg);
  assert.equal(r.stamped, 1);
  const stamped = r.catalog.filter((a) => vouchKeys(a).length);
  assert.deepEqual(ids(stamped), ['good.app']);
  assert.equal(stamped[0].vouchVoices, 3, 'the first good.app row wins');
  assert.equal(stamped[0].worksOnSeeker, true);
  assert.equal(r.catalog.find((a) => a.id === 'str.app').worksOnSeeker, undefined, "'true' as a string is no chip");
});

test('malformed, empty or missing bodies stamp nothing and keep every app', () => {
  const catalog = [app(SELF), app('a.b')];
  for (const body of [null, undefined, 'x', 42, [], {}, { apps: null }, { apps: {} }, { error: 'storage error' }]) {
    const r = stampVouches(catalog, body);
    assert.equal(r.valid, false, JSON.stringify(body));
    assert.equal(r.stamped, 0);
    assert.equal(r.changed, false);
    assert.deepEqual(r.catalog, catalog);
  }
  const empty = stampVouches(catalog, { generated_at: '2026-09-30T00:00:00.000Z', count: 0, apps: [] });
  assert.equal(empty.valid, true, 'an empty list is a real answer: nobody vouched');
  assert.equal(empty.stamped, 0);
  assert.deepEqual(empty.catalog, catalog);
});

test('old stamps are cleared first: a re-stamp depends on the catalog and the aggregate only', () => {
  const catalog = [
    app('a.app', { vouchVoices: 4, vouchWorksPct: 100, vouchRank: 1, worksOnSeeker: true }),
    app('b.app', { vouchVoices: 1, vouchWorksPct: 0, vouchRank: 2 }),
  ];
  const agg = { apps: [row('b.app', 3, 3, true)] };
  const r = stampVouches(catalog, agg);
  assert.deepEqual(vouchKeys(r.catalog[0]), [], 'a.app lost its chip and counts');
  assert.equal(r.catalog[1].vouchVoices, 3);
  assert.equal(r.catalog[1].vouchRank, 1);
  assert.equal(r.catalog[1].worksOnSeeker, true);
  assert.equal(r.changed, true);
  const again = stampVouches(r.catalog, agg);
  assert.equal(again.changed, false);
  assert.deepEqual(again.catalog, r.catalog);
  // No aggregate at all: ship without stamps, never with a chip nobody vouches for today.
  const cleared = stampVouches(r.catalog, null);
  assert.equal(cleared.catalog.every((a) => vouchKeys(a).length === 0), true);
  assert.equal(cleared.changed, true);
});

test('seedVaultNative is never set or cleared by a vouch', () => {
  const catalog = [app('a.app', { seedVaultNative: false }), app('b.app')];
  const agg = { apps: [row('a.app', 5, 5, true, { wallet_ok_voices: 5 }), row('b.app', 5, 5, true, { wallet_ok_voices: 5 })] };
  const r = stampVouches(catalog, agg);
  assert.equal(r.catalog[0].seedVaultNative, false);
  assert.equal(Object.hasOwn(r.catalog[1], 'seedVaultNative'), false);
});

test('a repeated catalog id is stamped once, on its first entry; a non-array catalog throws', () => {
  const catalog = [app('a.app'), app('a.app')];
  const r = stampVouches(catalog, { apps: [row('a.app', 3, 3, true)] });
  assert.equal(r.catalog[0].vouchRank, 1);
  assert.deepEqual(vouchKeys(r.catalog[1]), []);
  assert.throws(() => stampVouches({ apps: [] }, LIVE), TypeError);
});

/* ------------------------------ the loader ------------------------------ */

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'enrich-vouches-'));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const reply = (status, text) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => text });
const unreachable = async () => {
  throw new TypeError('fetch failed');
};
const saveCache = (path, fetchedAt, body = LIVE) =>
  writeFileSync(path, JSON.stringify({ fetched_at: new Date(fetchedAt).toISOString(), body }));

test('loader: a good live answer is used and saved as the last good copy', async () => {
  const cachePath = join(tmp(), 'last.json');
  const got = await loadAggregate({ fetchImpl: reply(200, JSON.stringify(LIVE)), cachePath, now: NOW, warn: silent });
  assert.equal(got.source, 'live');
  assert.deepEqual(got.body, LIVE);
  const saved = JSON.parse(readFileSync(cachePath, 'utf8'));
  assert.equal(saved.fetched_at, new Date(NOW).toISOString());
  assert.deepEqual(saved.body, LIVE);
});

test('loader: unreachable with no last good copy stamps nothing, with a warning', async () => {
  const warnings = [];
  const got = await loadAggregate({
    fetchImpl: unreachable, cachePath: join(tmp(), 'last.json'), now: NOW, warn: (m) => warnings.push(m),
  });
  assert.deepEqual(got, { body: null, source: 'none' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fetch failed.*stamping nothing/);
  assert.doesNotMatch(warnings[0], /https?:\/\//, 'no URL in the log');
});

test('loader: 500, non-JSON, the wrong shape and an oversized body all fall back to a fresh last good copy', async () => {
  const bodies = [
    reply(500, '{"error":"storage error"}'),
    reply(200, '<html>oops</html>'),
    reply(200, '{"error":"storage error"}'),
    reply(200, JSON.stringify({ apps: 'nope' })),
    reply(200, 'x'.repeat(2_000_001)),
    unreachable,
  ];
  for (const fetchImpl of bodies) {
    const cachePath = join(tmp(), 'last.json');
    saveCache(cachePath, NOW - 2 * 86_400_000);
    const before = readFileSync(cachePath, 'utf8');
    const got = await loadAggregate({ fetchImpl, cachePath, now: NOW, warn: silent });
    assert.equal(got.source, 'cache');
    assert.deepEqual(got.body, LIVE);
    assert.equal(readFileSync(cachePath, 'utf8'), before, 'a bad answer never replaces the last good copy');
  }
});

test('loader: a last good copy older than 3 days, from the future, or unreadable is not used', async () => {
  const cases = [
    (p) => saveCache(p, NOW - MAX_CACHE_AGE_MS - 1),
    (p) => saveCache(p, NOW + 2 * 3_600_000),
    (p) => writeFileSync(p, '{"fetched_at":'),
    (p) => writeFileSync(p, JSON.stringify({ fetched_at: new Date(NOW).toISOString(), body: { apps: 3 } })),
    (p) => writeFileSync(p, JSON.stringify({ body: LIVE })),
  ];
  for (const write of cases) {
    const cachePath = join(tmp(), 'last.json');
    write(cachePath);
    const got = await loadAggregate({ fetchImpl: unreachable, cachePath, now: NOW, warn: silent });
    assert.deepEqual(got, { body: null, source: 'none' });
  }
  const edge = join(tmp(), 'last.json');
  saveCache(edge, NOW - MAX_CACHE_AGE_MS);
  assert.equal((await loadAggregate({ fetchImpl: unreachable, cachePath: edge, now: NOW, warn: silent })).source, 'cache');
});

test('loader: a hung worker times out instead of holding the refresh', async () => {
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const warnings = [];
  const started = Date.now();
  const got = await loadAggregate({
    fetchImpl: hang, cachePath: join(tmp(), 'last.json'), now: NOW, timeoutMs: 50, warn: (m) => warnings.push(m),
  });
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(got, { body: null, source: 'none' });
  assert.match(warnings[0], /timed out/);
});

test('loader: an empty live list is a real answer and replaces the last good copy', async () => {
  const cachePath = join(tmp(), 'last.json');
  saveCache(cachePath, NOW - 86_400_000);
  const empty = { generated_at: '2026-09-30T12:00:00.000Z', count: 0, apps: [] };
  const got = await loadAggregate({ fetchImpl: reply(200, JSON.stringify(empty)), cachePath, now: NOW, warn: silent });
  assert.equal(got.source, 'live');
  assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf8')).body, empty);
});

/* ------------------------------ the file run ------------------------------ */

test('run: stamps the file in the catalog format, then leaves it untouched when nothing changed', async () => {
  const dir = tmp();
  const catalogPath = join(dir, 'catalog.json');
  const catalog = [app('a.app'), app(SELF)];
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 1));
  const logs = [];
  const opts = {
    catalogPath, cachePath: join(dir, 'last.json'), fetchImpl: reply(200, JSON.stringify(LIVE)),
    now: NOW, log: (m) => logs.push(m), warn: silent,
  };
  const r = await run(opts);
  assert.equal(r.source, 'live');
  const text = readFileSync(catalogPath, 'utf8');
  const written = JSON.parse(text);
  assert.equal(text, JSON.stringify(written, null, 1), 'same JSON layout as fetch-catalog.mjs');
  assert.equal(written.length, 2);
  assert.equal(written[1].vouchVoices, 1);
  assert.match(logs[0], /live aggregate; stamped 1 app\(s\), 0 with Works on Seeker/);
  const mtime = statSync(catalogPath).mtimeMs;
  await run(opts);
  assert.equal(readFileSync(catalogPath, 'utf8'), text);
  assert.equal(statSync(catalogPath).mtimeMs, mtime, 'not rewritten');
  assert.match(logs[1], /catalog unchanged/);
  assert.equal(existsSync(`${catalogPath}.tmp-${process.pid}`), false, 'no temp file left behind');
});

test('run: an unreachable worker with no last good copy leaves an unstamped catalog byte for byte', async () => {
  const dir = tmp();
  const catalogPath = join(dir, 'catalog.json');
  const text = JSON.stringify([app('a.app'), app(SELF)], null, 1);
  writeFileSync(catalogPath, text);
  const r = await run({ catalogPath, cachePath: join(dir, 'last.json'), fetchImpl: unreachable, now: NOW, log: silent, warn: silent });
  assert.equal(r.source, 'none');
  assert.equal(r.changed, false);
  assert.equal(readFileSync(catalogPath, 'utf8'), text);
});

test('run: an unreadable catalog rejects and is left as it was (the caller keeps its copy)', async () => {
  const dir = tmp();
  for (const text of ['{"not":"an array"}', '[{"id":"a.app"', '']) {
    const catalogPath = join(dir, 'catalog.json');
    writeFileSync(catalogPath, text);
    await assert.rejects(
      run({ catalogPath, cachePath: join(dir, 'last.json'), fetchImpl: reply(200, JSON.stringify(LIVE)), now: NOW, log: silent, warn: silent }),
    );
    assert.equal(readFileSync(catalogPath, 'utf8'), text);
  }
});
