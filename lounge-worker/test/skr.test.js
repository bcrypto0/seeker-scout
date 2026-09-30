// lounge-worker/test/skr.test.js. node:test, in-memory D1 (node:sqlite), fake RPC via fetch.
// SPEC-skr-final 7.2: decoders, PDA derivation, reads, the D1 cache and readStakeWeight,
// POST /vouch through the real router with the real reader, and the hourly re-weight cron
// (1.10: reweightVouches, checkDrift, index.js scheduled()). The POST /skr/read test joins
// with 1.11. Chain values come from the fixture's `expected` block (captured read-only
// 2026-09-30 at slot 451853888), never from literals of an older capture: share_price moves
// when rewards land.
// RPC_URL is 'http://fake.invalid/redacted' and globalThis.fetch is a shim: no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { base58, base64 } from '@scure/base';
import * as skr from '../src/skr.js';
import worker from '../src/index.js';
import { handleVouch } from '../src/vouch.js';
import { hasLoneSurrogate, sanitizeNote, sharedStakeWeight } from '../src/vouch-lib.js';
import { makeD1 } from './d1.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const fx = JSON.parse(readFileSync(here('./fixtures/skr_fixtures.json'), 'utf8'));
const X = fx.expected;
const MIGRATIONS = ['../schema.sql', '../migrations/001_vouches.sql', '../migrations/002_skr_cache.sql'].map(here);
const W = X.sampleUserStake.user;                            // GZaWCB..., owns 13MeAp... (bump 254)
const MISSING = fx.accounts.missingUserStake.user;           // Hgbea5..., PDA 5ZXR98... has no account
const SAMPLE_SKR = X.sampleUserStake.stakedSkr;              // 45,881.15968 at capture
const info = (a) => ({ owner: a.owner, lamports: a.lamports, data: [a.dataBase64, 'base64'], executable: false, rentEpoch: 0 });
const env = (opts) => ({ RPC_URL: 'http://fake.invalid/redacted', DB: makeD1(MIGRATIONS, opts) });
const count = (e, table) => e.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

// ---- fake RPC: counts hits, answers getMultipleAccounts from a map ----
let hits = 0;
let lastParams = null;
function serve(byAddr, { shortBy = 0 } = {}) {
  hits = 0;
  globalThis.fetch = async (_url, init) => {
    hits++;
    const { method, params } = JSON.parse(init.body);
    assert.equal(method, 'getMultipleAccounts');
    lastParams = params;
    const value = params[0].map((a) => byAddr.get(a) ?? null);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: fx.slot }, value: value.slice(0, value.length - shortBy) } }));
  };
}
function rpcDown() {
  hits = 0;
  globalThis.fetch = async () => { hits++; return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'down' } })); };
}
const cfgOnly = () => new Map([[fx.accounts.stakeConfig.address, info(fx.accounts.stakeConfig)]]);
const withFixture = () => { const m = cfgOnly(); m.set(fx.accounts.sampleUserStake.address, info(fx.accounts.sampleUserStake)); return m; };
/** The config account with bytes rewritten by `edit(bytes)`. */
function configWith(edit) {
  const b = new Uint8Array(base64.decode(fx.accounts.stakeConfig.dataBase64));
  edit(b);
  return { ...info(fx.accounts.stakeConfig), data: [base64.encode(b), 'base64'] };
}

// ---------------------------------------------------------------- constants, decoders and PDA
test('pinned constants equal the fixture capture', () => {
  assert.equal(skr.SKR_PROGRAM, fx.program.id);
  assert.equal(skr.PROGRAM_DATA, fx.program.programData);
  assert.equal(skr.PINNED_DEPLOY_SLOT, BigInt(fx.program.deploySlot));
  assert.equal(skr.STAKE_CONFIG, fx.accounts.stakeConfig.address);
  assert.deepEqual(skr.GUARDIAN_POOLS, [fx.accounts.guardianPool.address]);
  assert.equal(skr.SKR_MINT, X.stakeConfig.mint);
  assert.equal(skr.STAKE_VAULT, X.stakeConfig.stakeVault);
  assert.deepEqual([skr.SKR_WEIGHT_TTL_MS, skr.SKR_CACHE_TTL_MS], [60_000, 600_000]);
});

test('decoders match the fixture; stakedRawOf and sharesFor', () => {
  const c = skr.decodeStakeConfig(skr.assertAccount(info(fx.accounts.stakeConfig), 'config').data);
  for (const [k, v] of Object.entries(X.stakeConfig)) if (k !== 'address') assert.equal(String(c[k]), String(v), `config.${k}`);
  const p = skr.decodeGuardianPool(skr.assertAccount(info(fx.accounts.guardianPool), 'pool').data);
  for (const [k, v] of Object.entries(X.guardianPool)) if (k !== 'address') assert.equal(String(p[k]), String(v), `pool.${k}`);
  assert.equal(p.active, true); assert.equal(p.commissionBps, 0);
  const u = skr.decodeUserStake(skr.assertAccount(info(fx.accounts.sampleUserStake), 'user').data);
  for (const k of Object.keys(u)) assert.equal(String(u[k]), String(X.sampleUserStake[k]), `user.${k}`);
  assert.equal(u.user, W); assert.equal(u.shares, 40000000000n);
  const sp = BigInt(X.testValues.sharePrice);                                   // 1147028992 at capture
  assert.equal(c.sharePrice, sp);
  assert.equal(skr.stakedRawOf(u.shares, sp), BigInt(X.sampleUserStake.stakedRaw)); // 45881159680
  assert.equal(skr.toSkr(skr.stakedRawOf(u.shares, sp)), SAMPLE_SKR);
  assert.equal(skr.sharesFor(10_000_000_000n, 1136636001n), 8797891313n);         // pure math, spec literal
  assert.equal(skr.sharesFor(10_000_000_000n, sp), BigInt(X.testValues.sharesFor10kSkrAtLivePrice));
});

test('assertAccount fails closed on null, owner, length, discriminator, base64', () => {
  const g = fx.accounts.sampleUserStake;
  assert.equal(skr.assertAccount(null, 'user').ok, false);
  assert.equal(skr.assertAccount(info({ ...g, owner: '11111111111111111111111111111111' }), 'user').reason, 'user: wrong owner');
  assert.equal(skr.assertAccount(info({ ...g, dataBase64: g.dataBase64.slice(0, -8) }), 'user').ok, false);
  assert.equal(skr.assertAccount(info(g), 'config').ok, false);                   // right owner, wrong kind
  assert.equal(skr.assertAccount(info({ ...g, dataBase64: '!!not base64!!' }), 'user').ok, false);
  const flipped = new Uint8Array(base64.decode(g.dataBase64)); flipped[0] ^= 1;
  assert.equal(skr.assertAccount(info({ ...g, dataBase64: base64.encode(flipped) }), 'user').reason, 'user: discriminator');
});

test('userStakePda re-derives the live accounts (bumps 252 to 255) and the missing one', () => {
  const pool = base58.decode(skr.GUARDIAN_POOLS[0]);
  const a = skr.userStakePda(base58.decode(W), pool);
  assert.equal(base58.encode(a.address), '13MeApxaDr2tXPk3eAsfVmRjNznLobMXDGMxquTiZhq'); assert.equal(a.bump, 254);
  const b = skr.userStakePda(base58.decode(MISSING), pool);
  assert.equal(base58.encode(b.address), '5ZXR984KDHRG7KznwrV3k3sMcTkf2WcZrSFMSQrkrSx9'); assert.equal(b.bump, 255);
  for (const x of X.userStakes) {
    const r = skr.userStakePda(base58.decode(x.user), pool);
    assert.deepEqual([base58.encode(r.address), r.bump], [x.address, x.bump], x.label);
  }
});

test('decodeKey32 gives exactly what base58.decode gives for 32 bytes: random keys, leading zeros, extremes, random strings, bad characters', () => {
  const ref = (s) => {
    let b;
    try { b = base58.decode(s); } catch { return 'encoding'; }
    return b.length === 32 ? b : 'length';
  };
  const keys = [new Uint8Array(32), new Uint8Array(32).fill(255), Uint8Array.of(1, ...new Uint8Array(31))];
  for (let z = 0; z <= 32; z++) { const k = crypto.getRandomValues(new Uint8Array(32)); k.fill(0, 0, z); if (z < 32) k[z] ||= 1; keys.push(k); }
  for (let i = 0; i < 2000; i++) keys.push(crypto.getRandomValues(new Uint8Array(32)));
  for (const k of keys) assert.deepEqual(skr.decodeKey32(base58.encode(k)), k, base58.encode(k));
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let a = 12345;
  const r = () => { a = (Math.imul(a, 1103515245) + 12345) >>> 0; return a / 4294967296; };
  let got32 = 0;
  for (let i = 0; i < 20000; i++) {
    const len = 28 + Math.floor(r() * 20);
    const ones = r() < 0.3 ? Math.floor(r() * 34) : 0;
    const s = ('1'.repeat(ones) + Array.from({ length: len }, () => A[Math.floor(r() * 58)]).join('')).slice(0, Math.max(len, ones));
    const want = ref(s);
    if (want instanceof Uint8Array) got32 += 1;
    assert.deepEqual(skr.decodeKey32(s), want, s);
  }
  assert.ok(got32 > 1000, `random strings that are keys: ${got32}`);
  for (const s of ['', 'not-a-wallet', '0'.repeat(44), 'O'.repeat(40), 'I' + W.slice(1), 'l' + W.slice(1), W + ' ',
    W.slice(0, 20) + String.fromCharCode(0xe9) + W.slice(21), W.slice(0, 43) + String.fromCodePoint(0x1f680)]) {
    assert.deepEqual(skr.decodeKey32(s), ref(s), JSON.stringify(s));
  }
  for (const x of [undefined, null, 42, {}]) assert.equal(skr.decodeKey32(x), 'encoding');
  assert.deepEqual(skr.decodeKey32(W), base58.decode(W));
});

