/**
 * Scout Vouch stamps: copies the Lounge worker's public per-app head counts
 * (GET /vouch/aggregate) onto the catalog after it is built, the same slot
 * as enrich-onchain.mjs. scripts/refresh-catalog.mjs runs it on the STAGED
 * catalog (step 2c).
 *
 * Adds per vouched app, only when the package is already in the catalog:
 *   vouchVoices    distinct Genesis Tokens that vouched (one voice each)
 *   vouchWorksPct  share of those voices saying it works, 0..100 (head count)
 *   vouchRank      1-based place among vouched catalog apps, in the worker's
 *                  order (it orders by weighted works voices server side;
 *                  no weight is copied, the worker sends none)
 *   worksOnSeeker  true, only when the worker says so (its rule: 3 distinct
 *                  Genesis Tokens, weighted works >= 3, 80% works). Never
 *                  computed here or in the app.
 * Nothing else: no weights, no dates, no notes. seedVaultNative is never
 * touched (it stays the hand-verified overrides.json flag).
 *
 * Never blocks the deploy and never adds an app. The worker accepts any
 * package-shaped id, so a row whose package is not in the catalog is ignored
 * (it takes no rank either). If the live aggregate is unreachable or
 * malformed, the last good copy (indexer/vouch-aggregate.last.json, at most
 * 3 days old) is used; without one, nothing is stamped (absent = unknown,
 * never zero). Old vouch fields are always cleared first, so the output is a
 * function of the catalog and the aggregate alone. The catalog is written
 * atomically, and only when a vouch field changed.
 *
 * Usage:  node indexer/enrich-vouches.mjs [catalogPath]
 * Exit 1 only when the catalog itself cannot be read (the caller keeps the
 * file as it was); a worker failure is a warning and exit 0.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGGREGATE_URL = 'https://seeker-lounge.bcrypto-eth.workers.dev/vouch/aggregate';
/** Every field this script owns on a catalog entry. Cleared before each stamp. */
export const VOUCH_FIELDS = Object.freeze(['vouchVoices', 'vouchWorksPct', 'vouchRank', 'worksOnSeeker']);
export const MAX_CACHE_AGE_MS = 3 * 86_400_000;
const FETCH_TIMEOUT_MS = 20_000; // refresh-catalog.mjs live-verify idiom
// The worker caps the list at 2000 rows of ~220 bytes; anything far past that is not its answer.
const MAX_BODY_CHARS = 2_000_000;
const MAX_PACKAGE = 255;
const DEFAULT_CATALOG = fileURLToPath(new URL('./catalog.json', import.meta.url));
const DEFAULT_CACHE = fileURLToPath(new URL('./vouch-aggregate.last.json', import.meta.url));

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/** One aggregate row, or null when it is not the documented shape (the row is then dropped, not guessed at). */
function parseRow(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (typeof r.package !== 'string' || r.package.length === 0 || r.package.length > MAX_PACKAGE) return null;
  const voices = count(r.voices);
  const worksVoices = count(r.works_voices);
  const worksPct = count(r.works_pct);
  if (voices === null || voices < 1) return null;
  if (worksVoices === null || worksVoices > voices) return null;
  if (worksPct === null || worksPct > 100) return null;
  if (typeof r.works_on_seeker !== 'boolean') return null;
  return { package: r.package, voices, worksPct, worksOnSeeker: r.works_on_seeker };
}

/**
 * The GET /vouch/aggregate body, rows in the worker's order. Null when the
 * body is not `{ apps: [...] }`. Bad rows and repeated packages are dropped
 * and counted; an empty list is a valid answer (nothing vouched).
 */
export function parseAggregate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.apps)) return null;
  const rows = [];
  const seen = new Set();
  let dropped = 0;
  for (const raw of body.apps) {
    const row = parseRow(raw);
    if (!row || seen.has(row.package)) {
      dropped += 1;
      continue;
    }
    seen.add(row.package);
    rows.push(row);
  }
  return { rows, dropped };
}

/**
 * Pure: returns a new catalog array with the vouch fields cleared from every
 * app and set again from `body` (null or malformed = set on none). The input
 * is not mutated; apps without vouch fields before or after keep their
 * object. Same length and order as the input, always.
 */
export function stampVouches(catalog, body) {
  if (!Array.isArray(catalog)) throw new TypeError('catalog is not an array');
  const agg = parseAggregate(body);
  const position = new Map(); // package -> index of its first catalog entry
  catalog.forEach((app, i) => {
    if (app && typeof app === 'object' && typeof app.id === 'string' && !position.has(app.id)) {
      position.set(app.id, i);
    }
  });
  const stamps = new Map(); // catalog index -> fields
  let unknown = 0;
  for (const row of agg?.rows ?? []) {
    const i = position.get(row.package);
    if (i === undefined) {
      unknown += 1;
      continue;
    }
    const fields = { vouchVoices: row.voices, vouchWorksPct: row.worksPct, vouchRank: stamps.size + 1 };
    if (row.worksOnSeeker) fields.worksOnSeeker = true;
    stamps.set(i, fields);
  }
  let changed = false;
  let chips = 0;
  const out = catalog.map((app, i) => {
    if (!app || typeof app !== 'object') return app;
    const fields = stamps.get(i);
    if (!fields && !VOUCH_FIELDS.some((f) => Object.hasOwn(app, f))) return app;
    const next = { ...app };
    for (const f of VOUCH_FIELDS) delete next[f];
    if (fields) {
      Object.assign(next, fields);
      if (fields.worksOnSeeker) chips += 1;
    }
    if (VOUCH_FIELDS.some((f) => app[f] !== next[f] || Object.hasOwn(app, f) !== Object.hasOwn(next, f))) {
      changed = true;
    }
    return next;
  });
  return {
    catalog: out,
    valid: agg !== null,
    stamped: stamps.size,
    chips,
    unknown,
    dropped: agg?.dropped ?? 0,
    changed,
  };
}

