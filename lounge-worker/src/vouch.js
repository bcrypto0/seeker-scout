/**
 * Scout Vouch: one Genesis Token, one voice per app (docs/HACKATHON.md).
 *
 * Endpoints (routed from index.js):
 *   POST /vouch  {wallet, mint, ts, signature, package, verdict, tags?, note?}
 *                -> {ok, replayed, number, tier, vouch, weight, staked_skr,
 *                    weight_source, mints_in_wallet, app}
 *   GET  /flags                     -> {vouch, vote, stake, skr_read, withdraw}
 *   GET  /vouch/app/<package>       -> {app, recent}
 *   GET  /vouch/mine?mint=<base58>  -> {vouches: [{package, verdict, note_hidden, excluded}]}
 *   GET  /vouch/aggregate           -> {generated_at, count, apps}
 *   GET  /vouch/top                 -> {week, start, end, apps} (current week, top 10)
 *
 * No GET body and no `app` block carries a weight, a weighted sum or a stake:
 * those go only to the signer, in its own POST /vouch answer (vouchResponse).
 * Every GET is a D1-only read. On the write path everything D1 can answer
 * (kill switch, body shape, same-signature replay, per-mint package cap) runs
 * BEFORE verifyFn, the first place a chain call happens (index.js
 * verifyGenesisSig, behind the RPC budget). The only other one is the stake
 * read (step 7, skr.js): it runs after verifyFn took its budget unit and after
 * the per-wallet slot, reads the signer's own wallet only, and is served from
 * D1 when that wallet was read in the last 60 s. The monotonic 409 and the 429 stay
 * after it (spec 2.3): answered unsigned, they would tell anyone when a given
 * mint last vouched. Pure rules live in vouch-lib.js so node --test can import
 * them without Workers globals.
 */
import { base58 } from '@scure/base';
import { readStakeWeight } from './skr.js';
import {
  finishAggregate, hasHiddenLink, isCanonicalTs, isPackageId, isoWeek, maskToTags, sanitizeNote, settingOn,
  sharedStakeWeight, supersedes, tagsToMask, VERDICTS, weekBounds, MAX_NOTE, NOTE_PLACEHOLDER,
} from './vouch-lib.js';
// D11 commit adds: WEEK_RE, tallyResult

const RATE_MS = 10_000;          // one accepted write per wallet per 10 s (chat uses 4 s)
const MAX_BODY_BYTES = 8 * 1024; // alpha.js:57
const RECENT_NOTES = 10;         // newest visible notes on GET /vouch/app/<package>
const TOP_LIMIT = 10;            // rows on GET /vouch/top
const MEMO_MS = 60_000;          // per-isolate memo for the list reads (the edge ignores Cache-Control here)
const MAX_PACKAGES_PER_MINT = 50; // distinct package ids one Genesis mint can vouch for (ids are free text)
const AGGREGATE_LIMIT = 2000;     // rows on GET /vouch/aggregate (twice the catalog floor of 1000 apps)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', ...CORS, ...extra },
  });
const cached = (obj, seconds) => json(obj, 200, { 'cache-control': `public, max-age=${seconds}` });

/** Same rule as index.js:46 (1-100, 101-500, 501+), duplicated so this file owns its helpers. */
const tierOf = (n) => (n <= 100 ? 'founding' : n <= 500 ? 'early' : 'member');

/** Copy of alpha.js readJson (152-170): size-capped, never throws. */
async function readJson(request, maxBytes) {
  const declared = parseInt(request.headers.get('content-length') || '0', 10);
  if (Number.isFinite(declared) && declared > maxBytes) return { error: 'body too large', status: 413 };
  let raw;
  try { raw = await request.text(); } catch { return { error: 'bad body', status: 400 }; }
  if (raw.length > maxBytes) return { error: 'body too large', status: 413 };
  try { return { body: JSON.parse(raw) }; } catch { return { error: 'bad json', status: 400 }; }
}

/** Kill switch, read exactly as GET /flags reads it (settingOn). Missing row = enabled; a D1 failure surfaces as the caller's storage error. */
async function flagEnabled(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return settingOn(row?.value, true);
}

/** base58 32-byte pubkey, copy of alpha.js:124-131 (the mint is decoded but not length-checked at index.js:114). */
function isPubkey(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try { return base58.decode(s).length === 32; } catch { return false; }
}

