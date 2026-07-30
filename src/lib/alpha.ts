import AsyncStorage from '@react-native-async-storage/async-storage';
import { signMessageBytes } from './wallet';
import {
  AlphaCatalyst,
  AlphaCounts,
  AlphaDigest,
  AlphaEntitlement,
  AlphaFreshness,
  AlphaListing,
  AlphaSession,
  AlphaSmartMoney,
  AlphaStatusLevel,
  AlphaTerms,
  AlphaTier,
  AlphaTopWallet,
  AlphaUnlock,
  AlphaWalletRow,
} from './types';

/**
 * Alpha client — the paid War Room intel tab (docs/SCOUT_ALPHA_SPEC.md §2/§3).
 * Same worker as the Lounge; the free teaser is public, the live feed needs a
 * bearer whose payload carries `alpha: true`.
 *
 * Sells INFORMATION only — no execution, no custody. Every fetch is
 * timeout-bounded and every row is validated field-by-field: the digest is
 * machine-generated from a bot that is frequently offline, and one malformed
 * row must never crash the tab.
 */
export const BASE = 'https://seeker-lounge.bcrypto-eth.workers.dev';
export const ALPHA_TOKEN_KEY = 'seekerscout.alpha.token.v1';
/**
 * A USDC payment that landed but whose /alpha/subscribe call hasn't been
 * accepted yet. Persisted because the confirm step re-opens the wallet app
 * (signMessageBytes → transact), and Android reclaims a backgrounded RN
 * process freely — an in-memory ref would strand the user's money.
 */
export const ALPHA_PENDING_TX_KEY = 'seekerscout.alpha.pendingtx.v1';

/**
 * The USDC-receiving treasury wallet. Dedicated, receive-only address created
 * 2026-07-30 for Alpha revenue — deliberately NOT the publisher keypair (which
 * owns the dApp Store listing), the trading wallet, or the COOK treasury. Its
 * private key stays cold: nothing in this app or the worker ever signs with it.
 *
 * Must stay identical to the worker's `ALPHA_TREASURY` var (spec §2) — the
 * worker verifies the on-chain transfer against ITS value, and alphaTerms()
 * refuses to pay when the two disagree.
 */
export const ALPHA_TREASURY = 'CosHYybYt2VP6ScfJYqP2KoMFpKL8uckm3fT1JcM71h9';

/**
 * Subscription price + period. Mirrors the worker's `ALPHA_PRICE_USDC` var
 * (default "9.99"). The worker is the authority: it re-verifies the paid
 * amount on chain, so a mismatch is rejected server-side — but rejection
 * happens AFTER the USDC has moved, which protects the seller and not the
 * buyer. These constants are therefore only the pre-connect display value;
 * the amount we actually charge comes from alphaTerms() below.
 */
export const ALPHA_PRICE_USDC = 9.99;
export const ALPHA_PERIOD_DAYS = 30;

