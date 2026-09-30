// lounge-worker/test/bench.mjs: CPU of one hourly re-weight tick (SPEC-skr-final 0.1 and 1.10).
// Workers Free gives a Cron Trigger 10 ms of CPU per invocation; waiting on D1 or fetch does not
// count. Here D1 and fetch answer in-process from pre-built data (every await resolves as a
// microtask), so the wall clock of a tick is the worker's own JS: the selection rows turned into a
// plan, PDA derivation for new wallets, JSON.parse of the getMultipleAccounts reply, base64 and
// UserStake decodes, the weights and the JSON write parameters. The stub's own work (building the
// reply text) happens before the clock starts.
// process.cpuUsage() on Windows ticks in steps of about 15.6 ms, so it is only reported as an
// average over many ticks. Cold runs: a fresh node process per run times its FIRST tick (code not
// yet compiled or optimised), with the scenario prepared by the parent so that no skr.js code runs
// before the clock starts in the child.
//   node test/bench.mjs            (warm and cold, all scenarios)
// No network, no D1, no wrangler: nothing leaves this process.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants, cpus, setPriority, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { base58, base64 } from '@scure/base';
import * as skr from '../src/skr.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/skr_fixtures.json', import.meta.url), 'utf8'));
const POOL0 = base58.decode(skr.GUARDIAN_POOLS[0]);
const NOW = '2026-09-30T12:07:00.000Z';                 // a Wednesday: no closed-week grace
const NOW_DRIFT = '2026-10-05T03:07:00.000Z';           // Monday 03:07Z: grace window and drift check

const wLE = (b, o, v, n) => { for (let i = 0; i < n; i++) { b[o + i] = Number(v & 0xffn); v >>= 8n; } };
const acct = (owner, bytes) => ({ data: [base64.encode(bytes), 'base64'], executable: false, lamports: 2067120, owner, rentEpoch: 0, space: bytes.length });

/** A scenario: selection rows as D1 returns them and the exact RPC replies keyed by request body. */
function buildScenario({ wallets: nWallets, derive = 0, voters = 20, cap = skr.REWEIGHT_DEFAULT, drift = false }) {
  const rows = [];
  const byPda = new Map();
  const pdaOf = new Map();
  for (let i = 0; i < nWallets; i++) {
    const wb = crypto.getRandomValues(new Uint8Array(32));
    const wallet = base58.encode(wb);
    const { address, bump } = skr.userStakePda(wb, POOL0);
    const pda = base58.encode(address);
    pdaOf.set(wallet, pda);
    const b = new Uint8Array(base64.decode(FX.accounts.sampleUserStake.dataBase64));
    b[8] = bump; b.set(wb, 41);
    wLE(b, 105, BigInt(1_000_000_000 + i * 7_919_000), 16);
    if (i % 7 === 0) { wLE(b, 153, 5_000_000n, 8); wLE(b, 161, 1_790_000_000n, 8); } // some pending unstakes
    byPda.set(pda, acct(skr.SKR_PROGRAM, b));
    const stored = i >= derive; // the first `derive` wallets have no wallet_pdas row
    rows.push({
      wallet, n_vouch: 1 + (i % 3 === 0 ? 1 : 0), n_cur: i < voters ? 1 : 0, n_closed: drift && i < voters ? 1 : 0,
      pool: stored ? skr.GUARDIAN_POOLS[0] : null, pda: stored ? pda : null, bump: stored ? bump : null,
    });
  }
  const config = acct(FX.accounts.stakeConfig.owner, base64.decode(FX.accounts.stakeConfig.dataBase64));
  const replies = [];
  const todo = rows.map((r) => r.wallet);  // every wallet is read: derive <= DERIVE_BUDGET
  for (let i = 0; i < todo.length; i += 99) {
    const addresses = [skr.STAKE_CONFIG, ...todo.slice(i, i + 99).map((w) => pdaOf.get(w))];
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [addresses, { encoding: 'base64', commitment: 'confirmed' }] });
    const value = addresses.map((a) => (a === skr.STAKE_CONFIG ? config : byPda.get(a)));
    replies.push([body, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: FX.slot }, value } })]);
  }
  if (drift) {
    const slot = new Uint8Array(8); wLE(slot, 0, BigInt(FX.program.deploySlot), 8);
    const pd = { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', data: [base64.encode(slot), 'base64'], executable: false, lamports: 1, rentEpoch: 0 };
    replies.push([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [skr.PROGRAM_DATA, { encoding: 'base64', dataSlice: { offset: 4, length: 8 } }] }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: FX.slot }, value: pd } })]);
    const pool = acct(FX.accounts.guardianPool.owner, base64.decode(FX.accounts.guardianPool.dataBase64));
    replies.push([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [skr.GUARDIAN_POOLS, { encoding: 'base64' }] }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: FX.slot }, value: [pool] } })]);
  }
  return { rows, replies, cap, drift, now: drift ? NOW_DRIFT : NOW };
}

