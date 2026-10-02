/**
 * SKR staking, the read half the phone needs (SPEC-skr-final 2.1): the
 * pinned constants, the fail-closed decoders for StakeConfig and UserStake,
 * the UserStake PDA, the vouch weight curve, one getMultipleAccounts read
 * with its transport injected, and the sentences of the Profile card.
 *
 * Read only. Nothing here builds, signs or sends a transaction.
 *
 * No React Native import and no relative import, so `npm run test:app`
 * loads it with Node's type stripping (like vouchCore.ts). The one runtime
 * dependency is PublicKey from @solana/web3.js (base58 and the PDA search).
 *
 * The contract is the LIVE worker (lounge-worker/src/skr.js, and
 * vouch-lib.js for weightFor): the same constants, offsets, checks and
 * failure reasons, so the card and a signed vouch agree on the stake and the
 * weight. skr.parity.test.ts runs the worker's own file and this one over the
 * same RPC replies. Every check fails CLOSED to status 'unknown': the card
 * then says it couldn't read the stake and shows no number at all.
 * Layouts and pins: program/README.md (read from mainnet 2026-09-30, deploy
 * slot 393714625).
 */
import { PublicKey } from '@solana/web3.js';

// ---- pinned constants (program/README.md; lounge-worker/src/skr.js) ----
export const SKR_PROGRAM = 'SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ';
export const STAKE_CONFIG = '4HQy82s9CHTv1GsYKnANHMiHfhcqesYkK6sB3RDSYyqw';
export const GUARDIAN_POOLS: readonly string[] = ['DPJ58trLsF9yPrBa2pk6UaRkvqW8hWUYjawe788WBuqr']; // one pool today
export const STAKE_VAULT = '8isViKbwhuhFhsv2t8vaFL74pKCqaFPQXo1KkeQwZbB8';
export const SKR_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// BigInt() instead of bigint literals: the app bundle has none yet, and this keeps it that way.
const B0 = BigInt(0);
const B8 = BigInt(8);
const TWO63 = BigInt(1) << BigInt(63);
const TWO64 = BigInt(1) << BigInt(64);
/** share_price is scaled by 1e9 (StakeConfig.share_price). */
export const SHARE_SCALE = BigInt(1_000_000_000);
/** SKR has 6 decimals. */
const SKR_UNIT = BigInt(1_000_000);
export const WEIGHT_CAP = 4;

export type AccountKind = 'config' | 'user';
export const LEN: Readonly<Record<AccountKind, number>> = { config: 193, user: 169 };
export const DISC: Readonly<Record<AccountKind, Uint8Array>> = {
  config: Uint8Array.of(238, 151, 43, 3, 11, 151, 63, 176),
  user: Uint8Array.of(102, 53, 163, 107, 9, 138, 87, 153),
};

const PROGRAM_PK = new PublicKey(SKR_PROGRAM);
const CONFIG_BYTES = new PublicKey(STAKE_CONFIG).toBytes();
const MINT_BYTES = new PublicKey(SKR_MINT).toBytes();
const VAULT_BYTES = new PublicKey(STAKE_VAULT).toBytes();
const SEED_USER_STAKE = Uint8Array.from('user_stake', (c) => c.charCodeAt(0));

// ---- base64 (strict: the alphabet, length a multiple of 4, '=' only as the last one or two, zero padding bits) ----
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_INDEX[B64.charCodeAt(i)] = i;

/** base64 text to bytes, or null for anything that is not canonical-shape base64. */
export function decodeBase64(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || s.length % 4 !== 0) return null;
  const n = s.length;
  const pad = n && s.charCodeAt(n - 1) === 61 ? (s.charCodeAt(n - 2) === 61 ? 2 : 1) : 0;
  const out = new Uint8Array((n / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < n; i += 4) {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const at = i + k;
      const c = s.charCodeAt(at);
      let d: number;
      if (at >= n - pad) {
        if (c !== 61) return null;
        d = 0;
      } else {
        d = c < 128 ? B64_INDEX[c] : -1;
        if (d < 0) return null;
      }
      v = (v << 6) | d;
    }
    // The bits a padded quad drops must be zero, as @scure/base (the worker) requires.
    if (i + 4 === n && pad && (v & (pad === 2 ? 0xffff : 0xff)) !== 0) return null;
    out[o++] = (v >> 16) & 255;
    if (o < out.length) out[o++] = (v >> 8) & 255;
    if (o < out.length) out[o++] = v & 255;
  }
  return out;
}

