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
 * The hourly re-weight cron (reweightVouches, SPEC-skr-final 1.10) and its
 * drift check live at the end of this file; index.js scheduled() calls it.
 * It reads through readStakeMany only, so it is the same chain path and the
 * same fail-closed decode as POST /vouch.
 *
 * Not in this file yet: the signed POST /skr/read (1.11, D7 decision point).
 */
import { base58, base64 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import * as ed from '@noble/ed25519';
import { rpc } from './rpc.js';
import { isoWeek, previousWeek, settingOn, sharedStakeWeight, weekBounds, weightFor } from './vouch-lib.js';

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
// Little-endian reads through DataView (native): one BigInt per u64 instead of eight shifts, which
// matters in the hourly cron's cold isolate (99 accounts per tick, 10 ms CPU on the Free plan).
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const rdU16 = (b, o) => b[o] | (b[o + 1] << 8);
const rdU64 = (b, o) => view(b).getBigUint64(o, true);
const rdU128 = (b, o) => { const d = view(b); return d.getBigUint64(o, true) | (d.getBigUint64(o + 8, true) << 64n); };
const rdI64 = (b, o) => view(b).getBigInt64(o, true);
const rdKey = (b, o) => base58.encode(b.subarray(o, o + 32));
const eq32 = (b, o, k) => { for (let i = 0; i < 32; i++) if (b[o + i] !== k[i]) return false; return true; };

/**
 * base64 text -> bytes with the runtime's native decoder (Uint8Array.fromBase64 where the V8 has
 * it, else atob): @scure/base's generic radix-2 conversion cost about 15 ms for the 100 accounts
 * of one cron tick in a cold process, atob about 2.7 ms. The native decoders are forgiving (they
 * skip whitespace, accept missing padding and ignore stray bits under the padding) where
 * base64.decode throws, so the text must first be canonical base64: the alphabet, '=' only as
 * the last one or two characters, and zero bits under the padding. Anything else throws, exactly
 * where base64.decode throws (test/skr.test.js), and the app's decodeBase64 refuses the same
 * texts (src/lib/skr.parity.test.ts). The exact-length and discriminator checks below do the rest.
 */
const B64_CANONICAL = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;
const nativeBase64 = typeof Uint8Array.fromBase64 === 'function'
  ? (s) => Uint8Array.fromBase64(s)
  : (s) => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
const decodeBase64 = (s) => {
  if (!B64_CANONICAL.test(s)) throw new Error('bad base64');
  return nativeBase64(s);
};

/** One base64 account entry -> { ok, data } or { ok:false, reason }. null = missing. */
export function assertAccount(info, kind) {
  if (!info) return { ok: false, reason: `${kind}: missing` };
  if (info.owner !== SKR_PROGRAM) return { ok: false, reason: `${kind}: wrong owner` };
  const text = info.data?.[0] ?? '';
  if (typeof text !== 'string') return { ok: false, reason: `${kind}: bad base64` };
  let data;
  try { data = decodeBase64(text); } catch { return { ok: false, reason: `${kind}: bad base64` }; }
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
const MINT_BYTES = base58.decode(SKR_MINT);
const VAULT_BYTES = base58.decode(STAKE_VAULT);
/** Hot path for StakeConfig: mint and vault byte-compared (no base58 encode), the three numbers read. null = mismatch. */
function readConfigFast(data) {
  if (!eq32(data, 41, MINT_BYTES) || !eq32(data, 73, VAULT_BYTES)) return null;
  return { minStakeAmount: rdU64(data, 105), cooldownSeconds: rdU64(data, 113), sharePrice: rdU128(data, 137) };
}

// ---- base58 for wallet keys ----
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX = new Int8Array(128).fill(-1);
for (let i = 0; i < 58; i++) B58_INDEX[B58_ALPHABET.charCodeAt(i)] = i;
const TWO32 = 4294967296;
const B58_POW = [1, 58, 3364, 195112];                     // 58^0 .. 58^3
/**
 * base58 text -> a 32-byte key: the bytes base58.decode gives when it gives 32 of them, else
 * 'encoding' (a character outside the alphabet, where base58.decode throws) or 'length' (any
 * other decoded length). 32-bit limbs fed three digits at a time instead of @scure/base's
 * generic radix conversion, which cost 13 to 28 ms for the 99 wallets of one cron tick in a cold
 * process. test/skr.test.js holds it to base58.decode on random keys, leading-zero keys and
 * random strings.
 */
export function decodeKey32(s) {
  if (typeof s !== 'string') return 'encoding';
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c > 127 || B58_INDEX[c] < 0) return 'encoding';
  }
  if (n < 32 || n > 44) return 'length';                 // 32 bytes are 32 to 44 characters
  let zeros = 0;
  while (zeros < n && s.charCodeAt(zeros) === 49) zeros++; // each leading '1' is one leading 0x00
  const limbs = [0, 0, 0, 0, 0, 0, 0, 0, 0];              // little-endian; 58^44 < 2^258 fits in 9
  let used = 0;
  for (let i = zeros; i < n;) {
    const take = Math.min(3, n - i);
    let carry = 0;
    for (let t = 0; t < take; t++) carry = carry * 58 + B58_INDEX[s.charCodeAt(i + t)];
    i += take;
    const mul = B58_POW[take];
    for (let k = 0; k < used; k++) {
      const v = limbs[k] * mul + carry;                   // < 2^50: exact in a double
      carry = Math.floor(v / TWO32);
      limbs[k] = v - carry * TWO32;
    }
    if (carry) {
      if (used === 9) return 'length';
      limbs[used++] = carry;                              // carry <= 195112 < 2^32
    }
  }
  if (limbs[8] !== 0) return 'length';                   // the value alone needs more than 32 bytes
  const out = new Uint8Array(32);
  for (let k = 0; k < 8; k++) {
    const x = limbs[k];
    const o = 31 - 4 * k;
    out[o] = x & 0xff; out[o - 1] = (x >>> 8) & 0xff; out[o - 2] = (x >>> 16) & 0xff; out[o - 3] = x >>> 24;
  }
  let lead = 0;
  while (lead < 32 && out[lead] === 0) lead++;
  // Decoded length = leading '1's + bytes of the value = zeros + (32 - lead); 32 exactly when lead === zeros.
  return lead === zeros ? out : 'length';
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
  const walletBytes = decodeKey32(wallet);
  if (walletBytes === 'encoding') return { wallet, bad: 'wallet: bad encoding' };
  if (walletBytes === 'length') return { wallet, bad: 'wallet: bad length' };
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
    const cfg = cfgA.ok ? readConfigFast(cfgA.data) : null;      // mint and vault checked inside
    const cfgBad = !cfgA.ok ? cfgA.reason
      : (!cfg || cfg.sharePrice <= 0n || cfg.cooldownSeconds <= 0n) ? 'config: semantic mismatch' : null;
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

// ---- hourly re-weight cron (SPEC-skr-final 1.10; index.js scheduled(), wrangler.toml [triggers]) ----
// Why: weights are stamped at write time, so (a) a wallet that stops vouching keeps an old stamp while
// its stake moves, and (b) a weekly vote cast with a flash stake would keep its multiplier after the
// unstake. Stored vouches follow the stake both ways; stored votes only fall.
// Cloudflare limits (developers.cloudflare.com/workers/platform/limits/ and /d1/platform/limits/,
// read 2026-09-30): a Cron Trigger gets 10 ms CPU per invocation on Workers Free (30 s or 15 min on
// Paid), 50 subrequests per invocation on Free with D1 queries counted, 50 D1 queries per invocation
// on Free (1,000 on Paid, every statement inside batch() counted), 100 bound parameters per query.
// A Free tick over 10 ms is killed and its writes are lost, and the same stalest wallets would be
// picked again next hour, so the default is sized for Free: one getMultipleAccounts call and at most
// 7 D1 queries, and the hot path decodes keys and account data without @scure/base's generic radix
// code (decodeKey32, decodeBase64), which alone cost more than 10 ms per tick. test/bench.mjs
// measures the CPU of a tick, warm and on its first run.
const WALLETS_PER_CALL = Math.floor((ACCOUNTS_PER_CALL - 1) / GUARDIAN_POOLS.length); // 99 at one pool
export const REWEIGHT_DEFAULT = 99;     // wallets per tick: one RPC call (Free plan)
export const REWEIGHT_CEILING = 2000;   // Paid plan: REWEIGHT_MAX_WALLETS = "2000" in [vars], 21 RPC calls
// Wallets per tick whose PDA is not stored yet: 0.26 to 0.31 ms each warm (SPEC-skr-final 0.1); the
// first one in a fresh isolate costs a few ms more (test/bench.mjs). POST /vouch stores every PDA it
// reads, so only wallets that vouched before migration 002 arrive here without one.
export const DERIVE_BUDGET = 4;
const STAMPER_GRACE_MS = 8 * 3_600_000; // Mon 00:00Z to 08:00Z: the closed week's votes are re-checked
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

/** REWEIGHT_MAX_WALLETS as a whole number in [1, REWEIGHT_CEILING]; unset, '', 0, negative or junk is the default. */
export function reweightCap(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, REWEIGHT_CEILING) : REWEIGHT_DEFAULT;
}

