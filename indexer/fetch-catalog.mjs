/**
 * Builds catalog.json for Seeker Scout — the full dApp Store catalog.
 *
 * Data source: the dApp Store "explore" GraphQL feed (verified July 2026 via
 * seekertracker.com's proxy at /api/dappstore, which returns ~1,100+ apps
 * across 12 categories in ONE unpaginated response). Response shape:
 *
 *   data.explore.units.edges[].node = {
 *     __typename: 'DAppsByCategoryUnit',
 *     category: { id, name },            // e.g. 'Games', 'DeFi & Trading'
 *     dApps: { edges: [{ node: {
 *       androidPackage,                   // unique id
 *       rating: { rating, reviewsByRating: [n1..n5] },
 *       lastRelease: {
 *         displayName, subtitle, description, updatedOn, newInVersion,
 *         privacyPolicyUrl, icon: { uri },
 *         publisherDetails: { name, website, supportEmail },
 *         androidDetails: { version, versionCode, minSdk }
 *       }
 *     }}]}
 *   }
 *
 * Usage:
 *   node indexer/fetch-catalog.mjs                  # fetch live
 *   DAPPSTORE_FILE=fixture.json node indexer/...    # transform a local file
 *   DAPPSTORE_URL=<url> node indexer/...            # alternate endpoint
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const ENDPOINT = process.env.DAPPSTORE_URL ?? 'https://seekertracker.com/api/dappstore';

const BAYES_PRIOR_COUNT = 200; // pseudo-reviews at the global mean
const BAYES_PRIOR_MEAN = 4.1;

export function transform(payload) {
  const units = payload?.data?.explore?.units?.edges ?? [];
  const byId = new Map();

  for (const unit of units) {
    const category = unit?.node?.category?.name ?? 'Other';
    for (const edge of unit?.node?.dApps?.edges ?? []) {
      const n = edge?.node;
      if (!n?.androidPackage || !n?.lastRelease) continue; // nothing to show
      const rel = n.lastRelease ?? {};
      const hist = n.rating?.reviewsByRating ?? [];
      const reviews = hist.reduce((s, x) => s + (x || 0), 0);
      const rating = n.rating?.rating ?? 0;

      const existing = byId.get(n.androidPackage);
      if (existing) {
        // Duplicate across units (e.g. Top Picks + its real category)
        if (category === 'Top Picks') existing.topPick = true;
        else if (existing.category === 'Top Picks') {
          existing.category = category;
          existing.topPick = true;
        }
        continue;
      }

      byId.set(n.androidPackage, {
        id: n.androidPackage,
        name: rel.displayName ?? n.androidPackage,
        subtitle: rel.subtitle ?? '',
        description: (rel.description ?? '').slice(0, 400),
        category,
        topPick: category === 'Top Picks',
        lastUpdated: (rel.updatedOn ?? '').slice(0, 10),
        rating,
        reviews,
        iconUrl: rel.icon?.uri,
        publisher: rel.publisherDetails?.name,
        website: rel.publisherDetails?.website,
        version: rel.androidDetails?.version,
        trendScore: score(rating, reviews, rel.updatedOn),
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.trendScore - a.trendScore);
}

/** Bayesian-weighted rating + freshness boost, scaled ~0-100. */
function score(rating, reviews, updatedOn) {
  const bayes =
    (reviews / (reviews + BAYES_PRIOR_COUNT)) * rating +
    (BAYES_PRIOR_COUNT / (reviews + BAYES_PRIOR_COUNT)) * BAYES_PRIOR_MEAN;
  const days = updatedOn
    ? (Date.now() - new Date(updatedOn).getTime()) / 86_400_000
    : 9999;
  const freshBoost = Math.max(0, 1 - days / 365) * 0.5;
  const volume = Math.min(1, Math.log10(1 + reviews) / 4) * 0.5;
  return Math.round(((bayes + freshBoost + volume) * 100) / 6);
}

async function main() {
  let payload;
  if (process.env.DAPPSTORE_FILE) {
    payload = JSON.parse(readFileSync(process.env.DAPPSTORE_FILE, 'utf8'));
  } else {
    const res = await fetch(ENDPOINT, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    payload = await res.json();
  }

  let entries = transform(payload);

  // Manual enrichment (seedVaultNative flags, category fixes, etc.)
  const overridesPath = new URL('./overrides.json', import.meta.url);
  if (existsSync(overridesPath)) {
    const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
    for (const o of overrides) {
      const e = entries.find((x) => x.id === o.id);
      if (e) Object.assign(e, o);
      else entries.push(o);
    }
  }

  writeFileSync(
    new URL('./catalog.json', import.meta.url),
    JSON.stringify(entries, null, 1),
  );

  const cats = {};
  for (const e of entries) cats[e.category] = (cats[e.category] ?? 0) + 1;
  console.log(`Wrote ${entries.length} apps to indexer/catalog.json`);
  console.table(cats);
}

// Run only when executed directly (not when imported for tests)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fetch-catalog.mjs')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