/** env + fetch stub for a scenario; every await resolves in-process. */
function install(sc) {
  const replies = new Map(sc.replies);
  globalThis.fetch = async (_url, init) => {
    const text = replies.get(init.body);
    if (text === undefined) throw new Error('bench: unexpected request');
    return new Response(text);
  };
  const stmt = (sql) => ({
    bind: () => stmt(sql),
    first: async () => (sql.includes('settings') ? { value: '1' } : null),
    all: async () => ({ results: sc.rows, success: true }),
    run: async () => ({ success: true, meta: { changes: 0 } }),
  });
  const DB = { prepare: stmt, batch: async (s) => s.map(() => ({ success: true, meta: { changes: 1 } })) };
  return { RPC_URL: 'http://bench.invalid/', DB, REWEIGHT_MAX_WALLETS: String(sc.cap) };
}

const lines = [];
const quiet = () => { const o = console.log; console.log = (s) => lines.push(String(s).length); return () => { console.log = o; }; };

async function timeTick(env, sc) {
  const t = performance.now();
  const sum = await skr.reweightVouches(env, { now: new Date(sc.now), drift: sc.drift });
  const ms = performance.now() - t;
  if (sum.skipped || sum.unknown || sum.read !== sc.rows.length) throw new Error(`bench tick went wrong: ${JSON.stringify(sum)}`);
  return ms;
}

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f = (x) => x.toFixed(2);

// Less noise from other processes on a shared machine (this process and its children only).
try { setPriority(0, constants.priority.PRIORITY_ABOVE_NORMAL); } catch { /* best effort */ }

// ---- child mode: one cold tick of a prepared scenario, print the ms --------------------------
if (process.argv[2] === '--cold') {
  const sc = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const env = install(sc);
  // Node's Response and AbortSignal.timeout are JavaScript (undici) that loads on first use; on
  // Workers both are native. Warm those two only, so the clock sees skr.js, rpc.js and their
  // libraries on their first run, as in a fresh isolate.
  await new Response('{"a":1}').json();
  AbortSignal.timeout(1);
  const restore = quiet();
  const ms = await timeTick(env, sc);
  restore();
  console.log(JSON.stringify({ ms }));
  process.exit(0);
}
// Reference: one ed25519 verify on its first run, which every POST /claim, /chat/auth, /alpha/auth
// and /vouch already performs in production (index.js verifyGenesisSig).
if (process.argv[2] === '--verify') {
  const ed = await import('@noble/ed25519');
  const { sha512 } = await import('@noble/hashes/sha512');
  ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));
  const { pub, sig, msg } = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const t = performance.now();
  const ok = ed.verify(Uint8Array.from(sig), new TextEncoder().encode(msg), Uint8Array.from(pub), { zip215: false });
  const ms = performance.now() - t;
  if (!ok) throw new Error('bench: verify failed');
  console.log(JSON.stringify({ ms }));
  process.exit(0);
}

