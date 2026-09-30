// lounge-worker/test/integration.mjs
// Integration harness (SPEC-vouch 7.2), the subset that needs no vote and no
// report route, plus the D6 SKR stake reader (SPEC-skr-final 7.2: the fake RPC
// serves getMultipleAccounts from the mainnet fixture). It lands ahead of the
// D16-D17 harness (commit 19 grows it) and asserts nothing about routes later
// days mount. LOCAL ONLY. It assumes:
//   npm run schema:local && npm run migrate:local && npm run migrate:skr:local
//   npx wrangler dev --port 8787 --ip 127.0.0.1 --var RPC_URL:http://127.0.0.1:8899
// (RPC_URL MUST point at the fake: unset, the worker falls back to the public
// mainnet RPC.) It starts and stops the fake RPC itself (port 8899 must be
// free), writes to the local D1 only (it spawns `wrangler d1 execute --local`),
// prints PASS/FAIL per scenario and exits 1 on any FAIL. Two deliberate
// departures from 7.2, which leaves the local D1 as-is: it opens with the
// runbook's local reset of the vouch and SKR cache tables so every count below
// is exact on a re-run, and one scenario drops rpc_budget and re-creates it
// with the DDL of migrations/001.
// Each owner posts with its own cf-connecting-ip (wrangler dev keeps it).
// D16: the last scenarios trigger the hourly re-weight cron (skr.js reweightVouches)
// through miniflare's own scheduled route, GET /cdn-cgi/local/scheduled?cron=...&time=<ms>
// (wrangler dev serves it without --test-scheduled; `time` sets controller.scheduledTime),
// against this local D1 and the fake RPC, and read the rows back.
// D1_PERSIST_TO (optional): the --persist-to folder the worker was started with, passed to
// every `wrangler d1 execute --local` here, so a run can use a local D1 of its own.
// Chat replies (migrations/003_chat_replies.sql), last: three new owners claim numbers through
// POST /claim and take chat tokens from POST /chat/auth against the fake RPC, so the harness
// never needs the token secret. It needs 003 on the local D1, once, after checking that
// PRAGMA table_info(messages) has no reply_to yet:
//   npm run migrate:chat:local
// and a throwaway chat secret for the local worker (never the real one; unset, chat.js falls
// back to its dev value): add `--var CHAT_SECRET:<any throwaway string>` to wrangler dev.
// CHAT_ONLY=1 runs the chat scenarios alone (no vouch reset, no vouch, SKR or cron scenario).
// Chain calls per accepted POST /vouch since D6: the SGT pair (getAccountInfo +
// getTokenAccountsByOwner) plus one getMultipleAccounts stake read, or none
// when skr_cache holds a read of that wallet younger than 60 s
// (weight_source 'cache'). Owners without a registered stake read as "no
// stake account": weight 1, staked_skr 0, weight_source 'chain'.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { base58 } from '@scure/base';
import { startFakeRpc, stakePdaOf } from './fake-rpc.mjs';
import { hasLoneSurrogate, isoWeek, sanitizeNote, sharedStakeWeight, vouchMessage, weekBounds } from '../src/vouch-lib.js';
import { issueToken } from '../src/token.js';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const WORKER = process.env.WORKER_URL || 'http://127.0.0.1:8787';
const FAKE_PORT = Number(process.env.FAKE_RPC_PORT) || 8899;
if (!['127.0.0.1', 'localhost'].includes(new URL(WORKER).hostname)) throw new Error(`refusing non-local worker ${WORKER}`);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const RATE_MS = 10_000; // vouch.js RATE_MS
const D1_TIMEOUT_MS = 90_000;
const PERSIST = process.env.D1_PERSIST_TO || '';
const CHAT_ONLY = process.env.CHAT_ONLY === '1';
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
    const child = spawn(process.execPath, [WRANGLER, 'd1', 'execute', 'seeker-lounge', '--local', ...(PERSIST ? ['--persist-to', PERSIST] : []), '--json', '--command', sql], {
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
/**
 * Any JSON key naming a weight, a stake or a weighted share (weight, weight_works,
 * weight_broken, weight_works_week, works_share_week, staked_skr, ...). Owner decision
 * 2026-09-30: none may appear in a public body or in the `app` block of a POST answer;
 * the signer's own weight, staked_skr and weight_source stay on its POST answer only.
 */
const WEIGHTY = /"[a-z_]*(weight|staked|share)[a-z_]*":/;
function checkNoWeights(value, where) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const m = WEIGHTY.exec(text ?? '');
  check(!m, `${where} carries ${m?.[0]}: ${String(text).slice(0, 240)}`);
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
// D6 stake reader. S stakes 11,355.88 SKR (the demo wallet's number, requirement 9)
// at the fixture's share_price 1147028992: 9,900,255,425 shares * 1147028992 / 1e9
// = 11,355,880,000 raw exactly. S holds a second Genesis Token (S_MINT2).
const S = newOwner();
const S_MINT2 = randomMint();
const S_SHARES = '9900255425';
const S_SKR = 11355.88;
const S_WEIGHT = 3.06;          // weightFor(11355.88)
const S_WEIGHT_2 = 2.76;        // sharedStakeWeight(11355.88, 2) = weightFor(5677.94)
const S_MINT3 = randomMint();   // S's third Genesis Token, first used while its stake read fails
const MS = newOwner();          // its stake read comes back short (value has one entry too few)
const ML = newOwner();          // its UserStake comes back 168 bytes long
const SY = newOwner();          // lamports sent to its UserStake PDA: a bare System account, 0 bytes

let fake;
try {
  fake = await startFakeRpc({ port: FAKE_PORT });
} catch (e) {
  console.log(`FAIL start the fake RPC on 127.0.0.1:${FAKE_PORT}: ${e.message}`);
  process.exit(1);
}
fake.register({
  sgt: [...owners.map((o) => o.mint), UNHELD, H.mint, Q.mint, SPRAY_MINT, S.mint, S_MINT2, S_MINT3, MS.mint, ML.mint, SY.mint],
  notSgt: [NOT_SGT],
  holders: [...[...owners, H, Q, ...sprayers, S, MS, ML, SY].map((o) => [o.wallet, o.mint]), [A.wallet, NOT_SGT],
    [S.wallet, S_MINT2], [S.wallet, S_MINT3]],
  stakes: [[S.wallet, { shares: S_SHARES }]],
  badStakes: [[MS.wallet, 'short'], [ML.wallet, 'length'], [SY.wallet, 'system']],
});
const hits = () => fake.counts().hits;
/**
 * Chain calls an accepted POST /vouch made since `c0` (a fake.counts() snapshot):
 * exactly the SGT pair, plus one stake read unless the answer says 'cache'.
 */
function checkWriteCalls(c0, r) {
  const c1 = fake.counts();
  const d = (m) => (c1.byMethod[m] || 0) - (c0.byMethod[m] || 0);
  const stake = r.body?.weight_source === 'cache' ? 0 : 1;
  check(d('getAccountInfo') === 1 && d('getTokenAccountsByOwner') === 1,
    `SGT pair +${d('getAccountInfo')}/+${d('getTokenAccountsByOwner')}, expected +1/+1`);
  check(d('getMultipleAccounts') === stake,
    `stake reads +${d('getMultipleAccounts')}, expected +${stake} (weight_source ${r.body?.weight_source})`);
  check(c1.hits - c0.hits === 2 + stake, `hits +${c1.hits - c0.hits}, expected +${2 + stake}`);
}
const minuteKey = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().slice(0, 16);
const isBusy = (r) => r.status === 503 && /^busy/.test(r.body?.error ?? '');
const lastVouchAt = async (o) =>
  (await d1Rows(`SELECT last_vouch_at FROM vouch_members WHERE wallet = '${o.wallet}'`))[0]?.last_vouch_at ?? null;

try {
  const pre = await get('/flags').catch((e) => ({ status: 0, text: e.message }));
  if (pre.status !== 200) {
    console.log(`FAIL preflight: GET ${WORKER}/flags -> ${pre.status} ${pre.text}. Is wrangler dev running on the local D1?`);
    failed += 1;
  } else if (CHAT_ONLY) {
    console.log(`worker ${WORKER}, fake RPC ${fake.url}; CHAT_ONLY=1: the chat scenarios alone, no vouch reset`);
    await runChat();
  } else {
    console.log(`worker ${WORKER}, fake RPC ${fake.url}; resetting the vouch and SKR cache tables of the LOCAL D1`);
    await d1("DELETE FROM vouches; DELETE FROM votes; DELETE FROM vouch_reports; DELETE FROM vouch_members; DELETE FROM rpc_budget; DELETE FROM skr_cache; DELETE FROM wallet_pdas; UPDATE settings SET value='1' WHERE key='vouch_enabled'");
    await run();
    await runChat();
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

  await scenario('valid vouch, no stake account -> 200, replayed:false, weight 1, weight_source chain, staked_skr 0, 3 chain calls (SGT pair + one stake read)', async () => {
    first = vouch(A, 'x.place', { tags: ['wallet_ok'], note: 'Opens and signs fine on my Seeker.' });
    const c0 = fake.counts();
    const r = await post(first);
    expectStatus(r, 200);
    markAccepted(A);
    aPkgs.add('x.place');
    check(r.body.ok === true && r.body.replayed === false, `ok/replayed ${r.text}`);
    check(r.body.weight === 1 && r.body.vouch?.weight === 1, `weight ${r.body.weight}`);
    check(r.body.weight_source === 'chain' && r.body.staked_skr === 0 && r.body.vouch?.staked_skr === 0,
      `weight_source ${r.body.weight_source}, staked_skr ${r.body.staked_skr}`);
    check(r.body.mints_in_wallet === 1 && r.body.number === null && r.body.tier === null, 'mints_in_wallet/number/tier');
    check(r.body.vouch.signed_ts === first.ts && r.body.vouch.tags.join() === 'wallet_ok', 'stored receipt');
    check(r.body.app?.voices === 1 && r.body.app?.works_voices === 1, `app ${JSON.stringify(r.body.app)}`);
    checkNoWeights(r.body.app, 'the POST answer app block');
    check(hits() - c0.hits === 3, `fake RPC hits +${hits() - c0.hits}, expected +3 (is RPC_URL pointed at the fake?)`);
    checkWriteCalls(c0, r);
    lvaFirst = await lastVouchAt(A);
    check(typeof lvaFirst === 'string', 'vouch_members.last_vouch_at was not set');
  });

  await scenario('identical replay -> 200 replayed:true, no 429, no new row, no chain call, no slot', async () => {
    const h0 = hits();
    const r = await post(first);
    expectStatus(r, 200);
    check(r.body.replayed === true && r.body.weight_source === 'stored', `replayed ${r.text}`);
    check(r.body.weight === 1 && r.body.staked_skr === 0, `the replay lost the signer's own weight or stake: ${r.text}`);
    checkNoWeights(r.body.app, 'the replay answer app block');
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

  await scenario('note the 140 cut leaves holding half an emoji (a fixed point of sanitizeNote) -> 400 before any chain call', async () => {
    const note = sanitizeNote('see x.io ' + 'a'.repeat(120) + String.fromCodePoint(0x1f680).repeat(5));
    check(note.length === 140 && sanitizeNote(note) === note && hasLoneSurrogate(note), 'the generator did not reach the cut');
    const h0 = hits();
    expectStatus(await post(vouch(A, 'x.place', { note })), 400, 'note contains a link or is not normalised');
    check(hits() === h0, 'a refused note reached the chain');
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
      const h0 = hits();
      const r = await post(p);
      check(isBusy(r), `expected 503 busy, got ${r.status} ${r.text}`);
      check(hits() === h0, 'the chain was called past a spent open pool');
      await waitSlot(A);
      const c0 = fake.counts();
      const rA = await post(vouch(A, 'm.place'));
      expectStatus(rA, 200);
      markAccepted(A);
      aPkgs.add('m.place');
      checkWriteCalls(c0, rA); // was +2 before D6: the SGT pair, now plus a stake read unless cached
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
      const c0 = fake.counts();
      const rC = await post(vouch(C, 'c2.place'));
      expectStatus(rC, 200);
      markAccepted(C);
      checkWriteCalls(c0, rC); // was +2 before D6 (see the m.place write above)
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

  await scenario('chip: three wallets vouch works -> /vouch/app voices 3, works_pct 100, works_on_seeker true, no weighted total', async () => {
    for (const [i, o] of [D, E, F].entries()) {
      const p = await post(vouch(o, chipPkg, { tags: ['wallet_ok'], note: `Works fine on Seeker, owner ${i + 1}.` }));
      expectStatus(p, 200);
      checkNoWeights(p.body.app, `the POST answer app block (owner ${i + 1})`);
    }
    const r = await get(`/vouch/app/${chipPkg}`);
    expectStatus(r, 200);
    const a = r.body.app;
    check(a.voices === 3 && a.works_pct === 100 && a.works_on_seeker === true, JSON.stringify(a));
    check(a.wallet_ok_voices === 3 && a.broken_voices === 0, JSON.stringify(a));
    check(!('weight_works' in a) && !('weight_broken' in a), `weighted totals on /vouch/app: ${JSON.stringify(a)}`);
    checkNoWeights(r.text, `/vouch/app/${chipPkg}`);
    check(r.headers.get('cache-control') === 'public, max-age=60', `cache-control ${r.headers.get('cache-control')}`);
  });

  await scenario('/vouch/aggregate lists the chip package with the same numbers and no weighted total', async () => {
    const r = await get('/vouch/aggregate');
    expectStatus(r, 200);
    const a = r.body.apps.find((x) => x.package === chipPkg);
    check(a && a.voices === 3 && a.works_pct === 100 && a.works_on_seeker === true, JSON.stringify(a));
    check(!('weight_works' in a) && !('weight_broken' in a), `weighted totals on /vouch/aggregate: ${JSON.stringify(a)}`);
    checkNoWeights(r.text, '/vouch/aggregate');
    check(r.body.count === r.body.apps.length && r.body.apps[0].package === chipPkg, 'count / order by weight_works');
    check(r.body.apps.some((x) => x.package === 'old.place'), 'old.place missing from the all-time aggregate');
  });

  await scenario('/vouch/top ranks the chip package first with voices_week 3, no weighted total', async () => {
    const r = await get('/vouch/top');
    expectStatus(r, 200);
    const top = r.body.apps[0];
    check(top?.package === chipPkg && top.voices_week === 3, JSON.stringify(top));
    check(!('weight_works_week' in top) && !('weight_works' in top) && !('works_share_week' in top), `weighted totals on /vouch/top: ${JSON.stringify(top)}`);
    checkNoWeights(r.text, '/vouch/top');
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

  await scenario('public /vouch/app recent rows carry no wallet, no mint, no staked_skr, no weight', async () => {
    for (const pkg of [chipPkg, 'x.place']) {
      const r = await get(`/vouch/app/${pkg}`);
      expectStatus(r, 200);
      check(r.body.recent.length >= 1, `no recent rows on ${pkg}`);
      for (const v of r.body.recent) {
        // Spec 2.4 field list less `weight` (D6 privacy fix: real weights next to a
        // Lounge number would reveal roughly what that owner stakes), as a sorted set.
        const want = ['id', 'verdict', 'tags', 'note', 'number', 'tier', 'updated_at'].sort().join(',');
        check(Object.keys(v).sort().join(',') === want, Object.keys(v).join(','));
      }
      for (const o of owners) check(!r.text.includes(o.wallet) && !r.text.includes(o.mint), `a wallet or mint leaked on ${pkg}`);
      check(!/"(wallet|mint|genesis_mint|staked_skr|signature|weight)":/.test(r.text), `a private key name leaked on ${pkg}`);
      checkNoWeights(r.text, `/vouch/app/${pkg}`);
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

  // ---- D6: the SKR stake reader against fixture-shaped chain replies ----------
  // Last, so their weights (up to 3.06 on one package) cannot reorder the
  // aggregate and top-ten scenarios above.
  await scenario('staked owner, 11,355.88 SKR (fixture UserStake at the live share_price) -> 200, weight 3.06, weight_source chain, 3 chain calls; skr_cache and wallet_pdas rows written', async () => {
    const c0 = fake.counts();
    const r = await post(vouch(S, 's1.place', { note: 'Staked owner, works fine.' }));
    expectStatus(r, 200);
    markAccepted(S);
    check(r.body.weight === S_WEIGHT && r.body.vouch?.weight === S_WEIGHT, `weight ${r.body.weight}`);
    check(r.body.staked_skr === S_SKR && r.body.vouch?.staked_skr === S_SKR, `staked_skr ${r.body.staked_skr}`);
    check(r.body.weight_source === 'chain' && r.body.mints_in_wallet === 1, r.text);
    checkNoWeights(r.body.app, "the staked signer's app block"); // its own weight and stake above, not in the public block
    checkWriteCalls(c0, r);
    const cache = await d1Rows(`SELECT status, staked_raw, unstaking_raw, share_price, weight FROM skr_cache WHERE wallet = '${S.wallet}'`);
    check(cache.length === 1 && cache[0].status === 'ok' && cache[0].staked_raw === '11355880000' &&
      cache[0].unstaking_raw === '0' && cache[0].share_price === '1147028992' && cache[0].weight === S_WEIGHT, JSON.stringify(cache));
    const pdas = await d1Rows(`SELECT pda FROM wallet_pdas WHERE wallet = '${S.wallet}'`);
    check(pdas.length === 1 && pdas[0].pda === stakePdaOf(S.wallet), JSON.stringify(pdas));
  });

  await scenario('second vouch from the staked wallet inside 60 s -> weight_source cache, weight 3.06, staked_skr 11355.88, only the SGT pair reaches the chain', async () => {
    await waitSlot(S);
    const c0 = fake.counts();
    const r = await post(vouch(S, 's2.place'));
    expectStatus(r, 200);
    markAccepted(S);
    check(r.body.weight_source === 'cache', `weight_source ${r.body.weight_source} (more than 60 s since the first read?)`);
    check(r.body.weight === S_WEIGHT && r.body.staked_skr === S_SKR, r.text);
    checkWriteCalls(c0, r);
  });

  await scenario('a second Genesis Token in the staked wallet -> mints_in_wallet 2, weight 2.76 = sharedStakeWeight(11355.88, 2) on the new row and on every earlier row of the wallet', async () => {
    await waitSlot(S);
    const c0 = fake.counts();
    const r = await post(vouch(S, 's3.place', { mint: S_MINT2 }));
    expectStatus(r, 200);
    markAccepted(S);
    check(r.body.mints_in_wallet === 2 && r.body.weight === S_WEIGHT_2 && r.body.staked_skr === S_SKR, r.text);
    checkWriteCalls(c0, r);
    const rows = await d1Rows(`SELECT package, weight, staked_skr FROM vouches WHERE wallet = '${S.wallet}' ORDER BY package`);
    check(rows.length === 3 && rows.every((x) => x.weight === S_WEIGHT_2 && x.staked_skr === S_SKR), JSON.stringify(rows));
  });

  await scenario('malformed stake replies (value one entry short; a 168-byte UserStake) -> 200, weight 1, staked_skr null, weight_source error, nothing cached', async () => {
    for (const o of [MS, ML]) {
      const c0 = fake.counts();
      const r = await post(vouch(o, 'mal.place'));
      expectStatus(r, 200);
      markAccepted(o);
      check(r.body.weight === 1 && r.body.vouch?.weight === 1, `weight ${r.body.weight}`);
      check(r.body.staked_skr === null && r.body.vouch?.staked_skr === null && r.body.weight_source === 'error', r.text);
      checkWriteCalls(c0, r);
    }
    const cached = await d1Rows(`SELECT wallet FROM skr_cache WHERE wallet IN ('${MS.wallet}', '${ML.wallet}')`);
    check(cached.length === 0, `an unknown read was cached: ${JSON.stringify(cached)}`);
  });

  await scenario('lamports sent to a UserStake PDA (a bare System account, 0 bytes) -> no position: weight 1, staked_skr 0, weight_source chain, cached as none; the next vouch inside 60 s is served from the cache', async () => {
    let c0 = fake.counts();
    const r = await post(vouch(SY, 'sys.place'));
    expectStatus(r, 200);
    markAccepted(SY);
    check(r.body.weight === 1 && r.body.staked_skr === 0 && r.body.weight_source === 'chain', r.text);
    checkWriteCalls(c0, r);
    const cache = await d1Rows(`SELECT status, staked_raw, weight FROM skr_cache WHERE wallet = '${SY.wallet}'`);
    check(cache.length === 1 && cache[0].status === 'none' && cache[0].staked_raw === '0' && cache[0].weight === 1, JSON.stringify(cache));
    await waitSlot(SY);
    c0 = fake.counts();
    const r2 = await post(vouch(SY, 'sys2.place'));
    expectStatus(r2, 200);
    markAccepted(SY);
    check(r2.body.weight === 1 && r2.body.staked_skr === 0 && r2.body.weight_source === 'cache', r2.text);
    checkWriteCalls(c0, r2);
  });

  await scenario("the staked wallet's stake read fails (same Genesis Token, new package) -> 200 at 1.00x with staked_skr null and weight_source error; its earlier rows keep 2.76 and 11,355.88", async () => {
    fake.register({ badStakes: [[S.wallet, 'length']] });                 // S's UserStake now comes back 168 bytes
    await d1(`DELETE FROM skr_cache WHERE wallet = '${S.wallet}'`);        // so the next vouch reads the chain
    await waitSlot(S);
    const c0 = fake.counts();
    const r = await post(vouch(S, 's4.place'));
    expectStatus(r, 200);
    markAccepted(S);
    check(r.body.weight === 1 && r.body.staked_skr === null && r.body.weight_source === 'error' && r.body.mints_in_wallet === 2, r.text);
    checkWriteCalls(c0, r);
    const rows = await d1Rows(`SELECT package, weight, staked_skr FROM vouches WHERE wallet = '${S.wallet}' ORDER BY package`);
    const want = [['s1.place', S_WEIGHT_2, S_SKR], ['s2.place', S_WEIGHT_2, S_SKR], ['s3.place', S_WEIGHT_2, S_SKR], ['s4.place', 1, null]];
    check(JSON.stringify(rows.map((x) => [x.package, x.weight, x.staked_skr])) === JSON.stringify(want), JSON.stringify(rows));
  });

  await scenario("a third Genesis Token in the staked wallet while its read still fails -> the new row 1.00x; the earlier good rows re-divided from their stored stake by 3 (2.76 -> 2.59), the failed row stays 1.00x", async () => {
    await waitSlot(S);
    const c0 = fake.counts();
    const r = await post(vouch(S, 's5.place', { mint: S_MINT3 }));
    expectStatus(r, 200);
    markAccepted(S);
    check(r.body.weight === 1 && r.body.staked_skr === null && r.body.weight_source === 'error' && r.body.mints_in_wallet === 3, r.text);
    checkWriteCalls(c0, r);
    const w3 = sharedStakeWeight(S_SKR, 3);
    check(w3 === 2.59, `sharedStakeWeight(${S_SKR}, 3) = ${w3}`);
    const rows = await d1Rows(`SELECT package, weight, staked_skr FROM vouches WHERE wallet = '${S.wallet}' ORDER BY package`);
    const want = [['s1.place', w3, S_SKR], ['s2.place', w3, S_SKR], ['s3.place', w3, S_SKR], ['s4.place', 1, null], ['s5.place', 1, null]];
    check(JSON.stringify(rows.map((x) => [x.package, x.weight, x.staked_skr])) === JSON.stringify(want), JSON.stringify(rows));
  });

  await scenario("public /vouch/app of the staked owner's package: the recent note carries no weight and no stake, the app block no weighted total", async () => {
    const r = await get('/vouch/app/s1.place');
    expectStatus(r, 200);
    check(r.body.recent.length === 1 && r.body.recent[0].note === 'Staked owner, works fine.', r.text);
    check(!('weight' in r.body.recent[0]) && !('staked_skr' in r.body.recent[0]), JSON.stringify(r.body.recent[0]));
    check(r.body.app.voices === 1 && !('weight_works' in r.body.app) && !('weight_broken' in r.body.app), JSON.stringify(r.body.app));
    check(!r.text.includes(S.wallet) && !r.text.includes(S.mint) && !/"(staked_skr|weight)":/.test(r.text), r.text);
    checkNoWeights(r.text, '/vouch/app/s1.place');
  });

  await scenario('ordering still follows weight with the totals gone: on /vouch/aggregate the 2.59x one-voice packages rank above a two-voice 1.00x package; on /vouch/top a 2.59x one-voice package ranks above 1.00x one-voice packages that sort first', async () => {
    const stored = await d1Rows("SELECT package, weight FROM vouches WHERE package IN ('s1.place', 's3.place', 'mal.place', 'b.place') AND excluded = 0 ORDER BY package, weight");
    const w = (p) => stored.filter((x) => x.package === p).map((x) => x.weight);
    check(JSON.stringify([w('s1.place'), w('s3.place'), w('mal.place'), w('b.place')]) === JSON.stringify([[2.59], [2.59], [1, 1], [1]]),
      `stored weights ${JSON.stringify(stored)}`);
    const agg = await get('/vouch/aggregate');
    expectStatus(agg, 200);
    checkNoWeights(agg.text, '/vouch/aggregate');
    const pk = agg.body.apps.map((x) => x.package);
    const voicesOf = (p) => agg.body.apps.find((x) => x.package === p)?.voices;
    check(voicesOf('mal.place') === 2 && voicesOf('s1.place') === 1 && voicesOf('s3.place') === 1 && voicesOf('aa.a') === 1,
      `voices ${JSON.stringify(['mal.place', 's1.place', 's3.place', 'aa.a'].map(voicesOf))}`);
    check(pk[0] === chipPkg, `aggregate head ${JSON.stringify(pk.slice(0, 6))}`);
    for (const heavy of ['s1.place', 's3.place']) {
      check(pk.indexOf(heavy) > 0 && pk.indexOf(heavy) < pk.indexOf('mal.place') && pk.indexOf(heavy) < pk.indexOf('aa.a'),
        `${heavy} does not rank by weight: ${JSON.stringify(pk.slice(0, 12))}`);
    }
    const top = await get('/vouch/top');
    expectStatus(top, 200);
    checkNoWeights(top.text, '/vouch/top');
    const tk = top.body.apps.map((x) => x.package);
    const weekOf = (p) => top.body.apps.find((x) => x.package === p)?.voices_week;
    check(weekOf('s3.place') === 1 && weekOf('b.place') === 1 && weekOf('zz.real') === 1, `voices_week ${JSON.stringify(top.body.apps.map((x) => [x.package, x.voices_week]))}`);
    check(tk.indexOf('s3.place') >= 0 && tk.indexOf('s3.place') < tk.indexOf('b.place') && tk.indexOf('s3.place') < tk.indexOf('zz.real'),
      `s3.place does not rank by weight on /vouch/top: ${JSON.stringify(tk)}`);
  });

  // ---- D16: the hourly re-weight cron through the runtime's scheduled route -------------------
  // Fixed instants of NEXT UTC week, so the week keys are known and every write of this run comes
  // before the tick (a tick leaves rows stamped or written after its scheduled time alone, skr.js
  // VOUCH_RESTAMP): Wednesday 12:07Z (no drift check, no closed-week grace) and the Monday after it,
  // 03:07Z (drift check; that week closed 3 hours before).
  const wk = weekBounds(new Date(Date.parse(weekBounds(new Date()).end) + 86_400_000));
  const WED_MS = Date.parse(wk.start) + 2 * 86_400_000 + (12 * 60 + 7) * 60_000;
  const MON_MS = Date.parse(wk.end) + (3 * 60 + 7) * 60_000;
  const WEEK = isoWeek(new Date(WED_MS));
  const SHARE_PRICE = 1147028992n;     // the fixture StakeConfig the fake serves
  const skrOfShares = (shares) => Number((BigInt(shares) * SHARE_PRICE) / 1_000_000_000n) / 1e6;
  const V = newOwner();                // votes this week at 3.66, nothing staked at the tick
  const U = newOwner();                // votes this week at 3.66, unstakes before the week closes
  const P = newOwner();                // votes this week at 3.66, unstakes after the week closes
  const tsNow = isoAt();
  const voteRow = (week, o, weight, staked) =>
    `('${week}', '${o.mint}', '${o.wallet}', 'x.place', ${weight}, ${staked}, 'sig', '${tsNow}', '${tsNow}', '${tsNow}')`;
  const insertVotes = (rows) => d1('INSERT INTO votes (week, genesis_mint, wallet, package, weight, staked_skr, signature, ' +
    `signed_ts, created_at, updated_at) VALUES ${rows.join(', ')}`);
  const trigger = (ms) => call('GET', `/cdn-cgi/local/scheduled?cron=${encodeURIComponent('7 * * * *')}&time=${ms}&format=json`);
  const snapshot = async () => JSON.stringify([
    await d1Rows('SELECT id, weight, staked_skr, weight_checked_at FROM vouches ORDER BY id'),
    await d1Rows('SELECT week, genesis_mint, weight, staked_skr FROM votes ORDER BY week, genesis_mint'),
    await d1Rows('SELECT wallet, status, staked_raw, checked_at FROM skr_cache ORDER BY wallet'),
  ]);
  /** Rows once `ok(rows)` holds: work under ctx.waitUntil may still run when the route answers. */
  async function rowsWhen(sql, ok, tries = 5) {
    let rows;
    for (let i = 0; i < tries; i++) {
      rows = await d1Rows(sql);
      if (ok(rows)) return rows;
      await sleep(1000);
    }
    return rows;
  }
  /** Fake RPC calls per method since c0, once at least `min` getMultipleAccounts calls have landed. */
  async function callsSince(c0, min) {
    for (let i = 0; i < 20; i++) {
      const c1 = fake.counts();
      if ((c1.byMethod.getMultipleAccounts || 0) - (c0.byMethod.getMultipleAccounts || 0) >= min) break;
      await sleep(250);
    }
    const c1 = fake.counts();
    return (m) => (c1.byMethod[m] || 0) - (c0.byMethod[m] || 0);
  }
  const triggered = (r) => {
    expectStatus(r, 200);
    check(r.body?.outcome === 'ok', `scheduled outcome ${r.text}`);
  };

  await scenario('cron tick, Wednesday 12:07Z: a short getMultipleAccounts reply (MS is still in the call) changes no row and caches nothing; one stake read, no drift check', async () => {
    const before = await snapshot();
    const c0 = fake.counts();
    triggered(await trigger(WED_MS));
    const d = await callsSince(c0, 1);
    check(d('getMultipleAccounts') === 1 && d('getAccountInfo') === 0, `calls +${d('getMultipleAccounts')} getMultipleAccounts, +${d('getAccountInfo')} getAccountInfo`);
    await sleep(1000);
    check((await snapshot()) === before, 'a tick with a short reply changed a row');
  });

  await scenario("cron tick, Wednesday 12:07Z: S's stake doubles, so all five of its rows (the two its failed reads stamped 1.00x included) rise to sharedStakeWeight(22,711.76, 3); V's 3.66 vote with nothing staked falls to 1.00; S's 1.00 vote is not raised; ML's failed read leaves its rows as they were", async () => {
    const s2Shares = String(BigInt(S_SHARES) * 2n);
    const s2Skr = skrOfShares(s2Shares);
    const want = sharedStakeWeight(s2Skr, 3);
    check(Math.abs(s2Skr - 22711.76) < 0.01 && want === 2.88, `stake ${s2Skr}, weight ${want}`);
    fake.register({ stakes: [[S.wallet, { shares: s2Shares }], [MS.wallet, { shares: '0' }]] }); // MS: no position now, no short reply
    await insertVotes([voteRow(WEEK, V, 3.66, 45881.15968), voteRow(WEEK, S, 1, 0)]);
    const mlSql = `SELECT id, weight, staked_skr, weight_checked_at FROM vouches WHERE wallet = '${ML.wallet}' ORDER BY id`;
    const mlBefore = JSON.stringify(await d1Rows(mlSql));
    const c0 = fake.counts();
    triggered(await trigger(WED_MS));
    const d = await callsSince(c0, 1);
    check(d('getMultipleAccounts') === 1 && d('getAccountInfo') === 0, `calls +${d('getMultipleAccounts')}/+${d('getAccountInfo')}`);
    const wedIso = new Date(WED_MS).toISOString();
    const rows = await rowsWhen(`SELECT package, weight, staked_skr, weight_checked_at FROM vouches WHERE wallet = '${S.wallet}' ORDER BY package`,
      (x) => x.length === 5 && x.every((y) => y.weight === want));
    check(rows.length === 5 && rows.every((x) => x.weight === want && x.staked_skr === s2Skr && x.weight_checked_at === wedIso), JSON.stringify(rows));
    const votes = await d1Rows(`SELECT wallet, weight, staked_skr FROM votes WHERE week = '${WEEK}'`);
    const vote = (o) => votes.find((x) => x.wallet === o.wallet);
    check(vote(V)?.weight === 1 && vote(V)?.staked_skr === 0, `V ${JSON.stringify(vote(V))}`);
    check(vote(S)?.weight === 1, `S ${JSON.stringify(vote(S))}`);
    check(JSON.stringify(await d1Rows(mlSql)) === mlBefore, "ML's rows moved on a failed read");
    const ms = await d1Rows(`SELECT weight, staked_skr FROM vouches WHERE wallet = '${MS.wallet}'`);
    check(ms.length === 1 && ms[0].weight === 1 && ms[0].staked_skr === 0, `MS ${JSON.stringify(ms)}`);
    const qNull = await d1Rows(`SELECT COUNT(*) AS n FROM vouches WHERE wallet = '${Q.wallet}' AND staked_skr IS NULL`);
    check(qNull[0].n === 0, `Q rows with no stake stamped: ${qNull[0].n}`);
    const cache = await d1Rows(`SELECT wallet, status, staked_raw, checked_at FROM skr_cache WHERE wallet IN ('${S.wallet}', '${V.wallet}', '${ML.wallet}')`);
    const cs = cache.find((x) => x.wallet === S.wallet);
    check(cs?.status === 'ok' && cs.staked_raw === String((BigInt(s2Shares) * SHARE_PRICE) / 1_000_000_000n) && cs.checked_at === wedIso, JSON.stringify(cache));
    check(cache.find((x) => x.wallet === V.wallet)?.status === 'none' && !cache.some((x) => x.wallet === ML.wallet), JSON.stringify(cache));
  });

  await scenario("cron tick, next Monday 03:07Z: the drift check reads the pinned deploy slot and pool; this week, now closed, demotes U (unstake begun before the close) and spares P (begun after it); S's stake is gone, so its vouches fall to 1.00", async () => {
    const closeMs = Date.parse(wk.end);
    const unstake = (o, atMs) => [o.wallet, { shares: '0', unstaking: '45881159680', unstakeTs: String(Math.floor(atMs / 1000)) }];
    fake.register({ stakes: [unstake(U, closeMs - 30 * 60_000), unstake(P, closeMs + 60 * 60_000), [S.wallet, { shares: '0' }]] });
    await insertVotes([voteRow(WEEK, U, 3.66, 45881.15968), voteRow(WEEK, P, 3.66, 45881.15968)]);
    const c0 = fake.counts();
    triggered(await trigger(MON_MS));
    const d = await callsSince(c0, 2);
    check(d('getAccountInfo') === 1 && d('getMultipleAccounts') === 2, `calls +${d('getAccountInfo')} getAccountInfo (ProgramData), +${d('getMultipleAccounts')} getMultipleAccounts (stakes, pools)`);
    const votes = await rowsWhen(`SELECT wallet, weight FROM votes WHERE week = '${WEEK}'`,
      (x) => x.find((y) => y.wallet === U.wallet)?.weight === 1);
    const w = (o) => votes.find((x) => x.wallet === o.wallet)?.weight;
    check(w(U) === 1 && w(P) === 3.66 && w(V) === 1 && w(S) === 1, `votes U ${w(U)}, P ${w(P)}, V ${w(V)}, S ${w(S)}`);
    const rows = await rowsWhen(`SELECT weight, staked_skr FROM vouches WHERE wallet = '${S.wallet}'`, (x) => x.every((y) => y.weight === 1));
    check(rows.length === 5 && rows.every((x) => x.weight === 1 && x.staked_skr === 0), JSON.stringify(rows));
  });
}

// ---- Lounge chat replies (migrations/003_chat_replies.sql) -------------------------------------
// Three new owners (CX, CY, CZ) claim numbers and sign in to chat the way the app does. Every
// count below is exact on a re-run: new owners get new numbers, and every read starts after S0,
// the highest message id before this section. The helpers live inside runChat: the module's
// top-level code runs (and exits) before any const declared down here would be initialised.
async function runChat() {
  const DASH = String.fromCharCode(0x2014);
  const NL = String.fromCharCode(10);
  /** index.js claimMessage: POST /claim and POST /chat/auth verify the same string. */
  const claimMessage = (w, m, ts) => `Seeker Scout ${DASH} Owners' Lounge claim${NL}wallet: ${w}${NL}mint: ${m}${NL}ts: ${ts}`;
  const claimBody = (o) => {
    const ts = isoAt();
    return { wallet: o.wallet, mint: o.mint, ts, signature: base58.encode(ed.sign(new TextEncoder().encode(claimMessage(o.wallet, o.mint, ts)), o.priv)) };
  };
  const CHAT_RATE_MS = 4000; // chat.js RATE_MS
  const lastChat = new Map();
  const bearer = (o) => ({ authorization: `Bearer ${o.token}` });
  /** POST /chat/send, after this wallet's 4 s slot has passed. */
  const chatSend = async (o, body) => {
    const wait = (lastChat.get(o.wallet) ?? 0) + CHAT_RATE_MS + 300 - Date.now();
    if (wait > 0) await sleep(wait);
    const r = await call('POST', '/chat/send', body, bearer(o));
    if (r.status === 200) lastChat.set(o.wallet, Date.now());
    return r;
  };
  const idsOf = (list) => JSON.stringify(list.map((x) => x.id));
  const maxMessageId = async () => (await d1Rows('SELECT COALESCE(MAX(id), 0) AS mx FROM messages'))[0].mx;

  const CX = newOwner();
  const CY = newOwner();
  const CZ = newOwner();
  const chatters = [CX, CY, CZ];
  fake.register({ sgt: chatters.map((o) => o.mint), holders: chatters.map((o) => [o.wallet, o.mint]) });
  const FIRE = String.fromCodePoint(0x1f525); // one of chat.js REACTIONS
  const ids = {};
  let S0 = 0;

  await scenario('chat setup: messages.reply_to is on the local D1; three owners claim numbers (POST /claim) and get chat tokens (POST /chat/auth); /stats counts the claims', async () => {
    const cols = (await d1Rows('PRAGMA table_info(messages)')).map((c) => c.name);
    check(cols.includes('reply_to'), `messages has no reply_to (${cols.join(',')}): run npm run migrate:chat:local once`);
    const idx = await d1Rows("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_reply_to'");
    check(idx.length === 1, 'idx_messages_reply_to is missing');
    const before = await get('/stats');
    expectStatus(before, 200);
    for (const o of chatters) {
      const ip = { 'cf-connecting-ip': ipOf.get(o.wallet) };
      const c = await call('POST', '/claim', claimBody(o), ip);
      expectStatus(c, 200);
      check(Number.isInteger(c.body.number) && c.body.number >= 1, `claim ${c.text}`);
      o.number = c.body.number;
      const a = await call('POST', '/chat/auth', claimBody(o), ip);
      expectStatus(a, 200);
      check(typeof a.body.token === 'string' && a.body.number === o.number && a.body.tier === c.body.tier, `auth ${a.text}`);
      o.token = a.body.token;
    }
    const s = await get('/stats');
    expectStatus(s, 200);
    check(s.body.total === before.body.total + 3 && s.body.founding === Math.min(s.body.total, 100),
      `stats ${s.text}, before ${before.text}`);
    S0 = await maxMessageId();
  });

  await scenario('chat: a plain message -> 200, reply_to null and reply null; a token signed with another secret -> 401', async () => {
    const forged = await issueToken(`not-the-worker-secret-${Math.random()}`,
      { number: CX.number, wallet: CX.wallet, tier: 'member', exp: Date.now() + 60_000 });
    expectStatus(await call('POST', '/chat/send', { text: 'forged' }, { authorization: `Bearer ${forged}` }), 401, 'not authenticated');
    const r = await chatSend(CX, { text: 'gm from X' });
    expectStatus(r, 200);
    const m = r.body.message;
    check(Object.keys(m).join() === 'id,number,tier,text,created_at,reply_to,reply', Object.keys(m).join());
    check(m.number === CX.number && m.text === 'gm from X' && m.reply_to === null && m.reply === null, r.text);
    ids.x1 = m.id;
  });

  await scenario('chat: Y replies to X -> 200 with reply_to and reply {id, number, text}; /chat/messages carries both on every row', async () => {
    const r = await chatSend(CY, { text: 'gm X, from Y', reply_to: ids.x1 });
    expectStatus(r, 200);
    const m = r.body.message;
    check(m.reply_to === ids.x1 && JSON.stringify(m.reply) === JSON.stringify({ id: ids.x1, number: CX.number, text: 'gm from X' }), r.text);
    ids.y1 = m.id;
    const list = await get(`/chat/messages?since=${S0}`);
    expectStatus(list, 200);
    check(idsOf(list.body.messages) === JSON.stringify([ids.x1, ids.y1]), `ids ${idsOf(list.body.messages)}`);
    for (const x of list.body.messages) {
      check(Object.keys(x).join() === 'id,number,tier,text,created_at,reply_to,reply,reactions', Object.keys(x).join());
    }
    const [x1, y1] = list.body.messages;
    check(x1.reply_to === null && x1.reply === null, JSON.stringify(x1));
    check(y1.reply_to === ids.x1 && JSON.stringify(y1.reply) === JSON.stringify(m.reply), JSON.stringify(y1));
  });

  await scenario("chat: reply_to 0, -1, 1.5, a numeric string, true, or an id past the last message -> 400 'bad reply', no row written, no slot spent", async () => {
    const mx = await maxMessageId();
    for (const bad of [0, -1, 1.5, String(ids.x1), true, mx + 1000]) {
      expectStatus(await call('POST', '/chat/send', { text: 'bad', reply_to: bad }, bearer(CZ)), 400, 'bad reply');
    }
    const after = await maxMessageId();
    check(after === mx, `rows written: max id ${mx} -> ${after}`);
    const r = await call('POST', '/chat/send', { text: 'Z on X, straight after six refusals', reply_to: ids.x1 }, bearer(CZ));
    expectStatus(r, 200); // no wait: a refused reply took no slot
    lastChat.set(CZ.wallet, Date.now());
    ids.z1 = r.body.message.id;
  });

  await scenario('chat: a reply quotes its parent cut to 100 UTF-16 units, never half an emoji; the parent row stays whole', async () => {
    const long = 'a'.repeat(99) + String.fromCodePoint(0x1f680) + ' and the rest of a long message';
    const p = await chatSend(CX, { text: long });
    expectStatus(p, 200);
    ids.x2 = p.body.message.id;
    const r = await chatSend(CY, { text: 'long one', reply_to: ids.x2 });
    expectStatus(r, 200);
    ids.y2 = r.body.message.id;
    check(JSON.stringify(r.body.message.reply) === JSON.stringify({ id: ids.x2, number: CX.number, text: 'a'.repeat(99) }), r.text);
    const list = await get(`/chat/messages?since=${ids.x2 - 1}`);
    const byId = new Map(list.body.messages.map((x) => [x.id, x]));
    check(byId.get(ids.x2)?.text === long, 'the parent row was cut');
    check(byId.get(ids.y2)?.reply?.text === 'a'.repeat(99), JSON.stringify(byId.get(ids.y2)));
  });

  await scenario('chat: a parent hidden by three reports -> its reply shows reply {id, hidden: true}, no number, no text; a new reply to it -> 400', async () => {
    const p = await chatSend(CX, { text: 'this one gets reported' });
    expectStatus(p, 200);
    ids.x3 = p.body.message.id;
    const r = await chatSend(CZ, { text: 'reply before the reports', reply_to: ids.x3 });
    expectStatus(r, 200);
    ids.z3 = r.body.message.id;
    for (const o of chatters) {
      expectStatus(await call('POST', '/chat/report', { messageId: ids.x3 }, bearer(o)), 200);
    }
    const list = await get(`/chat/messages?since=${ids.x3 - 1}`);
    expectStatus(list, 200);
    check(!list.body.messages.some((x) => x.id === ids.x3), 'the reported parent is still listed');
    const z3 = list.body.messages.find((x) => x.id === ids.z3);
    check(z3?.reply_to === ids.x3 && JSON.stringify(z3.reply) === JSON.stringify({ id: ids.x3, hidden: true }), JSON.stringify(z3));
    check(!list.text.includes('this one gets reported'), 'the hidden text left through a reply');
    expectStatus(await chatSend(CY, { text: 'too late', reply_to: ids.x3 }), 400, 'bad reply');
  });

  await scenario("/chat/replies: X's number lists only others' replies to X's visible messages, newest first, count 3 (X's self-reply, the reply to its hidden message and replies to Y are left out); public, Cache-Control public, max-age=30", async () => {
    let r = await chatSend(CX, { text: 'adding to my own', reply_to: ids.x1 });
    expectStatus(r, 200);
    r = await chatSend(CZ, { text: 'Z on Y', reply_to: ids.y1 });
    expectStatus(r, 200);
    ids.zy = r.body.message.id;
    r = await chatSend(CX, { text: 'X on Y', reply_to: ids.y1 });
    expectStatus(r, 200);
    ids.xy = r.body.message.id;
    const rx = await get(`/chat/replies?to=${CX.number}&since=${S0}`);
    expectStatus(rx, 200);
    check(rx.headers.get('cache-control') === 'public, max-age=30', `cache-control ${rx.headers.get('cache-control')}`);
    check(Object.keys(rx.body).join() === 'latestId,count,replies', Object.keys(rx.body).join());
    check(idsOf(rx.body.replies) === JSON.stringify([ids.y2, ids.z1, ids.y1]) && rx.body.count === 3 && rx.body.latestId === ids.y2, rx.text);
    for (const x of rx.body.replies) check(Object.keys(x).join() === 'id,number,text,created_at,reply_to', Object.keys(x).join());
    const y1 = rx.body.replies[2];
    check(y1.number === CY.number && y1.reply_to === ids.x1 && y1.text === 'gm X, from Y' && typeof y1.created_at === 'string', JSON.stringify(y1));
    check(chatters.every((o) => !rx.text.includes(o.wallet)), 'a wallet left through /chat/replies');
    const ry = await get(`/chat/replies?to=${CY.number}&since=${S0}`);
    check(idsOf(ry.body.replies) === JSON.stringify([ids.xy, ids.zy]) && ry.body.count === 2 && ry.body.latestId === ids.xy, ry.text);
    const rz = await get(`/chat/replies?to=${CZ.number}&since=${S0}`);
    check(JSON.stringify(rz.body) === JSON.stringify({ latestId: S0, count: 0, replies: [] }), rz.text);
  });

  await scenario('/chat/replies since: only replies newer than since; at the newest one, count 0 and latestId = since; a reply hidden by reports leaves the list', async () => {
    let r = await get(`/chat/replies?to=${CX.number}&since=${ids.y1}`);
    check(idsOf(r.body.replies) === JSON.stringify([ids.y2, ids.z1]) && r.body.count === 2 && r.body.latestId === ids.y2, r.text);
    r = await get(`/chat/replies?to=${CX.number}&since=${ids.y2}`);
    check(JSON.stringify(r.body) === JSON.stringify({ latestId: ids.y2, count: 0, replies: [] }), r.text);
    for (const o of chatters) expectStatus(await call('POST', '/chat/report', { messageId: ids.y2 }, bearer(o)), 200);
    r = await get(`/chat/replies?to=${CX.number}&since=${S0}`);
    check(idsOf(r.body.replies) === JSON.stringify([ids.z1, ids.y1]) && r.body.count === 2 && r.body.latestId === ids.z1, r.text);
  });

  await scenario('/chat/replies count cap: 120 more replies to X (seeded, d1 --local) -> count 99, the 20 newest listed newest first, latestId the newest', async () => {
    await d1('WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 120) ' +
      'INSERT INTO messages (number, wallet, tier, text, created_at, reply_to) ' +
      `SELECT ${CZ.number}, '${CZ.wallet}', 'member', 'seeded reply ' || i, '${isoAt()}', ${ids.x1} FROM s`);
    const seeded = (await d1Rows(`SELECT id FROM messages WHERE wallet = '${CZ.wallet}' AND text LIKE 'seeded reply %' ORDER BY id DESC`)).map((x) => x.id);
    check(seeded.length === 120, `seeded ${seeded.length}`);
    let r = await get(`/chat/replies?to=${CX.number}&since=${S0}`);
    expectStatus(r, 200);
    check(r.body.count === 99 && r.body.replies.length === 20 && r.body.latestId === seeded[0], `count ${r.body.count}, listed ${r.body.replies.length}, latestId ${r.body.latestId}`);
    check(idsOf(r.body.replies) === JSON.stringify(seeded.slice(0, 20)), idsOf(r.body.replies));
    r = await get(`/chat/replies?to=${CX.number}&since=${seeded[30]}`);
    check(r.body.count === 30 && r.body.replies.length === 20 && r.body.latestId === seeded[0], `since ${seeded[30]}: count ${r.body.count}`);
  });

  await scenario("/chat/replies bad params -> 400 'bad to' (missing, 0, 1000001, abc, 1.5, -3) and 'bad since' (missing, empty, -1, abc, 2.5)", async () => {
    for (const qs of ['', 'since=0', 'to=0', 'to=1000001', 'to=abc', 'to=1.5', 'to=-3']) {
      expectStatus(await get(`/chat/replies?${qs}`), 400, 'bad to');
    }
    expectStatus(await get(`/chat/replies?to=${CX.number}`), 400, 'bad since');
    for (const qs of ['since=', 'since=-1', 'since=abc', 'since=2.5']) {
      expectStatus(await get(`/chat/replies?to=${CX.number}&${qs}`), 400, 'bad since');
    }
  });

  await scenario('regression: /chat/latest, /chat/react on a reply (toggle), /chat/messages paging, /stats, /flags and /vouch/top keep their shapes', async () => {
    const latest = await get(`/chat/latest?since=${S0}`);
    expectStatus(latest, 200);
    const visible = (await d1Rows(`SELECT COALESCE(MAX(id), 0) AS mx, COUNT(*) AS n FROM messages WHERE hidden = 0 AND id > ${S0}`))[0];
    check(latest.body.latestId === visible.mx && latest.body.newCount === visible.n, `latest ${latest.text}, want ${JSON.stringify(visible)}`);
    const react = await call('POST', '/chat/react', { messageId: ids.z1, emoji: FIRE }, bearer(CX));
    expectStatus(react, 200);
    check(react.body.messageId === ids.z1 && react.body.reactions[FIRE] === 1 && react.body.mine.join() === FIRE, react.text);
    const undo = await call('POST', '/chat/react', { messageId: ids.z1, emoji: FIRE }, bearer(CX));
    check(undo.status === 200 && Object.keys(undo.body.reactions).length === 0 && undo.body.mine.length === 0, undo.text);
    const page = await get('/chat/messages?since=0');
    expectStatus(page, 200);
    check(page.body.messages.length === 50 && page.body.messages.every((x) => 'reply_to' in x && 'reply' in x && 'reactions' in x && !('mine' in x)),
      `page of ${page.body.messages.length}`);
    const mine = await call('GET', `/chat/messages?since=${ids.z1 - 1}`, undefined, bearer(CX));
    check(mine.status === 200 && mine.body.messages.every((x) => Array.isArray(x.mine)), 'a signed-in read lost mine');
    const s = await get('/stats');
    expectStatus(s, 200);
    check(Object.keys(s.body).join() === 'total,founding' && s.body.total >= 3, s.text);
    const f = await get('/flags');
    expectStatus(f, 200);
    check(f.body.vouch === true && f.body.vote === true && f.body.withdraw === false, f.text);
    const t = await get('/vouch/top');
    expectStatus(t, 200);
    check(Array.isArray(t.body.apps) && typeof t.body.week === 'string' && typeof t.body.start === 'string', t.text.slice(0, 200));
    checkNoWeights(t.text, '/vouch/top');
    const nope = await call('GET', '/chat/nope', undefined, bearer(CX));
    check(nope.status === 404 && nope.body?.error === 'not found', nope.text);
  });

  // Last, since it pushes every earlier reply out of /chat/replies (chat.js REPLIES_WINDOW).
  await scenario('/chat/replies window: 1,000 newer messages (seeded, d1 --local) push every reply to X out (count 0, latestId = the since asked); a new reply counts again, also from since=0', async () => {
    await d1('WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 1000) ' +
      'INSERT INTO messages (number, wallet, tier, text, created_at) ' +
      `SELECT ${CZ.number}, '${CZ.wallet}', 'member', 'window filler ' || i, '${isoAt()}' FROM s`);
    let r = await get(`/chat/replies?to=${CX.number}&since=${S0}`);
    check(JSON.stringify(r.body) === JSON.stringify({ latestId: S0, count: 0, replies: [] }), r.text);
    const fresh = await chatSend(CY, { text: 'Y on X, after the filler', reply_to: ids.x1 });
    expectStatus(fresh, 200);
    for (const since of [S0, 0]) {
      r = await get(`/chat/replies?to=${CX.number}&since=${since}`);
      check(r.body.count === 1 && r.body.latestId === fresh.body.message.id && idsOf(r.body.replies) === JSON.stringify([fresh.body.message.id]),
        `since ${since}: ${r.text}`);
    }
  });
}
