import { DappEntry } from './types';

/**
 * Auto-generated Discover rails from data we already have — no editorial
 * cost (battle plan §7/§8). All pure functions over the catalog.
 */

// Same prior the indexer uses, so in-app rating rank agrees with the catalog.
const BAYES_PRIOR_COUNT = 200;
const BAYES_PRIOR_MEAN = 4.1;

/** Minimum reviews before a rating is trustworthy enough to filter on. */
export const RATING_MIN_REVIEWS = 20;
/** Threshold for the "great rating" quality filter. */
export const RATING_HIGH = 4.5;
/** Credibility floor for anything we feature as an editorial pick. */
const PICK_MIN_REVIEWS = 50;
/** How many vetted gems the daily hero rotates across (see scoutPick). */
const PICK_POOL = 10;

/**
 * Bayesian-shrunk rating — the honest answer to "sort by review score".
 * Raw rating is a trap: 13 apps sit at a perfect 5.0 and 12 of them have
 * under 10 reviews, so a naive sort returns a wall of one-review shovelware.
 * Pulling sparse ratings toward the global mean puts ★4.8-from-7,000 above
 * ★5.0-from-3, which is what a user actually means by "best rated".
 */
export function bayesRating(a: DappEntry): number {
  const n = a.reviews ?? 0;
  // No reviews = unrankable, not average. Shrinkage would score these at
  // exactly the prior (4.1), floating 32 apps that render "★ 0.0 (0)" above
  // hundreds of apps with thousands of real ratings — in a list the user
  // opened by tapping "Top rated".
  if (n <= 0) return -1;
  return (
    (n / (n + BAYES_PRIOR_COUNT)) * (a.rating ?? 0) +
    (BAYES_PRIOR_COUNT / (n + BAYES_PRIOR_COUNT)) * BAYES_PRIOR_MEAN
  );
}

/** True when an app's rating is both high AND backed by enough reviews. */
export function isHighlyRated(a: DappEntry): boolean {
  return (a.rating ?? 0) >= RATING_HIGH && (a.reviews ?? 0) >= RATING_MIN_REVIEWS;
}

/**
 * Freshness thresholds, in days since the developer's last release.
 *
 * These are the SINGLE SOURCE OF TRUTH: theme.freshness() paints the Active /
 * Aging / Stale badge from the same two numbers, so the badge on a card and
 * the "hide stale" filter in Discover can never disagree. Defining staleness
 * twice is how a user ends up hiding stale apps and still seeing red badges.
 */
export const FRESH_ACTIVE_DAYS = 30;
export const FRESH_STALE_DAYS = 180;

/** Days since the last release, or null when the date is missing/unparseable. */
export function daysSinceUpdate(a: DappEntry, now: number = Date.now()): number | null {
  const t = Date.parse(a.lastUpdated ?? '');
  return Number.isNaN(t) ? null : (now - t) / 86_400_000;
}

/**
 * True when a developer hasn't shipped in over FRESH_STALE_DAYS.
 *
 * An app with no usable release date is UNKNOWN, not stale — hiding it would
 * drop an app for missing metadata rather than for evidence about the app.
 * (No catalog entry lacks a date today; this is the safe direction to fail.)
 *
 * This is the BADGE predicate: it measures dApp Store release age and nothing
 * else. Do not use it to hide apps — see isAbandoned() for why.
 */
export function isStale(a: DappEntry, now: number = Date.now()): boolean {
  const days = daysSinceUpdate(a, now);
  return days !== null && days > FRESH_STALE_DAYS;
}

/**
 * Aliveness overrides for the hide filter. An old listing is spared when the
 * app is demonstrably still in use, by either signal:
 * - velocity: people are still writing reviews (Daemon Protocol: +202/30d on
 *   a 227-day-old listing);
 * - mass: the store's own users have voted at scale (Phantom: 3,008 reviews;
 *   its releases ship via Play Store, so its dApp Store listing ages even
 *   though the app is the most-used wallet on the platform — and its velocity
 *   is LOW, +2/30d, because everyone already has it. Mass is what saves it).
 * Measured against the live catalog: this cut the hidden set from 384 apps
 * (30%, including Phantom #9, Jito #33, SolanaFloor #27) to 173 (13%) whose
 * best-ranked member sat at #94 with +1 review in 30 days.
 */
export const ALIVE_REVIEWS_30D = 3;
export const ALIVE_REVIEW_MASS = 500;

/**
 * The FILTER predicate: old AND quiet, not merely old.
 *
 * "Stale" (the badge) states a fact: no dApp Store release in 6+ months.
 * "Abandoned" (this) makes a judgement: old and showing no signs of use —
 * which is the only thing a user means by "hide the dead ones". Hiding on
 * age alone deletes the platform's pillars for shipping through a different
 * channel. Missing reviews30d fails toward the mass rule alone (an old
 * cached catalog must not start hiding pillars).
 */
