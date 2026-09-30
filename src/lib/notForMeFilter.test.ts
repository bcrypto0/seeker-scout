// src/lib/notForMeFilter.test.ts: `npm run test:app` (node --test; Node 24 strips the types).
// The "Not for me" list in Discover: the feed and Top climbers skip hidden apps,
// the Hidden chip counts only the hidden apps the catalog lists, and the hero
// picks (the real scoutPick and ownersPick) fall back when today's pick is
// hidden. No clock reads: every pick gets a fixed date, and no fixture app sits
// in the date-based tiers (freshly listed, hidden gems). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as f from './notForMeFilter.ts';
import { scoutPick, topClimbers } from './collections.ts';
import { ownersPick } from './vouchStamp.ts';

type App = {
  id: string;
  name: string;
  rating: number;
  reviews: number;
  trendScore: number;
  rankDelta: number;
  lastUpdated: string;
  worksOnSeeker?: boolean;
  vouchRank?: number;
};

const DAY = 86_400_000;
const NOW = new Date('2026-09-30T13:00:00.000Z');
const DAY_INDEX = Math.floor(Date.UTC(2026, 8, 30) / DAY);

// Released in 2020, so hiddenGems (last 30 days) never qualifies; no firstSeen, so freshlyListed is empty.
const app = (id: string, x: Partial<App> = {}): App => ({
  id, name: id, rating: 4, reviews: 100, trendScore: 10, rankDelta: 0, lastUpdated: '2020-01-01', ...x,
});

// Three credible climbers (a rise of 3+ and 50+ reviews): the Scout pick rotates across them by UTC day.
const CLIMBERS = ['c1', 'c2', 'c3'];
const CATALOG: App[] = [
  app('big', { reviews: 5000, trendScore: 99 }),
  app('c1', { reviews: 400, trendScore: 50, rankDelta: 12 }),
  app('c2', { reviews: 300, trendScore: 40, rankDelta: 9 }),
  app('c3', { reviews: 120, trendScore: 30, rankDelta: 6 }),
  app('quiet', { reviews: 80, trendScore: 20, rankDelta: -2 }),
  app('small', { reviews: 5, trendScore: 5, rankDelta: 20 }),
  app('o1', { worksOnSeeker: true, vouchRank: 1 }),
  app('o2', { worksOnSeeker: true, vouchRank: 2 }),
];

const ids = (list: readonly (App | null | undefined)[]) => list.map((a) => a?.id);
const scout = (list: App[]) => scoutPick(list as never[], NOW) as App | undefined;
const owners = (list: App[]) => ownersPick(list, NOW);
const hide = (...xs: string[]) => new Set(xs);

test('empty list: the feed is the catalog itself, nothing counts as hidden, the picks do not move', () => {
  const none = hide();
  assert.equal(f.withoutHidden(CATALOG, none), CATALOG, 'the same array, so a memo on it does not rerun');
  assert.deepEqual(f.hiddenInCatalog(CATALOG, none), []);
  assert.equal(f.visiblePick(CATALOG, none, scout), scout(CATALOG));
  assert.equal(f.visiblePick(CATALOG, none, owners), owners(CATALOG));
  assert.deepEqual(ids(topClimbers(f.withoutHidden(CATALOG, none) as never[], 12) as never[]), ['small', 'c1', 'c2', 'c3']);
});