// ---- little-endian reads (byte loops: no DataView BigInt methods assumed on Hermes) ----
const rdU64 = (b: Uint8Array, o: number): bigint => {
  let v = B0;
  for (let i = 7; i >= 0; i--) v = (v << B8) | BigInt(b[o + i]);
  return v;
};
const rdU128 = (b: Uint8Array, o: number): bigint => {
  let v = B0;
  for (let i = 15; i >= 0; i--) v = (v << B8) | BigInt(b[o + i]);
  return v;
};
const rdI64 = (b: Uint8Array, o: number): bigint => {
  const v = rdU64(b, o);
  return v >= TWO63 ? v - TWO64 : v;
};
const rdKey = (b: Uint8Array, o: number): string => new PublicKey(b.subarray(o, o + 32)).toBase58();
const eq32 = (b: Uint8Array, o: number, k: Uint8Array): boolean => {
  for (let i = 0; i < 32; i++) if (b[o + i] !== k[i]) return false;
  return true;
};

// ---- decoders (fail closed) ----
export type Asserted = { ok: true; data: Uint8Array } | { ok: false; reason: string };

/**
 * One base64 account entry of a getMultipleAccounts reply ({ owner, data:
 * [base64, 'base64'], ... }) to its bytes, or the worker's reason: missing,
 * wrong owner, bad base64, wrong length, wrong discriminator.
 */
export function assertAccount(info: unknown, kind: AccountKind): Asserted {
  if (!info) return { ok: false, reason: `${kind}: missing` };
  const a = info as { owner?: unknown; data?: { [i: number]: unknown } | null };
  if (a.owner !== SKR_PROGRAM) return { ok: false, reason: `${kind}: wrong owner` };
  const text = a.data?.[0] ?? '';
  const data = decodeBase64(text);
  if (!data) return { ok: false, reason: `${kind}: bad base64` };
  if (data.length !== LEN[kind]) return { ok: false, reason: `${kind}: length ${data.length}` };
  const d = DISC[kind];
  for (let i = 0; i < 8; i++) if (data[i] !== d[i]) return { ok: false, reason: `${kind}: discriminator` };
  return { ok: true, data };
}

export interface StakeConfig {
  bump: number; authority: string; mint: string; stakeVault: string;
  minStakeAmount: bigint; cooldownSeconds: bigint; totalShares: bigint; sharePrice: bigint;
  commissionWeightSum: bigint; cumulativeCommissionPerShare: bigint; lastVaultAmount: bigint;
}
/** StakeConfig, 193 bytes (program/README.md). Call on assertAccount's bytes only. */
export function decodeStakeConfig(data: Uint8Array): StakeConfig {
  return {
    bump: data[8], authority: rdKey(data, 9), mint: rdKey(data, 41), stakeVault: rdKey(data, 73),
    minStakeAmount: rdU64(data, 105), cooldownSeconds: rdU64(data, 113), totalShares: rdU128(data, 121),
    sharePrice: rdU128(data, 137), commissionWeightSum: rdU128(data, 153),
    cumulativeCommissionPerShare: rdU128(data, 169), lastVaultAmount: rdU64(data, 185),
  };
}

export interface UserStake {
  bump: number; stakeConfig: string; user: string; guardianPool: string;
  shares: bigint; costBasis: bigint; cumulativeCommissionBeforeStaking: bigint;
  unstakingAmount: bigint; unstakeTimestamp: bigint;
}
/** UserStake, 169 bytes (program/README.md). Call on assertAccount's bytes only. */
export function decodeUserStake(data: Uint8Array): UserStake {
  return {
    bump: data[8], stakeConfig: rdKey(data, 9), user: rdKey(data, 41), guardianPool: rdKey(data, 73),
    shares: rdU128(data, 105), costBasis: rdU128(data, 121), cumulativeCommissionBeforeStaking: rdU128(data, 137),
    unstakingAmount: rdU64(data, 153), unstakeTimestamp: rdI64(data, 161),
  };
}

// ---- PDA ----
/** UserStake PDA: seeds ["user_stake", stake_config, user, guardian_pool] (IDL). Throws on a bad key. */
export function userStakePda(wallet: string, pool: string = GUARDIAN_POOLS[0]): { pda: string; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [SEED_USER_STAKE, CONFIG_BYTES, new PublicKey(wallet).toBytes(), new PublicKey(pool).toBytes()],
    PROGRAM_PK,
  );
  return { pda: pda.toBase58(), bump };
}

// ---- amounts and the weight curve ----
export const stakedRawOf = (shares: bigint, sharePrice: bigint): bigint => (shares * sharePrice) / SHARE_SCALE;
// Number() is exact in practice: one wallet's stake is far below 2^53 raw (all SKR staked is about 5.0e15 raw).
export const toSkr = (raw: bigint): number => Number(raw) / 1e6;

