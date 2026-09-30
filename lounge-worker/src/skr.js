// lounge-worker/src/skr.js
/**
 * SKR staking reads (SPEC-skr-final section 1, day D6 scope: 1.1 to 1.8).
 * Reads Solana Mobile's staking program through rpc.js only. Never signs,
 * never holds SKR, never calls getProgramAccounts. Every decode is asserted
 * (owner, exact length, discriminator, key fields) and fails CLOSED to
 * 'unknown', which the vouch router weighs at 1.00x.
 *
 * Frozen interface (SPEC-vouch-final 2.7), consumed by vouch.js step 7:
 *   readStakeWeight(env, wallet[, { maxAgeMs }])
 *     -> { stakedSkr: number|null, checkedAt: ISO, source: 'chain'|'cache'|'error', ... }
 * NEVER throws (the promise never rejects). Carries NO weight: the router
 * computes sharedStakeWeight(stakedSkr, mintsInWallet), so the per-wallet
 * division exists exactly once (vouch-lib.js). Any decode or RPC failure is
 * stakedSkr null, which weighs 1.00x: never an error, never a higher weight.
 *
 * Paid-RPC cost: one getMultipleAccounts call per read (rpc.js retries it up
 * to twice on 429/5xx/network). A clean read ('ok' or 'none') is cached in
 * skr_cache, so a wallet costs at most one per SKR_WEIGHT_TTL_MS; a failed read
 * ('unknown') is never cached, so it is retried on that wallet's next write,
 * which the per-wallet 10 s slot and the rpc_budget unit behind every write
 * bound. vouch.js reaches this only after the signature, one rpc_budget unit
 * and the SGT pair (index.js verifyGenesisSig) and after the per-wallet 10 s
 * slot, and it reads the signer's own wallet only, so this adds no open proxy.
 *
 * Not in this file yet (later days): the hourly re-weight cron and its drift
 * check (SPEC-skr-final 1.10, D16) and the signed POST /skr/read (1.11, D7
 * decision point).
 */
import { base58, base64 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import * as ed from '@noble/ed25519';
import { rpc } from './rpc.js';
import { weightFor } from './vouch-lib.js';

// ---- pinned constants (SPEC-skr-final 0.1; re-verified on mainnet 2026-09-30, deploy slot unchanged) ----
export const SKR_PROGRAM = 'SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ';
export const STAKE_CONFIG = '4HQy82s9CHTv1GsYKnANHMiHfhcqesYkK6sB3RDSYyqw';
export const GUARDIAN_POOLS = ['DPJ58trLsF9yPrBa2pk6UaRkvqW8hWUYjawe788WBuqr']; // one pool today
export const STAKE_VAULT = '8isViKbwhuhFhsv2t8vaFL74pKCqaFPQXo1KkeQwZbB8';
export const SKR_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3';
// ProgramData and the deploy slot the layouts below were pinned at (u64 at offset 4).
// Read by the D16 drift check; exported so the tests hold them against the fixture.
export const PROGRAM_DATA = '7f1KoiGPFFouvAafZtVmtdpgGJuADprihB9Pdzut3gaJ';
export const PINNED_DEPLOY_SLOT = 393714625n;

export const SKR_CACHE_TTL_MS = 10 * 60 * 1000; // decision 1: the signed READ window (POST /skr/read, cron rows)
export const SKR_WEIGHT_TTL_MS = 60 * 1000;     // POST /vouch and POST /vote stamp a weight at most 1 min old
const ACCOUNTS_PER_CALL = 100;                  // getMultipleAccounts hard limit

// ---- PDA derivation without web3.js (same strict on-curve test as web3.js 1.98.4) ----
const enc = new TextEncoder();
const PDA_MARKER = enc.encode('ProgramDerivedAddress');
const SEED_USER_STAKE = enc.encode('user_stake');
const PROGRAM_BYTES = base58.decode(SKR_PROGRAM);
const CONFIG_BYTES = base58.decode(STAKE_CONFIG);
const POOL_BYTES = GUARDIAN_POOLS.map((p) => base58.decode(p));

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** Throws = not on the curve = valid PDA (web3.js index.cjs.js:73-80 does the same). */
function isOnCurve(bytes) {
  try { ed.ExtendedPoint.fromHex(bytes); return true; } catch { return false; }
}
/** { address: Uint8Array(32), bump }, like PublicKey.findProgramAddressSync. About 0.27 ms. */
export function findProgramAddress(seeds, programId) {
  for (const s of seeds) if (s.length > 32) throw new Error('seed too long');
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(concat(...seeds, Uint8Array.of(bump), programId, PDA_MARKER));
    if (!isOnCurve(h)) return { address: h, bump };
  }
  throw new Error('no viable bump'); // unreachable in practice
}
/** UserStake PDA: seeds ["user_stake", stake_config, user, guardian_pool] (IDL). */
export function userStakePda(walletBytes, poolBytes) {
  return findProgramAddress([SEED_USER_STAKE, CONFIG_BYTES, walletBytes, poolBytes], PROGRAM_BYTES);
}