/** True once the CEO has replaced the treasury placeholder. */
export function isTreasuryConfigured(): boolean {
  return (
    ALPHA_TREASURY.length >= 32 &&
    ALPHA_TREASURY.length <= 44 &&
    !ALPHA_TREASURY.includes('<')
  );
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58Encode = (bytes: Uint8Array): string => {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
};

async function withTimeout(url: string, opts: RequestInit, ms = 12_000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * HTTP failure carrying its status, and — for /alpha/subscribe — the sales
 * gate the worker reported alongside it. A plain object rather than an Error
 * subclass so `instanceof` can't be broken by transpilation — callers read
 * the fields through the helpers below.
 */
type AlphaHttpError = Error & {
  status: number;
  salesClosed?: boolean;
};

const httpError = (message: string, status: number): AlphaHttpError =>
  Object.assign(new Error(message), { status });

/** Status of an error thrown by this module, or undefined if it wasn't ours. */
export function alphaErrorStatus(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null | undefined)?.status;
  return typeof s === 'number' ? s : undefined;
}

/**
 * True for "your token no longer entitles you" — re-auth, don't show a crash.
 * 402 is the worker's "the bearer is valid but your entitlement lapsed"
 * (/alpha/feed): same remedy as 401/403, so a subscriber whose 30 days ran
 * out mid-session stops being told "ALPHA ACTIVE".
 */
export function isAuthError(e: unknown): boolean {
  const s = alphaErrorStatus(e);
  return s === 401 || s === 402 || s === 403;
}

/**
 * True when the worker refused because the feed isn't live (its 409 sales
 * gate, which runs BEFORE the signature is consumed). Distinct from the
 * replay 409 — a stale-feed refusal must not tell the user to "tap again".
 */
export function isSalesClosedError(e: unknown): boolean {
  return (e as { salesClosed?: unknown } | null | undefined)?.salesClosed === true;
}

/**
 * True for the worker's "claim your founding number first" 403. Alpha only
 * needs Genesis ownership (spec §2), but a worker still routing /alpha/*
 * through the chat-grade membership check refuses unclaimed holders — the
 * screen turns this into a one-tap route to the Lounge instead of jargon.
 */
export function isClaimRequiredError(e: unknown): boolean {
  if (alphaErrorStatus(e) !== 403) return false;
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return typeof m === 'string' && m.toLowerCase().includes('founding number');
}

/* ------------------------------- parsing -------------------------------- */

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

const bool = (v: unknown): boolean => v === true;

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

/**
 * Worker/exporter timestamps arrive as epoch SECONDS in the digest and may
 * arrive as either seconds or ms in token payloads. Anything below the
 * year-2001 ms boundary is treated as seconds.
 */
const toMs = (v: number): number => (v > 1e12 ? v : v * 1000);

/** Map + drop rows that fail validation; never throws, never returns null. */
function rows<T>(v: unknown, parse: (r: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const raw of v) {
    const r = obj(raw);
    if (!r) continue;
    try {
      const parsed = parse(r);
      if (parsed) out.push(parsed);
    } catch {
      // one bad row is a dropped row, not a broken tab
    }
  }
  return out;
}

const LEVELS: AlphaStatusLevel[] = ['live', 'stale', 'degraded'];

/**
 * Freshness is the one field we must never guess optimistically: an absent or
 * unparseable block means we genuinely don't know how old this is, which is
 * 'degraded' — not 'live'.
 */
function parseFreshness(v: unknown): AlphaFreshness {
  const r = obj(v);
  const level = r ? str(r.status) : null;
  return {
    bot_running: r ? bool(r.bot_running) : false,
    newest_signal_ts: r ? num(r.newest_signal_ts) : null,
    oldest_source_stale_seconds: r ? num(r.oldest_source_stale_seconds) : null,
    status: LEVELS.includes(level as AlphaStatusLevel)
      ? (level as AlphaStatusLevel)
      : 'degraded',
  };
}

function parseTopWallet(r: Record<string, unknown>): AlphaTopWallet | null {
  const addr = str(r.addr); // redacted to null in the teaser
  const tier = str(r.tier); // null for a wallet we have never graded
  const win_rate = num(r.win_rate);
  const pnl_usd = num(r.pnl_usd);
  // An ungraded wallet is NOT a bad row — its address is the thing a paying
  // subscriber came for. Only an all-null row (the teaser's view of an
  // ungraded wallet, where addr is redacted too) carries nothing at all.
  if (!addr && !tier && win_rate === null && pnl_usd === null) return null;
  return { addr, tier, win_rate, pnl_usd };
}

function parseSmartMoney(r: Record<string, unknown>): AlphaSmartMoney | null {
  // symbol survives the teaser redaction; mint doesn't. A cluster with only a
  // mint is still identifiable — fall back to it rather than dropping the row.
  const symbol = str(r.symbol);
  const mint = str(r.mint);
  const label = symbol ?? mint;
  if (!label) return null;
  return {
    mint,
    symbol: label,
    chain: str(r.chain) ?? 'solana',
    wallet_count: num(r.wallet_count) ?? 0,
    buy_count: num(r.buy_count) ?? 0,
    window_sec: num(r.window_sec) ?? 0,
    grade: str(r.grade) ?? '',
    score: num(r.score) ?? 0,
    top_wallets: rows(r.top_wallets, parseTopWallet),
    ts: num(r.ts) ?? 0,
  };
}

function parseWalletRow(r: Record<string, unknown>): AlphaWalletRow | null {
  // addr is dropped in the teaser; tier can legitimately be null (a wallet
  // can be graded but untiered, and vice-versa). Drop only a row that
  // identifies nothing at all.
  const tier = str(r.tier);
  const addr = str(r.addr);
  const pnl = num(r.pnl_usd);
  if (!tier && !addr && pnl === null) return null;
  const wins = num(r.wins) ?? 0;
  const losses = num(r.losses) ?? 0;
  const winRate = num(r.win_rate);
  return {
    addr: addr ?? undefined,
    tier,
    wins,
    losses,
    // Derive only from numbers we were actually given — never invent a rate
    // for a wallet with no closed trades.
    win_rate: winRate ?? (wins + losses > 0 ? wins / (wins + losses) : 0),
    pnl_usd: num(r.pnl_usd) ?? 0,
    avg_pnl: num(r.avg_pnl) ?? 0,
    is_founding_vip: bool(r.is_founding_vip),
    last_trade_at: str(r.last_trade_at),
  };
}

function parseListing(r: Record<string, unknown>): AlphaListing | null {
  const coin = str(r.coin);
  if (!coin) return null;
  return {
    coin,
    exchange: str(r.exchange) ?? '',
    kind: str(r.kind) ?? '',
    is_pre_listing: bool(r.is_pre_listing),
    title: str(r.title) ?? '',
    ts: num(r.ts) ?? 0,
    source: str(r.source) ?? '',
  };
}

function parseCatalyst(r: Record<string, unknown>): AlphaCatalyst | null {
  const title = str(r.title);
  const symbol = str(r.symbol);
  if (!title && !symbol) return null;
  return {
    type: str(r.type) ?? '',
    symbol: symbol ?? '',
    title: title ?? '',
    score: num(r.score) ?? 0,
    ts: num(r.ts) ?? 0,
  };
}

function parseUnlock(r: Record<string, unknown>): AlphaUnlock | null {
  const coin = str(r.coin);
  const date = str(r.unlock_date);
  if (!coin || !date) return null;
  return {
    coin,
    unlock_date: date,
    pct_supply: num(r.pct_supply) ?? 0,
    days_until: num(r.days_until) ?? 0,
  };
}

function parseCounts(v: unknown): AlphaCounts {
  const r = obj(v);
  if (!r) return {};
  const pick = (k: keyof AlphaCounts) => {
    const n = num(r[k]);
    return n !== null && n >= 0 ? Math.floor(n) : undefined;
  };
  return {
    smart_money: pick('smart_money'),
    wallet_leaderboard: pick('wallet_leaderboard'),
    listing_radar: pick('listing_radar'),
    catalysts: pick('catalysts'),
    unlock_watch: pick('unlock_watch'),
  };
}

/**
 * Digest envelope → AlphaDigest. Returns null only when the payload isn't an
 * object at all; an empty-but-valid digest (which is exactly what a stale bot
 * produces today) parses fine and renders as "nothing fired in this window".
 */
export function parseDigest(v: unknown, teaser: boolean): AlphaDigest | null {
  const r = obj(v);
  if (!r) return null;
  // The worker may wrap the stored payload — accept both {..digest} and
  // {digest:{..}} / {payload:{..}} without guessing further.
  const inner = obj(r.digest) ?? obj(r.payload) ?? r;
  // The teaser envelope carries the CURRENT feed's status next to the
  // (deliberately delayed) snapshot; the live feed omits it.
  const feedStatus = str(r.feed_status) ?? str(inner.feed_status);
  const flag = (k: string): boolean | null =>
    typeof r[k] === 'boolean'
      ? (r[k] as boolean)
      : typeof inner[k] === 'boolean'
        ? (inner[k] as boolean)
        : null;
  return {
    version: num(inner.version) ?? 1,
    generated_at: str(inner.generated_at) ?? '',
    generated_ts: num(inner.generated_ts) ?? 0,
    freshness: parseFreshness(inner.freshness),
    smart_money: rows(inner.smart_money, parseSmartMoney),
    wallet_leaderboard: rows(inner.wallet_leaderboard, parseWalletRow),
    listing_radar: rows(inner.listing_radar, parseListing),
    catalysts: rows(inner.catalysts, parseCatalyst),
    unlock_watch: rows(inner.unlock_watch, parseUnlock),
    teaser: typeof inner.teaser === 'boolean' ? inner.teaser : teaser,
    // The worker sets available:false only for "nothing has ever been
    // ingested". The live feed sends no such key, so absent = available —
    // mislabelling a genuinely quiet live digest would be the worse lie.
    available: flag('available') !== false,
    delayed: flag('delayed') === true,
    sales_open: flag('sales_open') ?? undefined,
    feed_status:
      feedStatus && (LEVELS.includes(feedStatus as AlphaStatusLevel) || feedStatus === 'unknown')
        ? (feedStatus as AlphaStatusLevel | 'unknown')
        : undefined,
    counts: parseCounts(inner.counts),
  };
}

/**
 * True when digests ARE being published but none has aged into the free
 * tier's ≥24h window yet — i.e. the very first day of a live feed.
 *
 * The worker reports `available:false` for BOTH "nothing was ever ingested"
 * and "nothing old enough to show for free", but it still copies the stored
 * digest's real status into `feed_status`. So a concrete feed_status alongside
 * available:false is proof a digest exists and is simply too fresh to give
 * away. Without this split the tab tells a launch-day visitor the feed is dead
 * while paying members are reading it (caught on device 2026-07-30).
 */
export function isAwaitingFirstPreview(d: AlphaDigest): boolean {
  return (
    d.available === false &&
    !!d.feed_status &&
    d.feed_status !== 'unknown'
  );
}

/** True when a digest carries no rows at all (bot off, or a quiet window). */
export function isDigestEmpty(d: AlphaDigest): boolean {
  return (
    d.smart_money.length === 0 &&
    d.wallet_leaderboard.length === 0 &&
    d.listing_radar.length === 0 &&
    d.catalysts.length === 0 &&
    d.unlock_watch.length === 0
  );
}

/* ------------------------------ endpoints ------------------------------- */

/**
 * Free, delayed + partially redacted digest. Public — no wallet, no token.
 * null on any failure; the screen then shows its own "couldn't load" state
 * rather than an empty page pretending there's no intel.
 */
export async function getTeaser(): Promise<AlphaDigest | null> {
  try {
    const res = await withTimeout(`${BASE}/alpha/teaser`, {}, 10_000);
    if (!res.ok) return null;
    return parseDigest(await res.json(), true);
  } catch {
    return null;
  }
}

/**
 * The worker's authoritative payment terms, carried on both /alpha/auth and
 * /alpha/status. `sales_open` is read as a TRI-STATE: an older worker that
 * doesn't send it must read as "unknown", not as "closed", or the tab would
 * refuse sales it has no reason to refuse.
 */
function parseTerms(body: Record<string, unknown>): AlphaTerms {
  const treasury = str(body.treasury);
  const price = num(body.price_usdc);
  const feed = str(body.feed_status);
  return {
    // Shape-check the treasury exactly as isTreasuryConfigured() does, so a
    // worker still holding the placeholder reads as "not configured".
    treasury:
      treasury && treasury.length >= 32 && treasury.length <= 44 && !treasury.includes('<')
        ? treasury
        : null,
    price_usdc: price !== null && price > 0 ? price : null,
    sales_open: typeof body.sales_open === 'boolean' ? body.sales_open : null,
    feed_status:
      feed && (LEVELS.includes(feed as AlphaStatusLevel) || feed === 'unknown')
        ? (feed as AlphaStatusLevel | 'unknown')
        : null,
  };
}

/** Entitlement for a wallet without signing. null on any failure. */
export async function getAlphaStatus(
  wallet: string,
): Promise<AlphaEntitlement | null> {
  try {
    const res = await withTimeout(
      `${BASE}/alpha/status?wallet=${encodeURIComponent(wallet)}`,
      {},
      8000,
    );
    if (!res.ok) return null;
    const body = obj(await res.json());
    if (!body) return null;
    return {
      founding: bool(body.founding),
      paid_until: str(body.paid_until),
      active: bool(body.active),
      ...parseTerms(body),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve what we may actually charge, from the worker's own terms. Returns
 * the terms to pay with, or a human message explaining why we will NOT take
 * the user's money. Fails CLOSED on purpose: the worker refuses a sale it
 * disagrees with only AFTER the USDC has moved, so every disagreement has to
 * be caught here, before the wallet prompt.
 */
export function resolvePaymentTerms(
  terms: AlphaTerms | null,
): { treasury: string; price: number } | { error: string } {
  // Self-contained last gate: even if a caller ever reached here with the
  // placeholder still compiled in, this must not hand back payable terms.
  if (!isTreasuryConfigured()) {
    return {
      error:
        "Alpha payments aren't switched on yet — nothing was charged. Try again once we're live.",
    };
  }
  if (!terms) {
    return {
      error:
        "We couldn't confirm the current price with our server, so nothing was charged. Try again in a moment.",
    };
  }
  if (terms.sales_open === false) {
    const state = terms.feed_status && terms.feed_status !== 'unknown'
      ? terms.feed_status
      : 'not live';
    return {
      error:
        `Alpha is paused while our feed is ${state} — you have NOT been charged. ` +
        'We only sell a live feed; check back when the intel is flowing again.',
    };
  }
  if (!terms.treasury) {
    return {
      error:
        "Alpha payments aren't switched on yet — nothing was charged. Try again once we're live.",
    };
  }
  if (terms.treasury !== ALPHA_TREASURY) {
    return {
      error:
        "This version of Seeker Scout can't pay our current wallet — update the app from the dApp Store. Nothing was charged.",
    };
  }
  if (terms.price_usdc === null) {
    return {
      error:
        "We couldn't confirm the current price with our server, so nothing was charged. Try again in a moment.",
    };
  }
  if (Math.abs(terms.price_usdc - ALPHA_PRICE_USDC) > 1e-9) {
    return {
      error:
        `Alpha now costs ${terms.price_usdc} USDC, not ${ALPHA_PRICE_USDC} — update the app to unlock at the current price. Nothing was charged.`,
    };
  }
  return { treasury: terms.treasury, price: terms.price_usdc };
}

const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

function parseSession(token: string, body: Record<string, unknown>): AlphaSession {
  const tier = str(body.tier);
  const alphaExp = num(body.alphaExp);
  const exp = num(body.exp);
  return {
    token,
    number: num(body.number),
    wallet: str(body.wallet) ?? '',
    tier:
      tier === 'founding' || tier === 'early' || tier === 'member'
        ? (tier as AlphaTier)
        : null,
    alpha: bool(body.alpha),
    alphaExp: alphaExp !== null ? toMs(alphaExp) : null,
    exp: exp !== null ? toMs(exp) : null,
    ...parseTerms(body),
  };
}

/**
 * Cached session if the token is still good. Expiry is the EARLIEST of the
 * token TTL, the server's `exp`, and the entitlement's `alphaExp` — an
 * entitlement that lapsed mid-session must stop claiming to be entitled.
 */
export async function cachedAlphaToken(): Promise<AlphaSession | null> {
  try {
    const raw = await AsyncStorage.getItem(ALPHA_TOKEN_KEY);
    if (!raw) return null;
    const parsed = obj(JSON.parse(raw));
    if (!parsed) return null;
    const token = str(parsed.token);
    const until = num(parsed.until);
    if (!token || until === null) return null;
    if (Date.now() >= until - 60_000) return null;
    const session = obj(parsed.session);
    if (!session) return null;
    return parseSession(token, session);
  } catch {
    return null;
  }
}

/** Drop the cached session (sign-out, or the worker rejected our bearer). */
export async function clearAlphaToken(): Promise<void> {
  await AsyncStorage.removeItem(ALPHA_TOKEN_KEY).catch(() => {});
}

/**
 * A landed USDC payment whose entitlement hasn't been granted yet.
 *
 * One record, not one per wallet: the flow that writes it is a deliberate
 * payment by the wallet connected at that moment, so a second payment from a
 * different wallet supersedes it. `wallet` is carried so the signature is
 * never re-submitted under someone else's session, which the worker would
 * refuse with a 403 forever.
 */
export interface AlphaPendingTx {
  signature: string;
  /** The wallet that paid — the worker rejects a redemption from any other. */
  wallet: string;
  /** Epoch ms the payment was made. */
  ts: number;
}

/** Older than this and the signature is past any plausible redemption. */
const PENDING_TX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Remember a payment that already left the user's wallet. Written BEFORE the
 * confirm step, because that step re-opens the wallet app and a backgrounded
 * RN process can be killed at any moment — losing this record would mean the
 * next tap charges them a second time.
 */
export async function savePendingTx(tx: AlphaPendingTx): Promise<void> {
  try {
    await AsyncStorage.setItem(ALPHA_PENDING_TX_KEY, JSON.stringify(tx));
  } catch {
    // Best-effort: a blocked AsyncStorage costs us the crash-recovery path,
    // but the in-memory ref still covers the common retry.
  }
}

/** The stored pending payment, or null when there isn't a usable one. */
export async function cachedPendingTx(): Promise<AlphaPendingTx | null> {
  try {
    const raw = await AsyncStorage.getItem(ALPHA_PENDING_TX_KEY);
    if (!raw) return null;
    const parsed = obj(JSON.parse(raw));
    if (!parsed) return null;
    const signature = str(parsed.signature);
    const wallet = str(parsed.wallet);
    const ts = num(parsed.ts);
    if (!signature || !wallet || ts === null) return null;
    if (Date.now() - ts > PENDING_TX_MAX_AGE_MS) return null;
    return { signature, wallet, ts };
  } catch {
    return null;
  }
}

/**
 * Forget a pending payment. Called ONLY on a terminal verdict — granted, or
 * a refusal that means this signature can never be redeemed. A refusal that
 * left the signature unconsumed (stale feed, network, 5xx) keeps it.
 */
export async function clearPendingTx(): Promise<void> {
  await AsyncStorage.removeItem(ALPHA_PENDING_TX_KEY).catch(() => {});
}

async function cacheSession(
  token: string,
  body: Record<string, unknown>,
): Promise<AlphaSession> {
  const session = parseSession(token, body);
  const bounds = [Date.now() + TOKEN_TTL_MS, session.exp, session.alphaExp]
    .filter((v): v is number => typeof v === 'number' && v > Date.now());
  const until = bounds.length > 0 ? Math.min(...bounds) : Date.now() + TOKEN_TTL_MS;
  try {
    await AsyncStorage.setItem(
      ALPHA_TOKEN_KEY,
      JSON.stringify({ token, until, session: body }),
    );
  } catch {
    // A full/blocked AsyncStorage costs a re-sign next launch, nothing more.
  }
  return session;
}

/**
 * Alpha's own signed message — must match the worker's `alphaMessage` byte for
 * byte. Deliberately NOT the Lounge claim string that `lounge.ts` and
 * `chat.ts` sign: sharing it would make a captured free-tier login body a
 * valid credential for the paid endpoints. Do not "unify" these.
 */
const alphaMessage = (address: string, mint: string, ts: string) =>
  `Seeker Scout — Alpha access\npurpose: alpha-v1\nwallet: ${address}\nmint: ${mint}\nts: ${ts}`;

/**
 * Sign once → get + cache an Alpha bearer. Same Genesis-ownership proof the
 * Lounge claim and chat use, over Alpha's own domain-separated message, so
 * wallets that return signature‖message get the alternate slice retried.
 */
export async function authAlpha(
  address: string,
  authToken: string,
  mint: string,
): Promise<AlphaSession> {
  const ts = new Date().toISOString();
  const signed = await signMessageBytes(
    address,
    authToken,
    alphaMessage(address, mint, ts),
  );
  const candidates =
    signed.length === 64 ? [signed] : [signed.slice(0, 64), signed.slice(-64)];

  let lastErr = 'sign-in failed';
  let lastStatus = 401;
  for (const sig of candidates) {
    const res = await withTimeout(`${BASE}/alpha/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        wallet: address,
        mint,
        ts,
        signature: base58Encode(sig),
      }),
    });
    const body = obj(await res.json().catch(() => ({}))) ?? {};
    const token = str(body.token);
    if (res.ok && token) return await cacheSession(token, body);
    lastErr = str(body.error) ?? `sign-in failed (${res.status})`;
    // Preserve the real status (mirrors subscribeAlpha): collapsing every
    // failure to 401 makes a 503 "not configured" look like a bad token.
    lastStatus = res.status;
    if (res.status !== 401) break; // only signature-shape issues retry
  }
  throw httpError(lastErr, lastStatus);
}

/**
 * Full live digest. Throws with a status (401/402/403 = the session no longer
 * entitles us, see isAuthError) so the screen can tell "your entitlement
 * lapsed" from "the network is down".
 */
export async function getFeed(token: string): Promise<AlphaDigest> {
  const res = await withTimeout(`${BASE}/alpha/feed`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = str(obj(body)?.error) ?? `feed unavailable (${res.status})`;
    throw httpError(message, res.status);
  }
  const digest = parseDigest(body, false);
  if (!digest) throw httpError('feed returned an unreadable response', 502);
  return digest;
}

/**
 * Register a completed USDC payment. The worker re-verifies the transfer on
 * chain (amount, destination owner, source owner, replay) — a signature we
 * made up is rejected there, not trusted here. Returns the new entitlement.
 */
export async function subscribeAlpha(
  address: string,
  authToken: string,
  mint: string,
  txSignature: string,
): Promise<AlphaEntitlement> {
  const ts = new Date().toISOString();
  const signed = await signMessageBytes(
    address,
    authToken,
    alphaMessage(address, mint, ts),
  );
  const candidates =
    signed.length === 64 ? [signed] : [signed.slice(0, 64), signed.slice(-64)];

  let lastErr = 'could not confirm the payment';
  let lastStatus = 500;
  // The worker's stale-feed refusal and its replay refusal are both 409 but
  // need opposite handling: the former leaves the signature redeemable, the
  // latter means it is gone. Only the former carries sales_open:false.
  let lastSalesClosed = false;
  for (const sig of candidates) {
    // 20s: the worker waits on getTransaction, which lags a fresh signature.
    const res = await withTimeout(
      `${BASE}/alpha/subscribe`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          wallet: address,
          mint,
          ts,
          signature: base58Encode(sig),
          txSignature,
        }),
      },
      20_000,
    );
    const body = obj(await res.json().catch(() => ({}))) ?? {};
    if (res.ok) {
      return {
        founding: bool(body.founding),
        paid_until: str(body.paid_until),
        // A 200 from /alpha/subscribe means the payment verified; only treat
        // it as inactive if the worker explicitly says so.
        active: 'active' in body ? bool(body.active) : true,
        ...parseTerms(body),
      };
    }
    lastErr = str(body.error) ?? `could not confirm the payment (${res.status})`;
    lastStatus = res.status;
    lastSalesClosed = body.sales_open === false;
    if (res.status !== 401) break;
  }
  const err = httpError(lastErr, lastStatus);
  if (lastSalesClosed) err.salesClosed = true;
  throw err;
}