/**
 * The vouch weight a stake gives: 1 + min(3, log10(1 + staked/100)), rounded
 * to 2 dp, capped at 4.00. Anything unusable is 1. Byte for byte the worker's
 * vouch-lib.js weightFor. The worker then splits a wallet's stake evenly
 * across the Genesis Tokens it vouched with (sharedStakeWeight), which the
 * card says in words (STAKE_SHARED_NOTE) and does not compute: the phone
 * does not know that count.
 */
export function weightFor(stakedSkr: number | null | undefined): number {
  const s = typeof stakedSkr === 'number' && Number.isFinite(stakedSkr) && stakedSkr > 0 ? stakedSkr : 0;
  const w = 1 + Math.min(3, Math.log10(1 + s / 100));
  return Math.min(WEIGHT_CAP, Math.round(w * 100) / 100);
}

// ---- the read ----
export type StakeStatus = 'ok' | 'none' | 'unknown';

/** The worker's read shape (skr.js decodeWallet / UNKNOWN), plus when this device read it. */
export interface StakeRead {
  status: StakeStatus;
  /** Why a read is 'unknown'. A fixed vocabulary, never provider text or a URL. */
  reason?: string;
  slot: number;
  sharePrice: bigint;
  cooldownSeconds: bigint;
  minStakeAmount: bigint;
  stakedRaw: bigint;
  unstakingRaw: bigint;
  unstakeTimestamp: bigint;
  /** Unix seconds: the latest unstake start plus the cooldown. Null when nothing is unstaking. */
  withdrawableAt: number | null;
  /** Null only when the read is 'unknown'. */
  stakedSkr: number | null;
  unstakingSkr: number;
  weight: number;
  pools: Array<{ pool: string; pda: string; shares: bigint; stakedRaw: bigint }>;
  /** Device clock, ms. */
  checkedAt: number;
}

export function unknownRead(reason: string, checkedAt: number): StakeRead {
  return {
    status: 'unknown', reason, slot: 0, sharePrice: B0, cooldownSeconds: B0, minStakeAmount: B0,
    stakedRaw: B0, unstakingRaw: B0, unstakeTimestamp: B0, withdrawableAt: null,
    stakedSkr: null, unstakingSkr: 0, weight: 1, pools: [], checkedAt,
  };
}

export interface StakePlan {
  wallet: string;
  walletBytes: Uint8Array;
  pdas: Array<{ pool: string; poolBytes: Uint8Array; pda: string; bump: number }>;
}

/** The accounts one read asks for, or null when `wallet` is not a 32-byte base58 key. */
export function planStakeRead(wallet: string): StakePlan | null {
  if (typeof wallet !== 'string') return null;
  let walletBytes: Uint8Array;
  try {
    walletBytes = new PublicKey(wallet).toBytes();
  } catch {
    return null;
  }
  const pdas = GUARDIAN_POOLS.map((pool) => {
    const { pda, bump } = userStakePda(wallet, pool);
    return { pool, poolBytes: new PublicKey(pool).toBytes(), pda, bump };
  });
  return { wallet, walletBytes, pdas };
}

/** [StakeConfig, then one UserStake PDA per pinned pool]: the worker's order. */
export const planAddresses = (plan: StakePlan): string[] => [STAKE_CONFIG, ...plan.pdas.map((p) => p.pda)];

/**
 * Lamports sent to a PDA nobody staked at: owned by the System Program, no
 * data. Only the staking program can allocate or assign its PDA, so this is
 * "no position", as in the worker. Otherwise anyone could put any wallet's
 * card into the error state for about 0.00089 SOL.
 */
const isBareSystemAccount = (info: unknown): boolean => {
  const a = info as { owner?: unknown; data?: unknown } | null;
  return !!a && a.owner === SYSTEM_PROGRAM && Array.isArray(a.data) && a.data[0] === '';
};

/**
 * One getMultipleAccounts `result` ({ context: { slot }, value: [...] }) to
 * a StakeRead, with the worker's checks in the worker's order (readStakeMany
 * and decodeWallet): a short or malformed reply, then the config (owner,
 * length, discriminator, SKR mint, stake vault, a positive share price and
 * cooldown), then each position (none, or owner, length, discriminator, and
 * the bump, config, wallet and pool bytes it must carry). Pure; no network.
 */
