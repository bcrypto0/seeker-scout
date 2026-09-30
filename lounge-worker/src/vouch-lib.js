// lounge-worker/src/vouch-lib.js
// Pure rules for Scout Vouch. No env, no fetch, no D1: node --test imports this.

export const TAG_BITS = Object.freeze({ wallet_ok: 1, crashes: 2, needs_update: 4 });
export const TAG_NAMES = Object.freeze(['wallet_ok', 'crashes', 'needs_update']); // bit order
export const VERDICTS = Object.freeze(['works', 'broken']);
export const MAX_NOTE = 140;
export const MAX_PACKAGE = 160;
/** The `note:` line renders an empty note as this; a real note equal to it is refused (400 'note reserved'). */
export const NOTE_PLACEHOLDER = '-';
// Android package id: 2+ dot-separated Java identifiers (com.storj_mobile, x.place, fun.cfl.www.twa).
export const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
/** Exactly what new Date().toISOString() emits: 24 chars, millisecond precision, trailing Z. */
export const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isPackageId(s) {
  return typeof s === 'string' && s.length <= MAX_PACKAGE && PACKAGE_RE.test(s);
}

/**
 * Canonical timestamps only: TS_RE's shape AND an instant that toISOString()
 * gives back byte for byte, so '2026-02-30T00:00:00.000Z' or 'T24:00' (which
 * Date.parse quietly rolls forward) are refused. Because every stored
 * signed_ts is 24 chars in this one form, lexicographic order equals
 * chronological order, so the SQL guard (`excluded.signed_ts > vouches.signed_ts`)
 * and supersedes() agree exactly.
 */
export function isCanonicalTs(s) {
  return typeof s === 'string' && TS_RE.test(s) && Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString() === s;
}

export function tagsToMask(tags) {
  if (!Array.isArray(tags)) return 0;
  let mask = 0;
  for (const t of tags) if (typeof t === 'string' && TAG_BITS[t]) mask |= TAG_BITS[t];
  return mask;
}

export function maskToTags(mask) {
  return TAG_NAMES.filter((t) => (mask & TAG_BITS[t]) !== 0);
}

/** Bit-ordered, de-duplicated, or "-" when empty. Same output for [] and undefined. */
export function canonicalTags(tags) {
  const names = maskToTags(tagsToMask(tags));
  return names.length ? names.join(',') : NOTE_PLACEHOLDER;
}

/**
 * Strip anything link-shaped, then collapse whitespace and cut to MAX_NOTE.
 * Same four passes as chat.js sanitize() (blocklist by SHAPE, over-strip is
 * fine); returns '' for non-strings. The worker accepts a note only when
 * note === sanitizeNote(note), which is how it knows the note it stores is
 * the note the wallet signed, so the app's normalizeNote (src/lib/vouch.ts)
 * must give these bytes exactly: plain regexes, no normalize(), no Unicode
 * folding (Hermes on the phone is not relied on for either). Idempotent except
 * in one corner: when a replacement leaves ']' in front of text an earlier
 * pass skipped ('x.io1.2.3.4' -> '[link removed]1.2.3.4'), a second run strips
 * again. Only a note that already held a link gets there, and the worker
 * refuses it with the same 400, so the corner fails closed. Links these ASCII
 * passes cannot see are hasHiddenLink's job, and half an emoji left by the 140
 * cut is hasLoneSurrogate's (same 400).
 */
export function sanitizeNote(raw) {
  if (typeof raw !== 'string') return '';
  const R = '[link removed]';
  let t = raw.replace(/\s+/g, ' ').trim();
  t = t.replace(/\b(?:https?|ftp|tg|solana):\/\/\S+/gi, R);
  t = t.replace(/\bwww\.\S+/gi, R);
  t = t.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?:[:/]\S*)?/g, R);
  t = t.replace(/\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?/gi, R);
  return t.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE).trim();
}