// This week's voters first (and, inside the grace window, the closed week's), then every wallet with a
// vouch; inside each group the oldest skr_cache read first ('' = never read), so a cap below the
// population rotates through it tick by tick. n_vouch, n_cur and n_closed are the per-wallet divisors,
// counted exactly as POST /vouch counts them (COUNT(DISTINCT genesis_mint) FROM vouches WHERE wallet = ?,
// excluded rows included) and as the vote rule counts them per week.
const SELECT_TICK = `WITH sel AS (
    SELECT wallet, MIN(pri) AS p, MIN(ts) AS t FROM (
      SELECT o.wallet AS wallet, 0 AS pri, COALESCE(c.checked_at, '') AS ts
        FROM votes o LEFT JOIN skr_cache c ON c.wallet = o.wallet
       WHERE o.week = ?1 OR o.week = ?2
      UNION ALL
      SELECT v.wallet AS wallet, 1 AS pri, COALESCE(c.checked_at, '') AS ts
        FROM vouches v LEFT JOIN skr_cache c ON c.wallet = v.wallet
    ) GROUP BY wallet ORDER BY p, t, wallet LIMIT ?3
  )
  SELECT sel.wallet AS wallet,
    (SELECT COUNT(DISTINCT genesis_mint) FROM vouches WHERE vouches.wallet = sel.wallet) AS n_vouch,
    (SELECT COUNT(DISTINCT genesis_mint) FROM votes WHERE votes.week = ?1 AND votes.wallet = sel.wallet) AS n_cur,
    (SELECT COUNT(DISTINCT genesis_mint) FROM votes WHERE votes.week = ?2 AND votes.wallet = sel.wallet) AS n_closed,
    wp.pool AS pool, wp.pda AS pda, wp.bump AS bump
  FROM sel LEFT JOIN wallet_pdas wp ON wp.wallet = sel.wallet
  ORDER BY sel.p, sel.t, sel.wallet`;
