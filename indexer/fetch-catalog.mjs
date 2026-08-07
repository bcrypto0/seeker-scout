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
import {
  writeFileSync, readFileSync, existsSync, renameSync, mkdirSync, readdirSync,
} from 'node:fs';

const ENDPOINT = process.env.DAPPSTORE_URL ?? 'https://seekertracker.com/api/dappstore';

const BAYES_PRIOR_COUNT = 200; // pseudo-reviews at the global mean
const BAYES_PRIOR_MEAN = 4.1;
/**
 * Bump whenever the score formula or the sort key changes. Ranks computed
 * under different schemes are NOT comparable, so history rows carry this and
 * deltas/sparklines skip any snapshot that disagrees.
 * 1 = rounded score used as the sort key (through 2026-07-28)
 * 2 = precise float sort key, rounded only for display (2026-07-29 on)
 */
const SCORING_SCHEME = 2;

/** Trim to max chars on a word boundary, appending an ellipsis if cut. */
function clip(text, max) {
  const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (!t) return '';
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const atWord = cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40));
  return `${atWord.trimEnd()}…`;
}

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

      // The feed's changelog is human-written on ~1,200 apps and we were
      // discarding it. Truncate on a word boundary: it renders as a card
      // blurb, and half the store descriptions already taught us that
      // mid-word cuts ("…Use da") read as broken.
      const whatsNew = clip(rel.newInVersion, 240);

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
        // Full 1..5-star counts — lets the app show whether a 3.5 is
        // "mediocre" or "polarizing", which no rank number can.
        ...(reviews > 0 && hist.length === 5 ? { ratingHistogram: hist } : {}),
        ...(whatsNew ? { whatsNew } : {}),
        iconUrl: rel.icon?.uri,
        publisher: rel.publisherDetails?.name,
        website: rel.publisherDetails?.website,
        version: rel.androidDetails?.version,
        trendScore: score(rating, reviews, rel.updatedOn),
      });
    }
  }
  // Sort on the PRECISE score, then round only for display. Rounding before
  // sorting collapsed 1,200 apps into ~35 buckets (262 apps tied at 77), and
  // ties fall back to feed order — which reshuffles daily. That made
  // rankDelta, rankHistory, Top Climbers and Scout Pick measure noise for the
  // long tail (four different apps all showing "▲99"). Every consumer —
  // rank deltas below, and the app's own stable sorts — reads this array's
  // order, so ordering here is what actually has to be right.
  const out = [...byId.values()].sort((a, b) => b.trendScore - a.trendScore);
  for (const e of out) e.trendScore = Math.round(e.trendScore);
  return out;
}