/** Shape check BEFORE the signature: the message builder needs clean values. */
function parseVouchBody(body) {
  const b = body ?? {};
  if (!isPubkey(b.wallet) || !isPubkey(b.mint)) return { error: 'bad wallet or mint', status: 400 };
  if (typeof b.signature !== 'string' || b.signature.length < 80 || b.signature.length > 90) return { error: 'bad signature length', status: 400 };
  if (!isCanonicalTs(b.ts)) return { error: 'bad ts', status: 400 };
  if (!isPackageId(b.package)) return { error: 'bad package id', status: 400 };
  if (!VERDICTS.includes(b.verdict)) return { error: 'verdict must be works or broken', status: 400 };
  if (b.tags !== undefined && !Array.isArray(b.tags)) return { error: 'tags must be an array', status: 400 };
  const note = b.note === undefined ? '' : b.note;
  if (typeof note !== 'string' || note.length > MAX_NOTE || /[\r\n]/.test(note)) {
    return { error: 'note must be one line of at most 140 characters', status: 400 };
  }
  if (note === NOTE_PLACEHOLDER) return { error: 'note reserved', status: 400 };
  if (note !== sanitizeNote(note)) {
    return { error: 'note contains a link or is not normalised', status: 400 };
  }
  // A link the ASCII passes cannot see (U+3002 for the dot, a zero-width space
  // or a combining mark inside the domain, fullwidth letters) gets the same
  // 400: the client contract has one sentence for both.
  if (hasHiddenLink(note)) {
    return { error: 'note contains a link or is not normalised', status: 400 };
  }
  return { pkg: b.package, verdict: b.verdict, tags: maskToTags(tagsToMask(b.tags)), note };
}

/** Rate limit only (the block check is separate, see the chain). Slot = `column` on vouch_members. */
async function takeSlot(env, wallet, column) {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - RATE_MS).toISOString();
  await env.DB.prepare('INSERT OR IGNORE INTO vouch_members (wallet) VALUES (?)').bind(wallet).run();
  const slot = await env.DB.prepare(
    `UPDATE vouch_members SET ${column} = ? WHERE wallet = ? AND (${column} IS NULL OR ${column} < ?)`,
  ).bind(now, wallet, cutoff).run();                 // column is one of two literals, never user input
  return Boolean(slot.meta?.changes);
}

// ---------------------------------------------------------------------------
// Aggregates (single source of truth for the chip). WHERE excluded = 0 only:
// a reported note (note_hidden) still counts as a voice. COUNT(*) equals the
// distinct mints because of UNIQUE (genesis_mint, package). weight_works feeds
// the chip rule and the ORDER BY only; finishAggregate keeps it (and every
// other weighted number) off the public body.
// ---------------------------------------------------------------------------
const AGG_COLUMNS = `package,
       COUNT(*)                                                 AS voices,
       SUM(verdict = 'works')                                   AS works_voices,
       SUM(CASE WHEN verdict = 'works'  THEN weight ELSE 0 END) AS weight_works,
       SUM((tags & 1) > 0)                                      AS wallet_ok_voices,
       MAX(updated_at)                                          AS last_vouch_at`;

/**
 * Per-isolate memo for the list reads: Cache-Control on a workers.dev response
 * is honoured by the phone, not by the edge, so without it every hit runs the
 * GROUP BY. One query per isolate per route per minute; an accepted write in
 * this isolate clears it.
 */
const memo = new Map(); // key -> { at, body }
async function memoised(key, compute) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.body;
  const body = await compute();
  memo.set(key, { at: Date.now(), body });
  return body;
}

/** One package, or its zero row when nobody has vouched yet. */
async function aggregateOne(env, pkg) {
  const row = await env.DB.prepare(
    `SELECT ${AGG_COLUMNS} FROM vouches WHERE excluded = 0 AND package = ? GROUP BY package`,
  ).bind(pkg).first();
  return finishAggregate(row ?? { package: pkg });
}

async function aggregateAll(env) {
  const rows = await env.DB.prepare(
    `SELECT ${AGG_COLUMNS} FROM vouches WHERE excluded = 0
     GROUP BY package ORDER BY weight_works DESC, voices DESC, package ASC LIMIT ?`,
  ).bind(AGGREGATE_LIMIT).all();
  const apps = (rows.results ?? []).map(finishAggregate);
  return { generated_at: new Date().toISOString(), count: apps.length, apps };
}

