// lounge-worker/test/fake-rpc.mjs
// Fake Solana JSON-RPC for LOCAL runs only (SPEC-vouch 7.2 plus SPEC-skr-final 7.2).
// It answers exactly what index.js verifyGenesisSig and src/skr.js read:
//   getAccountInfo(mint, jsonParsed): a Token-2022 mint carrying the SGT
//     fingerprint (isGenuineSgt) for registered SGT mints, a parsed mint with a
//     different mintAuthority for registered NOT_SGT mints, else value null.
//   getTokenAccountsByOwner(wallet, {mint}, jsonParsed): one token account
//     holding 1 for registered (wallet, mint) pairs, else value [].
//   getMultipleAccounts([addresses], {encoding: 'base64'}): the StakeConfig
//     bytes of test/fixtures/skr_fixtures.json (mainnet, read-only capture) for
//     STAKE_CONFIG; for the UserStake PDA of a registered stake, the fixture's
//     sample UserStake with user, bump, shares and the unstake fields rewritten
//     for that wallet (the decoder asserts user == wallet); null for anything
//     else, which is "no stake account". A wallet registered as a bad stake gets
//     a malformed reply instead: 'short' drops the last entry of `value`,
//     'length' serves its UserStake one byte short (168 B). 'system' is not
//     malformed: it serves what lamports sent to the PDA create, an account
//     owned by the System Program with 0 bytes of data (no stake position).
//     A later registration of the same wallet replaces its mode.
// Test hooks (not JSON-RPC, not counted as hits):
//   POST /__register {sgt: [mint], notSgt: [mint], holders: [[wallet, mint]],
//                     stakes: [[wallet, {shares, unstaking?, unstakeTs?}]] (decimal strings),
//                     badStakes: [[wallet, 'short' | 'length' | 'system']]}
//   GET  /__hits     -> {hits, byMethod}
// Binds 127.0.0.1 only and never forwards anything anywhere.
//   Standalone: node test/fake-rpc.mjs [port]      (default 8899)
//   In-process: import { startFakeRpc } from './fake-rpc.mjs'
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { base58, base64 } from '@scure/base';
import { GUARDIAN_POOLS, SKR_PROGRAM, STAKE_CONFIG, userStakePda } from '../src/skr.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/skr_fixtures.json', import.meta.url), 'utf8'));
const POOL0 = base58.decode(GUARDIAN_POOLS[0]);
/** UserStake PDA of a wallet at the pinned pool (the derivation skr.test.js proves against 8 live accounts). */
export const stakePdaOf = (wallet) => base58.encode(userStakePda(base58.decode(wallet), POOL0).address);

const accountInfo = (owner, lamports, bytes) => ({
  data: [base64.encode(bytes), 'base64'], executable: false, lamports, owner, rentEpoch: 0, space: bytes.length,
});
const CONFIG_INFO = accountInfo(FX.accounts.stakeConfig.owner, FX.accounts.stakeConfig.lamports,
  base64.decode(FX.accounts.stakeConfig.dataBase64));
const wLE = (b, o, v, n) => { for (let i = 0; i < n; i++) { b[o + i] = Number(v & 0xffn); v >>= 8n; } };
/** The fixture UserStake rewritten for `wallet`: bump@8, user@41, shares u128@105, unstaking u64@153, ts i64@161. */
function userStakeBytes(wallet, { shares, unstaking = '0', unstakeTs = '0' }) {
  const b = new Uint8Array(base64.decode(FX.accounts.sampleUserStake.dataBase64));
  const walletBytes = base58.decode(wallet);
  b[8] = userStakePda(walletBytes, POOL0).bump;
  b.set(walletBytes, 41);
  wLE(b, 105, BigInt(shares), 16);
  wLE(b, 153, BigInt(unstaking), 8);
  wLE(b, 161, BigInt.asUintN(64, BigInt(unstakeTs)), 8);
  return b;
}

export const SGT_MINT_AUTHORITY = 'GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4';
export const SGT_METADATA_ADDRESS = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
export const SGT_GROUP_MINT_ADDRESS = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
// Any other authority fails isGenuineSgt at its first check (index.js:70).
export const NOT_SGT_AUTHORITY = 'BPFLoaderUpgradeab1e11111111111111111111111';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const MAX_BODY = 64 * 1024;

function mintAccount(mint, authority) {
  return {
    data: {
      parsed: {
        type: 'mint',
        info: {
          decimals: 0,
          freezeAuthority: null,
          isInitialized: true,
          mintAuthority: authority,
          supply: '1',
          extensions: [
            { extension: 'metadataPointer', state: { authority, metadataAddress: SGT_METADATA_ADDRESS } },
            { extension: 'tokenGroupMember', state: { group: SGT_GROUP_MINT_ADDRESS, mint, memberNumber: 1 } },
          ],
        },
      },
      program: 'spl-token-2022',
      space: 400,
    },
    executable: false,
    lamports: 4_000_000,
    owner: TOKEN_2022,
    rentEpoch: 0,
    space: 400,
  };
}

