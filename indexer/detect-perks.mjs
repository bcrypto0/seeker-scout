/**
 * App-perks detector (v0.4 — answers pulamea.skr's 4★ review: "I'd like to
 * see all the rewards from all the apps running on Solana mobile").
 *
 * Scans every catalog app's name/subtitle/description for reward-ish
 * signals (airdrop, play-to-earn, staking, earn, cashback, rewards,
 * points, mining) with word-boundary regexes, extracts the first matching
 * sentence as a display snippet, and writes perks.json — deployed next to
 * catalog.json as remote config, so detection tuning ships without an app
 * release.
 *
 * Usage: node indexer/detect-perks.mjs [catalogPath] [outPath]
 * Defaults: indexer/catalog.json → indexer/perks.json
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG = process.argv[2] ?? join(HERE, 'catalog.json');
const OUT = process.argv[3] ?? join(HERE, 'perks.json');
const SELF_ID = 'com.bilal.seekerscout'; // our own listing mentions rewards

/**
 * Ordered signal table — order = display precedence (an app's kinds array
 * keeps this order). Patterns are word-boundary anchored: \bearn\b does NOT
 * match "learn"; \bstake\b does not match "mistake"s inner letters.
 */
const SIGNALS = [
  { kind: 'airdrop', label: 'Airdrop', re: /\bairdrops?\b/i },
  { kind: 'play-to-earn', label: 'Play-to-earn', re: /\bplay[\s-]?(?:to|2|&)[\s-]?earn\b|\bp2e\b|\bplay and earn\b/i },
  // Bare "stake"/"yield" over-match badly (Grass "Earn a stake in AI",
  // ORE "lands will yield rewards", chess "win the stake") — require the
  // -ing/-APY forms or an explicit crypto object after "stake".
  { kind: 'staking', label: 'Staking', re: /\bstaking\b|\bapy\b|\bstake\s+(?:sol\b|skr\b|tokens?\b|crypto\b|\$)/i },
  { kind: 'earn', label: 'Earn', re: /\bearn(?:ing|ings)?\b|\bget paid\b|\bpassive income\b/i },
  { kind: 'cashback', label: 'Cashback', re: /\bcash\s?back\b/i },
  { kind: 'rewards', label: 'Rewards', re: /\brewards?\b/i },
  { kind: 'points', label: 'Points', re: /\b(?:loyalty|reward|earn(?:ing)?)\s+points\b|\bpoints\s+(?:program|system)\b|\bxp\b/i },
  { kind: 'mining', label: 'Mining', re: /\bmining\s+rewards?\b|\bmine\s+(?:crypto|tokens?|coins?|\$)/i },
];

/**
 * Known non-reward apps that keyword heuristics can't cleanly exclude
 * (news/directory apps QUOTING reward language, etc.) — release valve,
 * ships server-side with the next refresh.
 */
const DENYLIST = new Set(['com.emostically']);

/**
 * True when `part` contains a match of `re` that is NOT negated — i.e. not
 * preceded in the same clause by "no/not/without/zero/non". Kills entries
 * like "No tokens, no earn mechanics." appearing under REWARDS.
 */
function positiveMatch(part, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (const m of part.matchAll(g)) {
    const pre = part.slice(Math.max(0, m.index - 40), m.index);
    if (!/\b(?:no|not|without|zero|non)\b[^.!?;]*$/i.test(pre)) return true;
  }
  return false;
}

/** Sentence-ish segments of the app's store copy, tidied. */
function segmentsOf(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((p) =>
      p
        .replace(/[*_`#>]+/g, '') // markdown junk from store descriptions
        .replace(/\s+/g, ' ')
        .replace(/^[-•·:\s]+/, '')
        .trim(),
    )
    .filter(Boolean);
}

/**
 * Best display snippet for a signal: prefer positive-matching segments that
 * end in real punctuation (catalog descriptions are hard-capped ~400 chars,
 * so the last segment is often a mid-word fragment like "deve"). Falls back
 * to a fragment only if it's long enough to read, with an ellipsis.
 */
function snippetFor(segments, re) {
  const hits = segments.filter((p) => positiveMatch(p, re));
  const finished = hits.find((p) => /[.!?…]$/.test(p));
  let pick = finished ?? hits.find((p) => p.length >= 30) ?? '';
  if (!pick) return '';
  if (pick.length > 160) pick = `${pick.slice(0, 157).trimEnd()}…`;
  else if (!/[.!?…]$/.test(pick)) pick = `${pick}…`;
  return pick;
}

const apps = JSON.parse(readFileSync(CATALOG, 'utf8'));
if (!Array.isArray(apps)) throw new Error('catalog.json is not an array');

const perks = [];
for (const app of apps) {
  if (app.id === SELF_ID || DENYLIST.has(app.id)) continue;
  const text = [app.name, app.subtitle, app.description]
    .filter(Boolean)
    .join('\n');
  if (!text) continue;

  const segments = segmentsOf(text);
  const kinds = SIGNALS.filter((s) =>
    segments.some((p) => positiveMatch(p, s.re)),
  ).map((s) => s.kind);
  if (kinds.length === 0) continue;

  // Snippet from the strongest signal that yields a readable one — don't
  // drop the app just because its primary signal only matched a fragment.
  let snippet = '';
  for (const k of kinds) {
    snippet = snippetFor(segments, SIGNALS.find((s) => s.kind === k).re);
    if (snippet) break;
  }
  if (!snippet) continue; // nothing readable to show — skip

  perks.push({
    id: app.id,
    name: app.name,
    category: app.category,
    iconUrl: app.iconUrl,
    kinds,
    snippet,
    trendScore: app.trendScore ?? 0,
    rating: app.rating ?? 0,
    reviews: app.reviews ?? 0,
  });
}

// Strongest first: more distinct signals, then store traction.
perks.sort(
  (a, b) => b.kinds.length - a.kinds.length || b.trendScore - a.trendScore,
);

// Atomic write (temp + rename) — same discipline as the rest of the indexer.
const tmp = `${OUT}.tmp`;
writeFileSync(tmp, JSON.stringify(perks, null, 1));
renameSync(tmp, OUT);

// Console report for tuning runs.
const byKind = {};
for (const p of perks) for (const k of p.kinds) byKind[k] = (byKind[k] ?? 0) + 1;
console.log(`perks: ${perks.length}/${apps.length} apps with reward signals`);
console.table(byKind);
