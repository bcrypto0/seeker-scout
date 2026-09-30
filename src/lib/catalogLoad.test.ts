// src/lib/catalogLoad.test.ts: `npm run test:app` (node --test; Node 24 strips the types).
// The catalog download schedule on a fake clock: a fast link unchanged, a slow
// link that shows the seed and swaps in the live list when it lands, the retry
// waits, one download at a time, and no retries in the background.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from './catalogLoad.ts';

type App = { id: string };
const SEED: App[] = [{ id: 'seed' }];
const LIVE: App[] = [{ id: 'a' }, { id: 'b' }];

const flush = () => new Promise<void>((r) => setImmediate(r));

/** Timers on a clock that only moves when the test says so. */
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      seq += 1;
      timers.set(seq, { at: t + ms, fn });
      return seq;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    /** Moves the clock forward, firing every timer that comes due on the way, in order. */
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        await flush();
        const next = [...timers.entries()]
          .filter(([, x]) => x.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
      await flush();
    },
    /** Milliseconds until each pending timer fires. */
    waits: () => [...timers.values()].map((x) => x.at - t).sort((a, b) => a - b),
  };
}

/** Downloads the test answers by hand; an abort rejects the way fetch does. */
function scriptedDownloads() {
  const calls: { signal: AbortSignal; resolve: (v: App[] | null) => void; reject: (e: unknown) => void }[] = [];
  const download = (signal: AbortSignal) =>
    new Promise<App[] | null>((resolve, reject) => {
      calls.push({ signal, resolve, reject });
      signal.addEventListener('abort', () => reject(new Error('Aborted')));
    });
  return { calls, download, last: () => calls[calls.length - 1] };
}

function setup(opts: { foreground?: () => boolean } = {}) {
  const clock = fakeClock();
  const net = scriptedDownloads();
  const seen: App[][] = [];
  const loader = c.createCatalogLoader<App>({
    download: net.download,
    seed: SEED,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    foreground: opts.foreground,
  });
  loader.subscribe((list) => seen.push(list));
  return { clock, net, loader, seen };
}

/** Settles a promise the test does not await yet, so its value can be checked later. */
function track<T>(p: Promise<T>) {
  const box: { done: boolean; value?: T } = { done: false };
  p.then((v) => {
    box.done = true;
    box.value = v;
  });
  return box;
}

test('catalogRetryDelay: 5 s, 15 s, 30 s, 1 min, 2 min, 5 min, then the round is over', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(c.catalogRetryDelay), [5_000, 15_000, 30_000, 60_000, 120_000, 300_000]);
  for (const n of [7, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(c.catalogRetryDelay(n), null);
  // The whole round, background time included, stays under nine minutes.
  assert.equal(c.CATALOG_RETRY_MS.reduce((a, b) => a + b, 0), 530_000);
  assert.equal(c.CATALOG_SOFT_MS, 15_000); // what a caller waits at most, as before
  assert.ok(c.CATALOG_HARD_MS > c.CATALOG_SOFT_MS);
});

test('fast link: the live list straight from the first download, then from memory; nothing scheduled', async () => {
  const { clock, net, loader, seen } = setup();
  const first = track(loader.get());
  await clock.advance(1_200);
  net.last().resolve(LIVE);
  await clock.advance(0);
  assert.equal(first.value, LIVE);
  assert.equal(loader.cached(), LIVE);
  assert.deepEqual(seen, [LIVE]);
  assert.equal(await loader.get(), LIVE);
  assert.equal(net.calls.length, 1);
  assert.deepEqual(clock.waits(), []); // no retry, no leftover soft or hard timer
});

