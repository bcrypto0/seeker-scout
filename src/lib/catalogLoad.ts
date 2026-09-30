/**
 * When and how often the app downloads the hosted catalog, with the clock,
 * the timers and the download itself injected, so `npm run test:app` drives
 * it in Node. No React Native import, like vouchCore.ts: catalog.ts wires it
 * to fetch, AppState and the bundled seed.
 *
 * What it fixes: on a slow link (about 100 KB/s; the catalog is about 470 KB
 * gzipped) the single 15 s try aborted mid-download at startup, and every
 * screen kept the offline seed until a cold restart.
 *
 * - A caller waits at most CATALOG_SOFT_MS (the old 15 s) for the live list,
 *   then gets the seed. The download is not aborted: it runs on until
 *   CATALOG_HARD_MS, and when it lands every subscriber gets the live list.
 * - One download at a time: every caller joins the one in flight.
 * - A download that fails while no live list is in memory is retried in the
 *   background after each wait in CATALOG_RETRY_MS, never while the app is in
 *   the background (a retry that comes due then waits for the foreground).
 *   While a retry is scheduled, callers get the seed at once instead of each
 *   starting a download; `force` (pull to refresh, a Retry link) starts one
 *   now, and so does the app coming back to the foreground once
 *   CATALOG_RETRY_MS[0] has passed since the last try. After the last wait
 *   the round is over: the next screen that asks, or the app coming back to
 *   the foreground, starts a new round.
 * - On a fast link nothing changes: the first download lands well inside
 *   CATALOG_SOFT_MS and its callers get the live list from it, as before.
 */

/** How long a caller waits for the live list before it gets the seed (the download keeps going). */
export const CATALOG_SOFT_MS = 15_000;
/** How long one download may run before it is aborted and counts as failed. */
export const CATALOG_HARD_MS = 90_000;
/** The waits before background retries 1..6 after failed downloads; then the round is over. */
export const CATALOG_RETRY_MS: readonly number[] = Object.freeze([5_000, 15_000, 30_000, 60_000, 120_000, 300_000]);

/**
 * The wait before the next background download after `failures` failed ones
 * in a row (1 = the first failure), or null once the round is over.
 */
export function catalogRetryDelay(failures: number): number | null {
  if (!Number.isInteger(failures) || failures < 1 || failures > CATALOG_RETRY_MS.length) return null;
  return CATALOG_RETRY_MS[failures - 1];
}

export interface CatalogLoaderDeps<T> {
  /** One download of the live list. Rejects, or resolves null or [], on any failure; `signal` aborts it. */
  download: (signal: AbortSignal) => Promise<T[] | null>;
  /** What callers get while there is no live list: the bundled offline catalog. */
  seed: T[];
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
  /** False while the app is in the background; a retry that comes due then waits for resume(). */
  foreground?: () => boolean;
}

export interface CatalogLoader<T> {
  /** The live list, or the seed when none arrived within CATALOG_SOFT_MS. `force` skips the memory copy. */
  get(force?: boolean): Promise<T[]>;
  /** The live list in memory, or null. */
  cached(): T[] | null;
  /** Called with every live list that lands, including one that lands after its callers got the seed. */
  subscribe(fn: (list: T[]) => void): () => void;
  /** The app came back to the foreground. */
  resume(): void;
}

type Run<T> = { startedAt: number; done: Promise<T[] | null> };

export function createCatalogLoader<T>(deps: CatalogLoaderDeps<T>): CatalogLoader<T> {
  let cache: T[] | null = null;
  let current: Run<T> | null = null;
  let retryTimer: unknown = null;
  // A retry came due while the app was in the background.
  let retryDue = false;
  let failures = 0;
  let lastEndedAt = Number.NEGATIVE_INFINITY;
  const listeners = new Set<(list: T[]) => void>();
  const inForeground = () => (deps.foreground ? deps.foreground() : true);

  function cancelRetry(): void {
    if (retryTimer !== null) deps.clearTimer(retryTimer);
    retryTimer = null;
    retryDue = false;
  }

  function landed(list: T[] | null): void {
    lastEndedAt = deps.now();
    if (list) {
      cache = list;
      failures = 0;
      for (const fn of [...listeners]) {
        try {
          fn(list);
        } catch {
          // One screen's handler must not keep the list from the others.
        }
      }
      return;
    }
    // A failed refresh keeps the live list it had; only the seed on screen needs retries.
    if (cache) return;
    failures += 1;
    const wait = catalogRetryDelay(failures);
    if (wait === null) failures = 0; // round over: the next ask starts a new one
    else retryTimer = deps.setTimer(retryNow, wait);
  }

  function start(): Run<T> {
    if (current) return current;
    cancelRetry();
    const controller = new AbortController();
    const hard = deps.setTimer(() => controller.abort(), CATALOG_HARD_MS);
    const run: Run<T> = {
      startedAt: deps.now(),
      done: Promise.resolve()
        .then(() => deps.download(controller.signal))
        .then(
          (list) => (Array.isArray(list) && list.length > 0 ? list : null),
          () => null,
        )
        .then((list) => {
          deps.clearTimer(hard);
          if (current === run) current = null;
          landed(list);
          return list;
        }),
    };
    current = run;
    return run;
  }

  function retryNow(): void {
    retryTimer = null;
    if (cache || current) return;
    if (!inForeground()) {
      retryDue = true;
      return;
    }
    start();
  }

  /** The download's answer if it lands within `ms`, else null (it keeps going). */
  function within(done: Promise<T[] | null>, ms: number): Promise<T[] | null> {
    return new Promise((resolve) => {
      const id = deps.setTimer(() => resolve(null), ms);
      done.then((list) => {
        deps.clearTimer(id);
        resolve(list);
      });
    });
  }

  async function get(force = false): Promise<T[]> {
    if (cache && !force) return cache;
    // Backing off after a failure: the seed now; the scheduled retry delivers the live list.
    if (!force && !current && retryTimer !== null) return deps.seed;
    const run = start();
    const left = run.startedAt + CATALOG_SOFT_MS - deps.now();
    const list = left > 0 ? await within(run.done, left) : null;
    return list ?? cache ?? deps.seed;
  }

  function resume(): void {
    if (cache || current) return;
    // A retry that came due in the background, a scheduled wait (coming back
    // to the app is often coming back online; start() drops the scheduled
    // retry), or a round that is over. Never within the first retry wait of
    // the last try, however often the app is switched to.
    if (retryDue || deps.now() - lastEndedAt >= CATALOG_RETRY_MS[0]) start();
  }

  return {
    get,
    cached: () => cache,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    resume,
  };
}
