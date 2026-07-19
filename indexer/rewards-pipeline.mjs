/**
 * Rewards pipeline — makes our feed provably fresher + better-linked than
 * SolanaFloor's hand-curated one (their "Current" list carries 5+ expired
 * offers; ours never shows a stale one). Runs in the daily refresh.
 *
 * For each curated entry in rewards.json:
 *   - verify packageId exists in the live catalog (flag dead links)
 *   - auto-fill iconUrl from the catalog app (stop hand-setting it)
 *   - compute freshness: drop entries expired > GRACE days; warn when a
 *     non-season entry hasn't been re-verified in STALE_DAYS
 * Writes the enriched rewards.json for deployment + a report to stderr.
 *
 * Usage:  node indexer/rewards-pipeline.mjs [catalogPath] [rewardsPath]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const GRACE_DAYS = 60; // keep recently-expired for the app's PAST section (trust); drop only ancient
const STALE_DAYS = 45; // re-verify perks at least this often

const day = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) =>
  Math.floor((Date.parse(a) - Date.parse(b)) / 86_400_000);

export function runRewardsPipeline(rewards, catalog) {
  const byPkg = new Map(catalog.map((a) => [a.id, a]));
  const today = day();
  const warnings = [];
  const kept = [];

  for (const r of rewards) {
    // Package validity + icon enrichment (skip for season/program cards).
    if (r.packageId) {
      const app = byPkg.get(r.packageId);
      if (!app) {
        warnings.push(`dead package: ${r.id} -> ${r.packageId} not in catalog`);
      } else if (!r.iconUrl && app.iconUrl) {
        r.iconUrl = app.iconUrl; // auto-fill from catalog
      }
    }
    // Freshness: drop only ancient-expired (recent-past stays for the app's
    // PAST section — a trust signal SolanaFloor lacks); warn on stale verify.
    if (r.endsAt && daysBetween(today, r.endsAt) > GRACE_DAYS) {
      warnings.push(`ancient (expired ${daysBetween(today, r.endsAt)}d), dropped: ${r.id}`);
      continue;
    }
    if (r.kind !== 'season' && r.verified && daysBetween(today, r.verified) > STALE_DAYS) {
      warnings.push(`stale verify (${daysBetween(today, r.verified)}d): ${r.id} — re-check`);
    }
    kept.push(r);
  }
  return { rewards: kept, warnings };
}

function main() {
  const catalogPath = process.argv[2]
    ? new URL(`file://${process.argv[2].replace(/\\/g, '/')}`)
    : new URL('./catalog.json', import.meta.url);
  const rewardsPath = process.argv[3]
    ? new URL(`file://${process.argv[3].replace(/\\/g, '/')}`)
    : new URL('./rewards.json', import.meta.url);

  if (!existsSync(catalogPath) || !existsSync(rewardsPath)) {
    console.error('rewards-pipeline: missing catalog or rewards file');
    process.exit(0); // non-fatal
  }
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const rewards = JSON.parse(readFileSync(rewardsPath, 'utf8'));
  const { rewards: out, warnings } = runRewardsPipeline(rewards, catalog);

  writeFileSync(rewardsPath, JSON.stringify(out, null, 1));
  for (const w of warnings) console.error(`rewards-pipeline: ${w}`);
  console.error(
    `rewards-pipeline: ${out.length} live, ${rewards.length - out.length} dropped, ${warnings.length} warning(s)`,
  );
}

if (
  process.argv[1]?.replace(/\\/g, '/').split('/').pop() === 'rewards-pipeline.mjs'
) {
  main();
}