// ---- decoders (fail closed) ----
const LEN = { config: 193, pool: 188, user: 169 };
const DISC = {
  config: Uint8Array.of(238, 151, 43, 3, 11, 151, 63, 176),
  pool: Uint8Array.of(133, 238, 255, 214, 215, 11, 189, 23),
  user: Uint8Array.of(102, 53, 163, 107, 9, 138, 87, 153),
};
const rdU16 = (b, o) => b[o] | (b[o + 1] << 8);
const rdU64 = (b, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; };
const rdU128 = (b, o) => { let v = 0n; for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; };
const rdI64 = (b, o) => BigInt.asIntN(64, rdU64(b, o));
const rdKey = (b, o) => base58.encode(b.subarray(o, o + 32));
const eq32 = (b, o, k) => { for (let i = 0; i < 32; i++) if (b[o + i] !== k[i]) return false; return true; };

/** One base64 account entry -> { ok, data } or { ok:false, reason }. null = missing. */
export function assertAccount(info, kind) {
  if (!info) return { ok: false, reason: `${kind}: missing` };
  if (info.owner !== SKR_PROGRAM) return { ok: false, reason: `${kind}: wrong owner` };
  let data;
  try { data = base64.decode(info.data?.[0] ?? ''); } catch { return { ok: false, reason: `${kind}: bad base64` }; }
  if (data.length !== LEN[kind]) return { ok: false, reason: `${kind}: length ${data.length}` };
  const d = DISC[kind];
  for (let i = 0; i < 8; i++) if (data[i] !== d[i]) return { ok: false, reason: `${kind}: discriminator` };
  return { ok: true, data };
}
/** StakeConfig, 193 B (skr-reference 3.1). */
export function decodeStakeConfig(data) {
  return {
    bump: data[8], authority: rdKey(data, 9), mint: rdKey(data, 41), stakeVault: rdKey(data, 73),
    minStakeAmount: rdU64(data, 105), cooldownSeconds: rdU64(data, 113), totalShares: rdU128(data, 121),
    sharePrice: rdU128(data, 137), commissionWeightSum: rdU128(data, 153),
    cumulativeCommissionPerShare: rdU128(data, 169), lastVaultAmount: rdU64(data, 185),
  };
}
/** GuardianDelegationPool, 188 B (skr-reference 3.2). */
export function decodeGuardianPool(data) {
  return {
    stakeConfig: rdKey(data, 8), guardian: rdKey(data, 40), authority: rdKey(data, 72),
    totalShares: rdU128(data, 104), cumulativeCommissionPerShare: rdU128(data, 120),
    lastSharePrice: rdU128(data, 136), accruedCommission: rdU128(data, 152), commissionBps: rdU16(data, 168),
    bump: data[170], active: data[171] === 1, deregisteredSharePrice: rdU128(data, 172),
  };
}
/** UserStake, 169 B (skr-reference 3.3). Full decode with base58 keys (tests, drift check). */
export function decodeUserStake(data) {
  return {
    bump: data[8], stakeConfig: rdKey(data, 9), user: rdKey(data, 41), guardianPool: rdKey(data, 73),
    shares: rdU128(data, 105), costBasis: rdU128(data, 121), cumulativeCommissionBeforeStaking: rdU128(data, 137),
    unstakingAmount: rdU64(data, 153), unstakeTimestamp: rdI64(data, 161),
  };
}
/** Hot path: byte-compare bump and the three keys, read only the numbers (11 us vs 43 us). */
function readUserStakeFast(data, walletBytes, poolBytes, bump) {
  if (data[8] !== bump || !eq32(data, 9, CONFIG_BYTES) || !eq32(data, 41, walletBytes) || !eq32(data, 73, poolBytes)) return null;
  return { shares: rdU128(data, 105), unstakingAmount: rdU64(data, 153), unstakeTimestamp: rdI64(data, 161) };
}

