/**
 * Scout Daily: two daily games for Lounge members (v0.10).
 *
 *   Guess the dApp  one mystery app a day, 6 guesses. Each guess is compared
 *                   with the answer (same category? more or fewer reviews?
 *                   higher or lower rating?) and each miss unlocks a clue.
 *   Higher or Lower a chain of apps; say whether the next one has more or
 *                   fewer reviews than the last. One miss ends the run.
 *
 * Endpoints (routed from index.js):
 *   GET  /game/today        Bearer  -> both games' state + streak + this week
 *   POST /game/guess        Bearer  {appId}          -> Guess the dApp state
 *   POST /game/hol          Bearer  {pick}           -> Higher or Lower state
 *   GET  /game/leaderboard  public  -> this week's top 10
 *
 * FAIRNESS is the point of gating this to Lounge seats. A seat is one Seeker
 * Genesis Token, so it is one run per physical device per day. The answer and
 * the next app's review count never leave the server before they are earned,
 * and every move is append-only: a guess can't be taken back, and asking for
 * the answer by burning guesses ends YOUR run, not a throwaway one.
 *
 * The app pool is a small PUBLIC file the indexer publishes next to the
 * catalog (indexer/game-pool.mjs). Which app is today's answer is the secret:
 * it is picked with an HMAC of the date under CHAT_SECRET, so the pool can be
 * public without the answer being predictable.
 */
import { hmacKey, verifyToken } from './token.js';

const POOL_URL = 'https://seeker-scout-catalog.pages.dev/game-pool.json';
// Puzzle #1 is the first day the game server went live.
const EPOCH_DAY = '2026-09-26';
const MAX_GUESSES = 6;
const HOL_LENGTH = 30; // comparisons in a full Higher or Lower run
const ANSWER_COOLDOWN_DAYS = 120; // don't repeat an answer within this window
const REVIEW_CLOSE = 0.1; // reviews within 10% read as "close"
// Weekly-board points. Each game is worth at most 10 a day so neither
// swamps the other: raw scores would let a 30-long Higher or Lower run
// outweigh five perfect days of Guess the dApp.
const GUESS_POINTS = [10, 8, 6, 5, 4, 3]; // solved on guess 1..6
// floor, not round: "1 point for every 3 in a row" must be literally true.
const holPoints = (streak) => Math.floor(streak / 3); // 0..10 over a 30 run

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', ...CORS },
  });

// ---------------------------------------------------------------- dates ----

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (day, n) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a, b) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const puzzleNo = (day) => daysBetween(EPOCH_DAY, day) + 1;
/** Monday (UTC) of the ISO week containing `day`. */
function weekStart(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  return addDays(day, -dow);
}

// --------------------------------------------------------------- random ----

/** Uint32 from HMAC(secret, label): deterministic per day, unguessable. */
async function seed32(secret, label) {
  const key = await hmacKey(secret);
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(label)),
  );
  return ((sig[0] << 24) | (sig[1] << 16) | (sig[2] << 8) | sig[3]) >>> 0;
}

/** mulberry32: tiny, fast, good enough to shuffle a puzzle. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----------------------------------------------------------------- pool ----

async function loadPool() {
  // Edge-cached: the pool changes once a day, and every guess reads it.
  const res = await fetch(POOL_URL, { cf: { cacheTtl: 900, cacheEverything: true } });
  if (!res.ok) throw new Error(`pool ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.apps) || body.apps.length === 0) throw new Error('empty pool');
  return body.apps;
}

/**
 * The Higher or Lower chain. Consecutive apps always differ clearly in review
 * count (a 51-vs-49 pair is a coin flip, not a game), and the required gap
 * narrows as the run goes on so it starts easy and gets hard.
 */
function buildChain(candidates, rand) {
  const minRatio = (step) => (step <= 5 ? 2.2 : step <= 15 ? 1.6 : 1.25);
  const used = new Set();
  const first = candidates[Math.floor(rand() * candidates.length)];
  const chain = [first];
  used.add(first.id);
  for (let step = 1; chain.length < HOL_LENGTH + 1; step++) {
    const prev = chain[chain.length - 1];
    const want = minRatio(step);
    let pick = null;
    for (let tries = 0; tries < 400 && !pick; tries++) {
      const c = candidates[Math.floor(rand() * candidates.length)];
      if (used.has(c.id) || !c.v || !prev.v) continue;
      const ratio = c.v > prev.v ? c.v / prev.v : prev.v / c.v;
      if (ratio >= want) pick = c;
    }
    if (!pick) {
      // Exhausted at this ratio: take the unused app with the widest gap.
      let best = null;
      let bestRatio = 0;
      for (const c of candidates) {
        if (used.has(c.id) || !c.v) continue;
        const r = c.v > prev.v ? c.v / prev.v : prev.v / c.v;
        if (r > bestRatio) { best = c; bestRatio = r; }
      }
      if (!best || bestRatio <= 1) break;
      pick = best;
    }
    chain.push(pick);
    used.add(pick.id);
  }
  return chain;
}