/**
 * Current UTC week only. Windows use updated_at (server time), not signed_ts
 * (client clock). HAVING keeps quiet packages off the card instead of listing
 * ten all-time rows that read "0 owners this week". Ties on voices_week break
 * on works_share_week first: each mint's works weight split across the
 * packages it vouched this week (sharedStakeWeight's rule, per week), so one
 * Genesis Token spraying ids that sort first (aa.a, aa.b, ...) cannot push
 * apps other owners vouched off the top ten. When every mint vouched one
 * package this week it equals weight_works_week, the spec's tie-break. Both
 * weighted numbers order the rows and stay in SQL: the body carries
 * finishAggregate's head counts plus voices_week (see finishAggregate).
 */
async function topThisWeek(env) {
  const now = new Date();
  const { start, end } = weekBounds(now);
  const rows = await env.DB.prepare(
    `WITH wk AS (
       SELECT genesis_mint, COUNT(*) AS n FROM vouches
       WHERE excluded = 0 AND updated_at >= ?1 AND updated_at < ?2
       GROUP BY genesis_mint
     )
     SELECT ${AGG_COLUMNS},
       SUM(CASE WHEN updated_at >= ?1 AND updated_at < ?2 THEN 1 ELSE 0 END)                           AS voices_week,
       SUM(CASE WHEN updated_at >= ?1 AND updated_at < ?2 AND verdict = 'works' THEN weight ELSE 0 END) AS weight_works_week,
       ROUND(SUM(CASE WHEN updated_at >= ?1 AND updated_at < ?2 AND verdict = 'works'
                      THEN weight / wk.n ELSE 0 END), 6)                                               AS works_share_week
     FROM vouches LEFT JOIN wk USING (genesis_mint)
     WHERE excluded = 0
     GROUP BY package
     HAVING voices_week > 0
     ORDER BY voices_week DESC, works_share_week DESC, weight_works_week DESC, weight_works DESC, package ASC
     LIMIT ?3`,
  ).bind(start, end, TOP_LIMIT).all();
  const apps = (rows.results ?? []).map((r) => ({
    ...finishAggregate(r),
    voices_week: Number(r.voices_week) || 0,
  }));
  return { week: isoWeek(now), start, end, apps };
}

/**
 * Newest visible notes. No wallet, no mint, no staked_skr and no weight: this
 * payload is public, and since the SKR reader (D6) stamps real weights, a
 * weight next to a Lounge number would tell every reader roughly what that
 * owner stakes (weightFor is invertible to about 2 %). The app's note parser
 * (parseAppVouches) reads no weight at all. The `app` block beside the notes
 * carries no weighted sum either (finishAggregate, owner decision 2026-09-30).
 * What is left is the order of /vouch/aggregate and /vouch/top, which weight
 * sets server side: it ranks apps, it prints no number.
 */
async function recentNotes(env, pkg) {
  const rows = await env.DB.prepare(
    `SELECT v.id, v.verdict, v.tags, v.note, v.updated_at, c.id AS number
     FROM vouches v LEFT JOIN claims c ON c.genesis_mint = v.genesis_mint
     WHERE v.package = ? AND v.excluded = 0 AND v.note_hidden = 0 AND v.note <> ''
     ORDER BY v.updated_at DESC, v.id DESC
     LIMIT ?`,
  ).bind(pkg, RECENT_NOTES).all();
  return (rows.results ?? []).map((r) => {
    const number = Number.isInteger(r.number) ? r.number : null;
    return {
      id: r.id,
      verdict: r.verdict,
      tags: maskToTags(r.tags),
      note: r.note,
      number,
      tier: number === null ? null : tierOf(number),
      updated_at: r.updated_at,
    };
  });
}

/**
 * The POST /vouch body. `who` and `stake` are null on a replay: number/tier
 * then come from the same best-effort claims lookup verifyVouchOwner uses,
 * and weight/staked_skr from the stored row (weight_source 'stored'). This is
 * the only place a weight or staked_skr leaves the worker: the signer's own,
 * to the wallet that signed. Its `app` block is the public shape
 * (finishAggregate), with no weighted sum.
 */