test('assertAccount decodes account data byte for byte as base64.decode does, and refuses non-string data', () => {
  for (const a of [fx.accounts.stakeConfig, fx.accounts.guardianPool, fx.accounts.sampleUserStake, ...fx.accounts.userStakes]) {
    const kind = a === fx.accounts.stakeConfig ? 'config' : a === fx.accounts.guardianPool ? 'pool' : 'user';
    const r = skr.assertAccount(info(a), kind);
    assert.ok(r.ok, a.address);
    assert.deepEqual(r.data, base64.decode(a.dataBase64), a.address);
  }
  const g = fx.accounts.sampleUserStake;
  assert.deepEqual(skr.assertAccount({ ...info(g), data: [12345, 'base64'] }, 'user'), { ok: false, reason: 'user: bad base64' });
  // Non-canonical base64 (the native decoders accept it, base64.decode does not): refused as 'bad base64'.
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const t = g.dataBase64;
  const loose = t.slice(0, -3) + A[A.indexOf(t.at(-3)) + 1] + '==';       // a stray bit under the padding
  for (const s of ['QR==', 'QUJ=', loose, t.replace(/=+$/, ''), ` ${t}`, `${t}\n`, t.slice(0, 40) + ' ' + t.slice(40)]) {
    assert.throws(() => base64.decode(s), JSON.stringify(s.slice(-6)));
    assert.deepEqual(skr.assertAccount({ ...info(g), data: [s, 'base64'] }, 'user'), { ok: false, reason: 'user: bad base64' }, JSON.stringify(s.slice(-6)));
  }
  // Seeded short strings: assertAccount says 'bad base64' exactly where base64.decode throws.
  let a = 0xb64;
  const r = () => { a = (Math.imul(a, 1103515245) + 12345) >>> 0; return a / 4294967296; };
  const pool = 'AQRgwZz09+/== \n';
  let bad = 0;
  for (let i = 0; i < 20000; i++) {
    const s = Array.from({ length: Math.floor(r() * 13) }, () => pool[Math.floor(r() * pool.length)]).join('');
    let throws = false;
    try { base64.decode(s); } catch { throws = true; }
    const got = skr.assertAccount({ ...info(g), data: [s, 'base64'] }, 'user');
    assert.equal(got.reason === 'user: bad base64', throws, JSON.stringify(s));
    if (throws) bad += 1;
  }
  assert.ok(bad > 1000 && bad < 19900, `bad ${bad}`);
});

// ---------------------------------------------------------------- reads
test('readStakeMany: 7 real UserStakes and 1 missing PDA in ONE call decode to the fixture values', async () => {
  const m = withFixture();
  for (const a of fx.accounts.userStakes) m.set(a.address, info(a));
  serve(m);
  const e = env();
  const all = [X.sampleUserStake, ...X.userStakes];
  const reads = await skr.readStakeMany(e, [...all.map((x) => x.user), MISSING]);
  assert.equal(hits, 1);
  assert.deepEqual(lastParams[1], { encoding: 'base64', commitment: 'confirmed' });
  assert.equal(lastParams[0].length, 1 + all.length + 1);
  assert.equal(lastParams[0][0], skr.STAKE_CONFIG);
  for (const x of all) {
    const s = reads.get(x.user);
    const tag = x.label ?? 'sample';
    assert.equal(s.status, 'ok', tag);
    assert.equal(s.stakedRaw, BigInt(x.stakedRaw), tag);
    assert.equal(s.stakedSkr, x.stakedSkr, tag);
    assert.equal(s.unstakingRaw, BigInt(x.unstakingAmount), tag);    // excluded from the weight
    assert.equal(s.unstakingSkr, x.unstakingSkr, tag);
    assert.equal(s.withdrawableAt, x.withdrawableAt === null ? null : Number(x.withdrawableAt), tag);
    assert.equal(s.weight, x.weight, tag);
    assert.equal(s.slot, fx.slot, tag);
    assert.equal(s.pools[0].pda, x.address, tag);
  }
  const n = reads.get(MISSING);
  assert.deepEqual([n.status, n.weight, n.stakedSkr, n.withdrawableAt], ['none', 1, 0, null]);
  assert.equal(count(e, 'wallet_pdas'), all.length + 1);
});

test('readStake: fixture wallet ok at 3.66; unknown wallet none at 1; PDA stored once, then reused', async () => {
  serve(withFixture());
  const e = env();
  const s = await skr.readStake(e, W);
  assert.equal(s.status, 'ok'); assert.equal(s.stakedRaw, BigInt(X.sampleUserStake.stakedRaw)); assert.equal(s.weight, 3.66);
  const n = await skr.readStake(e, MISSING);
  assert.deepEqual([n.status, n.weight, n.stakedSkr], ['none', 1, 0]);
  const rows = e.DB.raw.prepare('SELECT wallet, pda, bump FROM wallet_pdas ORDER BY bump').all();
  assert.deepEqual(rows.map((r) => [r.pda, r.bump]), [['13MeApxaDr2tXPk3eAsfVmRjNznLobMXDGMxquTiZhq', 254], ['5ZXR984KDHRG7KznwrV3k3sMcTkf2WcZrSFMSQrkrSx9', 255]]);
  const q0 = e.DB.stats.queries;
  const again = await skr.readStake(e, W);                           // stored row: SELECT only, no INSERT
  assert.equal(again.stakedRaw, s.stakedRaw);
  assert.equal(e.DB.stats.queries - q0, 1);
  assert.equal(count(e, 'wallet_pdas'), 2);
});

test('readStakeMany: a short reply is unknown for every wallet and caches nothing', async () => {
  serve(withFixture(), { shortBy: 1 });
  const e = env();
  const m = await skr.readStakeMany(e, [W, MISSING]);
  for (const s of m.values()) { assert.equal(s.status, 'unknown'); assert.equal(s.reason, 'rpc: short reply'); assert.equal(s.stakedSkr, null); }
  const r = await skr.readStakeCached(e, W);
  assert.equal(r.status, 'unknown');
  assert.equal(count(e, 'skr_cache'), 0);
});

test('RPC failure: unknown, stakedSkr null, reason never carries the URL', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed: http://fake.invalid/redacted'); };
  const s = await skr.readStake(env(), W);
  assert.equal(s.status, 'unknown'); assert.equal(s.stakedSkr, null);
  assert.ok(!/redacted|http/.test(s.reason), s.reason);
  // A provider error message that names the endpoint and its key: kept out of `reason` too.
  globalThis.fetch = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'bad key in http://fake.invalid/redacted?api-key=SEKRIT' } }));
  const p = await skr.readStakeWeight(env(), W);
  assert.deepEqual([p.stakedSkr, p.source, p.reason], [null, 'error', 'rpc: error']);
});

test('no position is only null or a bare System account (lamports sent to the PDA, 0 bytes): cached as none; false, 0, "" or a System account with data stay unknown', async () => {
  const pda = fx.accounts.sampleUserStake.address;                     // W's UserStake PDA
  for (const junk of [false, 0, '']) {
    const m = cfgOnly(); m.set(pda, junk);
    serve(m);
    const e = env();
    const s = await skr.readStakeWeight(e, W);
    assert.deepEqual([s.stakedSkr, s.source, s.reason], [null, 'error', 'user: missing'], JSON.stringify(junk));
    assert.equal(count(e, 'skr_cache'), 0, JSON.stringify(junk));
  }
  const bare = { owner: '11111111111111111111111111111111', lamports: 890880, data: ['', 'base64'], executable: false, rentEpoch: 0 };
  let m = cfgOnly(); m.set(pda, bare);
  serve(m);
  const e = env();
  const t = Date.parse('2026-09-30T12:00:00.000Z');
  const a = await skr.readStakeWeight(e, W, { now: () => t });
  assert.deepEqual([a.stakedSkr, a.source, hits], [0, 'chain', 1]);
  const row = e.DB.raw.prepare('SELECT status, staked_raw, weight FROM skr_cache WHERE wallet = ?').get(W);
  assert.deepEqual([row.status, row.staked_raw, row.weight], ['none', '0', 1]);
  const b = await skr.readStakeWeight(e, W, { now: () => t + 30_000 });  // served from the cache: no paid call
  assert.deepEqual([b.stakedSkr, b.source, hits], [0, 'cache', 1]);
  m = cfgOnly(); m.set(pda, { ...bare, data: [base64.encode(new Uint8Array(8)), 'base64'] });
  serve(m);
  const c = await skr.readStake(env(), W);
  assert.deepEqual([c.status, c.reason, c.weight], ['unknown', 'user: wrong owner', 1]);
});