function holderAccount(wallet, mint) {
  return {
    pubkey: 'FakeTokenAccount111111111111111111111111111',
    account: {
      data: {
        parsed: {
          type: 'account',
          info: {
            isNative: false,
            mint,
            owner: wallet,
            state: 'initialized',
            tokenAmount: { amount: '1', decimals: 0, uiAmount: 1, uiAmountString: '1' },
          },
        },
        program: 'spl-token-2022',
        space: 170,
      },
      executable: false,
      lamports: 2_000_000,
      owner: TOKEN_2022,
      rentEpoch: 0,
      space: 170,
    },
  };
}

export function startFakeRpc({ port = 8899, host = '127.0.0.1', log = false } = {}) {
  const sgt = new Set();
  const notSgt = new Set();
  const holders = new Set();
  const stakeByPda = new Map(); // pda -> account info (a registered, well-formed UserStake)
  const badByPda = new Map();   // pda -> { mode, info }
  const byMethod = {};
  let hits = 0;

  const register = ({ sgt: s = [], notSgt: n = [], holders: h = [], stakes = [], badStakes = [] } = {}) => {
    for (const m of s) sgt.add(m);
    for (const m of n) notSgt.add(m);
    for (const [w, m] of h) holders.add(`${w}:${m}`);
    for (const [w, st] of stakes) {
      stakeByPda.set(stakePdaOf(w), accountInfo(SKR_PROGRAM, FX.accounts.sampleUserStake.lamports, userStakeBytes(w, st)));
    }
    for (const [w, mode] of badStakes) {
      if (mode !== 'short' && mode !== 'length' && mode !== 'system') throw new Error(`bad stake mode ${mode}`);
      const info = mode === 'system'
        ? accountInfo(SYSTEM_PROGRAM, 890_880, new Uint8Array(0))
        : accountInfo(SKR_PROGRAM, FX.accounts.sampleUserStake.lamports,
          userStakeBytes(w, { shares: FX.expected.sampleUserStake.shares }).subarray(0, 168));
      badByPda.set(stakePdaOf(w), { mode, info });
    }
  };
  const counts = () => ({ hits, byMethod: { ...byMethod } });

  const answer = (method, params) => {
    if (method === 'getAccountInfo') {
      const mint = params?.[0];
      const value = sgt.has(mint) ? mintAccount(mint, SGT_MINT_AUTHORITY)
        : notSgt.has(mint) ? mintAccount(mint, NOT_SGT_AUTHORITY) : null;
      return { result: { context: { slot: 1 }, value } };
    }
    if (method === 'getTokenAccountsByOwner') {
      const wallet = params?.[0];
      const mint = params?.[1]?.mint;
      const value = holders.has(`${wallet}:${mint}`) ? [holderAccount(wallet, mint)] : [];
      return { result: { context: { slot: 1 }, value } };
    }
    if (method === 'getMultipleAccounts') {
      const addresses = params?.[0];
      if (!Array.isArray(addresses) || addresses.length > 100 || params?.[1]?.encoding !== 'base64') {
        return { error: { code: -32602, message: 'Invalid params' } };
      }
      let short = false;
      const value = addresses.map((a) => {
        if (a === STAKE_CONFIG) return CONFIG_INFO;
        const bad = badByPda.get(a);
        if (bad) {
          if (bad.mode === 'short') short = true;
          return bad.info;
        }
        return stakeByPda.get(a) ?? null;
      });
      return { result: { context: { slot: FX.slot }, value: short ? value.slice(0, -1) : value } };
    }
    return { error: { code: -32601, message: 'Method not found' } };
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) req.destroy();
    });
    req.on('end', () => {
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET' && req.url === '/__hits') return send(200, counts());
      if (req.method === 'POST' && req.url === '/__register') {
        try { register(JSON.parse(raw || '{}')); } catch { return send(400, { error: 'bad json' }); }
        return send(200, { ok: true, sgt: sgt.size, notSgt: notSgt.size, holders: holders.size });
      }
      if (req.method !== 'POST') return send(404, { error: 'not found' });
      let msg;
      try { msg = JSON.parse(raw); } catch {
        return send(200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      hits += 1;
      byMethod[msg.method] = (byMethod[msg.method] || 0) + 1;
      if (log) console.log(`rpc ${msg.method} ${String(msg.params?.[0] ?? '').slice(0, 4)}..`);
      return send(200, { jsonrpc: '2.0', id: msg.id ?? null, ...answer(msg.method, msg.params) });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({
      url: `http://${host}:${port}`,
      register,
      counts,
      close: () => new Promise((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
    }));
  });
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.argv[2]) || 8899;
  const fake = await startFakeRpc({ port, log: true });
  console.log(`fake rpc on ${fake.url}: getAccountInfo, getTokenAccountsByOwner, getMultipleAccounts; hooks /__register, /__hits`);
}
