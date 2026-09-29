/**
 * Seeker Scout — Owners' Lounge founding-number claims.
 *
 * POST /claim  {wallet, mint, ts, signature}  → {number, tier}
 *   Verifies (1) canonical message freshness, (2) ed25519 signature by the
 *   wallet, (3) on-chain: the mint is a genuine Seeker Genesis Token (SGT
 *   fingerprint) AND the wallet holds it, then assigns the next number.
 *   One claim per Genesis Token mint, forever (replays return the existing
 *   number). The claims table's AUTOINCREMENT id IS the founding number.
 * GET /status?mint=<base58>                   → {claimed, number?, tier?}
 * GET /stats                                  → {total, founding: min(total,100)}
 *
 * SGT fingerprint constants mirror src/lib/wallet.ts in the app.
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { base58 } from '@scure/base';
import { handleChat } from './chat.js';
import { handleGame } from './game.js';
import { handleAlpha } from './alpha.js';
import { rpc } from './rpc.js';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const SGT_MINT_AUTHORITY = 'GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4';
const SGT_METADATA_ADDRESS = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
const SGT_GROUP_MINT_ADDRESS = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000; // past-dated tolerance
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000; // future-dated tolerance
// Alpha buys a paid entitlement, so a captured body is worth more there than
// on /claim: keep the replay window to a signature's realistic round-trip.
const ALPHA_MESSAGE_AGE_MS = 2 * 60 * 1000;
// Vouch reuses MAX_MESSAGE_AGE_MS (10 min, same retry window as /claim), not the alpha window.
// Cap on chain checks: every verified signature costs two RPC calls
// (verifyGenesisSig step 3) and rpc.js retries 429/5xx three times, so a keypair
// farm could otherwise burn the paid endpoint without ever touching D1.
// Two pools per UTC minute. A (wallet, mint) pair already in claims or vouches
// is a member and spends the members' pool, at most RPC_BUDGET_PER_MINT of it
// per Genesis mint, so a keypair farm cannot lock existing members out. Every
// other pair (first-time owners, and alpha subscribers who never claimed or
// vouched) shares the open pool, at most RPC_BUDGET_PER_IP of it per client
// address (an IPv6 /64 counts as one). One address cannot drain the open pool
// alone; many can (six at that cap, or the /64s of one IPv6 /56), and while
// they do, first-time owners get 503 'busy'. The backstop is the Cloudflare
// per-IP rule (spec 9, dashboard); it only raises the number of addresses a
// drain needs if it is set below RPC_BUDGET_PER_IP a minute. 120 a minute per
// pool is far above any honest peak; above it the caller gets 503 'busy'.
const RPC_BUDGET_PER_MIN = 120;
const RPC_BUDGET_PER_MINT = 10;
const RPC_BUDGET_PER_IP = 20;
// When D1 cannot count (overload, write quota, table not migrated yet) each
// isolate counts for itself, every pool capped at ISOLATE_BUDGET_PER_MIN:
// bounded, instead of letting every request through.
const ISOLATE_BUDGET_PER_MIN = 30;
const isolateBudget = { minute: '', n: new Map() }; // key suffix -> units this minute

// Days-since-install buckets the app may send with /ping (src/lib/lounge.ts
// ageBucket). Anything else is ignored, so the table can't be filled with junk.
const AGE_BUCKETS = new Set(['0', '1', '2', '3', '4-7', '8-14', '15-30', '31+']);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, x-alpha-key',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });

/** Tier from a founding number (battle plan: 1-100, 101-500, 501+). */
const tierOf = (n) => (n <= 100 ? 'founding' : n <= 500 ? 'early' : 'member');

/** The exact string the app asks Seed Vault to sign. */
const claimMessage = (wallet, mint, ts) =>
  `Seeker Scout — Owners' Lounge claim\nwallet: ${wallet}\nmint: ${mint}\nts: ${ts}`;