test('fail closed: foreign position, wrong owner, config tampering, missing config, bad wallet; a wrong stored PDA cannot raise a weight', async () => {
  const cases = [];
  // The fixture position served at the missing wallet's PDA: its user bytes are GZaWCB..., not Hgbea5...
  let m = cfgOnly(); m.set(fx.accounts.missingUserStake.address, info(fx.accounts.sampleUserStake));
  serve(m); cases.push([await skr.readStake(env(), MISSING), 'user: semantic mismatch']);
  m = cfgOnly(); m.set(fx.accounts.sampleUserStake.address, info({ ...fx.accounts.sampleUserStake, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }));
  serve(m); cases.push([await skr.readStake(env(), W), 'user: wrong owner']);
  // StakeConfig whose mint field says the vault, and one whose share_price is 0.
  m = withFixture(); m.set(skr.STAKE_CONFIG, configWith((b) => b.set(base58.decode(skr.STAKE_VAULT), 41)));
  serve(m); cases.push([await skr.readStake(env(), W), 'config: semantic mismatch']);
  m = withFixture(); m.set(skr.STAKE_CONFIG, configWith((b) => b.fill(0, 137, 153)));
  serve(m); cases.push([await skr.readStake(env(), W), 'config: semantic mismatch']);
  m = withFixture(); m.delete(skr.STAKE_CONFIG);
  serve(m); cases.push([await skr.readStake(env(), W), 'config: missing']);
  rpcDown(); cases.push([await skr.readStake(env(), W), 'rpc: error']); // provider text never kept (safeReason)
  // A wallet_pdas row pointing another wallet at the 3.66x fixture account.
  serve(withFixture());
  const e = env();
  e.DB.raw.prepare('INSERT INTO wallet_pdas (wallet, pool, pda, bump) VALUES (?, ?, ?, 254)')
    .run(MISSING, skr.GUARDIAN_POOLS[0], fx.accounts.sampleUserStake.address);
  cases.push([await skr.readStake(e, MISSING), 'user: semantic mismatch']);
  for (const [s, reason] of cases) {
    assert.deepEqual([s.status, s.reason, s.stakedSkr, s.weight], ['unknown', reason, null, 1]);
  }
  // Nothing to read: no paid call at all.
  serve(withFixture());
  const bad = await skr.readStake(env(), 'not-a-wallet');
  assert.deepEqual([bad.status, bad.reason, hits], ['unknown', 'wallet: bad encoding', 0]);
  const short = await skr.readStake(env(), base58.encode(new Uint8Array(31).fill(5)));
  assert.deepEqual([short.status, short.reason, hits], ['unknown', 'wallet: bad length', 0]);
});

// ---------------------------------------------------------------- cache and the frozen interface
test('readStakeWeight: frozen shape without weight; 60 s default window; 10 min only when asked', async () => {
  serve(withFixture());
  const e = env();
  const t = Date.parse('2026-09-30T12:00:00.000Z');
  const w1 = await skr.readStakeWeight(e, W, { now: () => t });
  assert.deepEqual([w1.stakedSkr, w1.source, 'weight' in w1, hits], [SAMPLE_SKR, 'chain', false, 1]);
  assert.deepEqual(Object.keys(w1).sort(), ['checkedAt', 'slot', 'source', 'stakedSkr', 'unstakingSkr', 'withdrawableAt']);
  assert.equal(w1.checkedAt, new Date(t).toISOString());
  const row = e.DB.raw.prepare('SELECT * FROM skr_cache WHERE wallet = ?').get(W);
  assert.deepEqual([row.status, row.staked_raw, row.share_price, row.weight, row.slot],
    ['ok', X.sampleUserStake.stakedRaw, X.stakeConfig.sharePrice, 3.66, fx.slot]);
  const w2 = await skr.readStakeWeight(e, W, { now: () => t + 30_000 });           // 30 s old: cache
  assert.deepEqual([w2.stakedSkr, w2.source, hits], [SAMPLE_SKR, 'cache', 1]);
  const w3 = await skr.readStakeWeight(e, W, { now: () => t + 5 * 60_000 });        // 5 min old: chain again
  assert.deepEqual([w3.source, hits], ['chain', 2]);
  const w4 = await skr.readStakeWeight(e, W, { maxAgeMs: skr.SKR_CACHE_TTL_MS, now: () => t + 14 * 60_000 }); // 9 min old, /skr/read window
  assert.deepEqual([w4.source, hits], ['cache', 2]);
  rpcDown();
  const w5 = await skr.readStakeWeight(env(), W);
  assert.deepEqual([w5.stakedSkr, w5.source, w5.reason], [null, 'error', 'rpc: error']);
});

test('cache: unknown is never stored; a row from the future or an unreadable row is a miss', async () => {
  const e = env();
  rpcDown();
  const w = await skr.readStakeWeight(e, W);
  assert.deepEqual([w.stakedSkr, w.source], [null, 'error']);
  assert.equal(count(e, 'skr_cache'), 0);
  const t = Date.parse('2026-09-30T12:00:00.000Z');
  // A row that would weigh 4.00x, dated 10 minutes ahead: never served.
  e.DB.raw.prepare(`INSERT INTO skr_cache (wallet, status, staked_raw, unstaking_raw, unstake_ts, cooldown_seconds, share_price, weight, slot, checked_at)
    VALUES (?, 'ok', '999000000000', '0', 0, 172800, '1147028992', 4, 1, '2026-09-30T12:10:00.000Z')`).run(W);
  serve(withFixture());
  const f = await skr.readStakeWeight(e, W, { now: () => t });
  assert.deepEqual([f.stakedSkr, f.source, hits], [SAMPLE_SKR, 'chain', 1]);
  e.DB.raw.prepare("UPDATE skr_cache SET staked_raw = 'garbage'").run();
  const g = await skr.readStakeWeight(e, W, { now: () => t + 1000 });
  assert.deepEqual([g.stakedSkr, g.source, hits], [SAMPLE_SKR, 'chain', 2]);
  e.DB.raw.prepare("UPDATE skr_cache SET status = 'unknown'").run();
  const h = await skr.readStakeWeight(e, W, { now: () => t + 2000 });
  assert.deepEqual([h.source, hits], ['chain', 3]);
});

test('readStakeWeight never rejects: no DB, a DB that throws on every query, null options, a throwing clock', async () => {
  serve(withFixture());
  const noDb = await skr.readStakeWeight({ RPC_URL: 'http://fake.invalid/redacted' }, W);
  assert.deepEqual([noDb.stakedSkr, noDb.source], [SAMPLE_SKR, 'chain']);
  const broken = await skr.readStakeWeight(env({ failWhen: () => true }), W);
  assert.deepEqual([broken.stakedSkr, broken.source], [SAMPLE_SKR, 'chain']);
  const nullOpts = await skr.readStakeWeight(env(), W, null);
  assert.deepEqual([nullOpts.stakedSkr, nullOpts.source], [SAMPLE_SKR, 'chain']);
  const clock = await skr.readStakeWeight(env(), W, { now: () => { throw new Error('clock'); } });
  assert.deepEqual([clock.stakedSkr, clock.source, clock.reason], [null, 'error', 'internal']);
  assert.ok(Number.isFinite(Date.parse(clock.checkedAt)));
});