async function vouchResponse(env, id, pkg, who, stake, replayed) {
  const row = await env.DB.prepare(
    `SELECT id, genesis_mint, wallet, package, verdict, tags, note, weight, staked_skr,
            signed_ts, updated_at, note_hidden, excluded
     FROM vouches WHERE id = ?`,
  ).bind(id).first();
  const c = await env.DB.prepare('SELECT COUNT(DISTINCT genesis_mint) AS n FROM vouches WHERE wallet = ?')
    .bind(row.wallet).first();
  let number = Number.isInteger(who?.number) ? who.number : null;
  if (replayed) {
    try {
      const claim = await env.DB.prepare('SELECT id FROM claims WHERE genesis_mint = ?')
        .bind(row.genesis_mint).first();
      if (Number.isInteger(claim?.id)) number = claim.id;
    } catch {
      // Label lookup only; an unlabelled voice is the safe side.
    }
  }
  return {
    ok: true,
    replayed,
    number,
    tier: number === null ? null : tierOf(number),
    vouch: {
      id: row.id,
      package: row.package,
      verdict: row.verdict,
      tags: maskToTags(row.tags),
      note: row.note,
      weight: row.weight,
      staked_skr: row.staked_skr,
      signed_ts: row.signed_ts,
      updated_at: row.updated_at,
      note_hidden: Boolean(row.note_hidden),
      excluded: Boolean(row.excluded),
    },
    weight: row.weight,
    staked_skr: replayed ? row.staked_skr : stake.stakedSkr,
    weight_source: replayed ? 'stored' : stake.source,
    mints_in_wallet: Number(c?.n) || 1,
    app: await aggregateOne(env, pkg),
  };
}

