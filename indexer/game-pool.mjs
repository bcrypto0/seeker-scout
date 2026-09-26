/**
 * Scout Daily game pool: the apps the daily games may use, as a small public
 * file the Lounge worker fetches instead of parsing the 1.4MB catalog.
 *
 *   node indexer/game-pool.mjs <catalog.json> <out game-pool.json>
 *
 * The pool is PUBLIC on purpose. Everything in it is already in catalog.json;
 * what stays secret is WHICH app is today's answer, which the worker picks
 * with a keyed hash of the date. Publishing the pool costs nothing and keeps
 * the worker well inside its CPU budget.
 *
 * Two tiers:
 *   - every pool app (v >= POOL_MIN_REVIEWS) is a valid GUESS, so the worker
 *     can compare it against the answer;
 *   - "a" apps (well known, still alive) can be an ANSWER and appear in
 *     Higher or Lower. Obscure answers make a guessing game unwinnable, and a
 *     Higher or Lower pair of two apps nobody has heard of is a coin flip.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , catalogPath, outPath] = process.argv;
if (!catalogPath || !outPath) {
  console.error('usage: node indexer/game-pool.mjs <catalog.json> <out.json>');
  process.exit(2);
}

// Kept in lockstep with src/lib/game.ts (the app mirrors it to decide which
// apps to offer in the guess box). The worker is authoritative either way.
export const POOL_MIN_REVIEWS = 25;
const ANSWER_MIN_REVIEWS = 150;
const ANSWER_MAX_AGE_DAYS = 365;
// The founder's own apps: an answer that happens to be ours reads as an ad.
const EXCLUDE = new Set(['com.bilal.seekerscout', 'fun.cook.app', 'fun.rangekeeper.app']);

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const now = Date.now();
const ageDays = (d) => {
  const t = Date.parse(d ?? '');
  return Number.isNaN(t) ? Infinity : (now - t) / 86_400_000;
};

const apps = [];
let answers = 0;
for (const a of catalog) {
  if (EXCLUDE.has(a.id) || !a.name || !a.iconUrl) continue;
  if ((a.reviews ?? 0) < POOL_MIN_REVIEWS) continue;
  const answer =
    a.reviews >= ANSWER_MIN_REVIEWS &&
    !!a.subtitle &&
    (ageDays(a.lastUpdated) <= ANSWER_MAX_AGE_DAYS || (a.reviews30d ?? 0) > 0);
  const row = {
    id: a.id,
    n: a.name,
    c: a.storeCategory ?? a.category,
    r: a.rating,
    v: a.reviews,
  };
  if (answer) {
    answers += 1;
    Object.assign(row, { a: 1, s: String(a.subtitle).slice(0, 90), i: a.iconUrl });
  }
  apps.push(row);
}

// Stable order so the worker's keyed pick is reproducible for a given pool.
apps.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

const out = { version: 1, generatedAt: new Date().toISOString(), apps };
writeFileSync(outPath, JSON.stringify(out));
console.log(
  `game-pool: ${apps.length} guessable, ${answers} answer-eligible, ` +
    `${Math.round(JSON.stringify(out).length / 1024)} KB`,
);
