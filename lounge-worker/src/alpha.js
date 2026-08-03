/**
 * Seeker Scout — Alpha intel feed (docs/SCOUT_ALPHA_SPEC.md §2).
 *
 * Sells INFORMATION only: the War Room's digest (VIP cluster buys, wallet
 * leaderboard, listing radar, catalysts, unlock watch). Free tier = a delayed,
 * partially-redacted teaser. Paid tier = the live digest, unlocked by a USDC
 * transfer to the treasury, or free for Lounge founders (#1-100).
 *
 * Endpoints (routed from index.js):
 *   POST /alpha/ingest    x-alpha-key: <ALPHA_INGEST_SECRET>  -> {ok, ...}
 *   GET  /alpha/teaser                                        -> delayed/redacted digest
 *   POST /alpha/auth      {wallet, mint, ts, signature}       -> {token, alpha, alphaExp, ...}
 *   GET  /alpha/feed      Bearer token (alpha:true)           -> full digest
 *   POST /alpha/subscribe {wallet, mint, ts, signature, txSignature} -> entitlement
 *   GET  /alpha/status?wallet=<base58>                        -> {founding, paid_until, active, ...}
 *
 * Two non-negotiables from the spec:
 *   1. Freshness is reported honestly — an absent or unrecognised status is
 *      'degraded'/'unknown', never optimistically 'live'.
 *   2. We do not sell a stale feed: /alpha/subscribe refuses new paid subs
 *      while the digest isn't 'live' — which means BOTH the producer's
 *      reported status AND the digest's actual age (see MAX_LIVE_AGE_SECONDS).
 *      The stored status alone never decays, so age is the real gate.
 */
import { base58 } from '@scure/base';
import { issueToken, verifyToken } from './token.js';
import { rpc } from './rpc.js';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * A digest older than this is NOT 'live', whatever the producer said when it
 * was ingested. The exporter pushes hourly, so 6h tolerates several missed
 * runs while still refusing to sell yesterday's intel as current.
 */
const MAX_LIVE_AGE_SECONDS = 6 * 60 * 60;
const SUB_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const FOUNDING_MAX = 100; // claims #1-100: alpha is a gift, no payment needed
const TEASER_ROWS = 2; // spec §1: "keep counts + first 2 rows of each array"
const TEASER_DELAY_MS = 24 * 60 * 60 * 1000;
const MAX_INGEST_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_ROWS = 500; // per digest array — bounds a hostile/runaway ingest
const DIGEST_RETENTION_DAYS = 14;
// Dated rows the retention sweep keeps no matter how old they are, so a
// resumed exporter can never wipe the corpus the free teaser is served from.
const TEASER_KEEP_ROWS = 2;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEFAULT_PRICE_USDC = '9.99';
const AMOUNT_EPSILON = 1e-9; // float slack on the price compare
const DIGEST_ARRAYS = [
  'smart_money',
  'wallet_leaderboard',
  'listing_radar',
  'catalysts',
  'unlock_watch',
];
const FRESHNESS_STATUSES = ['live', 'stale', 'degraded'];

const enc = new TextEncoder();

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, x-alpha-key',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', ...CORS },
  });

/**
 * Alpha tokens are signed with the chat secret PLUS a scope suffix. Same
 * scheme, same key material, different domain — so an alpha token is not a
 * valid chat token (it can't sidestep chat's block list) and a chat token is
 * not a valid alpha token. Needs no extra wrangler secret.
 *
 * NO fallback literal: a committed default key would let anyone forge an
 * `alpha:true` bearer, and /alpha/feed re-checks nothing against the DB. The
 * two routes that need it fail CLOSED when CHAT_SECRET is unset — same policy
 * as secretEquals() on the ingest path.
 */
const alphaSecret = (env) => `${env.CHAT_SECRET}|alpha-v1`;

/**
 * Compare a presented secret against the configured one without leaking its
 * length or a common prefix: hash both to a fixed 32 bytes, then diff every
 * byte with no early exit.
 */
