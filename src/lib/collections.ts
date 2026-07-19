import { DappEntry } from './types';

/**
 * Auto-generated Discover rails from data we already have — no editorial
 * cost (battle plan §7/§8). All pure functions over the catalog.
 */

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