// Set-based writes: one statement per table per chunk, each taking one JSON array parameter (D1 counts
// every statement of a batch and allows 100 bound parameters, so per-wallet statements do not fit).
// Vouches: the predicate of POST /vouch's own re-stamp (vouch.js step 9), so a row is written only when
// its weight or its stake changed. Votes: only a LOWER weight is written.
// A POST /vouch (or, later, POST /vote) can land while the tick's getMultipleAccounts call is in
// flight. Its stamp is newer than the tick's read, so each write also requires that nothing changed
// since the selection: the wallet's divisor is still the `n` the tick used, and the row was last
// stamped (vouches.weight_checked_at) or written (votes.updated_at) at or before the tick's scheduled
// time. A row that fails either test keeps the router's stamp until a later tick re-reads the wallet.
const VOUCH_RESTAMP = `UPDATE vouches SET weight = json_extract(j.value, '$.w'), staked_skr = json_extract(j.value, '$.s'),
    weight_checked_at = ?1
  FROM json_each(?2) AS j
  WHERE vouches.wallet = json_extract(j.value, '$.wallet')
    AND (vouches.weight <> json_extract(j.value, '$.w') OR vouches.staked_skr IS NOT json_extract(j.value, '$.s'))
    AND (vouches.weight_checked_at IS NULL OR vouches.weight_checked_at <= ?1)
    AND (SELECT COUNT(DISTINCT x.genesis_mint) FROM vouches AS x WHERE x.wallet = vouches.wallet) = json_extract(j.value, '$.n')`;