/** Today's puzzle, created on the first request of the day and then frozen. */
async function getDay(env, secret, day) {
  const read = () =>
    env.DB.prepare('SELECT day, answer_id, data FROM game_daily WHERE day = ?').bind(day).first();
  let row = await read();
  if (!row) {
    const pool = await loadPool();
    const answers = pool.filter((a) => a.a === 1);
    if (answers.length < HOL_LENGTH + 2) throw new Error('pool too small');
    const recent = await env.DB.prepare(
      'SELECT answer_id FROM game_daily WHERE day >= ?',
    ).bind(addDays(day, -ANSWER_COOLDOWN_DAYS)).all();
    const usedRecently = new Set((recent.results ?? []).map((r) => r.answer_id));
    const start = (await seed32(secret, `scout-daily:guess:${day}`)) % answers.length;
    let answer = answers[start];
    for (let k = 0; k < answers.length; k++) {
      const c = answers[(start + k) % answers.length];
      if (!usedRecently.has(c.id)) { answer = c; break; }
    }
    const chain = buildChain(
      answers,
      rng(await seed32(secret, `scout-daily:hol:${day}`)),
    );
    // Snapshot everything the day needs so it plays identically all day, even
    // if the pool refreshes mid-day.
    const data = {
      answer: { id: answer.id, n: answer.n, c: answer.c, r: answer.r, v: answer.v, s: answer.s, i: answer.i },
      chain: chain.map((a) => ({ id: a.id, n: a.n, c: a.c, v: a.v, i: a.i })),
    };
    // Two isolates may race to create the day. Both compute the same puzzle
    // from the same seed and history; OR IGNORE keeps the first, and we
    // re-read so every caller sees the stored row.
    await env.DB.prepare(
      'INSERT OR IGNORE INTO game_daily (day, answer_id, data, created_at) VALUES (?, ?, ?, ?)',
    ).bind(day, answer.id, JSON.stringify(data), new Date().toISOString()).run();
    row = await read();
  }
  return { day: row.day, ...JSON.parse(row.data) };
}

// ------------------------------------------------------------- plays ----

async function getPlay(env, day, game, claims) {
  const empty = game === 'guess' ? { guesses: [] } : { picks: [] };
  await env.DB.prepare(
    `INSERT OR IGNORE INTO game_plays
       (day, game, number, wallet, state, moves, done, score, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?)`,
  ).bind(day, game, claims.number, claims.wallet, JSON.stringify(empty), new Date().toISOString()).run();
  const row = await env.DB.prepare(
    'SELECT state, moves, done, score FROM game_plays WHERE day = ? AND game = ? AND number = ?',
  ).bind(day, game, claims.number).first();
  return { state: JSON.parse(row.state), moves: row.moves, done: !!row.done, score: row.score };
}

/**
 * Append-only write guarded by the move counter. If two requests for the
 * same seat race, only the one that read the current move count wins; the
 * other gets 409 and the app re-reads. Without this a double-tap could
 * record one guess twice or skip a clue.
 */
async function savePlay(env, day, game, number, prevMoves, state, done, score) {
  const res = await env.DB.prepare(
    `UPDATE game_plays SET state = ?, moves = moves + 1, done = ?, score = ?, updated_at = ?
     WHERE day = ? AND game = ? AND number = ? AND moves = ?`,
  ).bind(JSON.stringify(state), done ? 1 : 0, score, new Date().toISOString(), day, game, number, prevMoves).run();
  return !!res.meta?.changes;
}

// ---------------------------------------------------- Guess the dApp view ----