/**
 * Alpha's own signed message. Domain separation: without it, the exact
 * {wallet,mint,ts,signature} tuple a device sends to /claim or /chat/auth is
 * also a valid credential for the PAID endpoints, so a captured free-tier
 * login mints a live-feed bearer. Deviates from spec §2's "reuse
 * verifyGenesisSig" — deliberately, see the build report.
 *
 * ADDITIVE ONLY: shipped devices sign claimMessage for the Lounge claim and
 * chat, so that string must stay byte-identical.
 */
const alphaMessage = (wallet, mint, ts) =>
  `Seeker Scout — Alpha access\npurpose: alpha-v1\nwallet: ${wallet}\nmint: ${mint}\nts: ${ts}`;

/** jsonParsed Token-2022 mint → SGT fingerprint check (no SDK needed). */
function isGenuineSgt(mintInfo) {
  const parsed = mintInfo?.value?.data?.parsed;
  if (!parsed || parsed.type !== 'mint') return false;
  const info = parsed.info;
  if (info?.mintAuthority !== SGT_MINT_AUTHORITY) return false;
  const extensions = info?.extensions ?? [];
  const metaPtr = extensions.find((e) => e.extension === 'metadataPointer');
  const groupMember = extensions.find(
    (e) => e.extension === 'tokenGroupMember',
  );
  const metaOk =
    metaPtr?.state?.authority === SGT_MINT_AUTHORITY &&
    metaPtr?.state?.metadataAddress === SGT_METADATA_ADDRESS;
  const groupOk = groupMember?.state?.group === SGT_GROUP_MINT_ADDRESS;
  return metaOk && groupOk;
}

/** One unit from the rpc_budget row `key`: ensure-row + conditional UPDATE (chat.js:108-119 idiom). */
async function takeBudgetUnit(env, key, cap) {
  const ins = await env.DB.prepare('INSERT OR IGNORE INTO rpc_budget (minute, n) VALUES (?, 0)').bind(key).run();
  if (ins.meta?.changes) {
    await env.DB.prepare('DELETE FROM rpc_budget WHERE minute < ?')
      .bind(new Date(Date.now() - 2 * 60_000).toISOString().slice(0, 16)).run();
  }
  const take = await env.DB.prepare('UPDATE rpc_budget SET n = n + 1 WHERE minute = ? AND n < ?')
    .bind(key, cap).run();
  return Boolean(take.meta?.changes);
}

/**
 * Budget key for a client address (cf-connecting-ip): IPv4 as is, IPv6 cut to
 * its /64, because one subscriber holds a whole /64. '' when there is none
 * (Cloudflare always sets the header; a bare local run may not).
 */