const VOTE_DEMOTE = `UPDATE votes SET weight = json_extract(j.value, '$.w'), staked_skr = json_extract(j.value, '$.s')
  FROM json_each(?2) AS j
  WHERE votes.week = ?1 AND votes.wallet = json_extract(j.value, '$.wallet')
    AND votes.weight > json_extract(j.value, '$.w')
    AND votes.updated_at <= ?3
    AND (SELECT COUNT(DISTINCT x.genesis_mint) FROM votes AS x WHERE x.week = ?1 AND x.wallet = votes.wallet) = json_extract(j.value, '$.n')`;
// The tick's cache write keeps a row read after the tick's scheduled time (a POST /vouch read that
// landed while the tick's call was in flight): the older read never replaces the newer one.
const CACHE_UPSERT_TICK = `${CACHE_UPSERT_JSON}
    WHERE excluded.checked_at >= skr_cache.checked_at`;

const isWalletKey = (w) => decodeKey32(w) instanceof Uint8Array;

/** The one summary line of a tick: counts, a week key and drift flags only. No wallet, no stake, no URL. */
function logTick(t0, fields) {
  const line = { evt: 'reweight', ...fields, ms: Date.now() - t0 };
  console.log(JSON.stringify(line));
  return line;
}

/**
 * One hourly tick (index.js scheduled()). Never rejects; returns the summary it logs.
 * Rules (SPEC-skr-final 1.10):
 * - settings.skr_read_enabled, read as GET /flags reads it (settingOn): off skips the tick, and a
 *   D1 error on that read skips it too (fail closed), both before any chain call.
 * - Vouches follow the stake both ways: weight = sharedStakeWeight(staked, n_vouch), the value POST
 *   /vouch stores for the same stake and the same wallet.
 * - This week's votes only fall: sharedStakeWeight(staked, n_cur) is written when it is lower.
 * - For 8 hours after Monday 00:00Z the closed week's votes are re-checked the same way, unless the
 *   wallet's pending unstake began at or after the close (the one provably post-close drop).
 * - An 'unknown' read (RPC error, short reply, failed decode) writes nothing for that wallet: its rows
 *   keep their last good stamp and nothing is cached. A D1 error on the selection or a batch ends the
 *   tick with a `skipped` line.
 * - A router write that lands while the tick reads wins: rows stamped or written after the tick's
 *   scheduled time, a wallet whose divisor changed since the selection and a cache row read after the
 *   scheduled time are left as the router wrote them (VOUCH_RESTAMP, VOTE_DEMOTE, CACHE_UPSERT_TICK).
 * - drift: also run checkDrift (the 03:07 UTC tick).
 */
export async function reweightVouches(env, { now = new Date(), drift = false } = {}) {
  const t0 = Date.now();
  // A start line with no summary line after it (wrangler tail) marks a tick the runtime killed.
  console.log(JSON.stringify({ evt: 'reweight', phase: 'start' }));
  try {
    return await reweightTick(env, now, drift, t0);
  } catch {
    return logTick(t0, { skipped: 'internal' });
  }
}