async function handleVouchPost(request, env, verifyFn) {
  const started = Date.now();
  // 0. Kill switch, before any work.
  try {
    if (!(await flagEnabled(env, 'vouch_enabled'))) return json({ error: 'vouching is paused' }, 503);
  } catch { return json({ error: 'storage error' }, 500); }

  // 1. Body: size cap + shape (wallet, mint, signature, canonical ts, package, verdict, tags, note).
  const parsed = await readJson(request, MAX_BODY_BYTES);
  if (parsed.error) return json({ error: parsed.error }, parsed.status);
  const shape = parseVouchBody(parsed.body);
  if (shape.error) return json({ error: shape.error }, shape.status);
  const { wallet, mint, ts, signature } = parsed.body;
  const body = { wallet, mint, ts, signature, package: shape.pkg, verdict: shape.verdict, tags: shape.tags, note: shape.note };

  // 2. Same-signature replay answers from D1 before ANY chain call and before the
  //    slot (claim step 0, index.js:205-215). A lost response + client retry lands here.
  let existing;
  try {
    existing = await env.DB.prepare(
      'SELECT id, wallet, signature, signed_ts FROM vouches WHERE genesis_mint = ? AND package = ?',
    ).bind(mint, shape.pkg).first();
  } catch { return json({ error: 'storage error' }, 500); }
  if (existing && existing.signature === signature) {
    try {
      return json(await vouchResponse(env, existing.id, shape.pkg, null, null, true));
    } catch { return json({ error: 'storage error' }, 500); }
  }

  // 2b. A package new to this mint: cap distinct packages per Genesis mint. Package ids
  //     are free text, so without a cap one token stores ids without end. D1 only, so
  //     before any chain call; excluded rows count, so an excluded spammer stays capped.
  if (!existing) {
    try {
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM vouches WHERE genesis_mint = ?').bind(mint).first();
      if ((Number(c?.n) || 0) >= MAX_PACKAGES_PER_MINT) return json({ error: 'vouch limit reached' }, 403);
    } catch { return json({ error: 'storage error' }, 500); }
  }

  // 3. Freshness, ed25519 over vouchMessage(), RPC budget, SGT fingerprint + holder on chain
  //    (index.js verifyGenesisSig via verifyVouchOwner). 401 is load-bearing for the client.
  const who = await verifyFn(body, 'vouch');
  if (who.error) return json({ error: who.error }, who.status || 403);

  // 4. Block check, after the signature so block status cannot be probed by wallet.
  try {
    const m = await env.DB.prepare('SELECT blocked FROM vouch_members WHERE wallet = ?').bind(wallet).first();
    if (m?.blocked) return json({ error: 'account blocked' }, 403);
  } catch { return json({ error: 'storage error' }, 500); }

  // 5. Monotonic: a captured earlier "works" can never overwrite a later "broken".
  //    Before the slot, so a 409 costs the wallet nothing.
  if (existing && !supersedes(ts, existing.signed_ts)) {
    return json({ error: 'superseded by a newer vouch from this Seeker' }, 409);
  }

  // 6. Rate limit: the slot is taken only for a write we are about to attempt.
  try {
    if (!(await takeSlot(env, wallet, 'last_vouch_at'))) return json({ error: 'slow down' }, 429);
  } catch { return json({ error: 'storage error' }, 500); }

  // 7. Stake from the SKR staking program: one getMultipleAccounts (the third paid
  //    call of this request), or none when skr_cache holds a read of this wallet
  //    younger than 60 s. Never throws; a failed read is stakedSkr null (1.00x).
  const stake = await readStakeWeight(env, wallet);

  // 8. One stake backs one voice: count the distinct mints this wallet has vouched
  //    with, including this one if it is new to the wallet (`had` = it is not).
  let n = 1;
  let had = false;
  try {
    const c = await env.DB.prepare(
      'SELECT COUNT(DISTINCT genesis_mint) AS n, MAX(genesis_mint = ?) AS had FROM vouches WHERE wallet = ?',
    ).bind(mint, wallet).first();
    had = Number(c?.had) === 1;
    n = (Number(c?.n) || 0) + (had ? 0 : 1);
  } catch { return json({ error: 'storage error' }, 500); }
  const weight = sharedStakeWeight(stake.stakedSkr, n);

  // 9. Guarded upsert. The WHERE repeats the monotonic rule so two concurrent
  //    writes cannot both win; meta.changes === 0 means we lost. Then, on a clean
  //    read ('chain' or 'cache'), re-stamp every row of this wallet whose weight or
  //    stake differs, so all its voices carry the same divided weight and the same
  //    stake (the D16 cron's VOUCH_RESTAMP predicate, SPEC-skr-final 1.10). A failed
  //    read ('error') stamps only this row, at 1.00x, and keeps the wallet's last
  //    good stamp on the others: an RPC hiccup never demotes them. When this mint is
  //    new to the wallet, their division by the old n no longer holds, so their
  //    weight is re-divided from that last good stake by the new n (lower only).
  const now = new Date().toISOString();
  try {
    const res = await env.DB.prepare(
      `INSERT INTO vouches (genesis_mint, wallet, package, verdict, tags, note, signature, signed_ts,
                            weight, staked_skr, weight_checked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (genesis_mint, package) DO UPDATE SET
         wallet = excluded.wallet, verdict = excluded.verdict, tags = excluded.tags,
         note = excluded.note, signature = excluded.signature, signed_ts = excluded.signed_ts,
         weight = excluded.weight, staked_skr = excluded.staked_skr,
         weight_checked_at = excluded.weight_checked_at, updated_at = excluded.updated_at
       WHERE excluded.signed_ts > vouches.signed_ts`,
    ).bind(
      mint, wallet, shape.pkg, shape.verdict, tagsToMask(shape.tags), shape.note, signature, ts,
      weight, stake.stakedSkr, stake.checkedAt, now, now,
    ).run();
    if (!res.meta?.changes) return json({ error: 'superseded by a newer vouch from this Seeker' }, 409);
    if (stake.source !== 'error') {
      await env.DB.prepare(
        `UPDATE vouches SET weight = ?, staked_skr = ?, weight_checked_at = ?
         WHERE wallet = ? AND (weight <> ? OR staked_skr IS NOT ?)`,
      ).bind(weight, stake.stakedSkr, stake.checkedAt, wallet, weight, stake.stakedSkr).run();
    } else if (!had) {
      const last = await env.DB.prepare(
        `SELECT staked_skr FROM vouches WHERE wallet = ? AND staked_skr IS NOT NULL
         ORDER BY weight_checked_at DESC LIMIT 1`,
      ).bind(wallet).first();
      if (last) {
        const lower = sharedStakeWeight(last.staked_skr, n);
        await env.DB.prepare('UPDATE vouches SET weight = ? WHERE wallet = ? AND weight > ?')
          .bind(lower, wallet, lower).run();
      }
    }
    memo.clear(); // this isolate serves the new numbers at once; others within MEMO_MS
  } catch { return json({ error: 'storage error' }, 500); }

  // 10. The one structured line (decision 4). Mint fingerprinted, never the RPC URL.
  console.log(JSON.stringify({
    evt: 'vouch', ok: true, sig: 'ok', sgt: 'ok',
    mint: `${mint.slice(0, 4)}..${mint.slice(-4)}`, package: shape.pkg, verdict: shape.verdict,
    // No weight or staked_skr here: they sit next to the package and a mint fingerprint, and would
    // put an owner's stake into the logs. weight_source is enough to watch the reader.
    mints_in_wallet: n, weight_source: stake.source, ms: Date.now() - started,
  }));

  try {
    const row = await env.DB.prepare('SELECT id FROM vouches WHERE genesis_mint = ? AND package = ?')
      .bind(mint, shape.pkg).first();
    return json(await vouchResponse(env, row.id, shape.pkg, who, stake, false));
  } catch { return json({ error: 'storage error' }, 500); }
}