// hasHiddenLink's detection-only classes. Dropped: control, format and mark
// characters, plus the Hangul, Braille and Mongolian fillers that render as
// nothing. LOOKALIKE is one table, by code point, of what reads as the three
// separators a link needs: Unicode's confusables (17.0.0) for FULL STOP,
// MIDDLE DOT, SOLIDUS and COLON, less those NFKD and lowercase already turn
// into ASCII or into another entry (U+2024 and U+FF0E become '.', U+FF61
// becomes U+3002, U+2F03 becomes U+4E3F, U+FF1A becomes ':'), plus U+3002
// (browsers resolve it as a dot), U+06D4, U+2E33, U+1361 and U+1804. A run
// of dots holding at least one look-alike, ASCII dots included, reads as one
// '.'; a run of ASCII dots alone stays, so 'crashed...then' is still prose.
const HIDDEN_DROP = /[\p{Cc}\p{Cf}\p{Mn}\p{Me}\u115f\u1160\u3164\uffa0\u2800\u180e]/gu;
const LOOKALIKE = {
  '.': [0x3002, 0x06d4, 0x2e33,
    0x0660, 0x06f0, 0x0701, 0x0702, 0xa4f8, 0xa60e, 0x10a50, 0x1d16d,                        // FULL STOP
    0x00b7, 0x1427, 0x16eb, 0x2022, 0x2027, 0x2219, 0x22c5, 0x2e31, 0x30fb, 0xa78f, 0x10101], // MIDDLE DOT
  '/': [0x1735, 0x2041, 0x2044, 0x2215, 0x2571, 0x27cb, 0x29f8, 0x1d23a, 0x31d3, 0x3033, 0x2cc7, 0x30ce, 0x4e3f],
  ':': [0x02d0, 0x02f8, 0x0589, 0x05c3, 0x0703, 0x0704, 0x0903, 0x0a83, 0x16ec, 0x1803, 0x1809, 0x205a, 0x2236,
    0xa4fd, 0xa789, 0x11dd9, 0x1361, 0x1804],
};
const cls = (cps) => cps.map((cp) => `\\u{${cp.toString(16)}}`).join('');
const DOT_RUN = new RegExp(`\\.*[${cls(LOOKALIKE['.'])}][.${cls(LOOKALIKE['.'])}]*`, 'gu');
const SLASH_LIKE = new RegExp(`[${cls(LOOKALIKE['/'])}]`, 'gu');
const COLON_LIKE = new RegExp(`[${cls(LOOKALIKE[':'])}]`, 'gu');
/** chat.js sanitize()'s four link shapes, without the g flag so test() keeps no state. */
const LINK_SHAPES = [
  /\b(?:https?|ftp|tg|solana):\/\/\S+/i,
  /\bwww\.\S+/i,
  /\b\d{1,3}(?:\.\d{1,3}){3}(?:[:/]\S*)?/,
  /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?/i,
];

/** Explicit bidi embeddings, overrides and isolates (U+202A-U+202E, U+2066-U+2069). */
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/;

/**
 * True when the note carries a link the ASCII passes of sanitizeNote cannot
 * see: 'jupdrop' + U+3002 + 'com', U+22C5 or U+00B7 for the dot, a zero-width
 * space or a combining mark inside a domain, an accented letter just before
 * the dot, fullwidth letters, U+2215 for the slash, U+A789 for the colon. The
 * worker calls it on a fixed point of sanitizeNote and answers the same 400.
 * Detection only: it runs the four link shapes over a throwaway skeleton
 * (NFKD, so an accent drops off its letter instead of NFKC folding it in;
 * lowercase, before the drop so U+0130 leaves no U+0307 behind; the drop
 * class removed; LOOKALIKE read as '.', '/' and ':'; whitespace collapsed).
 * The skeleton is never stored or returned.
 */
export function hasHiddenLink(note) {
  if (typeof note !== 'string' || note === '') return false;
  // Bidi overrides and isolates reorder what is displayed: 'join ' + U+202E +
  // 'cba/em.t' renders as a t.me link. Nobody types them in a review.
  if (BIDI_CONTROL.test(note)) return true;
  const skeleton = note.normalize('NFKD').toLowerCase().replace(HIDDEN_DROP, '')
    .replace(DOT_RUN, '.').replace(SLASH_LIKE, '/').replace(COLON_LIKE, ':').replace(/\s+/g, ' ');
  return LINK_SHAPES.some((re) => re.test(skeleton));
}

/**
 * True when the string holds half of a surrogate pair. sanitizeNote's 140 cut
 * counts UTF-16 units, so when link removal pushes an emoji across it the cut
 * keeps only the emoji's first half, and that note is still a fixed point of
 * sanitizeNote. D1 stores a lone half as U+FFFD, so the public note would
 * differ from the signed one. The worker refuses such a note with the same
 * 400 (fail closed); the app's prepareNote already drops the trailing half.
 * A code-unit loop, the same test String.prototype.isWellFormed makes.
 */
export function hasLoneSurrogate(s) {
  if (typeof s !== 'string') return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1); // NaN past the end
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** The exact bytes the app asks Seed Vault to sign for a vouch. */
export function vouchMessage({ wallet, mint, ts, package: pkg, verdict, tags, note }) {
  return [
    'Seeker Scout \u2014 Vouch',
    'purpose: vouch-v1',
    `wallet: ${wallet}`,
    `mint: ${mint}`,
    `package: ${pkg}`,
    `verdict: ${verdict}`,
    `tags: ${canonicalTags(tags)}`,
    `note: ${note ? note : NOTE_PLACEHOLDER}`,
    `ts: ${ts}`,
  ].join('\n');
}

