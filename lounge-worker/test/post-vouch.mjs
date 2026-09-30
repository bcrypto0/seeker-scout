// lounge-worker/test/post-vouch.mjs
// D3 hand check (SPEC-vouch 7.2): sign ONE real vouch tuple, POST it to a LOCAL
// wrangler dev, replay it, print every read. One assertion (owner decision
// 2026-09-30): no public body (/vouch/app, /vouch/aggregate, /vouch/top) and no
// `app` block of a POST answer carries a weight, a weighted total or a stake,
// while the signer's own answer keeps its weight, staked_skr and weight_source.
// It prints PASS or FAIL for that and exits 1 on FAIL; read the rest of the output.
// Refuses any worker or RPC URL that is not 127.0.0.1 / localhost.
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { base58 } from '@scure/base';
import { vouchMessage } from '../src/vouch-lib.js';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m)); // exactly as index.js:22

const WORKER = process.env.WORKER_URL || 'http://127.0.0.1:8787';
const FAKE = process.env.FAKE_RPC_URL || 'http://127.0.0.1:8899';
for (const u of [WORKER, FAKE]) {
  if (!['127.0.0.1', 'localhost'].includes(new URL(u).hostname)) throw new Error(`refusing non-local target ${u}`);
}

console.log([
  'Preconditions (local only):',
  '  npm run schema:local && npm run migrate:local && npm run migrate:skr:local',
  '  node test/fake-rpc.mjs                         (fake RPC on 127.0.0.1:8899)',
  '  npx wrangler dev --port 8787 --ip 127.0.0.1 --var RPC_URL:http://127.0.0.1:8899',
  `Worker ${WORKER}, fake RPC ${FAKE}`,
].join('\n'));

async function call(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
function show(label, r) {
  console.log(`\n== ${label} -> ${r.status}`);
  console.log(JSON.stringify(r.body, null, 2));
}

// Any JSON key naming a weight, a stake or a weighted share (weight_works, works_share_week, staked_skr, ...).
const WEIGHTY = /"[a-z_]*(weight|staked|share)[a-z_]*":/;
const problems = [];
function noWeights(label, value) {
  const m = WEIGHTY.exec(JSON.stringify(value ?? null));
  if (m) problems.push(`${label} carries ${m[0]}`);
}

const randomKey = ed.utils.randomPrivateKey ?? ed.utils.randomSecretKey;
const priv = randomKey();
const wallet = base58.encode(ed.getPublicKey(priv));
const mint = base58.encode(crypto.getRandomValues(new Uint8Array(32)));
show('fake POST /__register', await call(FAKE, 'POST', '/__register', { sgt: [mint], holders: [[wallet, mint]] }));

const hits0 = (await call(FAKE, 'GET', '/__hits')).body.hits;
const fields = {
  wallet, mint, ts: new Date().toISOString(), package: 'x.place', verdict: 'works',
  tags: ['wallet_ok'], note: 'Opens, connects and signs fine on my Seeker.',
};
const message = vouchMessage(fields);
console.log(`\n== signed message (${new TextEncoder().encode(message).length} bytes)\n${message}`);
const signature = base58.encode(ed.sign(new TextEncoder().encode(message), priv));
const payload = { ...fields, signature };

const first = await call(WORKER, 'POST', '/vouch', payload);
show('POST /vouch', first);
const hits1 = (await call(FAKE, 'GET', '/__hits')).body.hits;
console.log(`\nfake RPC hits caused by the first POST: ${hits1 - hits0} (expect 3: the SGT pair plus one SKR stake read)`);
if (hits1 === hits0) {
  console.log('STOP: /__hits did not move, so RPC_URL was not overridden.');
  console.log('Put RPC_URL=http://127.0.0.1:8899 in .dev.vars for this run (SPEC 10.2) and restart wrangler dev.');
}
const replay = await call(WORKER, 'POST', '/vouch', payload);
show('POST /vouch again, same payload (expect replayed:true)', replay);
const hits2 = (await call(FAKE, 'GET', '/__hits')).body.hits;
console.log(`\nfake RPC hits caused by the replay: ${hits2 - hits1} (expect 0)`);
const app = await call(WORKER, 'GET', '/vouch/app/x.place');
show('GET /vouch/app/x.place', app);
show('GET /vouch/mine?mint=<mint>', await call(WORKER, 'GET', `/vouch/mine?mint=${mint}`));
const aggregate = await call(WORKER, 'GET', '/vouch/aggregate');
show('GET /vouch/aggregate', aggregate);
const top = await call(WORKER, 'GET', '/vouch/top');
show('GET /vouch/top', top);
show('GET /flags', await call(WORKER, 'GET', '/flags'));
show('fake GET /__hits', await call(FAKE, 'GET', '/__hits'));

// The one assertion: public bodies and POST app blocks carry no weighted number; the signer keeps its own.
for (const [label, r] of [['POST /vouch', first], ['replay', replay]]) {
  if (r.status !== 200) { problems.push(`${label} -> ${r.status}`); continue; }
  noWeights(`${label} app block`, r.body?.app);
  for (const k of ['weight', 'staked_skr', 'weight_source']) {
    if (!(k in (r.body ?? {}))) problems.push(`${label} lost the signer's own ${k}`);
  }
}
for (const [label, r] of [['GET /vouch/app/x.place', app], ['GET /vouch/aggregate', aggregate], ['GET /vouch/top', top]]) {
  if (r.status !== 200) problems.push(`${label} -> ${r.status}`);
  else noWeights(label, r.body);
}
if (problems.length) {
  console.log(`\nFAIL weighted numbers in public bodies:\n  ${problems.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log('\nPASS no public body and no POST app block carries a weight, a weighted total or a stake; the signer\'s own answer keeps weight, staked_skr and weight_source');
}
