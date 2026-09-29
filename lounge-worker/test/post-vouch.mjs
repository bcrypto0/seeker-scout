// lounge-worker/test/post-vouch.mjs
// D3 hand check (SPEC-vouch 7.2): sign ONE real vouch tuple, POST it to a LOCAL
// wrangler dev, replay it, print every read. No assertions: read the output.
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
  '  npm run schema:local && npm run migrate:local',
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

show('POST /vouch', await call(WORKER, 'POST', '/vouch', payload));
const hits1 = (await call(FAKE, 'GET', '/__hits')).body.hits;
console.log(`\nfake RPC hits caused by the first POST: ${hits1 - hits0} (expect 2)`);
if (hits1 === hits0) {
  console.log('STOP: /__hits did not move, so RPC_URL was not overridden.');
  console.log('Put RPC_URL=http://127.0.0.1:8899 in .dev.vars for this run (SPEC 10.2) and restart wrangler dev.');
}
show('POST /vouch again, same payload (expect replayed:true)', await call(WORKER, 'POST', '/vouch', payload));
const hits2 = (await call(FAKE, 'GET', '/__hits')).body.hits;
console.log(`\nfake RPC hits caused by the replay: ${hits2 - hits1} (expect 0)`);
show('GET /vouch/app/x.place', await call(WORKER, 'GET', '/vouch/app/x.place'));
show('GET /vouch/mine?mint=<mint>', await call(WORKER, 'GET', `/vouch/mine?mint=${mint}`));
show('GET /vouch/aggregate', await call(WORKER, 'GET', '/vouch/aggregate'));
show('GET /vouch/top', await call(WORKER, 'GET', '/vouch/top'));
show('GET /flags', await call(WORKER, 'GET', '/flags'));
show('fake GET /__hits', await call(FAKE, 'GET', '/__hits'));