async function reweightTick(env, nowArg, drift, t0) {
  try {
    const sw = await env.DB.prepare("SELECT value FROM settings WHERE key = 'skr_read_enabled'").first();
    if (!settingOn(sw?.value, true)) return logTick(t0, { skipped: 'disabled' });
  } catch {
    return logTick(t0, { skipped: 'settings unavailable' });
  }

  const now = nowArg instanceof Date && Number.isFinite(nowArg.getTime()) ? nowArg : new Date();
  const cap = reweightCap(env.REWEIGHT_MAX_WALLETS);
  const week = isoWeek(now);
  const weekStartMs = Date.parse(weekBounds(now).start);
  const closedWeek = now.getTime() - weekStartMs < STAMPER_GRACE_MS ? previousWeek(now) : null;
  const closeSec = BigInt(Math.floor(weekStartMs / 1000)); // the closed week ended where this one began

  let rows;
  try {
    ({ results: rows } = await env.DB.prepare(SELECT_TICK).bind(week, closedWeek ?? '', cap).all());
  } catch {
    return logTick(t0, { skipped: 'storage error' });
  }

  const counts = new Map(); // wallet -> { nVouch, nCur, nClosed }
  const stored = new Map(); // wallet -> [{ pool, pda, bump }] (readStakeMany's `stored`)
  for (const r of rows ?? []) {
    if (typeof r.wallet !== 'string') continue;
    if (!counts.has(r.wallet)) {
      counts.set(r.wallet, { nVouch: Number(r.n_vouch) || 0, nCur: Number(r.n_cur) || 0, nClosed: Number(r.n_closed) || 0 });
    }
    if (r.pda) {
      if (!stored.has(r.wallet)) stored.set(r.wallet, []);
      stored.get(r.wallet).push({ pool: r.pool, pda: r.pda, bump: r.bump });
    }
  }

  // A wallet with every pinned pool's PDA stored is read. At most DERIVE_BUDGET others derive theirs
  // (readStakeMany stores the row), the rest wait: they stay first in the order ('' = never read).
  // A wallet that is not a 32-byte key is never read and never spends the budget.
  let deriveLeft = DERIVE_BUDGET;
  let deferred = 0;
  let invalid = 0;
  const todo = [];
  for (const w of counts.keys()) {
    const have = stored.get(w);
    if (have && GUARDIAN_POOLS.every((p) => have.some((x) => x.pool === p))) todo.push(w);
    else if (!isWalletKey(w)) invalid++;
    else if (deriveLeft > 0) { deriveLeft--; todo.push(w); }
    else deferred++;
  }

  const nowIso = now.toISOString();
  let ok = 0, unknown = 0, chunks = 0, vouchRows = 0, voteRows = 0, cacheRows = 0;
  const tally = () => ({ ok, unknown, vouch_rows: vouchRows, vote_rows: voteRows, cache_rows: cacheRows });
  for (let i = 0; i < todo.length; i += WALLETS_PER_CALL) {
    const reads = await readStakeMany(env, todo.slice(i, i + WALLETS_PER_CALL), { stored });
    chunks++;
    const vouchJ = [], curJ = [], closedJ = [], cacheJ = [];
    for (const [wallet, s] of reads) {
      if (s.status === 'unknown') { unknown++; continue; } // keep the last good stamp; never demote on a failed read
      ok++;
      const n = counts.get(wallet);
      // `n` goes into each entry: the write re-checks it against the divisor at write time.
      if (n.nVouch > 0) vouchJ.push({ wallet, n: n.nVouch, w: sharedStakeWeight(s.stakedSkr, n.nVouch), s: s.stakedSkr });
      // This week's votes can only FALL: a stake that leaves before the close loses its multiplier.
      if (n.nCur > 0) curJ.push({ wallet, n: n.nCur, w: sharedStakeWeight(s.stakedSkr, n.nCur), s: s.stakedSkr });
      // Closed week, inside the grace window: demote unless the drop is an unstake begun at or after the close.
      if (closedWeek && n.nClosed > 0 && !(s.unstakingRaw > 0n && s.unstakeTimestamp >= closeSec)) {
        closedJ.push({ wallet, n: n.nClosed, w: sharedStakeWeight(s.stakedSkr, n.nClosed), s: s.stakedSkr });
      }
      cacheJ.push(cacheRow(wallet, s, nowIso));
    }
    const stmts = [];
    const kinds = [];
    if (vouchJ.length) { stmts.push(env.DB.prepare(VOUCH_RESTAMP).bind(nowIso, JSON.stringify(vouchJ))); kinds.push('vouch'); }
    if (curJ.length) { stmts.push(env.DB.prepare(VOTE_DEMOTE).bind(week, JSON.stringify(curJ), nowIso)); kinds.push('vote'); }
    if (closedJ.length) { stmts.push(env.DB.prepare(VOTE_DEMOTE).bind(closedWeek, JSON.stringify(closedJ), nowIso)); kinds.push('vote'); }
    if (cacheJ.length) { stmts.push(env.DB.prepare(CACHE_UPSERT_TICK).bind(JSON.stringify(cacheJ))); kinds.push('cache'); }
    if (!stmts.length) continue;
    let res;
    try {
      res = await env.DB.batch(stmts);
    } catch {
      return logTick(t0, { skipped: 'write failed', selected: counts.size, read: todo.length, chunks, ...tally() });
    }
    res.forEach((r, k) => {
      const c = Number(r?.meta?.changes) || 0;
      if (kinds[k] === 'vouch') vouchRows += c;
      else if (kinds[k] === 'vote') voteRows += c;
      else cacheRows += c;
    });
  }
  const driftInfo = drift ? await checkDrift(env) : {};
  return logTick(t0, {
    selected: counts.size, read: todo.length, deferred, invalid, chunks, ...tally(), closed_week: closedWeek, ...driftInfo,
  });
}

