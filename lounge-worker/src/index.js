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

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const SGT_MINT_AUTHORITY = 'GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4';
const SGT_METADATA_ADDRESS = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
const SGT_GROUP_MINT_ADDRESS = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000; // past-dated tolerance
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000; // future-dated tolerance
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
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

/** JSON-RPC with timeout + 2 retries (backoff w/ jitter) on 429/5xx/network. */
async function rpc(env, method, params) {
  const url = env.RPC_URL || DEFAULT_RPC;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) =>
        setTimeout(r, 400 * attempt + Math.random() * 300),
      );
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`rpc ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`rpc ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(`rpc: ${body.error.message}`);
      return body.result;
    } catch (e) {
      lastErr = e;
      if (e?.message?.startsWith('rpc:')) throw e; // RPC-level error: no retry
    }
  }
  throw lastErr ?? new Error('rpc unavailable');
}

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

async function handleClaim(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const { wallet, mint, ts, signature } = body ?? {};
  if (
    typeof wallet !== 'string' ||
    typeof mint !== 'string' ||
    typeof ts !== 'string' ||
    typeof signature !== 'string'
  ) {
    return json({ error: 'missing fields' }, 400);
  }

  // 0. Already claimed? Answer straight from D1 — zero crypto, zero RPC.
  // This is the replay/DoS short-circuit AND makes re-claims self-healing
  // (a claimant on a flaky network just gets their number back).
  try {
    const existing = await env.DB.prepare(
      'SELECT id FROM claims WHERE genesis_mint = ?',
    )
      .bind(mint)
      .first();
    if (existing) {
      return json({ number: existing.id, tier: tierOf(existing.id) });
    }
  } catch {
    return json({ error: 'storage error' }, 500);
  }

  // 1. Freshness — the signed message embeds the timestamp. Asymmetric
  // window: 10 min past (retries without re-signing) / 2 min future (skew).
  const dt = Date.now() - Date.parse(ts);
  if (!Number.isFinite(dt) || dt > MAX_MESSAGE_AGE_MS || dt < -MAX_CLOCK_SKEW_MS) {
    return json({ error: 'stale message' }, 400);
  }

  // 2. Signature by the wallet over the canonical message.
  let walletBytes, sigBytes;
  try {
    walletBytes = base58.decode(wallet);
    sigBytes = base58.decode(signature);
    base58.decode(mint); // validates encoding
  } catch {
    return json({ error: 'bad encoding' }, 400);
  }
  if (walletBytes.length !== 32 || sigBytes.length !== 64) {
    return json({ error: 'bad key or signature length' }, 400);
  }
  const msgBytes = new TextEncoder().encode(claimMessage(wallet, mint, ts));
  let sigOk = false;
  try {
    // zip215:false = strict RFC 8032 (rejects malleable signatures).
    sigOk = ed.verify(sigBytes, msgBytes, walletBytes, { zip215: false });
  } catch {
    sigOk = false;
  }
  if (!sigOk) return json({ error: 'signature verification failed' }, 401);

  // 3. On-chain: genuine SGT + held by this wallet.
  try {
    const [mintInfo, holdings] = await Promise.all([
      rpc(env, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }]),
      rpc(env, 'getTokenAccountsByOwner', [
        wallet,
        { mint },
        { encoding: 'jsonParsed' },
      ]),
    ]);
    if (!isGenuineSgt(mintInfo)) {
      return json({ error: 'not a Seeker Genesis Token' }, 403);
    }
    const holds = (holdings?.value ?? []).some(
      (a) =>
        Number(
          a?.account?.data?.parsed?.info?.tokenAmount?.amount ?? '0',
        ) >= 1,
    );
    if (!holds) return json({ error: 'wallet does not hold this token' }, 403);
  } catch (e) {
    return json({ error: `chain check unavailable: ${e.message}` }, 502);
  }

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
