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

/**
 * Verify a fresh, wallet-signed message proving control of a genuine Seeker
 * Genesis Token that the wallet holds. Steps 1-3 of the claim flow, shared
 * with chat auth. Returns null on success, or an {error,status} to return.
 *
 * `message` + `maxAgeMs` default to the Lounge claim's string and window —
 * changing either default would invalidate every signature already shipped
 * devices produce. /alpha/* overrides them for domain separation.
 */
async function verifyGenesisSig(
  body,
  env,
  { message = claimMessage, maxAgeMs = MAX_MESSAGE_AGE_MS } = {},
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
async function verifyMembership(body, env) {
  const bad = await verifyGenesisSig(body, env);
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
async function verifyAlphaOwner(body, env) {
  const bad = await verifyGenesisSig(body, env, {
    message: alphaMessage,
    maxAgeMs: ALPHA_MESSAGE_AGE_MS,
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

async function handleClaim(request, env) {
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
  const bad = await verifyGenesisSig(body, env);
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
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }
    if (request.method === 'POST' && url.pathname === '/claim') {
      return handleClaim(request, env);
    }
    if (url.pathname.startsWith('/chat/')) {
      return handleChat(request, env, url, (body) => verifyMembership(body, env));
    }
    if (url.pathname.startsWith('/game/')) {
      return handleGame(request, env, url);
    }
    if (url.pathname.startsWith('/alpha/')) {
      return handleAlpha(request, env, url, (body) => verifyAlphaOwner(body, env));
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
        try {
          await env.DB.prepare(
            'INSERT INTO opens (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1',
          ).bind(new Date().toISOString().slice(0, 10)).run();
        } catch {
          /* best-effort; never fail an open */
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