// ---------------------------------------------------------------- POST /vouch through the real router
// verifyFn is stubbed (index.js verifyGenesisSig has its own harness, test/integration.mjs); every
// fetch below is the stake read. parseVouchBody checks only the signature's length before verifyFn.
const SIG = (c) => c.repeat(88);
const MINT_A = base58.encode(new Uint8Array(32).fill(7));
const MINT_B = base58.encode(new Uint8Array(32).fill(9));
const MINT_C = base58.encode(new Uint8Array(32).fill(11));
const verifyOk = async () => ({ number: null, tier: null });
async function call(e, method, path, body) {
  const req = new Request(`https://w.test${path}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const r = await handleVouch(req, e, new URL(`https://w.test${path}`), verifyOk);
  return { status: r.status, body: await r.json() };
}
const vouchBody = (wallet, mint, pkg, sig) => ({
  wallet, mint, ts: new Date().toISOString(), signature: sig, package: pkg, verdict: 'works', tags: [], note: 'Fine on my Seeker.',
});
/** Any JSON key naming a weight, a stake or a weighted share: none may appear in a public body. */
const WEIGHTY = /"[a-z_]*(weight|staked|share)[a-z_]*":/;

test('POST /vouch: real stake from chain, cache for a second Genesis Token (re-stamps the wallet), 1.00x with staked_skr null when the read fails; public notes carry no weight', async () => {
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(String(s));
  try {
    serve(withFixture());
    const e = env();
    const r1 = await call(e, 'POST', '/vouch', vouchBody(W, MINT_A, 'x.place', SIG('1')));
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.deepEqual([r1.body.weight, r1.body.staked_skr, r1.body.weight_source, r1.body.mints_in_wallet, hits],
      [3.66, SAMPLE_SKR, 'chain', 1, 1]);

    e.DB.raw.exec('UPDATE vouch_members SET last_vouch_at = NULL');   // free the 10 s slot
    const r2 = await call(e, 'POST', '/vouch', vouchBody(W, MINT_B, 'y.place', SIG('2')));
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    const shared = sharedStakeWeight(SAMPLE_SKR, 2);                   // 3.36
    assert.deepEqual([r2.body.weight, r2.body.weight_source, r2.body.mints_in_wallet, hits], [shared, 'cache', 2, 1]);
    const rows = e.DB.raw.prepare('SELECT package, weight, staked_skr FROM vouches WHERE wallet = ? ORDER BY package').all(W);
    assert.deepEqual(rows.map((r) => [r.package, r.weight, r.staked_skr]), [['x.place', shared, SAMPLE_SKR], ['y.place', shared, SAMPLE_SKR]]);

    rpcDown();
    const r3 = await call(e, 'POST', '/vouch', vouchBody(MISSING, MINT_C, 'x.place', SIG('3')));
    assert.equal(r3.status, 200, JSON.stringify(r3.body));
    assert.deepEqual([r3.body.weight, r3.body.staked_skr, r3.body.weight_source, hits], [1, null, 'error', 1]);
    assert.equal(e.DB.raw.prepare('SELECT COUNT(*) AS n FROM skr_cache WHERE wallet = ?').get(MISSING).n, 0);

    const app = await call(e, 'GET', '/vouch/app/x.place');
    assert.equal(app.status, 200);
    assert.equal(app.body.recent.length, 2);
    for (const n of app.body.recent) assert.ok(!('weight' in n) && !('staked_skr' in n), JSON.stringify(n));
    // The app block is head counts only: its weighted sum (shared + 1 here) stays in SQL.
    assert.deepEqual([app.body.app.voices, app.body.app.works_voices], [2, 2]);
    assert.ok(!WEIGHTY.test(JSON.stringify(app.body)), JSON.stringify(app.body));
    for (const r of [r1, r2, r3]) assert.ok(!WEIGHTY.test(JSON.stringify(r.body.app)), JSON.stringify(r.body.app));
  } finally {
    console.log = orig;
  }
  const lines = logs.filter((l) => l.includes('"evt":"vouch"'));
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => JSON.parse(l).weight_source), ['chain', 'cache', 'error']);
  assert.ok(lines.every((l) => !/fake\.invalid|redacted|http/.test(l)), 'a log line carries the RPC URL');
});

test('POST /vouch: a failed stake read stamps only its own row; the wallet keeps its last good stamp, re-divided (lower only) when the mint is new to it', async () => {
  const orig = console.log;
  console.log = () => {};
  try {
    serve(withFixture());
    const e = env();
    // Free the 10 s slot and age the 60 s stake cache, so the next vouch reads the chain.
    const next = () => e.DB.raw.exec("UPDATE vouch_members SET last_vouch_at = NULL; UPDATE skr_cache SET checked_at = '2000-01-01T00:00:00.000Z'");
    const rowsOf = () => e.DB.raw.prepare('SELECT package, weight, staked_skr, weight_checked_at FROM vouches WHERE wallet = ? ORDER BY package').all(W)
      .map((r) => [r.package, r.weight, r.staked_skr]);
    const checkedAt = (pkg) => e.DB.raw.prepare('SELECT weight_checked_at AS t FROM vouches WHERE package = ?').get(pkg).t;
    const r1 = await call(e, 'POST', '/vouch', vouchBody(W, MINT_A, 'x.place', SIG('1')));
    assert.deepEqual([r1.status, r1.body.weight, r1.body.weight_source], [200, 3.66, 'chain'], JSON.stringify(r1.body));
    const good = checkedAt('x.place');

    // Same Genesis Token, another package, the RPC fails: n stays 1, x.place keeps 3.66.
    next(); rpcDown();
    const r2 = await call(e, 'POST', '/vouch', vouchBody(W, MINT_A, 'y.place', SIG('2')));
    assert.deepEqual([r2.status, r2.body.weight, r2.body.staked_skr, r2.body.weight_source, r2.body.mints_in_wallet],
      [200, 1, null, 'error', 1], JSON.stringify(r2.body));
    assert.deepEqual(rowsOf(), [['x.place', 3.66, SAMPLE_SKR], ['y.place', 1, null]]);
    assert.equal(checkedAt('x.place'), good);

    // A second Genesis Token, the RPC still failing: n grows to 2, so x.place is re-divided
    // from its stored stake (3.66 -> 3.36); the failed rows stay 1.00x and nothing rises.
    next();
    const shared = sharedStakeWeight(SAMPLE_SKR, 2);
    const r3 = await call(e, 'POST', '/vouch', vouchBody(W, MINT_B, 'z.place', SIG('3')));
    assert.deepEqual([r3.status, r3.body.weight, r3.body.weight_source, r3.body.mints_in_wallet], [200, 1, 'error', 2], JSON.stringify(r3.body));
    assert.deepEqual(rowsOf(), [['x.place', shared, SAMPLE_SKR], ['y.place', 1, null], ['z.place', 1, null]]);

    // The RPC is back: one clean read re-stamps every row of the wallet, the failed ones too.
    next(); serve(withFixture());
    const r4 = await call(e, 'POST', '/vouch', vouchBody(W, MINT_B, 'w.place', SIG('4')));
    assert.deepEqual([r4.status, r4.body.weight, r4.body.weight_source, r4.body.mints_in_wallet], [200, shared, 'chain', 2], JSON.stringify(r4.body));
    assert.deepEqual(rowsOf(), ['w.place', 'x.place', 'y.place', 'z.place'].map((p) => [p, shared, SAMPLE_SKR]));
  } finally {
    console.log = orig;
  }
});

test('POST /vouch: a clean read refreshes staked_skr on every row even when the 2-decimal weight is unchanged; a replay returns the fresh stake', async () => {
  const orig = console.log;
  console.log = () => {};
  try {
    serve(withFixture());
    const e = env();
    const b1 = vouchBody(W, MINT_A, 'x.place', SIG('1'));
    assert.equal((await call(e, 'POST', '/vouch', b1)).body.staked_skr, SAMPLE_SKR);
    e.DB.raw.exec("UPDATE vouch_members SET last_vouch_at = NULL; UPDATE skr_cache SET checked_at = '2000-01-01T00:00:00.000Z'");
    // Rewards landed: share_price 0.5 % higher, so the stake grows while the weight stays 3.66.
    const sp = (BigInt(X.testValues.sharePrice) * 1005n) / 1000n;
    const m = withFixture();
    m.set(skr.STAKE_CONFIG, configWith((b) => { let v = sp; for (let i = 0; i < 16; i++) { b[137 + i] = Number(v & 0xffn); v >>= 8n; } }));
    serve(m);
    const fresh = skr.toSkr(skr.stakedRawOf(40000000000n, sp));
    assert.notEqual(fresh, SAMPLE_SKR);
    const r2 = await call(e, 'POST', '/vouch', vouchBody(W, MINT_A, 'y.place', SIG('2')));
    assert.deepEqual([r2.status, r2.body.weight, r2.body.staked_skr, r2.body.weight_source], [200, 3.66, fresh, 'chain'], JSON.stringify(r2.body));
    const rows = e.DB.raw.prepare('SELECT package, weight, staked_skr, weight_checked_at FROM vouches ORDER BY package').all();
    assert.deepEqual(rows.map((r) => [r.package, r.weight, r.staked_skr]), [['x.place', 3.66, fresh], ['y.place', 3.66, fresh]]);
    assert.equal(rows[0].weight_checked_at, rows[1].weight_checked_at);
    const replay = await call(e, 'POST', '/vouch', b1);
    assert.deepEqual([replay.status, replay.body.replayed, replay.body.weight_source, replay.body.staked_skr], [200, true, 'stored', fresh]);
    assert.ok(!WEIGHTY.test(JSON.stringify(replay.body.app)), JSON.stringify(replay.body.app));
  } finally {
    console.log = orig;
  }
});