async function secretEquals(presented, configured) {
  if (typeof presented !== 'string' || typeof configured !== 'string') return false;
  if (!presented || !configured) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(presented)),
    crypto.subtle.digest('SHA-256', enc.encode(configured)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** base58 32-byte pubkey (also rejects the `<<TREASURY_PUBKEY>>` placeholder). */
function isPubkey(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try {
    return base58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/** base58 64-byte transaction signature. */
function isSignature(s) {
  if (typeof s !== 'string' || s.length < 64 || s.length > 96) return false;
  try {
    return base58.decode(s).length === 64;
  } catch {
    return false;
  }
}

const priceUsdc = (env) => {
  const p = parseFloat(env.ALPHA_PRICE_USDC || DEFAULT_PRICE_USDC);
  return Number.isFinite(p) && p > 0 ? p : parseFloat(DEFAULT_PRICE_USDC);
};

/** Configured treasury, or null while it is unset/placeholder (sales closed). */
const treasuryOf = (env) => (isPubkey(env.ALPHA_TREASURY) ? env.ALPHA_TREASURY : null);

/** Read + size-cap + parse a JSON body. Returns {body} or {error,status}. */
async function readJson(request, maxBytes) {
  const declared = parseInt(request.headers.get('content-length') || '0', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { error: 'body too large', status: 413 };
  }
  let raw;
  try {
    raw = await request.text();
  } catch {
    return { error: 'bad body', status: 400 };
  }
  // Chunked/lying content-length: re-check the material we actually read.
  if (raw.length > maxBytes) return { error: 'body too large', status: 413 };
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return { error: 'bad json', status: 400 };
  }
}

const finiteNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const MAX_TS_SECONDS = 4_102_444_800; // 2100-01-01; anything beyond is garbage

/**
 * Unix SECONDS, tolerating a millisecond stamp or a numeric string. Out-of-
 * range values are null, not clamped — a bogus stamp must not silently become
 * a plausible one (and must not blow up `new Date(...).toISOString()`).
 */
function normalizeTs(v) {
  const n = finiteNum(typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
  if (n === null || n <= 0) return null;
  const s = Math.floor(n > 1e12 ? n / 1000 : n);
  return s > 0 && s <= MAX_TS_SECONDS ? s : null;
}

/**
 * Validate + normalize an ingested digest to the spec §1 shape. Missing data
 * becomes an empty array (absence, not a fabricated zero row); an unknown
 * freshness status becomes 'degraded' — we never upgrade to 'live' by default.
 * Returns null if the payload is not an object at all.
 */
function normalizeDigest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const f = raw.freshness && typeof raw.freshness === 'object' && !Array.isArray(raw.freshness)
    ? raw.freshness
    : {};
  const parsedAt = typeof raw.generated_at === 'string' ? Date.parse(raw.generated_at) : NaN;
  let generatedTs = normalizeTs(raw.generated_ts);
  if (generatedTs === null && Number.isFinite(parsedAt)) generatedTs = Math.floor(parsedAt / 1000);
  if (generatedTs === null) generatedTs = Math.floor(Date.now() / 1000);
  const digest = {
    version: finiteNum(raw.version) ?? 1,
    generated_at: Number.isFinite(parsedAt)
      ? new Date(parsedAt).toISOString()
      : new Date(generatedTs * 1000).toISOString(),
    generated_ts: generatedTs,
    freshness: {
      bot_running: f.bot_running === true,
      newest_signal_ts: normalizeTs(f.newest_signal_ts),
      oldest_source_stale_seconds: finiteNum(f.oldest_source_stale_seconds),
      status: FRESHNESS_STATUSES.includes(f.status) ? f.status : 'degraded',
    },
  };
  for (const key of DIGEST_ARRAYS) {
    digest[key] = (Array.isArray(raw[key]) ? raw[key] : [])
      .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
      .slice(0, MAX_ROWS);
  }
  return digest;
}

/**
 * Shallow copy of a row: `drop` keys vanish, `blank` keys are always present
 * and null (stable shape for the app's per-field validators). Everything else
 * stays visible — the teaser is the sales pitch, not an empty husk.
 */
function redactRow(row, { drop = [], blank = [] } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (drop.includes(k) || blank.includes(k)) continue;
    out[k] = v;
  }
  for (const k of blank) out[k] = null;
  return out;
}

/** Spec §1 teaser transform: counts + first 2 rows, addresses/mints removed. */
function toTeaser(digest, delayed) {
  const counts = {};
  for (const key of DIGEST_ARRAYS) {
    counts[key] = Array.isArray(digest[key]) ? digest[key].length : 0;
  }
  const rows = (key) => (Array.isArray(digest[key]) ? digest[key] : []).slice(0, TEASER_ROWS);
  return {
    version: digest.version ?? 1,
    teaser: true,
    available: true,
    delayed,
    generated_at: digest.generated_at ?? null,
    generated_ts: digest.generated_ts ?? null,
    freshness: digest.freshness ?? { status: 'degraded' },
    counts,
    // mint nulled -> symbol only; top wallets keep tier + stats, lose addr.
    smart_money: rows('smart_money').map((r) => {
      const out = redactRow(r, { blank: ['mint'] });
      out.top_wallets = (Array.isArray(r.top_wallets) ? r.top_wallets : [])
        .slice(0, TEASER_ROWS)
        .filter((w) => w && typeof w === 'object' && !Array.isArray(w))
        .map((w) => redactRow(w, { blank: ['addr'] }));
      return out;
    }),
    wallet_leaderboard: rows('wallet_leaderboard').map((r) => redactRow(r, { drop: ['addr'] })),
    listing_radar: rows('listing_radar').map((r) => redactRow(r)),
    catalysts: rows('catalysts').map((r) => redactRow(r)),
    unlock_watch: rows('unlock_watch').map((r) => redactRow(r)),
  };
}

/** Honest empty teaser for "nothing has ever been ingested". */
function emptyTeaser() {
  const counts = {};
  const arrays = {};
  for (const key of DIGEST_ARRAYS) {
    counts[key] = 0;
    arrays[key] = [];
  }
  return {
    version: 1,
    teaser: true,
    available: false,
    delayed: false,
    generated_at: null,
    generated_ts: null,
    freshness: {
      bot_running: false,
      newest_signal_ts: null,
      oldest_source_stale_seconds: null,
      status: 'unknown',
    },
    counts,
    ...arrays,
  };
}

function parseDigestRow(row) {
  if (!row?.payload || typeof row.payload !== 'string') return null;
  try {
    const parsed = JSON.parse(row.payload);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null; // corrupt row → treated as absent, never a 1101
  }
}

/** Freshness + sales gate of the CURRENT feed (cheap: one indexed row). */
async function feedMeta(env) {
  const row = await env.DB.prepare(
    "SELECT generated_ts, status FROM alpha_digests WHERE id = 'latest'",
  ).first();
  const stored = FRESHNESS_STATUSES.includes(row?.status) ? row.status : 'unknown';
  const generatedTs = finiteNum(row?.generated_ts);

  // `stored` is the producer's self-report, frozen at INGEST time — it says
  // how fresh the signals were when the digest was built, not how old the
  // digest is NOW. On its own it never decays: when the exporter stopped
  // pushing, a 46-hour-old digest was still being served as 'live' with
  // sales_open=true, i.e. we would have taken 9.99 USDC for two-day-old
  // intel. Age is the authority; the producer can only make it worse.
  const ageSeconds =
    generatedTs === null ? null : Math.floor(Date.now() / 1000) - generatedTs;
  const tooOld = ageSeconds === null || ageSeconds > MAX_LIVE_AGE_SECONDS;
  const status = tooOld && stored === 'live' ? 'stale' : stored;

  return {
    status,
    generated_ts: row?.generated_ts ?? null,
    age_seconds: ageSeconds,
    // We refuse to take money for a feed that isn't live, and we refuse to
    // point a payment at an unconfigured treasury.
    salesOpen: status === 'live' && treasuryOf(env) !== null,
  };
}

/**
 * Entitlement for a wallet. `number` is its founding number (or null).
 * Founders (#1-100) are entitled with no payment; everyone else needs a sub
 * whose paid_until is in the future.
 */
async function entitlement(env, wallet, number) {
  const founding = Number.isInteger(number) && number > 0 && number <= FOUNDING_MAX;
  let paidUntil = null;
  let paidUntilMs = 0;
  const row = await env.DB.prepare('SELECT paid_until FROM alpha_subs WHERE wallet = ?')
    .bind(wallet).first();
  if (row?.paid_until) {
    const ms = Date.parse(row.paid_until);
    if (Number.isFinite(ms)) {
      paidUntil = row.paid_until;
      paidUntilMs = ms;
    }
  }
  return {
    founding,
    paid_until: paidUntil,
    paidUntilMs,
    active: founding || paidUntilMs > Date.now(),
  };
}

/**
 * Extend a subscription by 30 days from max(now, current paid_until).
 * Compare-and-swap so two concurrent redemptions can't both extend from the
 * same base (which would silently eat one payment). Returns the new
 * paid_until, or null if the write never landed.
 *
 * Idempotent per signature: the caller's compensating DELETE releases the
 * replay claim whenever this throws, including when the write DID land and
 * only the response was lost. Without the short-circuit below, the retry
 * would extend a second time off the already-extended base and one payment
 * would buy 60 days.
 */
async function extendSub(env, wallet, txSignature) {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await env.DB.prepare('SELECT paid_until, last_tx FROM alpha_subs WHERE wallet = ?')
      .bind(wallet).first();
    if (row?.last_tx === txSignature && row.paid_until) return row.paid_until;
    const currentMs = row?.paid_until ? Date.parse(row.paid_until) : NaN;
    const baseMs = Math.max(nowMs, Number.isFinite(currentMs) ? currentMs : 0);
    const paidUntil = new Date(baseMs + SUB_DURATION_MS).toISOString();
    if (!row) {
      const ins = await env.DB.prepare(
        'INSERT OR IGNORE INTO alpha_subs (wallet, paid_until, last_tx, updated_at) VALUES (?, ?, ?, ?)',
      ).bind(wallet, paidUntil, txSignature, nowIso).run();
      if (ins.meta?.changes) return paidUntil;
      continue; // lost the insert race — re-read and extend the winner's row
    }
    const upd = await env.DB.prepare(
      'UPDATE alpha_subs SET paid_until = ?, last_tx = ?, updated_at = ? WHERE wallet = ? AND paid_until = ?',
    ).bind(paidUntil, txSignature, nowIso, wallet, row.paid_until).run();
    if (upd.meta?.changes) return paidUntil;
  }
  // Pathological contention: take the payment rather than lose it, accepting
  // that a simultaneous second redemption may have extended from the same base.
  const cur = await env.DB.prepare('SELECT paid_until, last_tx FROM alpha_subs WHERE wallet = ?')
    .bind(wallet).first();
  if (cur?.last_tx === txSignature && cur.paid_until) return cur.paid_until;
  const paidUntil = new Date(nowMs + SUB_DURATION_MS).toISOString();
  const last = await env.DB.prepare(
    'INSERT INTO alpha_subs (wallet, paid_until, last_tx, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(wallet) DO UPDATE SET paid_until = max(alpha_subs.paid_until, excluded.paid_until), ' +
    'last_tx = excluded.last_tx, updated_at = excluded.updated_at',
  ).bind(wallet, paidUntil, txSignature, nowIso).run();
  if (!last.meta?.changes) return null;
  const row = await env.DB.prepare('SELECT paid_until FROM alpha_subs WHERE wallet = ?')
    .bind(wallet).first();
  return row?.paid_until ?? null;
}