function ipKey(ip) {
  if (typeof ip !== 'string' || !ip || ip.length > 64) return '';
  if (!ip.includes(':')) return ip;
  if (ip.includes('.')) return ip.slice(ip.lastIndexOf(':') + 1); // IPv4-mapped IPv6
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * Chain-check budget (verifyGenesisSig step 2b); false means 503 'busy'.
 * A member, a (wallet, mint) pair that already passed the chain check once
 * (a claims or vouches row), takes one unit from its mint's share and one from
 * the members' pool; anyone else takes one from its address's share and one
 * from the open pool, so a self-made keypair can only ever spend the open
 * pool and one address only a sixth of it. Every rpc_budget key starts with
 * the UTC minute ('<minute>' open pool, '<minute>k' members' pool,
 * '<minute>m<mint>' and '<minute>i<address>' shares), so one range DELETE
 * expires them all. When D1 cannot count, each isolate counts for itself.
 * Never throws.
 */
async function takeRpcBudget(env, wallet, mint, ip) {
  const minute = new Date().toISOString().slice(0, 16);
  let member = false;
  try {
    member = Boolean(await env.DB.prepare(
      `SELECT 1 AS hit FROM claims WHERE genesis_mint = ?1 AND wallet = ?2
       UNION ALL SELECT 1 FROM vouches WHERE genesis_mint = ?1 AND wallet = ?2 LIMIT 1`,
    ).bind(mint, wallet).first());
  } catch {
    // Unknown pair: the open pool.
  }
  const net = ipKey(ip);
  // [key suffix, cap] pairs, taken in order: the caller's share, then its pool.
  const takes = member
    ? [[`m${mint}`, RPC_BUDGET_PER_MINT], ['k', RPC_BUDGET_PER_MIN]]
    : [...(net ? [[`i${net}`, RPC_BUDGET_PER_IP]] : []), ['', RPC_BUDGET_PER_MIN]];
  const [poolSuffix, poolCap] = takes[takes.length - 1];
  try {
    // A spent pool answers from one read, so a flood past it writes nothing.
    const pool = await env.DB.prepare('SELECT n FROM rpc_budget WHERE minute = ?')
      .bind(minute + poolSuffix).first();
    if (pool && pool.n >= poolCap) return false;
    for (const [suffix, cap] of takes) {
      if (!(await takeBudgetUnit(env, minute + suffix, cap))) return false;
    }
    return true;
  } catch {
    if (isolateBudget.minute !== minute) {
      isolateBudget.minute = minute;
      isolateBudget.n.clear();
    }
    if (takes.some(([s, cap]) => (isolateBudget.n.get(s) ?? 0) >= Math.min(cap, ISOLATE_BUDGET_PER_MIN))) {
      return false;
    }
    for (const [s] of takes) isolateBudget.n.set(s, (isolateBudget.n.get(s) ?? 0) + 1);
    return true;
  }
}

/**
 * Verify a fresh, wallet-signed message proving control of a genuine Seeker
 * Genesis Token that the wallet holds. Steps 1-3 of the claim flow, shared
 * with chat auth. Returns null on success, or an {error,status} to return.
 *
 * `message` + `maxAgeMs` default to the Lounge claim's string and window —
 * changing either default would invalidate every signature already shipped
 * devices produce. /alpha/* overrides them for domain separation.
 * `ip` is the caller's cf-connecting-ip; it only picks the budget share.
 */
async function verifyGenesisSig(
  body,
  env,
  { message = claimMessage, maxAgeMs = MAX_MESSAGE_AGE_MS, ip = '' } = {},
) {
  const { wallet, mint, ts, signature } = body ?? {};
  if (
    typeof wallet !== 'string' || typeof mint !== 'string' ||
    typeof ts !== 'string' || typeof signature !== 'string'
  ) {
    return { error: 'missing fields', status: 400 };
  }
  // 1. Freshness: 10 min past (retries) / 2 min future (skew).
  const dt = Date.now() - Date.parse(ts);
  if (!Number.isFinite(dt) || dt > maxAgeMs || dt < -MAX_CLOCK_SKEW_MS) {
    return { error: 'stale message', status: 400 };
  }
  // 2. Signature by the wallet over the canonical message.
  let walletBytes, sigBytes;
  try {
    walletBytes = base58.decode(wallet);
    sigBytes = base58.decode(signature);
    base58.decode(mint);
  } catch {
    return { error: 'bad encoding', status: 400 };
  }
  if (walletBytes.length !== 32 || sigBytes.length !== 64) {
    return { error: 'bad key or signature length', status: 400 };
  }
  const msgBytes = new TextEncoder().encode(message(wallet, mint, ts));
  let sigOk = false;
  try {
    sigOk = ed.verify(sigBytes, msgBytes, walletBytes, { zip215: false });
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { error: 'signature verification failed', status: 401 };
  // 2b. Spend one unit of the per-minute chain budget (takeRpcBudget: the
  //     members' pool or the open pool). Only a valid signature gets here.
  if (!(await takeRpcBudget(env, wallet, mint, ip))) {
    return { error: 'busy, try again in a minute', status: 503 };
  }
  // 3. On-chain: genuine SGT held by this wallet.
  try {
    const [mintInfo, holdings] = await Promise.all([
      rpc(env, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }]),
      rpc(env, 'getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed' }]),
    ]);
    if (!isGenuineSgt(mintInfo)) return { error: 'not a Seeker Genesis Token', status: 403 };
    const holds = (holdings?.value ?? []).some(
      (a) => Number(a?.account?.data?.parsed?.info?.tokenAmount?.amount ?? '0') >= 1,
    );
    if (!holds) return { error: 'wallet does not hold this token', status: 403 };
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
  return null; // verified
}

