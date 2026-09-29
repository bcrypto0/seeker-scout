// lounge-worker/test/integration.mjs
// Integration harness (SPEC-vouch 7.2), the subset that needs no vote, no
// report route and no D6 decoder. It lands ahead of the D16-D17 harness
// (commit 19 grows it) and asserts nothing about routes later days mount.
// LOCAL ONLY. It assumes:
//   npm run schema:local && npm run migrate:local
//   npx wrangler dev --port 8787 --ip 127.0.0.1 --var RPC_URL:http://127.0.0.1:8899
// It starts and stops the fake RPC itself (port 8899 must be free), writes to
// the local D1 only (it spawns `wrangler d1 execute --local`), prints PASS/FAIL
// per scenario and exits 1 on any FAIL. Two deliberate departures from 7.2,
// which leaves the local D1 as-is: it opens with the runbook's local reset of
// the vouch tables so every count below is exact on a re-run, and one
// scenario drops rpc_budget and re-creates it with the DDL of migrations/001.
// Each owner posts with its own cf-connecting-ip (wrangler dev keeps it).
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { base58 } from '@scure/base';
import { startFakeRpc } from './fake-rpc.mjs';
import { vouchMessage, weekBounds } from '../src/vouch-lib.js';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const WORKER = process.env.WORKER_URL || 'http://127.0.0.1:8787';
const FAKE_PORT = Number(process.env.FAKE_RPC_PORT) || 8899;
if (!['127.0.0.1', 'localhost'].includes(new URL(WORKER).hostname)) throw new Error(`refusing non-local worker ${WORKER}`);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const RATE_MS = 10_000; // vouch.js RATE_MS
const D1_TIMEOUT_MS = 90_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- local D1 through wrangler (never --remote) ---------------------------
// On this Windows box `wrangler d1 execute --local` prints its result within
// about 2 s and then takes minutes to exit, so the result is taken from
// stdout as soon as the --json array is complete and the process tree is
// ended. The statements have committed by the time wrangler prints them.
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
function d1(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRANGLER, 'd1', 'execute', 'seeker-lounge', '--local', '--json', '--command', sql], {
      cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child.pid);
      fn(value);
    };
    const tryParse = () => {
      const t = out.trim();
      if (!t.startsWith('[') && !t.startsWith('{')) return;
      let parsed;
      try { parsed = JSON.parse(t); } catch { return; } // not complete yet
      if (Array.isArray(parsed)) finish(resolve, parsed);
      else finish(reject, new Error(`d1 execute --local error: ${JSON.stringify(parsed).slice(0, 300)}`));
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; tryParse(); });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('exit', (code) => {
      tryParse();
      finish(reject, new Error(`d1 execute --local exited ${code}: ${(err || out).trim().slice(-300)}`));
    });
    const timer = setTimeout(
      () => finish(reject, new Error(`d1 execute --local timed out: ${(err || out).trim().slice(-300)}`)),
      D1_TIMEOUT_MS,
    );
  });
}
const d1Rows = async (sql) => (await d1(sql)).flatMap((x) => x.results ?? []);