export function decodeStakeReply(plan: StakePlan, result: unknown, checkedAt: number): StakeRead {
  const r = result as { value?: unknown; context?: { slot?: unknown } } | null | undefined;
  const values = Array.isArray(r?.value) ? (r!.value as unknown[]) : null;
  if (!values || values.length !== 1 + plan.pdas.length) return unknownRead('rpc: short reply', checkedAt);
  const slot = Number(r?.context?.slot ?? 0);

  const cfgA = assertAccount(values[0], 'config');
  if (!cfgA.ok) return unknownRead(cfgA.reason, checkedAt);
  const c = cfgA.data;
  if (!eq32(c, 41, MINT_BYTES) || !eq32(c, 73, VAULT_BYTES)) return unknownRead('config: semantic mismatch', checkedAt);
  const sharePrice = rdU128(c, 137);
  const cooldownSeconds = rdU64(c, 113);
  const minStakeAmount = rdU64(c, 105);
  if (sharePrice <= B0 || cooldownSeconds <= B0) return unknownRead('config: semantic mismatch', checkedAt);

  // Past the config, a failure keeps the reply's slot, as the worker's { ...decodeWallet(), slot } does.
  const failed = (reason: string): StakeRead => ({ ...unknownRead(reason, checkedAt), slot });
  let stakedRaw = B0;
  let unstakingRaw = B0;
  let unstakeTimestamp = B0;
  const pools: StakeRead['pools'] = [];
  for (let i = 0; i < plan.pdas.length; i++) {
    const p = plan.pdas[i];
    const entry = values[i + 1];
    // No position: null (no account) or a bare System account. Anything else goes through assertAccount.
    if (entry === null || isBareSystemAccount(entry)) {
      pools.push({ pool: p.pool, pda: p.pda, shares: B0, stakedRaw: B0 });
      continue;
    }
    const a = assertAccount(entry, 'user');
    if (!a.ok) return failed(a.reason);
    const u = a.data;
    if (u[8] !== p.bump || !eq32(u, 9, CONFIG_BYTES) || !eq32(u, 41, plan.walletBytes) || !eq32(u, 73, p.poolBytes)) {
      return failed('user: semantic mismatch');
    }
    const shares = rdU128(u, 105);
    const unstaking = rdU64(u, 153);
    const ts = rdI64(u, 161);
    const s = stakedRawOf(shares, sharePrice);
    stakedRaw += s;
    unstakingRaw += unstaking;
    if (unstaking > B0 && ts > unstakeTimestamp) unstakeTimestamp = ts;
    pools.push({ pool: p.pool, pda: p.pda, shares, stakedRaw: s });
  }
  const stakedSkr = toSkr(stakedRaw);
  return {
    status: stakedRaw > B0 || unstakingRaw > B0 ? 'ok' : 'none',
    slot, sharePrice, cooldownSeconds, minStakeAmount,
    stakedRaw, unstakingRaw, unstakeTimestamp,
    withdrawableAt: unstakingRaw > B0 ? Number(unstakeTimestamp + cooldownSeconds) : null,
    stakedSkr, unstakingSkr: toSkr(unstakingRaw), weight: weightFor(stakedSkr), pools, checkedAt,
  };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Everything readStakeOnce touches outside itself, injectable for Node tests. */
export interface SkrDeps {
  rpcUrl: string;
  fetch?: FetchLike;
  /** Per attempt. Default 10 s. */
  timeoutMs?: number;
  /** Before the one retry. Default 600 ms. */
  retryDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const RPC_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 600;

type Attempt = { ok: true; result: unknown } | { ok: false; reason: string; retry: boolean };

async function postOnce(deps: SkrDeps, body: string): Promise<Attempt> {
  const f: FetchLike = deps.fetch ?? ((u, i) => fetch(u, i));
  const c = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    c.abort();
  }, deps.timeoutMs ?? RPC_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await f(deps.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: c.signal,
      });
    } catch {
      // A timeout is not retried (the card would spin for 20 s); a dropped connection is, once.
      return timedOut ? { ok: false, reason: 'timeout', retry: false } : { ok: false, reason: 'network', retry: true };
    }
    if (res.status === 429 || res.status >= 500) return { ok: false, reason: `rpc ${res.status}`, retry: true };
    if (!res.ok) return { ok: false, reason: `rpc ${res.status}`, retry: false };
    let j: unknown;
    try {
      j = await res.json();
    } catch {
      return { ok: false, reason: timedOut ? 'timeout' : 'rpc: bad reply', retry: false };
    }
    const o = j as { error?: unknown; result?: unknown } | null;
    if (!o || typeof o !== 'object') return { ok: false, reason: 'rpc: bad reply', retry: false };
    // Provider text (o.error.message) can name the endpoint: it never leaves this function.
    if (o.error) return { ok: false, reason: 'rpc: error', retry: false };
    return { ok: true, result: o.result };
  } finally {
    clearTimeout(t);
  }
}

