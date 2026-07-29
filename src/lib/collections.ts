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
 */
export function scoutPick(apps: DappEntry[]): DappEntry | undefined {
  const climber = topClimbers(apps, 1)[0];
  if (climber && (climber.rankDelta ?? 0) >= 3) return climber;
  const fresh = freshlyListed(apps, 1)[0];
  if (fresh) return fresh;
  return [...apps].sort((a, b) => b.trendScore - a.trendScore)[0];
}