function compareGuess(g, ans) {
  const dirOf = (mine, theirs, closeFrac) => {
    if (mine == null || theirs == null) return 'unknown';
    if (closeFrac ? Math.abs(theirs - mine) <= theirs * closeFrac : theirs === mine) return 'eq';
    return theirs > mine ? 'up' : 'down'; // the ANSWER is higher / lower than this guess
  };
  return {
    id: g.id,
    name: g.n,
    iconUrl: g.i ?? null,
    correct: g.id === ans.id,
    category: { value: g.c, match: g.c === ans.c },
    reviews: { value: g.v, dir: dirOf(g.v, ans.v, REVIEW_CLOSE) },
    rating: { value: g.r, dir: dirOf(g.r, ans.r, 0) },
  };
}

function roundCount(v) {
  if (v >= 1000) return `~${(Math.round(v / 100) / 10).toFixed(1).replace(/\.0$/, '')}k`;
  if (v >= 100) return `~${Math.round(v / 10) * 10}`;
  return `~${v}`;
}

function guessView(dayData, play, poolById) {
  const ans = dayData.answer;
  const guesses = play.state.guesses.map((id) => {
    const g = poolById.get(id) ?? { id, n: id };
    return compareGuess(g, ans);
  });
  const solved = guesses.some((g) => g.correct);
  const done = solved || guesses.length >= MAX_GUESSES;
  const misses = guesses.filter((g) => !g.correct).length;
  // One clue up front, one more per miss. When the game is over, show all.
  const all = [
    { key: 'category', label: 'Category', value: ans.c },
    { key: 'rating', label: 'Rating', value: `${Number(ans.r).toFixed(1)}★` },
    { key: 'reviews', label: 'Reviews', value: roundCount(ans.v) },
    { key: 'letter', label: 'Starts with', value: String(ans.n).trim().charAt(0).toUpperCase() },
    { key: 'tagline', label: 'Tagline', value: ans.s ?? '' },
    { key: 'icon', label: 'Icon', value: ans.i ?? '' },
  ];
  const unlocked = done ? all.length : Math.min(all.length, 1 + misses);
  return {
    maxGuesses: MAX_GUESSES,
    guesses,
    clues: all.slice(0, unlocked),
    done,
    solved,
    points: solved ? GUESS_POINTS[guesses.length - 1] : 0,
    answer: done ? { id: ans.id, name: ans.n, iconUrl: ans.i ?? null, subtitle: ans.s ?? null } : null,
  };
}

// --------------------------------------------------- Higher or Lower view ----

function holView(dayData, play) {
  const chain = dayData.chain;
  const picks = play.state.picks;
  const history = picks.map((pick, i) => {
    const a = chain[i];
    const b = chain[i + 1];
    const correct = (pick === 'higher' && b.v > a.v) || (pick === 'lower' && b.v < a.v);
    return { a: { ...a }, b: { ...b }, pick, correct };
  });
  const missed = history.some((h) => !h.correct);
  const length = chain.length - 1;
  const done = missed || picks.length >= length;
  const score = history.filter((h) => h.correct).length;
  const step = picks.length;
  // b's review count is the thing being guessed: never sent before the pick.
  const current = done
    ? null
    : {
        a: { ...chain[step] },
        b: { id: chain[step + 1].id, n: chain[step + 1].n, c: chain[step + 1].c, i: chain[step + 1].i },
      };
  return { length, step, history, current, done, score, points: holPoints(score) };
}

// ------------------------------------------------------ streak + week ----

async function streakFor(env, number, day) {
  const rows = await env.DB.prepare(
    `SELECT day FROM game_plays WHERE number = ? AND game = 'guess' AND done = 1
     ORDER BY day DESC LIMIT 400`,
  ).bind(number).all();
  const days = new Set((rows.results ?? []).map((r) => r.day));
  // A streak survives until today's puzzle is missed, so it counts back from
  // today if played, otherwise from yesterday.
  let cursor = days.has(day) ? day : addDays(day, -1);
  let n = 0;
  while (days.has(cursor)) { n += 1; cursor = addDays(cursor, -1); }
  return n;
}

async function weekBoard(env, day) {
  const start = weekStart(day);
  const rows = await env.DB.prepare(
    `SELECT p.number AS number, SUM(p.score) AS score, COUNT(DISTINCT p.day) AS days
     FROM game_plays p WHERE p.day >= ? AND p.day <= ? AND p.done = 1
     GROUP BY p.number HAVING SUM(p.score) > 0
     ORDER BY score DESC, days DESC, number ASC`,
  ).bind(start, day).all();
  return { start, rows: rows.results ?? [] };
}

const tierOf = (n) => (n <= 100 ? 'founding' : n <= 500 ? 'early' : 'member');

// ---------------------------------------------------------------- handler ----