test('public bodies carry no weighted total, yet /vouch/aggregate and /vouch/top still order by weight', async () => {
  const orig = console.log;
  console.log = () => {};
  try {
    serve(withFixture());
    const e = env();
    // One voice each: a.place at 1.00x (no stake account), b.place at 3.66x (the fixture stake).
    // Same voices, same week, so without the weight the package name would put a.place first.
    const ra = await call(e, 'POST', '/vouch', vouchBody(MISSING, MINT_C, 'a.place', SIG('5')));
    const rb = await call(e, 'POST', '/vouch', vouchBody(W, MINT_A, 'b.place', SIG('6')));
    assert.deepEqual([ra.status, ra.body.weight, rb.status, rb.body.weight], [200, 1, 200, 3.66]);
    // The signer's own answer keeps its own weight and stake; its app block does not.
    assert.deepEqual([rb.body.vouch.weight, rb.body.staked_skr, rb.body.weight_source], [3.66, SAMPLE_SKR, 'chain']);
    for (const r of [ra, rb]) assert.ok(!WEIGHTY.test(JSON.stringify(r.body.app)), JSON.stringify(r.body.app));
    const stored = e.DB.raw.prepare('SELECT package, weight FROM vouches ORDER BY package').all();
    assert.deepEqual(stored.map((r) => [r.package, r.weight]), [['a.place', 1], ['b.place', 3.66]]); // weights still stored

    const agg = await call(e, 'GET', '/vouch/aggregate');
    assert.equal(agg.status, 200);
    assert.deepEqual(agg.body.apps.map((a) => a.package), ['b.place', 'a.place']);
    assert.deepEqual(agg.body.apps.map((a) => a.voices), [1, 1]);
    assert.ok(!WEIGHTY.test(JSON.stringify(agg.body)), JSON.stringify(agg.body));

    const top = await call(e, 'GET', '/vouch/top');
    assert.equal(top.status, 200);
    assert.deepEqual(top.body.apps.map((a) => [a.package, a.voices_week]), [['b.place', 1], ['a.place', 1]]);
    assert.ok(!WEIGHTY.test(JSON.stringify(top.body)), JSON.stringify(top.body));

    for (const pkg of ['a.place', 'b.place']) {
      const app = await call(e, 'GET', `/vouch/app/${pkg}`);
      assert.equal(app.status, 200);
      assert.deepEqual([app.body.app.voices, app.body.recent.length], [1, 1]);
      assert.ok(!WEIGHTY.test(JSON.stringify(app.body)), JSON.stringify(app.body));
    }
  } finally {
    console.log = orig;
  }
});

// ---------------------------------------------------------------- hourly re-weight cron (1.10)
const SP = BigInt(X.testValues.sharePrice);
const skrOf = (shares) => skr.toSkr(skr.stakedRawOf(shares, SP));
const wU64 = (b, o, v) => { for (let i = 0; i < 8; i++) { b[o + i] = Number(v & 0xffn); v >>= 8n; } };
/** A UserStake account for any wallet: the fixture bytes with bump, user, shares and the unstake fields rewritten. */
function userStakeInfo(wallet, { shares, unstaking = 0n, unstakeTs = 0n }) {
  const b = new Uint8Array(base64.decode(fx.accounts.sampleUserStake.dataBase64));
  const { bump } = skr.userStakePda(base58.decode(wallet), base58.decode(skr.GUARDIAN_POOLS[0]));
  b[8] = bump; b.set(base58.decode(wallet), 41);
  wU64(b, 105, shares & 0xffffffffffffffffn); wU64(b, 113, shares >> 64n);
  wU64(b, 153, unstaking); wU64(b, 161, BigInt.asUintN(64, unstakeTs));
  return { owner: skr.SKR_PROGRAM, lamports: fx.accounts.sampleUserStake.lamports, data: [base64.encode(b), 'base64'], executable: false, rentEpoch: 0 };
}
const pdaOf = (wallet) => base58.encode(skr.userStakePda(base58.decode(wallet), base58.decode(skr.GUARDIAN_POOLS[0])).address);
const withStake = (wallet, opts, m = cfgOnly()) => { m.set(pdaOf(wallet), userStakeInfo(wallet, opts)); return m; };
const withPool = (m = cfgOnly(), edit = null) => {
  const b = new Uint8Array(base64.decode(fx.accounts.guardianPool.dataBase64));
  if (edit) edit(b);
  m.set(fx.accounts.guardianPool.address, { ...info(fx.accounts.guardianPool), data: [base64.encode(b), 'base64'] });
  return m;
};
const randomWallet = () => base58.encode(crypto.getRandomValues(new Uint8Array(32)));
const tally = (e, week) => e.DB.raw.prepare('SELECT ROUND(SUM(weight), 2) AS t FROM votes WHERE week = ?').get(week).t;
const TS0 = '2026-09-30T10:00:00.000Z';
function addVote(e, { week, mint, wallet = W, weight, staked = SAMPLE_SKR }) {
  e.DB.raw.prepare(`INSERT INTO votes (week, genesis_mint, wallet, package, weight, staked_skr, signature, signed_ts, created_at, updated_at)
    VALUES (?, ?, ?, 'x.place', ?, ?, 'sig', ?, ?, ?)`).run(week, mint, wallet, weight, staked, TS0, TS0, TS0);
}
function addVouch(e, { mint, wallet = W, pkg, weight = 1, staked = null, checkedAt = null }) {
  e.DB.raw.prepare(`INSERT INTO vouches (genesis_mint, wallet, package, verdict, signature, signed_ts, weight, staked_skr, weight_checked_at, created_at, updated_at)
    VALUES (?, ?, ?, 'works', 'sig', ?, ?, ?, ?, ?, ?)`).run(mint, wallet, pkg, TS0, weight, staked, checkedAt, TS0, TS0);
}
const vouchRows = (e, wallet = W) => e.DB.raw.prepare('SELECT package, weight, staked_skr FROM vouches WHERE wallet = ? ORDER BY package').all(wallet)
  .map((r) => [r.package, r.weight, r.staked_skr]);
const checkedAts = (e, wallet = W) => e.DB.raw.prepare('SELECT weight_checked_at AS t FROM vouches WHERE wallet = ? ORDER BY package').all(wallet).map((r) => r.t);
const snapshot = (e) => JSON.stringify([
  e.DB.raw.prepare('SELECT * FROM vouches ORDER BY id').all(),
  e.DB.raw.prepare('SELECT * FROM votes ORDER BY week, genesis_mint').all(),
  e.DB.raw.prepare('SELECT * FROM skr_cache ORDER BY wallet').all(),
]);
/** One tick at `iso`, console.log captured: { sum, logs }. */
async function tick(e, iso, opts = {}) {
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(String(s));
  try {
    return { sum: await skr.reweightVouches(e, { now: new Date(iso), ...opts }), logs };
  } finally {
    console.log = orig;
  }
}
const WED = '2026-09-30T12:07:00.000Z';                              // a Wednesday of 2026-W40
const hourAfter = (iso, h) => new Date(Date.parse(iso) + h * 3_600_000).toISOString();
/**
 * serve(byAddr), except that the first call (the tick's getMultipleAccounts) takes its reply, then
 * runs `during()` before returning it: a write that lands while the tick's read is in flight. Calls
 * made inside `during()` are answered from byAddr as it is then, so `during()` may edit it first.
 */
function serveRacing(byAddr, during) {
  serve(byAddr);
  const inner = globalThis.fetch;
  let fired = false;
  globalThis.fetch = async (url, init) => {
    const reply = await inner(url, init);
    if (!fired) { fired = true; await during(); }
    return reply;
  };
}

test('cron: flash stake. Vote at 3.66, stake gone, the next tick makes the tally 1.00 (one RPC call, a start line and one summary line)', async () => {
  const e = env();
  addVote(e, { week: '2026-W40', mint: 'M1', weight: 3.66 });
  serve(cfgOnly());                                                   // no UserStake: status none, 0 SKR
  const { sum, logs } = await tick(e, WED);
  assert.equal(tally(e, '2026-W40'), 1);
  assert.equal(e.DB.raw.prepare('SELECT staked_skr FROM votes').get().staked_skr, 0);
  assert.equal(hits, 1);
  assert.deepEqual([sum.selected, sum.read, sum.ok, sum.unknown, sum.chunks, sum.vote_rows, sum.vouch_rows, sum.cache_rows, sum.closed_week],
    [1, 1, 1, 0, 1, 1, 0, 1, null]);
  assert.deepEqual(logs.map((l) => JSON.parse(l)), [{ evt: 'reweight', phase: 'start' }, sum]);
});

test('cron: votes never go UP, and an unchanged stake writes no vote row', async () => {
  const e = env();
  addVote(e, { week: '2026-W40', mint: 'M1', weight: 1, staked: 0 });            // voted before staking
  addVote(e, { week: '2026-W40', mint: 'M2', wallet: MISSING, weight: 1, staked: 0 });
  serve(withFixture());                                                // W now holds the 3.66x stake
  const { sum } = await tick(e, WED);
  assert.equal(tally(e, '2026-W40'), 2);
  assert.deepEqual(e.DB.raw.prepare('SELECT weight, staked_skr FROM votes ORDER BY genesis_mint').all().map((r) => [r.weight, r.staked_skr]), [[1, 0], [1, 0]]);
  assert.deepEqual([sum.ok, sum.vote_rows, sum.cache_rows], [2, 0, 2]);
});