// ---- parent mode --------------------------------------------------------------------------------
const SCENARIOS = [
  ['99 wallets, all PDAs stored (default tick)', { wallets: 99 }],
  ['99 wallets, 1 of them derives a PDA', { wallets: 99, derive: 1 }],
  [`99 wallets, ${skr.DERIVE_BUDGET} of them derive a PDA (DERIVE_BUDGET)`, { wallets: 99, derive: skr.DERIVE_BUDGET }],
  ['99 wallets + drift check (Monday 03:07Z, closed-week grace)', { wallets: 99, drift: true }],
  ['297 wallets (REWEIGHT_MAX_WALLETS = "297", Paid plan)', { wallets: 297, cap: 297 }],
];
const WARM = 60, WARMUP = 10, AVG = 300, COLD = 15;
const dir = mkdtempSync(join(tmpdir(), 'reweight-bench-'));
const self = fileURLToPath(import.meta.url);
const coldRuns = (args) => {
  const out = [];
  for (let i = 0; i < COLD; i++) {
    const r = spawnSync(process.execPath, [self, ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`cold run failed: ${r.stderr.slice(-400)}`);
    out.push(JSON.parse(r.stdout.trim().split('\n').pop()));
  }
  return out;
};
const spread = (xs) => `min ${f(Math.min(...xs))}, median ${f(pct(xs, 0.5))}, max ${f(Math.max(...xs))}`;
// Cold runs report wall clock only: process CPU time there also counts V8's helper threads
// (concurrent compilers, GC), which ran up to twice the wall clock in trials, and Windows reports it
// in steps of about 15.6 ms.
const coldLine = (runs) => spread(runs.map((x) => x.ms));
console.log(`node ${process.version}, ${process.platform}, ${cpus().length} x ${cpus()[0]?.model}; warm: ${WARMUP} warm-up + ${WARM} timed ticks; ` +
  `cpuUsage average over ${AVG} ticks; cold: ${COLD} fresh processes, first tick each`);
// Calibration against SPEC-skr-final 0.1, measured on this machine on 2026-09-11: one PDA
// derivation 0.26 to 0.31 ms warm. A higher number here means the machine is slower right now
// (load, power plan), and every number below is inflated by about that factor.
{
  const ws = Array.from({ length: 200 }, () => crypto.getRandomValues(new Uint8Array(32)));
  for (const w of ws.slice(0, 20)) skr.userStakePda(w, POOL0);
  const t = performance.now();
  for (const w of ws) skr.userStakePda(w, POOL0);
  const pdaMs = (performance.now() - t) / ws.length;
  console.log(`calibration: one PDA derivation ${f(pdaMs)} ms warm (0.26 to 0.31 ms on 2026-09-11): this run is about ${(pdaMs / 0.285).toFixed(1)}x that machine state`);
}
try {
  {
    const ed = await import('@noble/ed25519');
    const { sha512 } = await import('@noble/hashes/sha512');
    ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));
    const priv = ed.utils.randomPrivateKey();
    const msg = 'Seeker Scout bench message';
    const file = join(dir, 'sig.json');
    writeFileSync(file, JSON.stringify({ pub: [...ed.getPublicKey(priv)], sig: [...ed.sign(new TextEncoder().encode(msg), priv)], msg }));
    console.log(`reference, one ed25519 verify (every signed POST in production does one)\n  cold first call ms: ${coldLine(coldRuns(['--verify', file]))}`);
  }
  for (const [label, opts] of SCENARIOS) {
    const sc = buildScenario(opts);
    const env = install(sc);
    const restore = quiet();
    for (let i = 0; i < WARMUP; i++) await timeTick(env, sc);
    const warm = [];
    for (let i = 0; i < WARM; i++) warm.push(await timeTick(env, sc));
    const c0 = process.cpuUsage();
    for (let i = 0; i < AVG; i++) await timeTick(env, sc);
    const c1 = process.cpuUsage(c0);
    restore();
    const file = join(dir, 'scenario.json');
    writeFileSync(file, JSON.stringify(sc));
    const cold = coldRuns(['--cold', file]);
    console.log(`${label}\n  warm ms: ${spread(warm)}, p90 ${f(pct(warm, 0.9))}; cpuUsage avg ${f((c1.user + c1.system) / 1000 / AVG)} ms/tick` +
      `\n  cold first tick ms: ${coldLine(cold)}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