export function isAbandoned(a: DappEntry, now: number = Date.now()): boolean {
  if (!isStale(a, now)) return false;
  if ((a.reviews ?? 0) >= ALIVE_REVIEW_MASS) return false;
  if (typeof a.reviews30d === 'number' && a.reviews30d >= ALIVE_REVIEWS_30D) {
    return false;
  }
  return true;
}

/** Biggest daily rank climbers (needs rankDelta from the indexer). */
export function topClimbers(apps: DappEntry[], n = 10): DappEntry[] {
  return apps
    .filter((a) => (a.rankDelta ?? 0) > 0)
    .sort((a, b) => (b.rankDelta ?? 0) - (a.rankDelta ?? 0))
    .slice(0, n);
}

/** Biggest daily fallers. */
export function topFallers(apps: DappEntry[], n = 10): DappEntry[] {
  return apps
    .filter((a) => (a.rankDelta ?? 0) < 0)
    .sort((a, b) => (a.rankDelta ?? 0) - (b.rankDelta ?? 0))
    .slice(0, n);
}

/**
 * Hidden Gems — genuinely good but under-discovered: strong rating, still
 * active, penalised for high review volume (Steam250 style). Surfaces quality
 * apps the trend score buries under popular ones.
 */
export function hiddenGems(apps: DappEntry[], n = 10): DappEntry[] {
  const weekAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  return apps
    .filter((a) => a.rating >= 4.3 && a.reviews >= 20 && a.reviews <= 800 && a.lastUpdated >= weekAgo)
    .map((a) => ({ a, gem: a.rating - Math.log10(a.reviews) * 0.15 }))
    .sort((x, y) => y.gem - x.gem)
    .slice(0, n)
    .map((x) => x.a);
}

/**
 * Back from the dead — apps that revived (Stale/Aging → recently updated).
 * Uses freshness recency vs a long gap before it.
 */
export function freshlyListed(apps: DappEntry[], n = 10): DappEntry[] {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  return apps
    .filter((a) => (a.firstSeen ?? '') >= weekAgo)
    .sort((a, b) => (b.firstSeen ?? '').localeCompare(a.firstSeen ?? ''))
    .slice(0, n);
}

/**
 * Scout Pick — one daily hero. Prefer the biggest genuine climber; fall back
 * to the freshest high-trend app so it's never empty.
 *
 * WHY THE GEM TIER ROTATES (2026-07-31): the first two tiers almost never fire
 * in practice, because PICK_MIN_REVIEWS=50 and the apps that swing hardest are
 * the smallest — measured against the live catalog, the top 6 climbers had
 * 43/2/1/2/4/2 reviews and the 6 newest listings had 1/0/10/8/2/1, so nothing
 * cleared the floor. That is the floor working as intended (it exists because
 * "★5.0 from 10 reviews" once shipped as the hero), but it means the pick lands
 * on hiddenGems() every day — and that is a pure function of the catalog, so it
 * returned the SAME app for days (Tribalchat, gem 4.5550 vs 4.3853 for #2).
 * A "daily hero" that never changes is not a daily hero. Rotating over the
 * vetted pool by UTC day keeps it deterministic (every device shows the same
 * pick on the same day) while actually varying.
 */
export function scoutPick(apps: DappEntry[], now: Date = new Date()): DappEntry | undefined {
  // Every candidate must clear a credibility floor. The hero is the most
  // prominent editorial claim in the app, and "★5.0 from 10 reviews" reads
  // as noise — a perfect score on a handful of reviews means nothing, and
  // small apps also produce the biggest (least meaningful) rank swings.
  const credible = (a?: DappEntry) => !!a && (a.reviews ?? 0) >= PICK_MIN_REVIEWS;
  const dayIndex = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86_400_000,
  );

  // Rotate across ALL credible climbers, not first-wins: when one app tops
  // the movers for a week, a fixed pick makes the hero slot look frozen.
  const climbers = topClimbers(apps, 10).filter(
    (a) => (a.rankDelta ?? 0) >= 3 && credible(a),
  );
  if (climbers.length) return climbers[dayIndex % climbers.length];

  const fresh = freshlyListed(apps, 5).find(credible);
  if (fresh) return fresh;

  // Quality-over-popularity before falling back to the biggest app — a
  // genuinely good under-discovered app is a better pick than the #1 everyone
  // already has. Rotate across the vetted pool so the hero changes daily.
  const pool = hiddenGems(apps, PICK_POOL);
  if (pool.length) {
    return pool[((dayIndex % pool.length) + pool.length) % pool.length];
  }

  return [...apps].sort((a, b) => b.trendScore - a.trendScore)[0];
}