test('cron: per-wallet division. Two Seekers behind one stake stay at 3.36 each, then fall to 1.00', async () => {
  const e = env();
  const shared = sharedStakeWeight(SAMPLE_SKR, 2);
  assert.equal(shared, X.testValues.sampleWeightSharedBy2);          // 3.36
  addVote(e, { week: '2026-W40', mint: 'M1', weight: shared });
  addVote(e, { week: '2026-W40', mint: 'M2', weight: shared });
  serve(withFixture());
  let { sum } = await tick(e, WED);
  assert.deepEqual([tally(e, '2026-W40'), sum.vote_rows, hits], [6.72, 0, 1]);
  serve(cfgOnly());
  ({ sum } = await tick(e, hourAfter(WED, 1)));
  assert.deepEqual([tally(e, '2026-W40'), sum.vote_rows, hits], [2, 2, 1]);
});

test('cron: vouches follow the stake both ways with the division POST /vouch stores; a failed read moves nothing', async () => {
  const orig = console.log;
  console.log = () => {};
  try {
    serve(withFixture());
    const e = env();
    const shared = sharedStakeWeight(SAMPLE_SKR, 2);
    // Two Genesis Tokens in one wallet vouch through the real router: n = 2, both rows 3.36.
    let r = await call(e, 'POST', '/vouch', vouchBody(W, MINT_A, 'x.place', SIG('1')));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    e.DB.raw.exec('UPDATE vouch_members SET last_vouch_at = NULL');
    r = await call(e, 'POST', '/vouch', vouchBody(W, MINT_B, 'y.place', SIG('2')));
    assert.deepEqual([r.status, r.body.weight, r.body.mints_in_wallet], [200, shared, 2], JSON.stringify(r.body));

    // Same stake: the cron's divisor and weight equal the router's, so no vouch row is written.
    // The ticks run from an hour after the real clock: the router stamps real time, and a tick
    // leaves rows stamped after its scheduled time alone (the race tests below).
    const T0 = hourAfter(new Date().toISOString(), 1);
    serve(withFixture());
    let { sum } = await tick(e, T0);
    assert.deepEqual([sum.ok, sum.vouch_rows, sum.cache_rows, hits], [1, 0, 1, 1]);
    assert.deepEqual(vouchRows(e), [['x.place', shared, SAMPLE_SKR], ['y.place', shared, SAMPLE_SKR]]);

    // The stake doubles: both rows go UP, stamped at the tick's time.
    const up = skrOf(80000000000n);
    const upW = sharedStakeWeight(up, 2);
    assert.ok(upW > shared);
    serve(withStake(W, { shares: 80000000000n }));
    const t1 = hourAfter(T0, 1);
    ({ sum } = await tick(e, t1));
    assert.deepEqual(vouchRows(e), [['x.place', upW, up], ['y.place', upW, up]]);
    assert.deepEqual([sum.vouch_rows, checkedAts(e)], [2, [t1, t1]]);

    // POST /vouch reading the same stake stamps the same weight and re-stamps no other row.
    e.DB.raw.exec("UPDATE vouch_members SET last_vouch_at = NULL; UPDATE skr_cache SET checked_at = '2000-01-01T00:00:00.000Z'");
    r = await call(e, 'POST', '/vouch', vouchBody(W, MINT_A, 'z.place', SIG('3')));
    assert.deepEqual([r.status, r.body.weight, r.body.staked_skr, r.body.weight_source, r.body.mints_in_wallet], [200, upW, up, 'chain', 2], JSON.stringify(r.body));
    assert.deepEqual(checkedAts(e).slice(0, 2), [t1, t1]);

    // The RPC fails: weights, stakes, stamps and the cache stay exactly as they were.
    const before = snapshot(e);
    rpcDown();
    ({ sum } = await tick(e, hourAfter(T0, 2)));
    assert.equal(snapshot(e), before);
    assert.deepEqual([sum.ok, sum.unknown, sum.vouch_rows, sum.cache_rows, hits], [0, 1, 0, 0, 1]);

    // The stake is gone: every row falls to 1.00 with staked_skr 0.
    serve(cfgOnly());
    ({ sum } = await tick(e, hourAfter(T0, 3)));
    assert.deepEqual(vouchRows(e), [['x.place', 1, 0], ['y.place', 1, 0], ['z.place', 1, 0]]);
    assert.equal(sum.vouch_rows, 3);
  } finally {
    console.log = orig;
  }
});

test('cron race: a POST /vouch with a second Genesis Token lands while the tick reads; the tick does not undo its division (the divisor changed)', async () => {
  const orig = console.log;
  console.log = () => {};
  let r2;
  try {
    serve(withFixture());
    const e = env();
    assert.equal((await call(e, 'POST', '/vouch', vouchBody(W, MINT_A, 'x.place', SIG('1')))).body.weight, 3.66);
    const shared = sharedStakeWeight(SAMPLE_SKR, 2);
    serveRacing(withFixture(), async () => {
      e.DB.raw.exec('UPDATE vouch_members SET last_vouch_at = NULL');
      r2 = await call(e, 'POST', '/vouch', vouchBody(W, MINT_B, 'y.place', SIG('2')));
    });
    const T = new Date().toISOString();                                 // the tick selected n_vouch = 1
    console.log = orig;
    const { sum } = await tick(e, T);
    assert.deepEqual([r2.status, r2.body.weight, r2.body.mints_in_wallet], [200, shared, 2], JSON.stringify(r2.body));
    assert.deepEqual(vouchRows(e), [['x.place', shared, SAMPLE_SKR], ['y.place', shared, SAMPLE_SKR]]);
    assert.deepEqual([sum.ok, sum.vouch_rows], [1, 0]);
    // The next tick selects n_vouch = 2: same weights, nothing to write.
    serve(withFixture());
    const next = await tick(e, hourAfter(T, 1));
    assert.deepEqual([next.sum.ok, next.sum.vouch_rows], [1, 0]);
    assert.deepEqual(vouchRows(e), [['x.place', shared, SAMPLE_SKR], ['y.place', shared, SAMPLE_SKR]]);
  } finally {
    console.log = orig;
  }
});

test('cron race: the owner unstakes and vouches while the tick reads the old stake; the tick keeps the newer stamp and the newer cache row', async () => {
  const orig = console.log;
  console.log = () => {};
  let r2;
  try {
    serve(withFixture());
    const e = env();
    assert.equal((await call(e, 'POST', '/vouch', vouchBody(W, MINT_A, 'x.place', SIG('1')))).body.weight, 3.66);
    const m = withFixture();
    serveRacing(m, async () => {
      m.delete(fx.accounts.sampleUserStake.address);                     // unstaked after the tick's read
      e.DB.raw.exec("UPDATE vouch_members SET last_vouch_at = NULL; UPDATE skr_cache SET checked_at = '2000-01-01T00:00:00.000Z'");
      await new Promise((r) => setTimeout(r, 5));                        // the POST reads after the tick's scheduled time
      r2 = await call(e, 'POST', '/vouch', vouchBody(W, MINT_A, 'y.place', SIG('2')));
    });
    const T = new Date().toISOString();
    console.log = orig;
    const { sum } = await tick(e, T);
    assert.deepEqual([r2.status, r2.body.weight, r2.body.staked_skr, r2.body.weight_source], [200, 1, 0, 'chain'], JSON.stringify(r2.body));
    assert.deepEqual(vouchRows(e), [['x.place', 1, 0], ['y.place', 1, 0]]);
    const stamps = checkedAts(e);
    assert.ok(stamps[0] === stamps[1] && stamps[0] > T, JSON.stringify([T, stamps]));
    const c = e.DB.raw.prepare('SELECT status, staked_raw, checked_at FROM skr_cache WHERE wallet = ?').get(W);
    assert.deepEqual([c.status, c.staked_raw, c.checked_at], ['none', '0', stamps[0]]);
    assert.deepEqual([sum.ok, sum.vouch_rows, sum.cache_rows], [1, 0, 0]);
  } finally {
    console.log = orig;
  }
});

test('cron race: a vote written while the tick reads is not demoted by the older read, and a wallet whose vote divisor changed is left for the next tick', async () => {
  const e = env();
  const W2 = randomWallet();
  addVote(e, { week: '2026-W40', mint: 'M1', weight: 1, staked: 0 });              // W voted before staking
  addVote(e, { week: '2026-W40', mint: 'M3', wallet: W2, weight: 2, staked: 300 }); // W2: nothing staked now
  const later = new Date(Date.parse(WED) + 1000).toISOString();
  serveRacing(cfgOnly(), async () => {
    // W stakes and re-votes (the tick's read is older: no stake); W2 votes with a second Genesis Token.
    e.DB.raw.prepare("UPDATE votes SET weight = 3.66, staked_skr = ?, updated_at = ? WHERE genesis_mint = 'M1'").run(SAMPLE_SKR, later);
    e.DB.raw.prepare(`INSERT INTO votes (week, genesis_mint, wallet, package, weight, staked_skr, signature, signed_ts, created_at, updated_at)
      VALUES ('2026-W40', 'M4', ?, 'x.place', 1, 0, 'sig', ?, ?, ?)`).run(W2, later, later, later);
  });
  const { sum } = await tick(e, WED);
  const votes = () => e.DB.raw.prepare('SELECT genesis_mint, weight FROM votes ORDER BY genesis_mint').all().map((r) => [r.genesis_mint, r.weight]);
  assert.deepEqual(votes(), [['M1', 3.66], ['M3', 2], ['M4', 1]]);
  assert.deepEqual([sum.ok, sum.vote_rows], [2, 0]);
  // An hour later the tick reads W's stake (3.66 stands) and selects W2 with its divisor of 2, so
  // W2's 2.00 vote falls to 1.00.
  serve(withFixture());
  const next = await tick(e, hourAfter(WED, 1));
  assert.deepEqual(votes(), [['M1', 3.66], ['M3', 1], ['M4', 1]]);
  assert.equal(next.sum.vote_rows, 1);
});

