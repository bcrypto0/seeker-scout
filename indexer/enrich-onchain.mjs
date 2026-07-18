/**
 * Track A enrichment pass — stamps verified on-chain release data onto catalog
 * apps whose publisher we know (indexer/publishers.json). Runs AFTER the
 * catalog is built; bounded to known publishers so it never hammers RPC across
 * all ~1,166 apps and never blocks the daily deploy on RPC availability.
 *
 * Adds per matching app: onchainVerified:true, onchainReleaseCount:<n>.
 * Coverage grows as publishers.json accumulates (via onchain.mjs crawls).
 *
 * Usage:  node indexer/enrich-onchain.mjs [catalogPath]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { getPublisherReleases, loadPublisherMap } from './onchain.mjs';

async function main() {
  const catalogPath = process.argv[2]
    ? new URL(`file://${process.argv[2].replace(/\\/g, '/')}`)
    : new URL('./catalog.json', import.meta.url);
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const map = loadPublisherMap();
  const publishers = [...new Set(Object.values(map))];
  if (!publishers.length) {
    console.log('enrich: no known publishers yet — nothing to stamp');
    return;
  }

  // Resolve on-chain release counts per package, one crawl per publisher.
  const counts = new Map();
  for (const pub of publishers) {
    try {
      for (const app of await getPublisherReleases(pub)) {
        if (app.package) counts.set(app.package, app.releaseCount);
      }
    } catch (e) {
      console.warn(`enrich: publisher ${pub.slice(0, 8)}… failed (${e.message})`);
    }
  }

  let stamped = 0;
  for (const app of catalog) {
    const n = counts.get(app.id);
    if (n) {
      app.onchainVerified = true;
      app.onchainReleaseCount = n;
      stamped += 1;
    }
  }
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 1));
  console.log(`enrich: stamped ${stamped} app(s) with on-chain verification`);
}

if (
  process.argv[1]?.replace(/\\/g, '/').split('/').pop() ===
  'enrich-onchain.mjs'
) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
