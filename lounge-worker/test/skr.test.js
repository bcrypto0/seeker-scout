// lounge-worker/test/skr.test.js. node:test, in-memory D1 (node:sqlite), fake RPC via fetch.
// SPEC-skr-final 7.2, the D6 part: decoders, PDA derivation, reads, the D1 cache and
// readStakeWeight, plus POST /vouch through the real router with the real reader. The cron
// tests join on D16 (1.10) and the POST /skr/read test with 1.11. Chain values come from the
// fixture's `expected` block (captured read-only 2026-09-30 at slot 451853888), never from
// literals of an older capture: share_price moves when rewards land.
// RPC_URL is 'http://fake.invalid/redacted' and globalThis.fetch is a shim: no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { base58, base64 } from '@scure/base';
import * as skr from '../src/skr.js';
import { handleVouch } from '../src/vouch.js';
import { sharedStakeWeight } from '../src/vouch-lib.js';
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