/** Temp file + rename, so a killed run leaves the old file or the new one, never half of one. */
function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

async function fetchAggregate(url, fetchImpl, timeoutMs) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch');
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!res || !res.ok) throw new Error(`HTTP ${res?.status ?? '?'}`);
  const text = await res.text();
  if (text.length > MAX_BODY_CHARS) throw new Error('body too large');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('not JSON');
  }
  if (!parseAggregate(body)) throw new Error('unexpected shape');
  return body;
}

/** The last good copy, when it parses, has the aggregate shape and is at most MAX_CACHE_AGE_MS old. */
function readCache(cachePath, now) {
  if (!cachePath || !existsSync(cachePath)) return { body: null, why: 'no last good copy' };
  try {
    const saved = JSON.parse(readFileSync(cachePath, 'utf8'));
    const at = Date.parse(saved?.fetched_at ?? '');
    const age = now - at;
    // A copy stamped in the future (clock moved back) is not trusted either.
    if (!Number.isFinite(age) || age < -3_600_000 || age > MAX_CACHE_AGE_MS) {
      return { body: null, why: 'the last good copy is too old' };
    }
    if (!parseAggregate(saved.body)) return { body: null, why: 'the last good copy is unreadable' };
    return { body: saved.body, fetchedAt: saved.fetched_at };
  } catch {
    return { body: null, why: 'the last good copy is unreadable' };
  }
}

/**
 * Live aggregate, else the last good copy, else null. Never throws: every
 * failure is a warning. A good live answer (an empty list included) replaces
 * the last good copy.
 */
export async function loadAggregate({
  url = AGGREGATE_URL,
  fetchImpl = globalThis.fetch,
  cachePath = DEFAULT_CACHE,
  now = Date.now(),
  timeoutMs = FETCH_TIMEOUT_MS,
  warn = console.warn,
} = {}) {
  let reason;
  try {
    const body = await fetchAggregate(url, fetchImpl, timeoutMs);
    if (cachePath) {
      try {
        writeAtomic(cachePath, JSON.stringify({ fetched_at: new Date(now).toISOString(), body }));
      } catch (e) {
        warn(`enrich-vouches: could not save the last good copy (${e?.message ?? e})`);
      }
    }
    return { body, source: 'live' };
  } catch (e) {
    reason = e?.name === 'TimeoutError' ? 'timed out' : (e?.message ?? String(e));
  }
  const cached = readCache(cachePath, now);
  if (cached.body) {
    warn(`enrich-vouches: live aggregate failed (${reason}); using the last good copy from ${cached.fetchedAt}`);
    return { body: cached.body, source: 'cache' };
  }
  warn(`enrich-vouches: live aggregate failed (${reason}) and ${cached.why}; stamping nothing`);
  return { body: null, source: 'none' };
}

/** Read the catalog, stamp it, write it back when a vouch field changed. Throws only on an unreadable catalog. */
export async function run({
  catalogPath = DEFAULT_CATALOG,
  cachePath = DEFAULT_CACHE,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  url = AGGREGATE_URL,
  timeoutMs = FETCH_TIMEOUT_MS,
  log = console.log,
  warn = console.warn,
} = {}) {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  if (!Array.isArray(catalog)) throw new Error('catalog is not an array');
  const { body, source } = await loadAggregate({ url, fetchImpl, cachePath, now, timeoutMs, warn });
  const r = stampVouches(catalog, body);
  if (r.catalog.length !== catalog.length) throw new Error('stamping changed the app count'); // cannot happen
  if (r.changed) writeAtomic(catalogPath, JSON.stringify(r.catalog, null, 1));
  const from = source === 'live' ? 'live aggregate' : source === 'cache' ? 'last good copy' : 'no aggregate';
  log(
    `enrich-vouches: ${from}; stamped ${r.stamped} app(s), ${r.chips} with Works on Seeker` +
      (r.unknown ? `; ${r.unknown} package(s) not in the catalog ignored` : '') +
      (r.dropped ? `; ${r.dropped} malformed row(s) dropped` : '') +
      (r.changed ? '' : '; catalog unchanged'),
  );
  return { ...r, source };
}

if (process.argv[1]?.replace(/\\/g, '/').split('/').pop() === 'enrich-vouches.mjs') {
  run({ catalogPath: process.argv[2] ? resolve(process.argv[2]) : DEFAULT_CATALOG }).catch((e) => {
    console.error(`enrich-vouches: ${e?.message ?? e}`);
    process.exit(1);
  });
}
