/**
 * Scout Daily client (v0.10): Guess the dApp + Higher or Lower.
 *
 * Every rule that matters lives on the server (lounge-worker/src/game.js):
 * the answer, which clue is unlocked, whether a pick was right. This file only
 * moves state back and forth and never guesses at an outcome, so a slow or
 * failed request shows as "try again", never as a fabricated result.
 *
 * Playing ranked needs a Lounge seat, and reuses the chat token: one seat is
 * one Seeker Genesis Token, which is what makes the board fair.
 */
import { DappEntry } from './types';

const BASE = 'https://seeker-lounge.bcrypto-eth.workers.dev';

/**
 * Mirrors indexer/game-pool.mjs POOL_MIN_REVIEWS and its exclusions, to
 * decide which apps to offer in the guess box. The worker is the authority:
 * if these ever drift, an offered app just comes back as "not in today's
 * game", never as a wrong answer.
 */
export const POOL_MIN_REVIEWS = 25;
const EXCLUDE = new Set(['com.bilal.seekerscout', 'fun.cook.app', 'fun.rangekeeper.app']);
export const isGuessable = (a: DappEntry) =>
  !EXCLUDE.has(a.id) && !!a.iconUrl && !!a.name && (a.reviews ?? 0) >= POOL_MIN_REVIEWS;

export type Dir = 'up' | 'down' | 'eq' | 'unknown';

export interface GuessRow {
  id: string;
  name: string;
  iconUrl: string | null;
  correct: boolean;
  category: { value: string; match: boolean };
  /** dir = where the ANSWER sits relative to this guess. */
  reviews: { value: number; dir: Dir };
  rating: { value: number; dir: Dir };
}

export interface Clue {
  key: 'category' | 'rating' | 'reviews' | 'letter' | 'tagline' | 'icon';
  label: string;
  value: string;
}

export interface GuessState {
  maxGuesses: number;
  guesses: GuessRow[];
  clues: Clue[];
  done: boolean;
  solved: boolean;
  points: number;
  answer: { id: string; name: string; iconUrl: string | null; subtitle: string | null } | null;
}

export interface HolApp {
  id: string;
  n: string;
  c: string;
  i?: string;
  /** Review count. Absent on the app you are guessing about. */
  v?: number;
}

export interface HolState {
  length: number;
  step: number;
  history: { a: HolApp; b: HolApp; pick: 'higher' | 'lower'; correct: boolean }[];
  current: { a: HolApp; b: HolApp } | null;
  done: boolean;
  score: number;
  points: number;
}

export interface Today {
  day: string;
  puzzleNo: number;
  nextAt: string;
  guess: GuessState;
  hol: HolState;
  streak: number;
  week: { start: string; score: number; rank: number | null; players: number };
}

export interface BoardRow {
  rank: number;
  number: number;
  tier: 'founding' | 'early' | 'member';
  score: number;
  days: number;
}

export interface Board {
  weekStart: string;
  day: string;
  puzzleNo: number;
  top: BoardRow[];
  players: number;
}

/**
 * Thrown for any non-2xx, carrying the server's own message when it sent one.
 * `stale` means a new UTC day's puzzle started while this one was open: the
 * right response is to reload, not to show an error.
 */
export class GameError extends Error {
  constructor(message: string, readonly status: number, readonly stale = false) {
    super(message);
  }
}

async function call<T>(path: string, token: string | null, body?: object): Promise<T> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15_000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: c.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new GameError(
        data?.error || `Something went wrong (${res.status})`,
        res.status,
        data?.stale === true,
      );
    }
    return data as T;
  } catch (e) {
    if (e instanceof GameError) throw e;
    throw new GameError("Couldn't reach the game server. Check your connection.", 0);
  } finally {
    clearTimeout(t);
  }
}

export const getToday = (token: string) => call<Today>('/game/today', token);
/** `day` is the puzzle on screen; the server refuses it once midnight passes. */
export const sendGuess = (token: string, appId: string, day: string) =>
  call<{ guess: GuessState }>('/game/guess', token, { appId, day }).then((r) => r.guess);
export const sendPick = (token: string, pick: 'higher' | 'lower', day: string) =>
  call<{ hol: HolState }>('/game/hol', token, { pick, day }).then((r) => r.hol);
export const getBoard = () => call<Board>('/game/leaderboard', null);

/** "4h 12m" until the next puzzle (UTC midnight). */
export function untilNext(nextAt: string, now = Date.now()): string {
  const ms = Math.max(0, Date.parse(nextAt) - now);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * The result a player can post to the Lounge. Plain text on purpose: it goes
 * through the normal chat send (and its link-stripping), is sent by the
 * member themselves, and reads fine in any client, including v0.9 which has
 * no special rendering for it.
 *
 * ONE line, " · "-separated: the chat server's sanitizer collapses every run
 * of whitespace, newlines included, into a single space, so a multi-line
 * result would arrive as one run-on sentence.
 */
export const SHARE_PREFIX = '🧭 Scout Daily #';
export const SHARE_SEP = ' · ';

export function shareText(t: Today): string {
  const lines = [`🧭 Scout Daily #${t.puzzleNo}`];
  if (t.guess.done) {
    const squares = t.guess.guesses.map((g) => (g.correct ? '🟩' : '🟥')).join('');
    lines.push(
      t.guess.solved
        ? `Guess the dApp: ${squares} ${t.guess.guesses.length}/${t.guess.maxGuesses}`
        : `Guess the dApp: ${squares} X/${t.guess.maxGuesses}`,
    );
  }
  if (t.hol.done) {
    lines.push(
      t.hol.score >= t.hol.length
        ? `Higher or Lower: 🔥 ${t.hol.score} (perfect run)`
        : `Higher or Lower: 🔥 ${t.hol.score}`,
    );
  }
  if (t.streak > 1) lines.push(`${t.streak}-day streak`);
  return lines.join(SHARE_SEP);
}

/** Recognises a shared result so the chat can render it as a card. */
export const isShare = (text: string) => text.startsWith(SHARE_PREFIX);

/** Split a shared result back into its title and lines, for the chat card. */
export function parseShare(text: string): { title: string; lines: string[] } {
  const [title, ...lines] = text.split(SHARE_SEP);
  return { title, lines };
}