/**
 * Chat auth: verify Genesis ownership AND that the wallet already claimed a
 * founding number (chat is members-only). Returns {number,tier} or {error,status}.
 */
async function verifyMembership(body, env, ip) {
  const bad = await verifyGenesisSig(body, env, { ip });
  if (bad) return bad;
  try {
    const row = await env.DB.prepare('SELECT id FROM claims WHERE genesis_mint = ?')
      .bind(body.mint).first();
    if (!row) return { error: 'claim your founding number first', status: 403 };
    return { number: row.id, tier: tierOf(row.id) };
  } catch {
    return { error: 'storage error', status: 500 };
  }
}

/**
 * Alpha auth (spec §2): Genesis ownership is the gate. A founding number is a
 * BONUS — it decides the free founder tier — so we resolve it best-effort by
 * mint and leave it null for a Seeker owner who never entered the Lounge race.
 * Gating alpha on verifyMembership instead would 403 every owner who has not
 * claimed, blocking them from the free founder check AND from paying.
 */
async function verifyAlphaOwner(body, env, ip) {
  const bad = await verifyGenesisSig(body, env, {
    message: alphaMessage,
    maxAgeMs: ALPHA_MESSAGE_AGE_MS,
    ip,
  });
  if (bad) return bad;
  let number = null;
  try {
    const row = await env.DB.prepare('SELECT id FROM claims WHERE genesis_mint = ?')
      .bind(body.mint).first();
    if (Number.isInteger(row?.id)) number = row.id;
  } catch {
    // A claims-lookup failure must not lock a payer out: unclaimed reads as
    // non-founding, which is the safe (still payable) side.
  }
  return { number, tier: number === null ? null : tierOf(number) };
}