// ---- amounts ----
export const SHARE_SCALE = 1_000_000_000n;
export const stakedRawOf = (shares, sharePrice) => (shares * sharePrice) / SHARE_SCALE;
export const sharesFor = (amountRaw, sharePrice) => (amountRaw * SHARE_SCALE) / sharePrice;
// Number() is exact in practice: one wallet's stake is far below 2^53 raw (about 9.0e15;
// all SKR staked is about 5.0e15 raw), although the raw supply (about 1.06e16) is not.
export const toSkr = (raw) => Number(raw) / 1e6;

// ---- reads ----
const UNKNOWN = (reason) => ({
  status: 'unknown', reason, slot: 0, sharePrice: 0n, cooldownSeconds: 0n, minStakeAmount: 0n,
  stakedRaw: 0n, unstakingRaw: 0n, unstakeTimestamp: 0n, withdrawableAt: null,
  stakedSkr: null, unstakingSkr: 0, weight: 1, pools: [],
});

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
/**
 * Lamports sent to a PDA nobody staked at: owned by the System Program, 0 bytes.
 * Nobody but the staking program can allocate or assign a PDA, so this is "no
 * position", like a missing account. Read as 'unknown' instead, about 0.00089 SOL
 * sent to anyone's PDA would keep their reads uncached and failing.
 */
const isBareSystemAccount = (info) =>
  info?.owner === SYSTEM_PROGRAM && Array.isArray(info.data) && info.data[0] === '';

function decodeWallet(walletBytes, cfg, entries, pdas) {
  let stakedRaw = 0n, unstakingRaw = 0n, unstakeTimestamp = 0n;
  const pools = [];
  for (let i = 0; i < pdas.length; i++) {
    const p = pdas[i];
    // No position: null (no account) or a bare System account. Anything else,
    // including false, 0 or '' in a malformed reply, goes through assertAccount.
    if (entries[i] === null || isBareSystemAccount(entries[i])) {
      pools.push({ pool: p.pool, pda: p.pda, shares: 0n, stakedRaw: 0n });
      continue;
    }
    const a = assertAccount(entries[i], 'user');
    if (!a.ok) return UNKNOWN(a.reason);
    const us = readUserStakeFast(a.data, walletBytes, POOL_BYTES[p.poolIndex], p.bump);
    if (!us) return UNKNOWN('user: semantic mismatch');
    const s = stakedRawOf(us.shares, cfg.sharePrice);
    stakedRaw += s;
    unstakingRaw += us.unstakingAmount;
    if (us.unstakingAmount > 0n && us.unstakeTimestamp > unstakeTimestamp) unstakeTimestamp = us.unstakeTimestamp;
    pools.push({ pool: p.pool, pda: p.pda, shares: us.shares, stakedRaw: s });
  }
  const stakedSkr = toSkr(stakedRaw);
  return {
    status: stakedRaw > 0n || unstakingRaw > 0n ? 'ok' : 'none',
    sharePrice: cfg.sharePrice, cooldownSeconds: cfg.cooldownSeconds, minStakeAmount: cfg.minStakeAmount,
    stakedRaw, unstakingRaw, unstakeTimestamp,
    withdrawableAt: unstakingRaw > 0n ? Number(unstakeTimestamp + cfg.cooldownSeconds) : null,
    stakedSkr, unstakingSkr: toSkr(unstakingRaw), weight: weightFor(stakedSkr), pools,
  };
}

/**
 * A fixed vocabulary, so no provider-authored text (which can name the endpoint
 * or its key) leaves this file: rpc.js's own 'rpc <status>' is kept, its
 * 'rpc: <provider message>' becomes 'rpc: error', anything else (a raw fetch
 * error can carry the target URL on Workers) becomes 'rpc unavailable'.
 */
const safeReason = (e) => {
  const m = typeof e?.message === 'string' ? e.message : '';
  if (/^rpc \d{3}$/.test(m)) return m;
  return m.startsWith('rpc:') ? 'rpc: error' : 'rpc unavailable';
};

/** Stored PDA rows win; otherwise derive once and queue the row. `stored`: Map<wallet, [{pool,pda,bump}]>. */
function planWallet(wallet, stored, derived) {
  let walletBytes;
  try { walletBytes = base58.decode(wallet); } catch { return { wallet, bad: 'wallet: bad encoding' }; }
  if (walletBytes.length !== 32) return { wallet, bad: 'wallet: bad length' };
  const have = stored?.get(wallet);
  const pdas = GUARDIAN_POOLS.map((pool, poolIndex) => {
    const row = have?.find((r) => r.pool === pool);
    if (row) return { pool, poolIndex, pda: row.pda, bump: Number(row.bump) };
    const { address, bump } = userStakePda(walletBytes, POOL_BYTES[poolIndex]);
    const pda = base58.encode(address);
    derived.push([wallet, pool, pda, bump]);
    return { pool, poolIndex, pda, bump };
  });
  return { wallet, walletBytes, pdas };
}