/** uiAmount of a pre/postTokenBalances entry, preferring the exact raw amount. */
function uiAmountOf(bal) {
  const t = bal?.uiTokenAmount;
  if (!t || typeof t !== 'object') return null;
  const dec = Number(t.decimals);
  if (typeof t.amount === 'string' && /^\d+$/.test(t.amount) &&
      Number.isInteger(dec) && dec >= 0 && dec <= 18) {
    const ui = Number(t.amount) / 10 ** dec;
    if (Number.isFinite(ui)) return ui;
  }
  const ui = typeof t.uiAmount === 'number'
    ? t.uiAmount
    : parseFloat(t.uiAmountString);
  return Number.isFinite(ui) ? ui : null;
}

/**
 * Net USDC movement per owner, derived from meta.pre/postTokenBalances — the
 * instruction-shape-independent way to read a transfer (works for transfer,
 * transferChecked, CPI, router hops, ATA-created-in-tx, ATA-closed-in-tx).
 */
function usdcDeltasByOwner(meta) {
  const byIndex = new Map();
  const collect = (list, field) => {
    for (const b of Array.isArray(list) ? list : []) {
      if (!b || typeof b !== 'object') continue;
      if (b.mint !== USDC_MINT) continue;
      const idx = Number(b.accountIndex);
      if (!Number.isInteger(idx)) continue;
      const ui = uiAmountOf(b);
      if (ui === null) continue;
      const cur = byIndex.get(idx) ?? { owner: null, pre: 0, post: 0 };
      cur[field] = ui;
      if (typeof b.owner === 'string' && b.owner) cur.owner = b.owner;
      byIndex.set(idx, cur);
    }
  };
  collect(meta?.preTokenBalances, 'pre');
  collect(meta?.postTokenBalances, 'post');
  const byOwner = new Map();
  for (const { owner, pre, post } of byIndex.values()) {
    if (!owner) continue;
    byOwner.set(owner, (byOwner.get(owner) ?? 0) + (post - pre));
  }
  return byOwner;
}