/** Bayesian-weighted rating + freshness boost, scaled ~0-100 (unrounded). */
function score(rating, reviews, updatedOn) {
  const bayes =
    (reviews / (reviews + BAYES_PRIOR_COUNT)) * rating +
    (BAYES_PRIOR_COUNT / (reviews + BAYES_PRIOR_COUNT)) * BAYES_PRIOR_MEAN;
  const days = updatedOn
    ? (Date.now() - new Date(updatedOn).getTime()) / 86_400_000
    : 9999;
  const freshBoost = Math.max(0, 1 - days / 365) * 0.5;
  const volume = Math.min(1, Math.log10(1 + reviews) / 4) * 0.5;
  return ((bayes + freshBoost + volume) * 100) / 6;
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

  // First-seen tracking (since 2026-07-14): ids new to the feed are stamped
  // with today's date; ids from the pre-tracking baseline stay null (unknown).
  // first-seen.json is ratchet state that can't be regenerated from the feed,
  // so every mutation is guarded: fixture runs (DAPPSTORE_FILE) and
  // FIRSTSEEN_READONLY=1 never persist, partial feeds never baseline or stamp,
  // corrupt state is quarantined (not deleted), a missing file recovers stamps
  // from the previous catalog.json, and writes are temp+rename atomic.
  const FIRSTSEEN_MIN_FEED = 1000; // don't trust a smaller feed
  const FIRSTSEEN_MAX_NEW = 100; // bigger one-day influx = feed anomaly
  const readOnly =
    !!process.env.DAPPSTORE_FILE || process.env.FIRSTSEEN_READONLY === '1';
  const firstSeenPath = new URL('./first-seen.json', import.meta.url);
  const prevCatalogPath = new URL('./catalog.json', import.meta.url);

  let firstSeen = null;
  let recovered = false;
  if (existsSync(firstSeenPath)) {
    try {
      const parsed = JSON.parse(readFileSync(firstSeenPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object map');
      }
      firstSeen = parsed;
    } catch (err) {
      console.warn(`first-seen.json unreadable (${err.message})`);
      if (!readOnly) {
        const quarantine = new URL(
          `./first-seen.corrupt-${Date.now()}.json`, import.meta.url,
        );
        renameSync(firstSeenPath, quarantine);
        console.warn('corrupt state preserved aside for manual recovery');
      }
    }
  }
  if (!firstSeen && existsSync(prevCatalogPath)) {
    // Recover stamps from the previous run's catalog instead of silently
    // re-baselining (which would erase all accumulated first-seen dates).
    try {
      const prev = JSON.parse(readFileSync(prevCatalogPath, 'utf8'));
      if (Array.isArray(prev) && prev.length >= FIRSTSEEN_MIN_FEED) {
        firstSeen = Object.fromEntries(
          prev.map((e) => [e.id, e.firstSeen ?? null]),
        );
        recovered = true; // persist the recovery — catalog.json is not durable
        console.warn(
          `first-seen state recovered from previous catalog.json (${prev.length} ids)`,
        );
      }
    } catch {
      /* previous catalog unreadable — fall through to fresh baseline */
    }
  }

  const fullFeed = entries.length >= FIRSTSEEN_MIN_FEED;
  let mutated = recovered;
  if (!firstSeen) {
    if (fullFeed) {
      firstSeen = Object.fromEntries(entries.map((e) => [e.id, null]));
      mutated = true;
      console.warn('first-seen tracking: fresh pre-tracking baseline created');
    } else {
      firstSeen = {};
      console.warn(
        `first-seen tracking: no state and feed too small (${entries.length}) — skipped`,
      );
    }
  } else if (!fullFeed) {
    console.warn(
      `first-seen tracking: feed too small (${entries.length}) — not stamping`,
    );
  } else {
    const unseen = entries.filter((e) => !(e.id in firstSeen));
    if (unseen.length > FIRSTSEEN_MAX_NEW) {
      console.warn(
        `first-seen tracking: ${unseen.length} unseen ids > ${FIRSTSEEN_MAX_NEW} — feed anomaly, not stamping`,
      );
    } else if (unseen.length) {
      const today = new Date().toISOString().slice(0, 10);
      for (const e of unseen) firstSeen[e.id] = today;
      mutated = true;
      console.log(`${unseen.length} apps first seen today`);
    }
  }
  for (const e of entries) {
    if (firstSeen[e.id]) e.firstSeen = firstSeen[e.id];
  }
  if (mutated && !readOnly) {
    const tmp = new URL('./first-seen.json.tmp', import.meta.url);
    writeFileSync(tmp, JSON.stringify(firstSeen, null, 1));
    renameSync(tmp, firstSeenPath);
  } else if (mutated) {
    console.log('first-seen tracking: read-only mode — changes not persisted');
  }

  // Daily rank history (battle plan move #1) — one compact snapshot per day,
  // same-day reruns overwrite. This dataset compounds and CANNOT be
  // backfilled; it feeds rank deltas (#2), sparklines, movers and the
  // State-of-the-Store report. Same guards as first-seen: full live feeds
  // only, read-only runs never write.
  if (fullFeed) {
    const day = new Date().toISOString().slice(0, 10);
    const historyDir = new URL('./history/', import.meta.url);
    mkdirSync(historyDir, { recursive: true });

    // Rank deltas (#2 data side) vs the newest snapshot older than today.
    const prevFile = readdirSync(historyDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < day)
      .sort()
      .pop();
    if (prevFile) {
      try {
        const prevRows = JSON.parse(
          readFileSync(new URL(`./history/${prevFile}`, import.meta.url), 'utf8'),
        );
        // Ranks from a DIFFERENT scoring scheme aren't comparable. When the
        // rounded score was replaced by a precise sort key, 1,010 apps whose
        // score never changed still "moved" — median jump 28, max 371 — and
        // that noise reached users as ticker headlines and push alerts.
        // Refuse to diff across schemes; one clean run restores deltas.
        const prevScheme = prevRows[0]?.scheme ?? 0;
        if (prevScheme !== SCORING_SCHEME) {
          throw new Error(
            `scoring scheme changed (${prevScheme} -> ${SCORING_SCHEME}) — skipping deltas for one run`,
          );
        }
        const prevRank = new Map(prevRows.map((r) => [r.id, r.rank]));
        let moved = 0;
        entries.forEach((e, i) => {
          const was = prevRank.get(e.id);
          if (was !== undefined) {
            e.rankDelta = was - (i + 1); // positive = climbed
            if (e.rankDelta !== 0) moved += 1;
          }
        });
        console.log(`rank deltas vs ${prevFile.slice(0, 10)}: ${moved} apps moved`);
      } catch (e) {
        console.warn(`no rank deltas this run: ${e.message}`);
      }
    }

    // rankHistory (sparkline feed, UI lands v0.3): up to 6 prior daily ranks
    // + today's, oldest→newest.
    const histFiles = readdirSync(historyDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < day)
      .sort()
      .slice(-6);
    if (histFiles.length) {
      const maps = histFiles
        .map((f) => {
          try {
            const rows = JSON.parse(
              readFileSync(new URL(`./history/${f}`, import.meta.url), 'utf8'),
            );
            // Same rule as deltas: a sparkline that splices two scoring
            // schemes draws a cliff that never happened.
            if ((rows[0]?.scheme ?? 0) !== SCORING_SCHEME) return null;
            return new Map(rows.map((r) => [r.id, r.rank]));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      entries.forEach((e, i) => {
        const seq = maps.map((m) => m.get(e.id)).filter((v) => v !== undefined);
        if (seq.length) e.rankHistory = [...seq, i + 1];
      });
    }

    if (!readOnly) {
      const rows = entries.map((e, i) => ({
        id: e.id, rank: i + 1, trendScore: e.trendScore, rating: e.rating,
        reviews: e.reviews, lastUpdated: e.lastUpdated,
        scheme: SCORING_SCHEME,
      }));
      const tmp = new URL(`./history/${day}.json.tmp`, import.meta.url);
      writeFileSync(tmp, JSON.stringify(rows));
      renameSync(tmp, new URL(`./history/${day}.json`, import.meta.url));
      console.log(`history snapshot written: ${day} (${rows.length} rows)`);
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