test('slow link: the seed after 15 s, the download keeps going, and the live list reaches subscribers when it lands', async () => {
  const { clock, net, loader, seen } = setup();
  const first = track(loader.get());
  const second = track(loader.get()); // Rewards prefetch while Discover waits: one download
  assert.equal(net.calls.length, 0); // starts on the next tick
  await clock.advance(14_999);
  assert.equal(net.calls.length, 1);
  assert.equal(first.done, false);
  await clock.advance(1);
  assert.equal(first.value, SEED);
  assert.equal(second.value, SEED);
  assert.equal(net.last().signal.aborted, false);
  // A screen that asks after the soft deadline gets the seed at once and joins the same download.
  const late = track(loader.get());
  await clock.advance(0);
  assert.equal(late.value, SEED);
  await clock.advance(20_000);
  net.last().resolve(LIVE);
  await clock.advance(0);
  assert.deepEqual(seen, [LIVE]);
  assert.equal(loader.cached(), LIVE);
  assert.equal(net.calls.length, 1);
  assert.deepEqual(clock.waits(), []);
});

test('a download that runs past CATALOG_HARD_MS is aborted and retried after 5 s', async () => {
  const { clock, net, loader } = setup();
  const first = track(loader.get());
  await clock.advance(c.CATALOG_HARD_MS - 1);
  assert.equal(first.value, SEED);
  assert.equal(net.last().signal.aborted, false);
  await clock.advance(1);
  assert.equal(net.calls[0].signal.aborted, true);
  assert.deepEqual(clock.waits(), [5_000]);
  await clock.advance(5_000);
  assert.equal(net.calls.length, 2);
  assert.equal(net.last().signal.aborted, false);
});

test('offline: the seed at once, retries on the schedule while callers get the seed without new downloads, then the round ends', async () => {
  const { clock, net, loader, seen } = setup();
  const first = track(loader.get());
  await clock.advance(0);
  net.last().reject(new TypeError('Network request failed'));
  await clock.advance(0);
  assert.equal(first.value, SEED); // no 15 s wait when the network says no
  assert.equal(clock.now(), 0);
  // Screens mounting during the wait get the seed at once and do not start their own downloads.
  const mounted = track(loader.get());
  await clock.advance(0);
  assert.equal(mounted.value, SEED);
  assert.equal(net.calls.length, 1);
  const started: number[] = [];
  for (const wait of c.CATALOG_RETRY_MS) {
    assert.deepEqual(clock.waits(), [wait]);
    await clock.advance(wait);
    started.push(clock.now());
    net.last().reject(new TypeError('Network request failed'));
    await clock.advance(0);
  }
  assert.deepEqual(started, [5_000, 20_000, 50_000, 110_000, 230_000, 530_000]);
  assert.equal(net.calls.length, 7);
  assert.deepEqual(clock.waits(), []); // round over: nothing more in the background
  assert.deepEqual(seen, []);
  // The next screen that asks starts a new round.
  const again = track(loader.get());
  await clock.advance(0);
  assert.equal(net.calls.length, 8);
  net.last().resolve([]); // an empty file counts as a failure too
  await clock.advance(0);
  assert.equal(again.value, SEED);
  assert.deepEqual(clock.waits(), [5_000]);
});

test('a background retry that succeeds swaps in the live list and ends the schedule', async () => {
  const { clock, net, loader, seen } = setup();
  const first = track(loader.get());
  await clock.advance(0);
  net.last().resolve(null);
  await clock.advance(5_000);
  assert.equal(first.value, SEED);
  assert.equal(net.calls.length, 2);
  net.last().resolve(LIVE);
  await clock.advance(0);
  assert.deepEqual(seen, [LIVE]);
  assert.equal(await loader.get(), LIVE);
  assert.deepEqual(clock.waits(), []);
});

test('force (Retry, pull to refresh) during the wait starts a download now and drops the scheduled one', async () => {
  const { clock, net, loader } = setup();
  loader.get();
  await clock.advance(0);
  net.last().reject(new Error('down'));
  await clock.advance(2_000);
  assert.deepEqual(clock.waits(), [3_000]);
  const retry = track(loader.get(true));
  await clock.advance(0);
  assert.equal(net.calls.length, 2);
  net.last().resolve(LIVE);
  await clock.advance(0);
  assert.equal(retry.value, LIVE);
  await clock.advance(10_000);
  assert.equal(net.calls.length, 2);
});