const PDA_INSERT = `INSERT OR IGNORE INTO wallet_pdas (wallet, pool, pda, bump)
  SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]')
  FROM json_each(?1)`;

/** N wallets in ONE getMultipleAccounts: [config, pda(w1,p1), ..., pda(wN,pP)]. Map<wallet, read>. */
export async function readStakeMany(env, wallets, { stored = null } = {}) {
  const derived = [];
  const plan = wallets.map((w) => planWallet(w, stored, derived));
  const addresses = [STAKE_CONFIG];
  for (const p of plan) if (p.pdas) for (const x of p.pdas) addresses.push(x.pda);
  if (addresses.length > ACCOUNTS_PER_CALL) throw new Error('readStakeMany: chunk too large'); // caller chunks
  const out = new Map();
  // Nothing valid to read: answer without spending a paid call.
  if (addresses.length === 1) {
    for (const p of plan) out.set(p.wallet, UNKNOWN(p.bad ?? 'wallet: nothing to read'));
    return out;
  }
  try {
    let res;
    try {
      res = await rpc(env, 'getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }]);
    } catch (e) {
      const reason = safeReason(e);
      for (const p of plan) out.set(p.wallet, UNKNOWN(p.bad ?? reason));
      return out;
    }
    const values = Array.isArray(res?.value) ? res.value : null;
    if (!values || values.length !== addresses.length) {       // short or malformed: never "no position"
      for (const p of plan) out.set(p.wallet, UNKNOWN(p.bad ?? 'rpc: short reply'));
      return out;
    }
    const slot = Number(res?.context?.slot ?? 0);
    const cfgA = assertAccount(values[0], 'config');
    const cfg = cfgA.ok ? decodeStakeConfig(cfgA.data) : null;
    const cfgBad = !cfgA.ok ? cfgA.reason
      : (cfg.mint !== SKR_MINT || cfg.stakeVault !== STAKE_VAULT || cfg.sharePrice <= 0n || cfg.cooldownSeconds <= 0n)
        ? 'config: semantic mismatch' : null;
    let cursor = 1;
    for (const p of plan) {
      if (p.bad) { out.set(p.wallet, UNKNOWN(p.bad)); continue; }
      const entries = values.slice(cursor, cursor + p.pdas.length);
      cursor += p.pdas.length;
      out.set(p.wallet, cfgBad ? UNKNOWN(cfgBad) : { ...decodeWallet(p.walletBytes, cfg, entries, p.pdas), slot });
    }
    return out;
  } finally {
    if (derived.length && env.DB) {
      try { await env.DB.prepare(PDA_INSERT).bind(JSON.stringify(derived)).run(); } catch { /* next read derives again */ }
    }
  }
}

/** One wallet: stored PDA if any, then one RPC call. */
export async function readStake(env, wallet) {
  let stored = null;
  try {
    const { results } = await env.DB.prepare('SELECT pool, pda, bump FROM wallet_pdas WHERE wallet = ?1').bind(wallet).all();
    if (results?.length) stored = new Map([[wallet, results]]);
  } catch { /* derive */ }
  return (await readStakeMany(env, [wallet], { stored })).get(wallet);
}

// ---- per-wallet D1 cache (migrations/002_skr_cache.sql) ----
function rowToRead(row) {
  if (row.status !== 'ok' && row.status !== 'none') throw new Error('bad cache row');
  const stakedRaw = BigInt(row.staked_raw), unstakingRaw = BigInt(row.unstaking_raw);
  const cooldown = BigInt(row.cooldown_seconds), ts = BigInt(row.unstake_ts);
  const stakedSkr = toSkr(stakedRaw);
  return {
    status: row.status, slot: row.slot, sharePrice: BigInt(row.share_price), cooldownSeconds: cooldown,
    minStakeAmount: 1_000_000n, stakedRaw, unstakingRaw, unstakeTimestamp: ts,
    withdrawableAt: unstakingRaw > 0n ? Number(ts + cooldown) : null,
    stakedSkr, unstakingSkr: toSkr(unstakingRaw), weight: weightFor(stakedSkr),
    pools: [], cached: true, checkedAt: row.checked_at,
  };
}
const cacheRow = (wallet, s, nowIso) => ({
  wallet, status: s.status, staked_raw: s.stakedRaw.toString(), unstaking_raw: s.unstakingRaw.toString(),
  unstake_ts: Number(s.unstakeTimestamp), cooldown_seconds: Number(s.cooldownSeconds),
  share_price: s.sharePrice.toString(), weight: weightFor(s.stakedSkr), slot: s.slot, checked_at: nowIso,
});
// One JSON array parameter, so the single-wallet path and the D16 cron share one statement
// (D1 allows 100 bound parameters per query; 10 columns row by row would cap it at 10 wallets).
const CACHE_UPSERT_JSON = `INSERT INTO skr_cache (wallet, status, staked_raw, unstaking_raw, unstake_ts, cooldown_seconds, share_price, weight, slot, checked_at)
  SELECT json_extract(value, '$.wallet'), json_extract(value, '$.status'), json_extract(value, '$.staked_raw'),
         json_extract(value, '$.unstaking_raw'), json_extract(value, '$.unstake_ts'), json_extract(value, '$.cooldown_seconds'),
         json_extract(value, '$.share_price'), json_extract(value, '$.weight'), json_extract(value, '$.slot'),
         json_extract(value, '$.checked_at')
  FROM json_each(?1) WHERE true
  ON CONFLICT(wallet) DO UPDATE SET status = excluded.status, staked_raw = excluded.staked_raw,
    unstaking_raw = excluded.unstaking_raw, unstake_ts = excluded.unstake_ts, cooldown_seconds = excluded.cooldown_seconds,
    share_price = excluded.share_price, weight = excluded.weight, slot = excluded.slot, checked_at = excluded.checked_at`;
const CACHE_SELECT = `SELECT status, staked_raw, unstaking_raw, unstake_ts, cooldown_seconds, share_price, slot, checked_at
  FROM skr_cache WHERE wallet = ?1`;

/**
 * Cache-first read; 'unknown' is returned but never stored. now() injectable for tests.
 * A row younger than maxAgeMs is served; a row from the future or one that does not
 * parse counts as a miss (chain).
 */
export async function readStakeCached(env, wallet, { maxAgeMs = SKR_CACHE_TTL_MS, now = Date.now } = {}) {
  let row = null;
  try { row = await env.DB.prepare(CACHE_SELECT).bind(wallet).first(); } catch { /* chain */ }
  if (row) {
    const age = now() - Date.parse(row.checked_at);
    if (age >= 0 && age < maxAgeMs) {
      try { return rowToRead(row); } catch { /* unreadable row: chain */ }
    }
  }
  const fresh = await readStake(env, wallet);
  const checkedAt = new Date(now()).toISOString();
  if (fresh.status !== 'unknown') {
    try { await env.DB.prepare(CACHE_UPSERT_JSON).bind(JSON.stringify([cacheRow(wallet, fresh, checkedAt)])).run(); } catch { /* best-effort */ }
  }
  return { ...fresh, cached: false, checkedAt };
}

// ---- the frozen interface (SPEC-vouch-final 2.7), D6 body (SPEC-skr-final 1.8) ----
/**
 * { stakedSkr: number|null, checkedAt, source } and NO weight (the router computes
 * sharedStakeWeight). Compatible additions: unstakingSkr, withdrawableAt, slot on a clean
 * read; reason on an error (composed here or safeReason's fixed vocabulary, never provider text).
 * Optional third argument { maxAgeMs } (default 60 s); the frozen two-argument call gets it.
 * Never throws and never rejects; any failure is stakedSkr null (1.00x).
 */
export async function readStakeWeight(env, wallet, opts = {}) {
  try {
    const { maxAgeMs = SKR_WEIGHT_TTL_MS, now = Date.now } = opts ?? {};
    const s = await readStakeCached(env, wallet, { maxAgeMs, now });
    if (s.status === 'unknown') return { stakedSkr: null, checkedAt: s.checkedAt, source: 'error', reason: s.reason };
    return {
      stakedSkr: s.stakedSkr, checkedAt: s.checkedAt, source: s.cached ? 'cache' : 'chain',
      unstakingSkr: s.unstakingSkr, withdrawableAt: s.withdrawableAt, slot: s.slot,
    };
  } catch {
    return { stakedSkr: null, checkedAt: new Date().toISOString(), source: 'error', reason: 'internal' };
  }
}