/**
 * The card's read: ONE getMultipleAccounts (base64, confirmed) for the
 * StakeConfig and this wallet's UserStake PDA, decoded by decodeStakeReply.
 * One retry on 429, 5xx or a dropped connection. Never throws and never
 * rejects: every failure is status 'unknown' with a reason from a fixed
 * vocabulary. Never getProgramAccounts, never a send.
 */
export async function readStakeOnce(deps: SkrDeps, wallet: string): Promise<StakeRead> {
  const now = deps.now ?? Date.now;
  try {
    const plan = planStakeRead(wallet);
    if (!plan) return unknownRead('wallet: bad key', now());
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts',
      params: [planAddresses(plan), { encoding: 'base64', commitment: 'confirmed' }],
    });
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let reason = 'network';
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await sleep(deps.retryDelayMs ?? RETRY_DELAY_MS);
      const a = await postOnce(deps, body);
      if (a.ok) return decodeStakeReply(plan, a.result, now());
      reason = a.reason;
      if (!a.retry) break;
    }
    return unknownRead(reason, now());
  } catch {
    return unknownRead('internal', now());
  }
}

// ---- the Profile card's sentences ----
export const STAKE_EXPLAINER =
  'Staked SKR raises your vouch weight, up to 4.00x. SKR in an unstake cooldown does not count.';
export const STAKE_SHARED_NOTE =
  'If this wallet vouches with more than one Genesis Token, its stake is split evenly between them.';
export const STAKE_NO_GENESIS = 'No Genesis Token in this wallet, so this stake gives no vouch weight.';
export const STAKE_READ_ERROR = "Couldn't read your stake right now.";

const commas = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Raw SKR (6 decimals) to "9,176.23": exact bigint math, rounded half up to 2 dp. No Intl. */
export function formatSkrRaw(raw: bigint): string {
  const r = raw > B0 ? raw : B0;
  const cents = (r + BigInt(5_000)) / BigInt(10_000);
  const hundred = BigInt(100);
  return `${commas((cents / hundred).toString())}.${(cents % hundred).toString().padStart(2, '0')}`;
}

/** "Withdrawable in 23h 12m" (minutes rounded up), or "Withdrawable now" once the cooldown has passed. */
export function cooldownLine(withdrawableAt: number, nowMs: number): string {
  const left = withdrawableAt * 1000 - nowMs;
  if (!(left > 0)) return 'Withdrawable now';
  const mins = Math.ceil(left / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `Withdrawable in ${[h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ')}`;
}

export interface StakeCardView {
  ok: boolean;
  /** "11,400.00 SKR" */
  amount: string | null;
  /** "Vouch weight 3.06x"; null when `noGenesis` (weightNote says why) or on an error. */
  weight: string | null;
  weightNote: string | null;
  /** "Unstaking 999.99 SKR", with `cooldown` under it. */
  unstaking: string | null;
  cooldown: string | null;
  source: string | null;
  error: string | null;
}

/**
 * What the card prints for one read. An 'unknown' read prints the error
 * sentence and nothing else: no amount, no weight, not even 1.00x.
 * `noGenesis`: the Genesis check came back "none in this wallet", so a vouch
 * from it is refused and the stake weighs nothing.
 */
export function stakeCardView(read: StakeRead, opts: { noGenesis: boolean; nowMs: number }): StakeCardView {
  if (read.status === 'unknown' || read.stakedSkr === null) {
    return {
      ok: false, amount: null, weight: null, weightNote: null, unstaking: null, cooldown: null,
      source: null, error: STAKE_READ_ERROR,
    };
  }
  const slot = Number.isSafeInteger(read.slot) && read.slot > 0 ? `, slot ${commas(String(read.slot))}` : '';
  const pending = read.unstakingRaw > B0;
  return {
    ok: true,
    amount: `${formatSkrRaw(read.stakedRaw)} SKR`,
    weight: opts.noGenesis ? null : `Vouch weight ${read.weight.toFixed(2)}x`,
    weightNote: opts.noGenesis ? STAKE_NO_GENESIS : null,
    unstaking: pending ? `Unstaking ${formatSkrRaw(read.unstakingRaw)} SKR` : null,
    cooldown: pending && read.withdrawableAt !== null ? cooldownLine(read.withdrawableAt, opts.nowMs) : null,
    source: `Read on chain from Solana Mobile's staking program${slot}.`,
    error: null,
  };
}