// ---- HTTP -----------------------------------------------------------------
async function call(method, path, body, headers = {}) {
  const res = await fetch(WORKER + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, text, headers: res.headers };
}
// Every owner posts from its own client address: wrangler dev keeps a
// cf-connecting-ip the request already carries, so the per-address share of
// the open pool only bites in the scenarios that test it.
const ipOf = new Map(); // wallet -> address
const randomIp = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 256)).join('.')}`;
const post = (payload, ip) =>
  call('POST', '/vouch', payload, { 'cf-connecting-ip': ip ?? ipOf.get(payload.wallet) ?? randomIp() });
const get = (path) => call('GET', path);

// ---- owners, mints, signatures ---------------------------------------------
const randomKey = ed.utils.randomPrivateKey ?? ed.utils.randomSecretKey;
const randomMint = (bytes = 32) => base58.encode(crypto.getRandomValues(new Uint8Array(bytes)));
function newOwner() {
  const priv = randomKey();
  const wallet = base58.encode(ed.getPublicKey(priv));
  ipOf.set(wallet, randomIp());
  return { priv, wallet, mint: randomMint() };
}
const isoAt = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const sign = (fields, priv) => base58.encode(ed.sign(new TextEncoder().encode(vouchMessage(fields)), priv));
/** A signed POST /vouch body. `over` may replace any field, including wallet/mint/ts. */
function vouch(owner, pkg, over = {}) {
  const fields = { wallet: owner.wallet, mint: owner.mint, ts: isoAt(), package: pkg, verdict: 'works', tags: [], note: '', ...over };
  return { ...fields, signature: sign(fields, owner.priv) };
}

// One accepted write per wallet per 10 s: wait out the slot before an expected 200.
const lastAccept = new Map();
const markAccepted = (o) => lastAccept.set(o.wallet, Date.now());
async function waitSlot(o) {
  const wait = (lastAccept.get(o.wallet) ?? 0) + RATE_MS + 500 - Date.now();
  if (wait > 0) await sleep(wait);
}

// ---- runner ---------------------------------------------------------------
let passed = 0;
let failed = 0;
async function scenario(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${name}: ${e?.message ?? e}`);
  }
}
function check(cond, msg) {
  if (!cond) throw new Error(msg);
}
function expectStatus(r, status, error) {
  check(r.status === status, `expected ${status}, got ${r.status} ${String(r.text).slice(0, 240)}`);
  if (error !== undefined) check(r.body?.error === error, `expected error '${error}', got '${r.body?.error}'`);
}

const A = newOwner();
const B = newOwner();
const C = newOwner();
const D = newOwner();
const E = newOwner();
const F = newOwner();
const G = newOwner();
const J = newOwner();           // posts a Japanese note (prose, expects 200)
const K = newOwner();           // posts an Arabic note (prose, expects 200)
const owners = [A, B, C, D, E, F, G, J, K];
const NOT_SGT = randomMint();   // parsed mint, different mintAuthority; A holds it
const UNHELD = randomMint();    // genuine SGT fingerprint, nobody holds it
const H = newOwner();           // vouches one app this week
const Q = newOwner();           // its mint is seeded up to the per-mint package cap
const SPRAY_MINT = randomMint(); // one Genesis Token held by eleven wallets
const sprayers = Array.from({ length: 11 }, () => ({ ...newOwner(), mint: SPRAY_MINT }));
const aPkgs = new Set();        // packages A holds an accepted row for

let fake;
try {
  fake = await startFakeRpc({ port: FAKE_PORT });
} catch (e) {
  console.log(`FAIL start the fake RPC on 127.0.0.1:${FAKE_PORT}: ${e.message}`);
  process.exit(1);
}
fake.register({
  sgt: [...owners.map((o) => o.mint), UNHELD, H.mint, Q.mint, SPRAY_MINT],
  notSgt: [NOT_SGT],
  holders: [...[...owners, H, Q, ...sprayers].map((o) => [o.wallet, o.mint]), [A.wallet, NOT_SGT]],
});
const hits = () => fake.counts().hits;
const minuteKey = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().slice(0, 16);
const isBusy = (r) => r.status === 503 && /^busy/.test(r.body?.error ?? '');
const lastVouchAt = async (o) =>
  (await d1Rows(`SELECT last_vouch_at FROM vouch_members WHERE wallet = '${o.wallet}'`))[0]?.last_vouch_at ?? null;