async function handleClaim(request, env, ip) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const { mint } = body ?? {};

  // 0. Already claimed? Answer straight from D1 — replay/DoS short-circuit,
  // and re-claims are self-healing. (Field validation happens in step 1.)
  if (typeof mint === 'string') {
    try {
      const existing = await env.DB.prepare('SELECT id FROM claims WHERE genesis_mint = ?')
        .bind(mint).first();
      if (existing) return json({ number: existing.id, tier: tierOf(existing.id) });
    } catch {
      return json({ error: 'storage error' }, 500);
    }
  }

  // 1-3. Fresh signed message + genuine Genesis Token held by the wallet.
  const bad = await verifyGenesisSig(body, env, { ip });
  if (bad) return json({ error: bad.error }, bad.status);
  const { wallet } = body;

  // 4. Assign the next number. Plain INSERT (no OR IGNORE — an ignored
  // insert on an AUTOINCREMENT table would burn a founding number); a
  // concurrent-duplicate race hits the UNIQUE constraint and we return the
  // winner's number.
  try {
    await env.DB.prepare(
      'INSERT INTO claims (genesis_mint, wallet, claimed_at) VALUES (?, ?, ?)',
    )
      .bind(mint, wallet, new Date().toISOString())
      .run();
  } catch {
    // UNIQUE collision (concurrent claim) — fall through to the SELECT.
  }
  try {
    const row = await env.DB.prepare(
      'SELECT id FROM claims WHERE genesis_mint = ?',
    )
      .bind(mint)
      .first();
    if (!row) return json({ error: 'storage error' }, 500);
    return json({ number: row.id, tier: tierOf(row.id) });
  } catch {
    return json({ error: 'storage error' }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ip = request.headers.get('cf-connecting-ip') || ''; // picks the RPC budget share only
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }
    if (request.method === 'POST' && url.pathname === '/claim') {
      return handleClaim(request, env, ip);
    }
    if (url.pathname.startsWith('/chat/')) {
      return handleChat(request, env, url, (body) => verifyMembership(body, env, ip));
    }
    if (url.pathname.startsWith('/game/')) {
      return handleGame(request, env, url);
    }
    if (url.pathname.startsWith('/alpha/')) {
      return handleAlpha(request, env, url, (body) => verifyAlphaOwner(body, env, ip));
    }
    // Anonymous app-open ping (fire-and-forget from the app on launch).
    // Cheap spam gate: only count pings carrying the app's static header
    // (x-ss = versionCode). Not bulletproof — a determined forger can send
    // it — but it stops drive-by curl loops and browser-embedded fetch()
    // from polluting the ad metric. Respond 204 either way (don't leak the
    // gate), just skip the write. D1 write quota is shared with claims/chat,
    // so uncounted spam also can't exhaust it.
    if (request.method === 'POST' && url.pathname === '/ping') {
      if (request.headers.get('x-ss')) {
        const day = new Date().toISOString().slice(0, 10);
        try {
          await env.DB.prepare(
            'INSERT INTO opens (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1',
          ).bind(day).run();
        } catch {
          /* best-effort; never fail an open */
        }
        // v0.10.1+: at most once a day per install, the phone adds how many
        // days ago the app was installed (already bucketed on the phone) and
        // whether this is its first launch ever. No id travels with it, so
        // this counts installs by age, never a person. Its own try: a missing
        // table must not cost the opens counter above.
        const age = request.headers.get('x-age');
        if (age && AGE_BUCKETS.has(age)) {
          const kind = request.headers.get('x-first') === '1' ? 'first' : 'return';
          try {
            await env.DB.prepare(
              `INSERT INTO opens_age (day, kind, bucket, count) VALUES (?, ?, ?, 1)
               ON CONFLICT(day, kind, bucket) DO UPDATE SET count = count + 1`,
            ).bind(day, kind, age).run();
          } catch {
            /* best-effort */
          }
        }
      }
      return new Response(null, { status: 204, headers: CORS });
    }
    // Metrics for the ad-sales dashboard: daily opens + 7d total + claims + msgs.
    if (request.method === 'GET' && url.pathname === '/metrics') {
      try {
        const rows = await env.DB.prepare(
          'SELECT day, count FROM opens ORDER BY day DESC LIMIT 30',
        ).all();
        const claims = await env.DB.prepare('SELECT COUNT(*) AS n FROM claims').first();
        const msgs = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first();
        const days = rows.results ?? [];
        // Date-bound, NOT row-bound: zero-open days have no row, so the
        // 7 newest ROWS can silently span months and overstate the metric.
        const cutoff = new Date(Date.now() - 6 * 86_400_000)
          .toISOString().slice(0, 10);
        const opens7d = days
          .filter((r) => r.day >= cutoff)
          .reduce((s, r) => s + r.count, 0);
        return json({
          opens7d,
          opensToday: days[0]?.day === new Date().toISOString().slice(0, 10) ? days[0].count : 0,
          opensByDay: days,
          claims: claims?.n ?? 0,
          messages: msgs?.n ?? 0,
        });
      } catch {
        return json({ error: 'storage error' }, 500);
      }
    }
    try {
      if (request.method === 'GET' && url.pathname === '/status') {
        const mint = url.searchParams.get('mint');
        if (!mint) return json({ error: 'mint required' }, 400);
        const row = await env.DB.prepare(
          'SELECT id FROM claims WHERE genesis_mint = ?',
        )
          .bind(mint)
          .first();
        return row
          ? json({ claimed: true, number: row.id, tier: tierOf(row.id) })
          : json({ claimed: false });
      }
      if (request.method === 'GET' && url.pathname === '/stats') {
        const row = await env.DB.prepare(
          'SELECT COUNT(*) AS total FROM claims',
        ).first();
        const total = row?.total ?? 0;
        return json({ total, founding: Math.min(total, 100) });
      }
    } catch {
      return json({ error: 'storage error' }, 500);
    }
    return json({ error: 'not found' }, 404);
  },
};