export async function handleGame(request, env, url) {
  const secret = env.CHAT_SECRET;
  if (!secret) return json({ error: 'game not configured' }, 503);
  const path = url.pathname;
  const day = today();

  try {
    // Public: the weekly board is meant to be seen, including by people who
    // haven't claimed a seat yet.
    if (request.method === 'GET' && path === '/game/leaderboard') {
      const { start, rows } = await weekBoard(env, day);
      return json({
        weekStart: start,
        day,
        puzzleNo: puzzleNo(day),
        top: rows.slice(0, 10).map((r, i) => ({
          rank: i + 1, number: r.number, tier: tierOf(r.number), score: r.score, days: r.days,
        })),
        players: rows.length,
      });
    }

    const auth = request.headers.get('authorization') || '';
    const claims = await verifyToken(secret, auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (!claims?.number) return json({ error: 'not authenticated' }, 401);
    const m = await env.DB.prepare('SELECT blocked FROM chat_members WHERE wallet = ?')
      .bind(claims.wallet).first();
    if (m?.blocked) return json({ error: 'account blocked' }, 403);

    // A client still showing yesterday's puzzle after UTC midnight must not
    // have its next move land on TODAY's puzzle behind the old clues. The
    // app sends the day it is playing; a mismatch tells it to reload.
    // Optional for compatibility: a request without `day` is simply trusted.
    if (request.method === 'POST') {
      const peek = await request.clone().json().catch(() => ({}));
      if (typeof peek?.day === 'string' && peek.day !== day) {
        return json({ error: 'A new puzzle has started.', stale: true, day }, 409);
      }
    }

    const dayData = await getDay(env, secret, day);

    if (request.method === 'GET' && path === '/game/today') {
      const pool = await loadPool();
      const poolById = new Map(pool.map((a) => [a.id, a]));
      const [guessPlay, holPlay, streak, board] = await Promise.all([
        getPlay(env, day, 'guess', claims),
        getPlay(env, day, 'hol', claims),
        streakFor(env, claims.number, day),
        weekBoard(env, day),
      ]);
      const mine = board.rows.findIndex((r) => r.number === claims.number);
      return json({
        day,
        puzzleNo: puzzleNo(day),
        nextAt: `${addDays(day, 1)}T00:00:00Z`,
        guess: guessView(dayData, guessPlay, poolById),
        hol: holView(dayData, holPlay),
        streak,
        week: {
          start: board.start,
          score: mine >= 0 ? board.rows[mine].score : 0,
          rank: mine >= 0 ? mine + 1 : null,
          players: board.rows.length,
        },
      });
    }

    if (request.method === 'POST' && path === '/game/guess') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const appId = typeof body?.appId === 'string' ? body.appId.slice(0, 200) : '';
      if (!appId) return json({ error: 'appId required' }, 400);
      const pool = await loadPool();
      const poolById = new Map(pool.map((a) => [a.id, a]));
      if (!poolById.has(appId)) return json({ error: "That app isn't in today's game." }, 400);
      const play = await getPlay(env, day, 'guess', claims);
      const before = guessView(dayData, play, poolById);
      if (before.done) return json({ error: "Today's puzzle is finished.", guess: before }, 409);
      if (play.state.guesses.includes(appId)) {
        return json({ error: 'You already tried that one.', guess: before }, 400);
      }
      const next = { guesses: [...play.state.guesses, appId] };
      const view = guessView(dayData, { ...play, state: next }, poolById);
      const ok = await savePlay(env, day, 'guess', claims.number, play.moves, next, view.done, view.points);
      if (!ok) return json({ error: 'Busy, try again.' }, 409);
      return json({ guess: view });
    }

    if (request.method === 'POST' && path === '/game/hol') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const pick = body?.pick;
      if (pick !== 'higher' && pick !== 'lower') return json({ error: 'pick must be higher or lower' }, 400);
      const play = await getPlay(env, day, 'hol', claims);
      const before = holView(dayData, play);
      if (before.done) return json({ error: 'Your run is over for today.', hol: before }, 409);
      const next = { picks: [...play.state.picks, pick] };
      const view = holView(dayData, { ...play, state: next });
      const ok = await savePlay(env, day, 'hol', claims.number, play.moves, next, view.done, view.points);
      if (!ok) return json({ error: 'Busy, try again.' }, 409);
      return json({ hol: view });
    }
  } catch (e) {
    return json({ error: 'game unavailable', detail: String(e?.message ?? e).slice(0, 120) }, 503);
  }

  return json({ error: 'not found' }, 404);
}