test('the Scout pick: when today\'s pick is hidden the next one stands in; hiding another app leaves it alone', () => {
  const today = scout(CATALOG);
  assert.equal(today?.id, CLIMBERS[DAY_INDEX % 3], 'the fixture picks a climber today');

  // Today's pick hidden: the pick is made again over the rest, so it is a
  // different credible climber (the two left rotate by the same UTC day).
  const left = CLIMBERS.filter((id) => id !== today!.id);
  const stand = f.visiblePick(CATALOG, hide(today!.id), scout);
  assert.equal(stand?.id, left[DAY_INDEX % 2]);

  // Hiding an app that is not today's pick does not reshuffle the rotation.
  for (const other of [...left, 'big', 'quiet', 'small', 'o1']) {
    assert.equal(f.visiblePick(CATALOG, hide(other), scout)?.id, today!.id, `hid ${other}`);
  }

  // Every climber hidden: scoutPick's own fallback (the top trend app) takes over.
  assert.equal(f.visiblePick(CATALOG, hide(...CLIMBERS), scout)?.id, 'big');
  // And that one hidden too: the next best trend that is left, never a hidden app.
  const next = f.visiblePick(CATALOG, hide(...CLIMBERS, 'big'), scout);
  assert.equal(next?.id, 'quiet');
});

test('the owners\' pick: a hidden pick hands over to the next chip app, then to no owners\' pick at all', () => {
  const today = owners(CATALOG);
  assert.equal(today?.id, ['o1', 'o2'][DAY_INDEX % 2]);
  const other = today!.id === 'o1' ? 'o2' : 'o1';
  assert.equal(f.visiblePick(CATALOG, hide(today!.id), owners)?.id, other);
  assert.equal(f.visiblePick(CATALOG, hide(other), owners)?.id, today!.id);
  // Both hidden: no owners' pick, so the hero shows the Scout pick, which is not hidden.
  const both = hide('o1', 'o2');
  assert.equal(f.visiblePick(CATALOG, both, owners), undefined);
  const hero = f.visiblePick(CATALOG, both, owners) ?? f.visiblePick(CATALOG, both, scout);
  assert.ok(hero && !both.has(hero.id));
});

test('all hidden: an empty feed, every app under Hidden in catalog order, no picks, no climbers', () => {
  const all = hide(...CATALOG.map((a) => a.id));
  assert.deepEqual(f.withoutHidden(CATALOG, all), []);
  assert.deepEqual(ids(f.hiddenInCatalog(CATALOG, all)), ids(CATALOG));
  assert.equal(f.visiblePick(CATALOG, all, scout), undefined);
  assert.equal(f.visiblePick(CATALOG, all, owners), undefined);
  assert.deepEqual(topClimbers(f.withoutHidden(CATALOG, all) as never[], 12), []);
});

test('ids the catalog does not list (a delisted app, the offline seed): not counted, not shown, kept on the list', () => {
  const list = hide('gone.app', 'c2');
  assert.deepEqual(ids(f.hiddenInCatalog(CATALOG, list)), ['c2'], 'Hidden (1), not Hidden (2)');
  assert.deepEqual(ids(f.withoutHidden(CATALOG, list)), ['big', 'c1', 'c3', 'quiet', 'small', 'o1', 'o2']);
  assert.deepEqual([...list], ['gone.app', 'c2'], 'the helpers never edit the list');

  // Only unknown ids: the feed is the whole catalog and the chip has nothing to count.
  const gone = hide('gone.app');
  assert.deepEqual(ids(f.withoutHidden(CATALOG, gone)), ids(CATALOG));
  assert.deepEqual(f.hiddenInCatalog(CATALOG, gone), []);
  assert.equal(f.visiblePick(CATALOG, gone, scout), scout(CATALOG));
});

test('Top climbers skip a hidden app and keep their order', () => {
  const rail = topClimbers(f.withoutHidden(CATALOG, hide('small', 'c2')) as never[], 12) as never[];
  assert.deepEqual(ids(rail), ['c1', 'c3']);
});

test('a junk row in a hand-edited catalog does not throw and is never listed as hidden', () => {
  const junk = [app('a'), null, app('b')] as App[];
  // The feed leaves the junk row where it was (dropping it is not this list's job).
  assert.deepEqual(f.withoutHidden(junk, hide('a')), [null, junk[2]]);
  assert.deepEqual(ids(f.hiddenInCatalog(junk, hide('a', 'b'))), ['a', 'b']);
});

test('the label on the toggle and on a hidden app\'s card', () => {
  assert.equal(f.NOT_FOR_ME_LABEL, 'Not for me');
});