/**
 * The one client-facing switchboard, read exactly as the worker's own gate
 * reads it (settingOn): only '1' is on. A missing row reads as enabled,
 * except withdraw (off).
 */
async function handleFlags(env) {
  let rows;
  try {
    rows = await env.DB.prepare('SELECT key, value FROM settings').all();
  } catch { return json({ error: 'storage error' }, 500); }
  const v = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
  return cached({
    vouch: settingOn(v.vouch_enabled, true),
    vote: settingOn(v.vote_enabled, true),
    stake: settingOn(v.stake_enabled, true),
    skr_read: settingOn(v.skr_read_enabled, true),
    withdraw: settingOn(v.withdraw_enabled, false),
  }, 60);
}

async function handleApp(env, path) {
  let pkg;
  try {
    pkg = decodeURIComponent(path.slice('/vouch/app/'.length));
  } catch { return json({ error: 'bad package id' }, 400); }
  if (!isPackageId(pkg)) return json({ error: 'bad package id' }, 400);
  try {
    const app = await aggregateOne(env, pkg);
    const recent = await recentNotes(env, pkg);
    return cached({ app, recent }, 60);
  } catch { return json({ error: 'storage error' }, 500); }
}

/**
 * The owner's own state by mint: verdict per package and the two moderation
 * flags, nothing else. No id and no updated_at: both also sit on the public
 * recent notes (GET /vouch/app), so either one would pin a note shown as an
 * anonymous Seeker owner to this mint and so to its holder wallet.
 */
async function handleMine(env, url) {
  const mint = url.searchParams.get('mint');
  if (!mint) return json({ error: 'mint required' }, 400);
  if (!isPubkey(mint)) return json({ error: 'bad mint' }, 400);
  let rows;
  try {
    rows = await env.DB.prepare(
      'SELECT package, verdict, note_hidden, excluded FROM vouches WHERE genesis_mint = ? ORDER BY package',
    ).bind(mint).all();
  } catch { return json({ error: 'storage error' }, 500); }
  const vouches = (rows.results ?? []).map((r) => ({
    package: r.package,
    verdict: r.verdict,
    note_hidden: Boolean(r.note_hidden),
    excluded: Boolean(r.excluded),
  }));
  return json({ vouches }, 200, { 'cache-control': 'no-store' });
}

/**
 * @param verifyFn async (body, kind) => {number,tier} | {error,status}
 *   index.js's verifyVouchOwner: fresh signature over vouchMessage(body) +
 *   genuine Genesis Token held by the wallet, behind the RPC budget.
 *   number/tier label the voice and are null for an owner who never claimed.
 */
export async function handleVouch(request, env, url, verifyFn) {
  try {
    return await route(request, env, url, verifyFn);
  } catch {
    return json({ error: 'vouch service error' }, 500); // alpha.js:577-584 posture
  }
}

async function route(request, env, url, verifyFn) {
  const path = url.pathname;
  const method = request.method;
  if (method === 'POST' && path === '/vouch') return handleVouchPost(request, env, verifyFn);
  if (method === 'GET' && path === '/flags') return handleFlags(env);
  if (method === 'GET' && path.startsWith('/vouch/app/')) return handleApp(env, path);
  if (method === 'GET' && path === '/vouch/mine') return handleMine(env, url);
  if (method === 'GET' && path === '/vouch/aggregate') {
    try {
      return cached(await memoised('aggregate', () => aggregateAll(env)), 300);
    } catch { return json({ error: 'storage error' }, 500); }
  }
  if (method === 'GET' && path === '/vouch/top') {
    try {
      return cached(await memoised('top', () => topThisWeek(env)), 120);
    } catch { return json({ error: 'storage error' }, 500); }
  }
  // /vote/* (D11-D12) and /vouch/report (D16-D17) are mounted here later.
  return json({ error: 'not found' }, 404);
}