test('cron: a failed read for one wallet leaves its rows as they were while the rest of the chunk is re-stamped', async () => {
  const e = env();
  addVouch(e, { mint: 'M1', pkg: 'x.place', weight: 1, staked: 0 });                        // W: rises to 3.66
  addVouch(e, { mint: 'M2', wallet: MISSING, pkg: 'x.place', weight: 2.5, staked: 1500 });
  addVote(e, { week: '2026-W40', mint: 'M2', wallet: MISSING, weight: 2.5, staked: 1500 });
  const m = withFixture();
  m.set(fx.accounts.missingUserStake.address, info(fx.accounts.sampleUserStake));        // W's position at MISSING's PDA
  serve(m);
  const { sum } = await tick(e, WED);
  assert.deepEqual(vouchRows(e), [['x.place', 3.66, SAMPLE_SKR]]);
  assert.deepEqual(vouchRows(e, MISSING), [['x.place', 2.5, 1500]]);
  assert.equal(tally(e, '2026-W40'), 2.5);
  assert.equal(e.DB.raw.prepare('SELECT COUNT(*) AS n FROM skr_cache WHERE wallet = ?').get(MISSING).n, 0);
  assert.deepEqual([sum.read, sum.ok, sum.unknown, sum.chunks, hits], [2, 1, 1, 1, 1]);
});

test('cron: closed-week grace. Inside 8 h of the close an unstake begun before it demotes the closed week, one begun after it does not; this week demotes either way; from 08:00Z the closed week is frozen', async () => {
  const mon = '2026-10-05T03:07:00.000Z';                               // Monday of 2026-W41; W40 closed at 00:00Z
  const before = BigInt(Date.parse('2026-10-04T23:30:00.000Z') / 1000);
  const after = BigInt(Date.parse('2026-10-05T01:00:00.000Z') / 1000);
  const unstaked = (ts) => withStake(W, { shares: 0n, unstaking: BigInt(X.sampleUserStake.stakedRaw), unstakeTs: ts });
  for (const [ts, expectClosed] of [[before, 1], [after, 3.66]]) {
    const e = env();
    addVote(e, { week: '2026-W40', mint: 'M1', weight: 3.66 });
    addVote(e, { week: '2026-W41', mint: 'M1', weight: 3.66 });
    serve(unstaked(ts));
    const { sum } = await tick(e, mon);
    assert.equal(sum.closed_week, '2026-W40');
    assert.equal(tally(e, '2026-W40'), expectClosed, `unstake at ${ts}`);
    assert.equal(tally(e, '2026-W41'), 1, 'this week has no grace');
  }
  const e = env();
  addVote(e, { week: '2026-W40', mint: 'M1', weight: 3.66 });
  serve(unstaked(before));
  const { sum } = await tick(e, '2026-10-05T08:00:00.000Z');
  assert.deepEqual([sum.closed_week, sum.selected, hits, tally(e, '2026-W40')], [null, 0, 0, 3.66]);
});

test('cron: a short reply demotes nothing, re-stamps nothing and caches nothing', async () => {
  const e = env();
  addVote(e, { week: '2026-W40', mint: 'M1', weight: 3.66 });
  addVouch(e, { mint: 'M1', pkg: 'x.place', weight: 3.66, staked: SAMPLE_SKR, checkedAt: TS0 });
  serve(cfgOnly(), { shortBy: 1 });
  const before = snapshot(e);
  const { sum } = await tick(e, WED);
  assert.equal(snapshot(e), before);
  assert.equal(tally(e, '2026-W40'), 3.66);
  assert.equal(count(e, 'skr_cache'), 0);
  assert.deepEqual([sum.ok, sum.unknown, sum.vote_rows, sum.vouch_rows, sum.cache_rows, hits], [0, 1, 0, 0, 0, 1]);
});

test('cron: the switch read fails CLOSED on a D1 error and skr_read_enabled off (any value but 1) skips the tick, both with zero RPC calls; a D1 error on the selection or the write skips it too', async () => {
  serve(withFixture());
  const a = await tick(env({ failWhen: (sql) => sql.includes('settings') }), WED);
  assert.equal(a.sum.skipped, 'settings unavailable');
  for (const v of ['0', 'false']) {
    const e = env();
    e.DB.raw.prepare("UPDATE settings SET value = ? WHERE key = 'skr_read_enabled'").run(v);
    addVote(e, { week: '2026-W40', mint: 'M1', weight: 3.66 });
    const b = await tick(e, WED);
    assert.deepEqual([b.sum.skipped, tally(e, '2026-W40')], ['disabled', 3.66], v);
  }
  const c = await tick(env({ failWhen: (sql) => sql.includes('WITH sel') }), WED);
  assert.equal(c.sum.skipped, 'storage error');
  assert.equal(hits, 0);
  for (const s of [a, c]) assert.equal(s.logs.length, 2);
  // The batch fails: it rolls back, so the vote keeps 3.66 and nothing is cached.
  const e = env({ failWhen: (sql) => sql.startsWith('INSERT INTO skr_cache') });
  addVote(e, { week: '2026-W40', mint: 'M1', weight: 3.66 });
  serve(cfgOnly());
  const d = await tick(e, WED);
  assert.deepEqual([d.sum.skipped, tally(e, '2026-W40'), count(e, 'skr_cache')], ['write failed', 3.66, 0]);
  // A missing settings row reads as on (settingOn), as GET /flags reads it.
  const f = env();
  f.DB.raw.exec("DELETE FROM settings WHERE key = 'skr_read_enabled'");
  addVote(f, { week: '2026-W40', mint: 'M1', weight: 3.66 });
  serve(cfgOnly());
  const g = await tick(f, WED);
  assert.deepEqual([g.sum.skipped, g.sum.ok, tally(f, '2026-W40'), hits], [undefined, 1, 1, 1]);
});

test('cron: REWEIGHT_MAX_WALLETS is clamped; 3 x 99 wallets under "297" stay inside the Free plan caps; the default reads the 99 stalest in ONE call', async () => {
  assert.deepEqual(['', undefined, null, '0', '-5', '1.5', 'abc', '297', ' 50 ', '999999', 2000].map(skr.reweightCap),
    [99, 99, 99, 99, 99, 99, 99, 297, 50, 2000, 2000]);
  assert.deepEqual([skr.REWEIGHT_DEFAULT, skr.REWEIGHT_CEILING, skr.DERIVE_BUDGET], [99, 2000, 4]);
  const e = env();
  const m = cfgOnly();
  const wallets = Array.from({ length: 297 }, randomWallet);
  const insV = e.DB.raw.prepare(`INSERT INTO vouches (genesis_mint, wallet, package, verdict, signature, signed_ts, created_at, updated_at)
    VALUES (?, ?, 'a.app', 'works', 's', ?, ?, ?)`);
  const insP = e.DB.raw.prepare('INSERT INTO wallet_pdas (wallet, pool, pda, bump) VALUES (?, ?, ?, ?)');
  e.DB.raw.exec('BEGIN');
  for (const w of wallets) {
    insV.run('M' + w.slice(0, 8), w, TS0, TS0, TS0);
    const r = skr.userStakePda(base58.decode(w), base58.decode(skr.GUARDIAN_POOLS[0]));
    insP.run(w, skr.GUARDIAN_POOLS[0], base58.encode(r.address), r.bump);
    m.set(base58.encode(r.address), userStakeInfo(w, { shares: 1_000_000_000n }));
  }
  e.DB.raw.exec('COMMIT');
  e.REWEIGHT_MAX_WALLETS = '297';                                      // a Paid-plan [vars] override
  serve(m);
  let q0 = e.DB.stats.queries;
  let { sum } = await tick(e, WED);
  const queries = e.DB.stats.queries - q0;
  assert.equal(hits, 3);
  assert.ok(queries + hits <= 50, `queries ${queries} + fetches ${hits}`);
  assert.deepEqual([sum.selected, sum.read, sum.chunks, sum.ok, sum.vouch_rows, sum.cache_rows, sum.deferred], [297, 297, 3, 297, 297, 297, 0]);
  assert.equal(count(e, 'skr_cache'), 297);
  assert.equal(e.DB.raw.prepare('SELECT MIN(weight) AS w FROM vouches').get().w, X.testValues.oneShareUnitWeight); // 1,147.03 SKR each
  console.log(`# tick of 297 wallets: ${queries} D1 queries, ${hits} RPC calls`);
  delete e.REWEIGHT_MAX_WALLETS;                                       // Free-plan default
  serve(m);
  q0 = e.DB.stats.queries;
  const t1 = hourAfter(WED, 1);
  ({ sum } = await tick(e, t1));
  assert.equal(hits, 1);                                               // 99 wallets = one getMultipleAccounts
  assert.deepEqual([sum.selected, sum.read, sum.chunks, sum.vouch_rows, sum.cache_rows], [99, 99, 1, 0, 99]);
  assert.equal(e.DB.raw.prepare('SELECT COUNT(*) AS n FROM skr_cache WHERE checked_at = ?').get(t1).n, 99);
  console.log(`# default tick: ${e.DB.stats.queries - q0} D1 queries, ${hits} RPC call`);
});