/**
 * The 03:07 UTC tick: the ProgramData deploy slot (u64 at offset 4) against the slot the layouts
 * were pinned at, and every pinned pool's `active` flag. Two RPC calls. It never flips a switch:
 * deploy_slot_changed true or pool_active false means the owner flips stake_enabled and checks by
 * hand (SPEC-skr-final 6.3). Any failure is { drift_error } with safeReason's fixed vocabulary.
 */
export async function checkDrift(env) {
  try {
    const [pd, pools] = await Promise.all([
      rpc(env, 'getAccountInfo', [PROGRAM_DATA, { encoding: 'base64', dataSlice: { offset: 4, length: 8 } }]),
      rpc(env, 'getMultipleAccounts', [GUARDIAN_POOLS, { encoding: 'base64' }]),
    ]);
    let deploySlot = null;
    if (pd?.value?.owner === UPGRADEABLE_LOADER) {
      let b = new Uint8Array(0);
      try { b = base64.decode(pd.value.data?.[0] ?? ''); } catch { /* stays null */ }
      if (b.length === 8) deploySlot = rdU64(b, 0);
    }
    const values = Array.isArray(pools?.value) && pools.value.length === GUARDIAN_POOLS.length ? pools.value : null;
    let poolActive = null;
    if (values) {
      const decoded = values.map((v) => assertAccount(v, 'pool'));
      if (decoded.every((a) => a.ok)) poolActive = decoded.every((a) => decodeGuardianPool(a.data).active);
    }
    return {
      deploy_slot: deploySlot === null ? null : Number(deploySlot),
      deploy_slot_changed: deploySlot !== PINNED_DEPLOY_SLOT,
      pool_active: poolActive,
    };
  } catch (e) {
    return { drift_error: safeReason(e) };
  }
}