/** Was `wallet` a signer of this transaction? */
function isSignerOf(tx, wallet) {
  const keys = tx?.transaction?.message?.accountKeys;
  if (!Array.isArray(keys)) return false;
  for (const k of keys) {
    // jsonParsed gives {pubkey, signer, ...}; a raw-encoding fallback gives
    // bare strings, where presence is all we can assert (the balance-delta
    // check below is the real proof that the funds were theirs).
    if (typeof k === 'string') {
      if (k === wallet) return true;
    } else if (k?.pubkey === wallet && k.signer === true) {
      return true;
    }
  }
  return false;
}

/**
 * Spec §2 payment verify, steps 2-3. Returns {amount} on success or
 * {error,status}. Never throws.
 */
async function verifyUsdcPayment(env, signature, wallet, treasury, price) {
  let tx;
  try {
    tx = await rpc(env, 'getTransaction', [
      signature,
      { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
  } catch (e) {
    // Never echo a raw fetch error: on Workers it can carry the target URL,
    // and RPC_URL is a SECRET (Triton embeds the API key in the path). Only
    // rpc.js's own messages ('rpc 503' / 'rpc: <provider msg>') are safe.
    const detail =
      typeof e?.message === 'string' && /^rpc[ :]/.test(e.message) ? e.message : '';
    return {
      error: detail ? `chain check unavailable: ${detail}` : 'chain check unavailable',
      status: 502,
    };
  }
  if (!tx) {
    return { error: 'transaction not found yet — wait for confirmation and retry', status: 404 };
  }
  const meta = tx.meta;
  if (!meta || typeof meta !== 'object') {
    return { error: 'transaction metadata unavailable', status: 502 };
  }
  if ((meta.err ?? null) !== null) {
    return { error: 'transaction failed on-chain', status: 400 };
  }
  const deltas = usdcDeltasByOwner(meta);
  if (deltas.size === 0) {
    return { error: 'no USDC transfer found in this transaction', status: 400 };
  }
  const received = deltas.get(treasury) ?? 0;
  if (received <= 0) {
    return { error: 'no USDC was transferred to the treasury', status: 400 };
  }
  if (received < price - AMOUNT_EPSILON) {
    return {
      error: `underpaid: received ${received} USDC, ${price} required`,
      status: 400,
    };
  }
  const sent = -(deltas.get(wallet) ?? 0);
  if (sent < price - AMOUNT_EPSILON) {
    return { error: 'payment did not come from this wallet', status: 403 };
  }
  if (!isSignerOf(tx, wallet)) {
    return { error: 'transaction was not signed by this wallet', status: 403 };
  }
  return { amount: received };
}

/**
 * @param verifyFn async ({wallet,mint,ts,signature}) => {number,tier} | {error,status}
 *   index.js's verifyAlphaOwner — fresh signature over ALPHA's own message +
 *   genuine Genesis Token held by the wallet. `number`/`tier` are the founding
 *   number resolved best-effort by mint, and are NULL for an owner who never
 *   claimed one: Genesis ownership is the gate here, a founding number only
 *   decides the free founder tier.
 */
export async function handleAlpha(request, env, url, verifyFn) {
  try {
    return await route(request, env, url, verifyFn);
  } catch {
    // Never echo an internal error (it can carry config) and never a 1101.
    return json({ error: 'alpha service error' }, 500);
  }
}

async function route(request, env, url, verifyFn) {
  const path = url.pathname;

  // --- ingest: the exporter pushes a digest (shared-secret header) ---
  if (request.method === 'POST' && path === '/alpha/ingest') {
    if (!(await secretEquals(request.headers.get('x-alpha-key'), env.ALPHA_INGEST_SECRET))) {
      return json({ error: 'unauthorized' }, 401);
    }
    const parsed = await readJson(request, MAX_INGEST_BYTES);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const digest = normalizeDigest(parsed.body);
    if (!digest) return json({ error: 'invalid digest' }, 400);

    const payload = JSON.stringify(digest);
    const day = new Date(digest.generated_ts * 1000).toISOString().slice(0, 10);
    const upsert =
      'INSERT INTO alpha_digests (id, generated_ts, status, payload) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET generated_ts = excluded.generated_ts, ' +
      'status = excluded.status, payload = excluded.payload ' +
      // An out-of-order push must never rewind the feed.
      'WHERE excluded.generated_ts >= alpha_digests.generated_ts';
    try {
      await env.DB.batch([
        env.DB.prepare(upsert).bind('latest', digest.generated_ts, digest.freshness.status, payload),
        env.DB.prepare(upsert).bind(day, digest.generated_ts, digest.freshness.status, payload),
      ]);
    } catch {
      return json({ error: 'storage error' }, 500);
    }
    // Best-effort trim of the rolling window; never fails an accepted ingest.
    // The newest TEASER_KEEP_ROWS dated rows survive regardless of age: after
    // a multi-week ingestion gap every pre-gap row is past the cutoff, and
    // sweeping them all would leave the teaser with nothing >=24h old. A
    // 19-day-old teaser is honest (its freshness block travels with it);
    // an undelayed one gives the paid feed away.
    try {
      const cutoff = Math.floor((Date.now() - DIGEST_RETENTION_DAYS * 86_400_000) / 1000);
      await env.DB.prepare(
        "DELETE FROM alpha_digests WHERE id <> 'latest' AND generated_ts < ? " +
        "AND id NOT IN (SELECT id FROM alpha_digests WHERE id <> 'latest' " +
        'ORDER BY generated_ts DESC LIMIT ?)',
      ).bind(cutoff, TEASER_KEEP_ROWS).run();
    } catch {
      /* retention is housekeeping, not correctness */
    }
    const counts = {};
    for (const key of DIGEST_ARRAYS) counts[key] = digest[key].length;
    return json({
      ok: true,
      day,
      generated_ts: digest.generated_ts,
      status: digest.freshness.status,
      counts,
    });
  }

  // --- teaser: free, delayed, redacted. Public. ---
  if (request.method === 'GET' && path === '/alpha/teaser') {
    const cutoff = Math.floor((Date.now() - TEASER_DELAY_MS) / 1000);
    let row;
    try {
      row = await env.DB.prepare(
        "SELECT payload FROM alpha_digests WHERE id <> 'latest' AND generated_ts <= ? " +
        'ORDER BY generated_ts DESC LIMIT 1',
      ).bind(cutoff).first();
    } catch {
      return json({ error: 'storage error' }, 500);
    }
    // NEVER fall back to `latest`. The 24h delay IS the paywall for
    // listing_radar / catalysts / unlock_watch (redactRow strips nothing from
    // them), and a teaser smart_money row still names the symbol. Serving the
    // current digest here would hand the most time-sensitive part of the paid
    // product to an unauthenticated GET. Nothing old enough => honest empty.
    const digest = parseDigestRow(row);
    const meta = await feedMeta(env);
    const teaser = digest ? toTeaser(digest, true) : emptyTeaser();
    return json({ ...teaser, feed_status: meta.status, sales_open: meta.salesOpen });
  }

  // --- auth: prove Genesis once, get an alpha bearer token ---
  if (request.method === 'POST' && path === '/alpha/auth') {
    // No signing key, no tokens. Degrading to teaser-only is honest; issuing
    // one signed with a public constant is a giveaway of the paid feed.
    if (!env.CHAT_SECRET) return json({ error: 'alpha auth is not configured' }, 503);
    const parsed = await readJson(request, MAX_BODY_BYTES);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const res = await verifyFn(parsed.body);
    if (res.error) return json({ error: res.error }, res.status || 403);
    const wallet = parsed.body?.wallet;
    let ent;
    try {
      ent = await entitlement(env, wallet, res.number);
    } catch {
      return json({ error: 'storage error' }, 500);
    }
    const exp = Date.now() + TOKEN_TTL_MS;
    // Founding entitlement never lapses, so it gets the full token TTL;
    // a paid sub is capped at its own paid_until.
    const alphaExp = ent.active ? (ent.founding ? exp : Math.min(exp, ent.paidUntilMs)) : 0;
    const payload = {
      number: res.number,
      wallet,
      tier: res.tier,
      alpha: ent.active,
      alphaExp,
      exp,
    };
    const meta = await feedMeta(env);
    return json({
      token: await issueToken(alphaSecret(env), payload),
      ...payload,
      founding: ent.founding,
      paid_until: ent.paid_until,
      price_usdc: priceUsdc(env),
      treasury: treasuryOf(env),
      feed_status: meta.status,
      sales_open: meta.salesOpen,
    });
  }

  // --- feed: the full live digest, entitled holders only ---
  if (request.method === 'GET' && path === '/alpha/feed') {
    // Unset signing key: no bearer can be trusted, so none is accepted.
    if (!env.CHAT_SECRET) return json({ error: 'not authenticated' }, 401);
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const claims = await verifyToken(alphaSecret(env), token);
    if (!claims) return json({ error: 'not authenticated' }, 401);
    if (claims.alpha !== true || !(Number(claims.alphaExp) > Date.now())) {
      return json({ error: 'alpha subscription required' }, 402);
    }
    let digest;
    try {
      digest = parseDigestRow(
        await env.DB.prepare("SELECT payload FROM alpha_digests WHERE id = 'latest'").first(),
      );
    } catch {
      return json({ error: 'storage error' }, 500);
    }
    if (!digest) return json({ error: 'no digest available yet' }, 503);
    // Served as-is, including its honest freshness block — an entitled member
    // still sees "bot offline" when the bot is off.
    return json(digest);
  }

  // --- subscribe: redeem an on-chain USDC payment for 30 days ---
  if (request.method === 'POST' && path === '/alpha/subscribe') {
    const parsed = await readJson(request, MAX_BODY_BYTES);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const body = parsed.body ?? {};
    const txSignature = typeof body.txSignature === 'string' ? body.txSignature.trim() : '';
    if (!isSignature(txSignature)) return json({ error: 'txSignature required' }, 400);

    const treasury = treasuryOf(env);
    if (!treasury) {
      return json({
        error: 'subscriptions are not configured yet — no payment was consumed',
      }, 503);
    }
    // Sales gate FIRST, before we touch the signature: we do not sell a stale
    // feed, and a payment refused here is NOT consumed, so the same signature
    // can be redeemed once the exporter is publishing live again.
    let meta;
    try {
      meta = await feedMeta(env);
    } catch {
      return json({ error: 'storage error' }, 500);
    }
    if (meta.status !== 'live') {
      return json({
        error: `the feed is ${meta.status}, so new subscriptions are paused. ` +
          'Your transaction was NOT consumed — redeem it once the feed is live again.',
        feed_status: meta.status,
        sales_open: false,
      }, 409);
    }

    const res = await verifyFn(body);
    if (res.error) return json({ error: res.error }, res.status || 403);
    const wallet = body.wallet;

    // 1. Replay guard (before the RPC round-trip).
    let used;
    try {
      used = await env.DB.prepare('SELECT wallet FROM alpha_tx_used WHERE signature = ?')
        .bind(txSignature).first();
    } catch {
      return json({ error: 'storage error' }, 500);
    }
    if (used) return json({ error: 'transaction already used' }, 409);

    // 2-3. On-chain: a confirmed, successful USDC transfer of >= price from
    // this wallet to the treasury.
    const check = await verifyUsdcPayment(env, txSignature, wallet, treasury, priceUsdc(env));
    if (check.error) return json({ error: check.error }, check.status);

    // 4. Atomically claim the signature, then extend the sub. If the extend
    // fails we release the claim so the payment is not lost.
    let paidUntil = null;
    try {
      const claim = await env.DB.prepare(
        'INSERT OR IGNORE INTO alpha_tx_used (signature, wallet, used_at) VALUES (?, ?, ?)',
      ).bind(txSignature, wallet, new Date().toISOString()).run();
      if (!claim.meta?.changes) return json({ error: 'transaction already used' }, 409);
      paidUntil = await extendSub(env, wallet, txSignature);
    } catch {
      paidUntil = null;
    }
    if (!paidUntil) {
      try {
        await env.DB.prepare('DELETE FROM alpha_tx_used WHERE signature = ?')
          .bind(txSignature).run();
      } catch {
        /* the claim row is the only thing blocking a retry; best-effort */
      }
      return json({
        error: 'storage error — subscription not written and your transaction was not consumed, please retry',
      }, 500);
    }
    const founding = Number.isInteger(res.number) && res.number > 0 && res.number <= FOUNDING_MAX;
    return json({
      ok: true,
      wallet,
      founding,
      paid_until: paidUntil,
      active: true,
      amount_usdc: check.amount,
      tx: txSignature,
    });
  }

  // --- status: public entitlement lookup for a wallet ---
  if (request.method === 'GET' && path === '/alpha/status') {
    const wallet = (url.searchParams.get('wallet') || '').trim();
    if (!wallet) return json({ error: 'wallet required' }, 400);
    if (!isPubkey(wallet)) return json({ error: 'bad wallet' }, 400);
    let number = null;
    let ent;
    let meta;
    try {
      // Best-effort founding lookup: claims.wallet is the ORIGINAL claimant,
      // so a resold Seeker reports founding=false here. /alpha/auth is
      // authoritative (it resolves the number by Genesis mint).
      const row = await env.DB.prepare(
        'SELECT id FROM claims WHERE wallet = ? ORDER BY id ASC LIMIT 1',
      ).bind(wallet).first();
      number = Number.isInteger(row?.id) ? row.id : null;
      ent = await entitlement(env, wallet, number);
      meta = await feedMeta(env);
    } catch {
      return json({ error: 'storage error' }, 500);
    }
    return json({
      founding: ent.founding,
      paid_until: ent.paid_until,
      active: ent.active,
      number,
      price_usdc: priceUsdc(env),
      treasury: treasuryOf(env),
      feed_status: meta.status,
      feed_generated_ts: meta.generated_ts,
      sales_open: meta.salesOpen,
    });
  }

  return json({ error: 'not found' }, 404);
}
