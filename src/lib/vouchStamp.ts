/**
 * Reading the Scout Vouch stamps on catalog entries: the Works on Seeker chip
 * (AppCard, the app page) and the Discover hero's owners' pick.
 *
 * indexer/enrich-vouches.mjs copies the Lounge worker's public GET
 * /vouch/aggregate onto the catalog once a day, for catalog apps only:
 * vouchVoices, vouchWorksPct, vouchRank and, only when the worker says so,
 * worksOnSeeker: true. The worker alone decides the chip (3 distinct Genesis
 * Tokens, weighted works 3 or more, 80% say it works); nothing here
 * re-evaluates it. An absent field means nobody vouched or that day's stamp
 * was skipped, never zero. catalog.ts casts the hosted JSON without per-field
 * checks and the offline seed carries no stamps, so every read guards its type.
 *
 * Pure, with no React Native import and a type-only import, so `npm run
 * test:app` loads it with Node's type stripping (src/lib/vouchStamp.test.ts).
 */
import type { DappEntry } from './types';

/** The fields the stamper owns (indexer/enrich-vouches.mjs VOUCH_FIELDS); the test pins both lists together. */
export const STAMP_FIELDS = ['vouchVoices', 'vouchWorksPct', 'vouchRank', 'worksOnSeeker'] as const;

export const WORKS_CHIP_LABEL = 'Works on Seeker';
export const WORKS_CHIP_A11Y = 'Works on Seeker, from Seeker owner vouches';

/** The package id of this app: the hero never recommends the app it is shown in. */
export const SELF_ID = 'com.bilal.seekerscout';

/** How many of the best-ranked chip apps the owners' pick rotates across, one per UTC day. */
export const OWNERS_PICK_POOL = 5;

type Stamped = Pick<DappEntry, 'id' | 'vouchVoices' | 'vouchWorksPct' | 'vouchRank' | 'worksOnSeeker'>;

const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

/** The catalog stamp's chip: a real boolean true only ('true' or 1 from a bad file is no chip). */
export function hasWorksChip(app: Pick<DappEntry, 'worksOnSeeker'> | null | undefined): boolean {
  return app?.worksOnSeeker === true;
}

/**
 * The chip on the app page header. The page also reads the worker live
 * (VouchCard); once that answer is in, it wins over the day-old stamp, so the
 * header never disagrees with the numbers under it. Before it, or when the
 * read failed, the stamp stands.
 */
export function worksChipShown(
  app: Pick<DappEntry, 'worksOnSeeker'> | null | undefined,
  live: { worksOnSeeker: boolean } | null | undefined,
): boolean {
  return live ? live.worksOnSeeker === true : hasWorksChip(app);
}

/** Stamped owner count, or null when absent or not a count. */
export function vouchVoicesOf(app: Pick<DappEntry, 'vouchVoices'>): number | null {
  return count(app.vouchVoices);
}

/** Stamped place among vouched catalog apps (1 = first), or null. */
export function vouchRankOf(app: Pick<DappEntry, 'vouchRank'>): number | null {
  const r = count(app.vouchRank);
  return r !== null && r >= 1 ? r : null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The hero's line under the chip, e.g. "4 owners vouched · 100% say it
 * works". Null when the counts are missing or do not fit together, so the
 * hero shows the chip alone rather than a made-up number.
 */
export function ownersLine(app: Pick<DappEntry, 'vouchVoices' | 'vouchWorksPct'>): string | null {
  const voices = count(app.vouchVoices);
  const pct = count(app.vouchWorksPct);
  if (voices === null || voices < 1) return null;
  const vouched = `${plural(voices, 'owner')} vouched`;
  return pct === null || pct > 100 ? vouched : `${vouched} · ${pct}% say it works`;
}

const utcDay = (now: Date) =>
  Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86_400_000);

/**
 * The Discover hero's owners' pick, or undefined when no app carries the
 * chip (then the hero keeps the Scout Pick). Candidates are the apps the
 * worker marked Works on Seeker, minus this app itself, best stamped rank
 * first (the worker's own order; an app without a rank goes last, ties by
 * id). The pick rotates across the first OWNERS_PICK_POOL of them by UTC
 * day, like scoutPick's gem tier: deterministic for every device on the same
 * day, and not the same app every day while several qualify.
 */
export function ownersPick<T extends Stamped>(apps: readonly T[], now: Date = new Date()): T | undefined {
  const pool = apps
    .filter((a) => !!a && hasWorksChip(a) && a.id !== SELF_ID)
    .map((a) => ({ a, rank: vouchRankOf(a) ?? Number.POSITIVE_INFINITY }))
    .sort((x, y) => x.rank - y.rank || (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0))
    .slice(0, OWNERS_PICK_POOL)
    .map((x) => x.a);
  if (!pool.length) return undefined;
  const day = utcDay(now);
  return pool[((day % pool.length) + pool.length) % pool.length];
}