test('a failed refresh keeps the live list in memory and schedules nothing', async () => {
  const { clock, net, loader } = setup();
  loader.get();
  await clock.advance(0);
  net.last().resolve(LIVE);
  await clock.advance(0);
  const refresh = track(loader.get(true));
  await clock.advance(0);
  net.last().reject(new Error('down'));
  await clock.advance(0);
  assert.equal(refresh.value, LIVE); // not the seed over a good list
  assert.equal(loader.cached(), LIVE);
  assert.deepEqual(clock.waits(), []);
});

test('no downloads in the background: a retry that comes due waits for the foreground', async () => {
  let fg = true;
  const { clock, net, loader, seen } = setup({ foreground: () => fg });
  loader.get();
  await clock.advance(0);
  net.last().reject(new Error('down'));
  await clock.advance(0);
  fg = false;
  await clock.advance(60_000);
  assert.equal(net.calls.length, 1);
  assert.deepEqual(clock.waits(), []);
  fg = true;
  loader.resume();
  await clock.advance(0);
  assert.equal(net.calls.length, 2);
  net.last().resolve(LIVE);
  await clock.advance(0);
  assert.deepEqual(seen, [LIVE]);
  loader.resume(); // a live list in memory: nothing to do
  await clock.advance(0);
  assert.equal(net.calls.length, 2);
});

test('resume: a new round once the last one is over, never within 5 s of the last try, nothing while a download runs', async () => {
  const { clock, net, loader } = setup();
  loader.get();
  await clock.advance(0);
  net.last().reject(new Error('down'));
  await clock.advance(0);
  loader.resume(); // the last try ended just now: the scheduled 5 s retry stands
  await clock.advance(0);
  assert.equal(net.calls.length, 1);
  assert.deepEqual(clock.waits(), [5_000]);
  // Let the round run out.
  for (const wait of c.CATALOG_RETRY_MS) {
    await clock.advance(wait);
    loader.resume(); // a download is running: no second one
    await clock.advance(0);
    net.last().reject(new Error('down'));
    await clock.advance(0);
  }
  assert.equal(net.calls.length, 7);
  loader.resume(); // the last try ended just now
  await clock.advance(4_999);
  loader.resume();
  await clock.advance(0);
  assert.equal(net.calls.length, 7);
  await clock.advance(1);
  loader.resume();
  await clock.advance(0);
  assert.equal(net.calls.length, 8);
});

test('resume during a long wait: a download now once 5 s have passed since the last try, and the scheduled retry is dropped', async () => {
  const { clock, net, loader, seen } = setup();
  loader.get();
  await clock.advance(0);
  for (const wait of c.CATALOG_RETRY_MS.slice(0, 5)) {
    net.last().reject(new Error('down'));
    await clock.advance(wait);
  }
  net.last().reject(new Error('down'));
  await clock.advance(0);
  assert.equal(net.calls.length, 6);
  assert.deepEqual(clock.waits(), [300_000]); // the last wait of the round
  await clock.advance(4_999);
  loader.resume(); // under 5 s since the last try: keep waiting
  await clock.advance(0);
  assert.equal(net.calls.length, 6);
  await clock.advance(1);
  loader.resume(); // back in the app, maybe back online: try now instead of in 295 s
  await clock.advance(0);
  assert.equal(net.calls.length, 7);
  assert.deepEqual(clock.waits(), [c.CATALOG_HARD_MS]); // only this download's own timer
  net.last().resolve(LIVE);
  await clock.advance(0);
  assert.deepEqual(seen, [LIVE]);
  await clock.advance(300_000);
  assert.equal(net.calls.length, 7); // the dropped retry never fires
  assert.deepEqual(clock.waits(), []);
});

test('subscribers: unsubscribe works and one throwing handler does not stop the others', async () => {
  const { clock, net, loader, seen } = setup();
  const other: App[][] = [];
  const after: App[][] = [];
  const off = loader.subscribe(() => {
    throw new Error('screen handler');
  });
  const gone = loader.subscribe((l) => other.push(l));
  loader.subscribe((l) => after.push(l));
  gone();
  loader.get();
  await clock.advance(0);
  net.last().resolve(LIVE);
  await clock.advance(0);
  assert.deepEqual(seen, [LIVE]);
  assert.deepEqual(after, [LIVE]);
  assert.deepEqual(other, []);
  off();
});