test('cron: at most DERIVE_BUDGET wallets without a stored PDA are derived per tick; the rest wait and come first next tick; a wallet that is not a key is never read', async () => {
  const e = env();
  const m = cfgOnly();
  const wallets = Array.from({ length: 10 }, randomWallet);
  wallets.forEach((w, i) => { addVouch(e, { mint: `M${i}`, wallet: w, pkg: 'a.app' }); withStake(w, { shares: 1_000_000_000n }, m); });
  addVouch(e, { mint: 'MX', wallet: 'not-a-wallet', pkg: 'a.app' });
  const expected = [[11, 4, 6, 1, 4], [11, 8, 2, 1, 8], [11, 10, 0, 1, 10]];
  for (const [k, want] of expected.entries()) {
    serve(m);
    const { sum } = await tick(e, hourAfter(WED, k));
    assert.deepEqual([sum.selected, sum.read, sum.deferred, sum.invalid, count(e, 'wallet_pdas')], want, `tick ${k}`);
    assert.equal(hits, 1);
  }
  assert.equal(count(e, 'skr_cache'), 10);
  assert.deepEqual(vouchRows(e, 'not-a-wallet'), [['a.app', 1, null]]);
});

// checkDrift and the scheduled() handler: getAccountInfo(ProgramData, dataSlice) plus getMultipleAccounts.
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
function serveDrift(byAddr, { deploySlot = BigInt(fx.program.deploySlot), owner = LOADER } = {}) {
  hits = 0;
  globalThis.fetch = async (_url, init) => {
    hits++;
    const { method, params } = JSON.parse(init.body);
    let value;
    if (method === 'getAccountInfo') {
      assert.equal(params[0], skr.PROGRAM_DATA);
      assert.deepEqual(params[1], { encoding: 'base64', dataSlice: { offset: 4, length: 8 } });
      const b = new Uint8Array(8);
      wU64(b, 0, deploySlot);
      value = { owner, lamports: 1, data: [base64.encode(b), 'base64'], executable: false, rentEpoch: 0 };
    } else {
      assert.equal(method, 'getMultipleAccounts');
      value = params[0].map((a) => byAddr.get(a) ?? null);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: fx.slot }, value } }));
  };
}

test('checkDrift: the pinned deploy slot and an active pool read clean; a new slot, a foreign owner, an inactive or missing pool and an RPC error are reported, never thrown', async () => {
  const e = { RPC_URL: 'http://fake.invalid/redacted' };
  serveDrift(withPool());
  assert.deepEqual(await skr.checkDrift(e), { deploy_slot: fx.program.deploySlot, deploy_slot_changed: false, pool_active: true });
  assert.equal(hits, 2);
  serveDrift(withPool(), { deploySlot: skr.PINNED_DEPLOY_SLOT + 1n });
  assert.deepEqual(await skr.checkDrift(e), { deploy_slot: fx.program.deploySlot + 1, deploy_slot_changed: true, pool_active: true });
  serveDrift(withPool(), { owner: '11111111111111111111111111111111' });
  assert.deepEqual(await skr.checkDrift(e), { deploy_slot: null, deploy_slot_changed: true, pool_active: true });
  serveDrift(withPool(cfgOnly(), (b) => { b[171] = 0; }));
  assert.equal((await skr.checkDrift(e)).pool_active, false);
  serveDrift(cfgOnly());                                               // pool account missing
  assert.equal((await skr.checkDrift(e)).pool_active, null);
  rpcDown();
  assert.deepEqual(await skr.checkDrift(e), { drift_error: 'rpc: error' });
});

test('index.js scheduled(): the 03:07 UTC tick re-weights and runs the drift check through waitUntil; 04:07 re-weights only', async () => {
  const e = env();
  addVote(e, { week: '2026-W41', mint: 'M1', weight: 3.66 });
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(String(s));
  try {
    for (const iso of ['2026-10-05T03:07:00.000Z', '2026-10-05T04:07:00.000Z']) {
      serveDrift(withPool(cfgOnly()));                                // no UserStake: the vote falls
      const waits = [];
      await worker.scheduled({ scheduledTime: Date.parse(iso), cron: '7 * * * *' }, e, { waitUntil: (p) => waits.push(p) });
      assert.equal(waits.length, 1);
      await Promise.all(waits);
      logs.push(`# hits ${hits}`);
    }
  } finally {
    console.log = orig;
  }
  const sums = logs.filter((l) => l.startsWith('{') && !l.includes('"phase"')).map((l) => JSON.parse(l));
  assert.equal(sums.length, 2);
  assert.deepEqual([sums[0].ok, sums[0].vote_rows, sums[0].closed_week, sums[0].deploy_slot, sums[0].deploy_slot_changed, sums[0].pool_active],
    [1, 1, '2026-W40', fx.program.deploySlot, false, true]);
  assert.ok(!('deploy_slot' in sums[1]) && sums[1].ok === 1 && sums[1].vote_rows === 0, JSON.stringify(sums[1]));
  assert.deepEqual(logs.filter((l) => l.startsWith('# hits')), ['# hits 3', '# hits 1']);
  assert.equal(tally(e, '2026-W41'), 1);
});

test('cron log lines carry counts, a week key and drift flags only: no wallet, no stake, no URL', async () => {
  const e = env();
  addVote(e, { week: '2026-W41', mint: 'M1', weight: 3.66 });
  addVouch(e, { mint: 'M1', pkg: 'x.place' });
  addVouch(e, { mint: 'M2', wallet: MISSING, pkg: 'x.place', weight: 2, staked: 300 });
  serveDrift(withPool(withFixture()));
  const { logs, sum } = await tick(e, '2026-10-05T03:07:00.000Z', { drift: true });
  assert.equal(logs.length, 2);
  assert.equal(sum.deploy_slot_changed, false);
  const ALLOWED = new Set(['evt', 'phase', 'skipped', 'selected', 'read', 'deferred', 'invalid', 'chunks', 'ok', 'unknown',
    'vouch_rows', 'vote_rows', 'cache_rows', 'closed_week', 'deploy_slot', 'deploy_slot_changed', 'pool_active', 'drift_error', 'ms']);
  for (const l of logs) {
    for (const k of Object.keys(JSON.parse(l))) assert.ok(ALLOWED.has(k), `log key ${k}`);
    assert.ok(![W, MISSING, pdaOf(W), String(SAMPLE_SKR), X.sampleUserStake.stakedRaw].some((x) => l.includes(x)), l);
    assert.ok(!/https?:|fake\.invalid|redacted/.test(l), l);
  }
});

// ---------------------------------------------------------------- notes: half of a surrogate pair
test('POST /vouch: a note holding half of a surrogate pair (the 140 cut after an emoji) is refused 400 before verifyFn and the chain; the whole emoji passes', async () => {
  const rocket = String.fromCodePoint(0x1f680);
  let note = null;
  for (let j = 0; j < 140 && note === null; j++) {
    const n = sanitizeNote('see x.io ' + 'a'.repeat(j) + rocket.repeat(20)); // the stripped link pushes the emoji across 140
    if (hasLoneSurrogate(n)) note = n;
  }
  assert.ok(note, 'the generator reaches the cut');
  assert.equal(note.length, 140);
  assert.equal(sanitizeNote(note), note);                               // a fixed point: only the new check refuses it
  const lowAlone = 'fine' + String.fromCharCode(0xdc00) + 'app';
  let verified = 0;
  const verifyCount = async () => { verified++; return { number: null, tier: null }; };
  const post = async (e, body) => {
    const req = new Request('https://w.test/vouch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const r = await handleVouch(req, e, new URL('https://w.test/vouch'), verifyCount);
    return { status: r.status, body: await r.json() };
  };
  serve(withFixture());
  const e = env();
  for (const bad of [note, lowAlone]) {
    const r = await post(e, { ...vouchBody(W, MINT_A, 'x.place', SIG('1')), note: bad });
    assert.deepEqual([r.status, r.body.error], [400, 'note contains a link or is not normalised']);
  }
  assert.deepEqual([verified, hits, count(e, 'vouches')], [0, 0, 0]);
  const orig = console.log;
  console.log = () => {};
  try {
    const whole = note.slice(0, -1);                                    // ends on a complete emoji
    const r = await post(e, { ...vouchBody(W, MINT_A, 'x.place', SIG('2')), note: whole });
    assert.deepEqual([r.status, r.body.vouch?.note, verified], [200, whole, 1], JSON.stringify(r.body));
  } finally {
    console.log = orig;
  }
});