// voteMessage (purpose vote-v1) joins this file with the vote commit (SPEC 8.5).

export const WEIGHT_CAP = 4;
/** 1 + min(3, log10(1 + staked/100)), rounded to 2 dp, capped at 4.00. Anything unusable is 1. */
export function weightFor(stakedSkr) {
  const s = typeof stakedSkr === 'number' && Number.isFinite(stakedSkr) && stakedSkr > 0 ? stakedSkr : 0;
  const w = 1 + Math.min(3, Math.log10(1 + s / 100));
  return Math.min(WEIGHT_CAP, Math.round(w * 100) / 100);
}

/**
 * One stake backs one full voice. A wallet that holds n Genesis Tokens (n rows
 * in vouches with this wallet, or n votes this week) splits its stake across
 * them: weight = weightFor(staked / n). n <= 0 or non-integer counts as 1.
 */
export function sharedStakeWeight(stakedSkr, distinctMints) {
  const n = Number.isInteger(distinctMints) && distinctMints > 0 ? distinctMints : 1;
  const s = typeof stakedSkr === 'number' && Number.isFinite(stakedSkr) && stakedSkr > 0 ? stakedSkr : 0;
  return weightFor(s / n);
}

export const CHIP_MIN_VOICES = 3;        // distinct Genesis mints
export const CHIP_MIN_WORKS_WEIGHT = 3;  // sum of weight over 'works'
export const CHIP_MIN_WORKS_PCT = 80;    // HEAD COUNT, not weighted: SKR cannot move it

/**
 * Turn one GROUP BY row (2.6 SQL) into the public aggregate shape: head counts
 * and the chip, no weighted sum. The row's weight_works still decides
 * works_on_seeker here (and orders /vouch/aggregate and /vouch/top in SQL), but
 * it never leaves the worker: on an app with one voice it equals that owner's
 * weight, which weightFor turns back into roughly what the owner stakes, and
 * the difference between two reads gives each new voice's weight.
 */
export function finishAggregate(row) {
  const voices = Number(row.voices) || 0;
  const worksVoices = Number(row.works_voices) || 0;
  const weightWorks = round2(row.weight_works);
  const worksPct = voices ? Math.round((worksVoices * 100) / voices) : 0;
  return {
    package: row.package,
    voices,
    works_voices: worksVoices,
    broken_voices: voices - worksVoices,
    works_pct: worksPct,
    wallet_ok_voices: Number(row.wallet_ok_voices) || 0,
    last_vouch_at: row.last_vouch_at ?? null,
    works_on_seeker:
      voices >= CHIP_MIN_VOICES && weightWorks >= CHIP_MIN_WORKS_WEIGHT && worksPct >= CHIP_MIN_WORKS_PCT,
  };
}
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** ISO-8601 week key in UTC, 'YYYY-Www'. Weeks run Monday 00:00Z to the next Monday 00:00Z. */
export function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;                 // Mon=1 .. Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day);          // the Thursday decides the year
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - jan1) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** [start, end) ISO strings of the week containing `date`, in UTC. */
export function weekBounds(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  const start = d.toISOString();
  d.setUTCDate(d.getUTCDate() + 7);
  return { start, end: d.toISOString() };
}

/** The week key that closed most recently before `date` (used by the catalog stamper). */
export function previousWeek(date = new Date()) {
  return isoWeek(new Date(date.getTime() - 7 * 86_400_000));
}

// WEEK_RE and tallyResult join this file with the vote commit (SPEC 8.5).

/**
 * Monotonic guard shared by vouch and vote upserts. Both sides are canonical
 * (parseVouchBody refuses anything else), so this is the SAME string compare
 * SQLite performs in the upsert WHERE; a stored non-canonical value (none can
 * exist after 001, kept for safety) is always superseded.
 */
export function supersedes(newTs, storedSignedTs) {
  if (!isCanonicalTs(newTs)) return false;
  if (!isCanonicalTs(storedSignedTs)) return true;
  return newTs > storedSignedTs;
}

/**
 * One reading of a settings row for both sides of a kill switch (the worker's
 * POST gate and GET /flags): only '1' is on, any other stored value is off,
 * a missing row is `fallback`. A hand-typed 'false' therefore pauses the
 * worker and hides the app's button together, never one without the other.
 */
export function settingOn(value, fallback) {
  return value === undefined || value === null ? fallback : value === '1';
}