try {
  const pre = await get('/flags').catch((e) => ({ status: 0, text: e.message }));
  if (pre.status !== 200) {
    console.log(`FAIL preflight: GET ${WORKER}/flags -> ${pre.status} ${pre.text}. Is wrangler dev running on the local D1?`);
    failed += 1;
  } else {
    console.log(`worker ${WORKER}, fake RPC ${fake.url}; resetting the vouch tables of the LOCAL D1`);
    await d1("DELETE FROM vouches; DELETE FROM votes; DELETE FROM vouch_reports; DELETE FROM vouch_members; DELETE FROM rpc_budget; UPDATE settings SET value='1' WHERE key='vouch_enabled'");
    await run();
  }
} catch (e) {
  failed += 1;
  console.log(`FAIL harness error: ${e?.message ?? e}`);
} finally {
  await fake.close();
}
console.log(`\n${passed} passed, ${failed} failed (fake RPC hits: ${JSON.stringify(fake.counts())})`);
process.exit(failed ? 1 : 0);

async function run() {
  let first;
  let lvaFirst;

  await scenario('valid vouch -> 200, replayed:false, weight 1, weight_source stub, 2 chain calls', async () => {
    first = vouch(A, 'x.place', { tags: ['wallet_ok'], note: 'Opens and signs fine on my Seeker.' });
    const h0 = hits();
    const r = await post(first);
    expectStatus(r, 200);
    markAccepted(A);
    aPkgs.add('x.place');
    check(r.body.ok === true && r.body.replayed === false, `ok/replayed ${r.text}`);
    check(r.body.weight === 1 && r.body.vouch?.weight === 1, `weight ${r.body.weight}`);
    check(r.body.weight_source === 'stub' && r.body.staked_skr === null, `weight_source ${r.body.weight_source}`);
    check(r.body.mints_in_wallet === 1 && r.body.number === null && r.body.tier === null, 'mints_in_wallet/number/tier');
    check(r.body.vouch.signed_ts === first.ts && r.body.vouch.tags.join() === 'wallet_ok', 'stored receipt');
    check(r.body.app?.voices === 1 && r.body.app?.works_voices === 1, `app ${JSON.stringify(r.body.app)}`);
    check(hits() - h0 === 2, `fake RPC hits +${hits() - h0}, expected +2 (is RPC_URL pointed at the fake?)`);
    lvaFirst = await lastVouchAt(A);
    check(typeof lvaFirst === 'string', 'vouch_members.last_vouch_at was not set');
  });

  await scenario('identical replay -> 200 replayed:true, no 429, no new row, no chain call, no slot', async () => {
    const h0 = hits();
    const r = await post(first);
    expectStatus(r, 200);
    check(r.body.replayed === true && r.body.weight_source === 'stored', `replayed ${r.text}`);
    check(hits() === h0, 'the replay reached the chain');
    const mine = await get(`/vouch/mine?mint=${A.mint}`);
    check(mine.status === 200 && mine.body.vouches.length === 1, `rows ${mine.body?.vouches?.length}`);
    check((await lastVouchAt(A)) === lvaFirst, 'the replay moved last_vouch_at');
  });

  await scenario('older ts with a new signature -> 409, slot untouched', async () => {
    const h0 = hits();
    const r = await post(vouch(A, 'x.place', { ts: new Date(Date.parse(first.ts) - 5000).toISOString() }));
    expectStatus(r, 409, 'superseded by a newer vouch from this Seeker');
    check(hits() - h0 === 2, `hits +${hits() - h0}: the signature and chain run before the 409`);
    check((await lastVouchAt(A)) === lvaFirst, 'the 409 moved last_vouch_at');
  });

  await scenario('ts without milliseconds, or on a date Date.parse rolls forward -> 400 bad ts', async () => {
    const h0 = hits();
    expectStatus(await post(vouch(A, 'x.place', { ts: isoAt().replace(/\.\d{3}Z$/, 'Z') })), 400, 'bad ts');
    for (const ts of ['2026-02-30T00:00:00.000Z', '2026-04-31T23:59:00.000Z', '2026-09-11T24:00:00.000Z']) {
      expectStatus(await post(vouch(A, 'x.place', { ts })), 400, 'bad ts');
    }
    check(hits() === h0, 'chain called');
  });

  await scenario("note '-' -> 400 note reserved", async () => {
    expectStatus(await post(vouch(A, 'x.place', { note: '-' })), 400, 'note reserved');
  });

  await scenario('31-byte mint -> 400 bad wallet or mint', async () => {
    expectStatus(await post(vouch(A, 'x.place', { mint: randomMint(31) })), 400, 'bad wallet or mint');
  });

  await scenario('signature over another package -> 401', async () => {
    const other = vouch(A, 'y.place');
    const h0 = hits();
    expectStatus(await post({ ...other, package: 'x.place' }), 401, 'signature verification failed');
    check(hits() === h0, 'chain called before the signature failed');
  });

  await scenario('key A signing for wallet B -> 401', async () => {
    expectStatus(await post(vouch(A, 'x.place', { wallet: B.wallet, mint: B.mint })), 401, 'signature verification failed');
  });

  await scenario('ts 11 minutes old -> 400 stale message', async () => {
    expectStatus(await post(vouch(A, 'x.place', { ts: isoAt(-11 * 60_000) })), 400, 'stale message');
  });

  await scenario('ts 3 minutes in the future -> 400 stale message', async () => {
    expectStatus(await post(vouch(A, 'x.place', { ts: isoAt(3 * 60_000) })), 400, 'stale message');
  });

  await scenario('non-SGT mint -> 403 not a Seeker Genesis Token', async () => {
    expectStatus(await post(vouch(A, 'x.place', { mint: NOT_SGT })), 403, 'not a Seeker Genesis Token');
  });

  await scenario('wallet that does not hold the SGT -> 403 wallet does not hold this token', async () => {
    expectStatus(await post(vouch(A, 'x.place', { mint: UNHELD })), 403, 'wallet does not hold this token');
  });

  await scenario('note with a link -> 400 before any chain call, also hidden (U+200B, fullwidth, U+3002 by a mark or filler, two U+3002, U+2024, U+22C5, a look-alike colon and slashes, an accent on the letter before the dot); Japanese and Arabic prose -> 200', async () => {
    const wide = (s) => [...s].map((ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join('');
    const h0 = hits();
    for (const note of [
      'join t.me/x for help',
      'v2 moved to jupdrop\u200b.com',
      'v2 moved to jupdrop\uff0ecom',
      `v2 moved to ${wide('jupdrop')}.com`,
      'v2 moved to jupdrop\u034f\u3002com',
      'v2 moved to jupdrop\u3002\ufe0fcom',
      'v2 moved to jupdrop\u1160\u3002com',
      'v2 moved to jupdrop\u3002\u3002com',
      'v2 moved to jupdrop\u2024com',
      'v2 live at jupdrop\u22c5com try it',
      'claim at https\ua789\u2571\u2571jupdrop',
      'v2 moved to jupdrop\u0301.com',
    ]) {
      expectStatus(await post(vouch(A, 'x.place', { note })), 400, 'note contains a link or is not normalised');
    }
    check(hits() === h0, `hits +${hits() - h0}: a refused note reached the chain`);
    const japanese = '\u826f\u3044\u30a2\u30d7\u30ea\u3067\u3059\u3002\u30b9\u30ef\u30c3\u30d7\u3082\u901f\u3044\u3002';
    const arabic = '\u064a\u0639\u0645\u0644 \u062c\u064a\u062f\u064b\u0627 \u0639\u0644\u0649 \u0633\u064a\u0643\u0631';
    try {
      for (const [o, note] of [[J, japanese], [K, arabic]]) {
        const r = await post(vouch(o, 'prose.place', { note }));
        expectStatus(r, 200);
        check(r.body.vouch?.note === note, `stored note ${JSON.stringify(r.body.vouch?.note)}`);
      }
    } finally {
      await d1("DELETE FROM vouches WHERE package = 'prose.place'"); // later counts stay exact
    }
  });

  await scenario('141-character note -> 400', async () => {
    expectStatus(await post(vouch(A, 'x.place', { note: 'a'.repeat(141) })), 400,
      'note must be one line of at most 140 characters');
  });

  await scenario('newer ts with verdict broken -> 200 and broken_voices 1', async () => {
    await waitSlot(A);
    const r = await post(vouch(A, 'x.place', { verdict: 'broken', tags: ['crashes'], note: 'Crashes on launch since the last update.' }));
    expectStatus(r, 200);
    markAccepted(A);
    check(r.body.replayed === false && r.body.vouch.verdict === 'broken', r.text);
    const app = await get('/vouch/app/x.place');
    const a = app.body?.app;
    check(app.status === 200 && a.voices === 1 && a.broken_voices === 1 && a.works_voices === 0, JSON.stringify(a));
  });

  await scenario('second vouch from the same wallet inside 10 s -> 429, same payload after 10.5 s -> 200', async () => {
    const p = vouch(A, 'z.place');
    expectStatus(await post(p), 429, 'slow down');
    await sleep(RATE_MS + 500);
    const r = await post(p);
    expectStatus(r, 200);
    markAccepted(A);
    aPkgs.add('z.place');
    check(r.body.mints_in_wallet === 1, `mints_in_wallet ${r.body.mints_in_wallet}`);
  });

  await scenario('open pool at 120 -> a new owner gets 503 busy with no chain call, a member still gets 200; row deleted -> 200', async () => {
    const p = vouch(B, 'b.place');
    const [m0, m1] = [minuteKey(), minuteKey(60_000)];
    await d1(`INSERT OR REPLACE INTO rpc_budget (minute, n) VALUES ('${m0}', 120), ('${m1}', 120)`);
    try {
      let h0 = hits();
      const r = await post(p);
      check(isBusy(r), `expected 503 busy, got ${r.status} ${r.text}`);
      check(hits() === h0, 'the chain was called past a spent open pool');
      await waitSlot(A);
      h0 = hits();
      const rA = await post(vouch(A, 'm.place'));
      expectStatus(rA, 200);
      markAccepted(A);
      aPkgs.add('m.place');
      check(hits() - h0 === 2, `member write +${hits() - h0} hits, expected +2`);
    } finally {
      await d1('DELETE FROM rpc_budget');
    }
    const r2 = await post(p);
    expectStatus(r2, 200);
    markAccepted(B);
  });

  await scenario("kill switch '0', and a stray 'false' -> 503 vouching is paused and /flags vouch:false; back on -> 200", async () => {
    const p = vouch(C, 'k.place');
    try {
      for (const value of ['0', 'false']) {
        await d1(`UPDATE settings SET value='${value}', updated_at='${isoAt()}' WHERE key='vouch_enabled'`);
        expectStatus(await post(p), 503, 'vouching is paused');
        const f = await get('/flags');
        check(f.status === 200 && f.body.vouch === false, `flags with '${value}': ${f.text}`);
        check(f.body.vote === true && f.body.withdraw === false, `other flags ${f.text}`);
      }
    } finally {
      await d1(`UPDATE settings SET value='1', updated_at='${isoAt()}' WHERE key='vouch_enabled'`);
    }
    const f2 = await get('/flags');
    check(f2.body.vouch === true, `flags did not flip back: ${f2.text}`);
    expectStatus(await post(p), 200);
    markAccepted(C);
  });

  await scenario("members pool: one mint's share (10 a minute) spent -> 503 for that mint only; members pool at 120 -> 503", async () => {
    const [m0, m1] = [minuteKey(), minuteKey(60_000)];
    await d1(`INSERT OR REPLACE INTO rpc_budget (minute, n) VALUES ('${m0}m${A.mint}', 10), ('${m1}m${A.mint}', 10)`);
    try {
      await waitSlot(A);
      let h0 = hits();
      const rA = await post(vouch(A, 'n.place'));
      check(isBusy(rA), `A with its mint share spent: ${rA.status} ${rA.text}`);
      check(hits() === h0, 'the chain was called past a spent mint share');
      await waitSlot(C);
      h0 = hits();
      expectStatus(await post(vouch(C, 'c2.place')), 200);
      markAccepted(C);
      check(hits() - h0 === 2, `another member +${hits() - h0} hits, expected +2`);
      await d1(`INSERT OR REPLACE INTO rpc_budget (minute, n) VALUES ('${m0}k', 120), ('${m1}k', 120)`);
      await waitSlot(B);
      h0 = hits();
      const rB = await post(vouch(B, 'b2.place'));
      check(isBusy(rB), `B with the members pool spent: ${rB.status} ${rB.text}`);
      check(hits() === h0, 'the chain was called past a spent members pool');
    } finally {
      await d1('DELETE FROM rpc_budget');
    }
  });

  await scenario('open pool, per address: 20 first-time checks from one address, the 21st gets 503 busy; another address or another /64 still reaches the chain', async () => {
    const sec = new Date().getUTCSeconds();
    if (sec > 45) await sleep((61 - sec) * 1000); // keep each address's calls inside one UTC minute
    await d1('DELETE FROM rpc_budget');
    try {
      for (const [addr, sameNet, otherNet] of [
        [() => '203.0.113.7', '203.0.113.7', '203.0.113.8'],
        [(i) => `2001:db8:5:6::${(i + 1).toString(16)}`, '2001:0DB8:0005:0006:ffff:0:0:9', '2001:db8:5:7::1'],
      ]) {
        const h0 = hits();
        const st = [];
        for (let i = 0; i < 20; i++) st.push((await post(vouch(newOwner(), 'ip.place'), addr(i))).status); // unregistered mints
        check(st.every((s) => s === 403), `first 20 from ${addr(0)}: ${JSON.stringify(st)}`);
        check(hits() - h0 === 40, `hits +${hits() - h0}, expected +40`);
        const h1 = hits();
        const r = await post(vouch(newOwner(), 'ip.place'), sameNet);
        check(isBusy(r), `21st from ${sameNet}: ${r.status} ${r.text}`);
        check(hits() === h1, `the chain was called past the spent share of ${sameNet}`);
        expectStatus(await post(vouch(newOwner(), 'ip.place'), otherNet), 403, 'not a Seeker Genesis Token');
      }
    } finally {
      await d1('DELETE FROM rpc_budget');
    }
  });

  await scenario('rpc_budget missing -> the isolate counts for itself: 20 checks per address, 30 in the open pool, then 503 busy; a member still passes', async () => {
    const sec = new Date().getUTCSeconds();
    if (sec > 40) await sleep((61 - sec) * 1000); // keep the 32 calls inside one UTC minute
    await d1('DROP TABLE rpc_budget');
    try {
      const h0 = hits();
      const one = '198.51.100.20';
      const fromOne = [];
      for (let i = 0; i < 21; i++) fromOne.push((await post(vouch(newOwner(), 'fb.place'), one)).status); // unregistered: not an SGT
      check(fromOne.slice(0, 20).every((s) => s === 403) && fromOne[20] === 503, `one address: ${JSON.stringify(fromOne)}`);
      const spread = [];
      for (let i = 0; i < 11; i++) spread.push((await post(vouch(newOwner(), 'fb.place'))).status); // an address each
      check(spread.slice(0, 10).every((s) => s === 403) && spread[10] === 503, `open pool: ${JSON.stringify(spread)}`);
      check(hits() - h0 === 60, `hits +${hits() - h0}, expected +60`);
      await waitSlot(A);
      expectStatus(await post(vouch(A, 'fb.place')), 200);
      markAccepted(A);
      aPkgs.add('fb.place');
    } finally {
      await d1('CREATE TABLE IF NOT EXISTS rpc_budget (minute TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)');
    }
  });

  await scenario('per-mint package cap: 50 rows on one mint (excluded ones count) -> 403 vouch limit reached, no chain call; an existing package still updates', async () => {
    const seedTs = new Date(Date.parse(weekBounds(new Date()).start) - 2 * 86_400_000).toISOString();
    await d1('WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 50) ' +
      'INSERT INTO vouches (genesis_mint, wallet, package, verdict, tags, note, signature, signed_ts, weight, excluded, created_at, updated_at) ' +
      `SELECT '${Q.mint}', '${Q.wallet}', 'cap.p' || i, 'works', 0, '', 'seed', '${seedTs}', 1, 1, '${seedTs}', '${seedTs}' FROM s`);
    const h0 = hits();
    expectStatus(await post(vouch(Q, 'cap.new')), 403, 'vouch limit reached');
    check(hits() === h0, 'the chain was called for a capped mint');
    const r = await post(vouch(Q, 'cap.p1', { verdict: 'broken' }));
    expectStatus(r, 200);
    check(r.body.vouch?.verdict === 'broken' && r.body.vouch?.excluded === true, r.text);
  });

  const { start } = weekBounds(new Date());
  const beforeWeek = new Date(Date.parse(start) - 86_400_000).toISOString();
  const chipPkg = 'chip.place';

  await scenario('setup: G vouches old.place, then its updated_at moves before this week (d1 --local)', async () => {
    expectStatus(await post(vouch(G, 'old.place', { note: 'Worked for me last week.' })), 200);
    await d1(`UPDATE vouches SET updated_at='${beforeWeek}', created_at='${beforeWeek}' WHERE package='old.place'`);
    const rows = await d1Rows("SELECT updated_at FROM vouches WHERE package='old.place'");
    check(rows.length === 1 && rows[0].updated_at === beforeWeek, `old.place row ${JSON.stringify(rows)}`);
  });

  await scenario('chip: three wallets vouch works -> /vouch/app voices 3, weight_works 3, works_pct 100, works_on_seeker true', async () => {
    for (const [i, o] of [D, E, F].entries()) {
      expectStatus(await post(vouch(o, chipPkg, { tags: ['wallet_ok'], note: `Works fine on Seeker, owner ${i + 1}.` })), 200);
    }
    const r = await get(`/vouch/app/${chipPkg}`);
    expectStatus(r, 200);
    const a = r.body.app;
    check(a.voices === 3 && a.weight_works === 3 && a.works_pct === 100 && a.works_on_seeker === true, JSON.stringify(a));
    check(a.wallet_ok_voices === 3 && a.broken_voices === 0, JSON.stringify(a));
    check(r.headers.get('cache-control') === 'public, max-age=60', `cache-control ${r.headers.get('cache-control')}`);
  });

  await scenario('/vouch/aggregate lists the chip package with the same numbers', async () => {
    const r = await get('/vouch/aggregate');
    expectStatus(r, 200);
    const a = r.body.apps.find((x) => x.package === chipPkg);
    check(a && a.voices === 3 && a.weight_works === 3 && a.works_pct === 100 && a.works_on_seeker === true, JSON.stringify(a));
    check(r.body.count === r.body.apps.length && r.body.apps[0].package === chipPkg, 'count / order by weight_works');
    check(r.body.apps.some((x) => x.package === 'old.place'), 'old.place missing from the all-time aggregate');
  });

  await scenario('/vouch/top ranks the chip package first with voices_week 3', async () => {
    const r = await get('/vouch/top');
    expectStatus(r, 200);
    const top = r.body.apps[0];
    check(top?.package === chipPkg && top.voices_week === 3 && top.weight_works_week === 3, JSON.stringify(top));
    check(r.body.start === start && typeof r.body.week === 'string', `week ${r.body.week} ${r.body.start}`);
  });

  await scenario('a package vouched only before this week is absent from /vouch/top', async () => {
    const r = await get('/vouch/top');
    expectStatus(r, 200);
    check(!r.body.apps.some((x) => x.package === 'old.place'), 'old.place is listed');
    check(r.body.apps.every((x) => x.voices_week > 0), 'a row with voices_week 0 is listed');
  });

  await scenario("one Genesis Token spraying 11 ids that sort first cannot push another owner's app off /vouch/top", async () => {
    for (const [i, s] of sprayers.entries()) {
      expectStatus(await post(vouch(s, `aa.${'abcdefghijk'[i]}`)), 200);
    }
    expectStatus(await post(vouch(H, 'zz.real', { note: 'Solid on my Seeker.' })), 200);
    const r = await get('/vouch/top');
    expectStatus(r, 200);
    const pk = r.body.apps.map((x) => x.package);
    const iReal = pk.indexOf('zz.real');
    check(iReal >= 0, `zz.real is missing: ${JSON.stringify(pk)}`);
    check(pk.every((p, i) => !p.startsWith('aa.') || i > iReal), `a sprayed id ranks above zz.real: ${JSON.stringify(pk)}`);
    check(pk.length <= 10 && pk[0] === chipPkg, `top ${JSON.stringify(pk)}`);
  });

  await scenario('/vouch/mine returns only {package, verdict, note_hidden, excluded}: no id, no updated_at', async () => {
    const r = await get(`/vouch/mine?mint=${A.mint}`);
    expectStatus(r, 200);
    check(r.headers.get('cache-control') === 'no-store', `cache-control ${r.headers.get('cache-control')}`);
    check(r.body.vouches.length === aPkgs.size, `rows ${r.body.vouches.length}, expected ${aPkgs.size}`);
    for (const v of r.body.vouches) {
      check(Object.keys(v).sort().join(',') === 'excluded,note_hidden,package,verdict', Object.keys(v).join(','));
    }
    check(!/"(id|updated_at)":/.test(r.text), 'a join key to the public notes leaked');
  });

  await scenario('public /vouch/app recent rows carry no wallet, no mint, no staked_skr', async () => {
    for (const pkg of [chipPkg, 'x.place']) {
      const r = await get(`/vouch/app/${pkg}`);
      expectStatus(r, 200);
      check(r.body.recent.length >= 1, `no recent rows on ${pkg}`);
      for (const v of r.body.recent) {
        // Spec 2.4 field list, compared as a sorted set.
        const want = ['id', 'verdict', 'tags', 'note', 'weight', 'number', 'tier', 'updated_at'].sort().join(',');
        check(Object.keys(v).sort().join(',') === want, Object.keys(v).join(','));
      }
      for (const o of owners) check(!r.text.includes(o.wallet) && !r.text.includes(o.mint), `a wallet or mint leaked on ${pkg}`);
      check(!/"(wallet|mint|genesis_mint|staked_skr|signature)":/.test(r.text), `a private key name leaked on ${pkg}`);
    }
  });

  await scenario('bad reads -> 400 (bad package id, mint required, bad mint)', async () => {
    expectStatus(await get('/vouch/app/jupiter'), 400, 'bad package id');
    expectStatus(await get('/vouch/mine'), 400, 'mint required');
    expectStatus(await get('/vouch/mine?mint=abc'), 400, 'bad mint');
  });

  await scenario('unknown paths under the mount -> 404 JSON', async () => {
    // Only paths no later day mounts: /vote/* (D11) and /vouch/report (D16-D17) stay out of this list.
    for (const [m, p] of [['GET', '/vouch/nope'], ['GET', '/vouch']]) {
      const r = await call(m, p, m === 'POST' ? {} : undefined);
      check(r.status === 404 && r.body?.error === 'not found', `${m} ${p} -> ${r.status} ${r.text}`);
    }
  });
}
