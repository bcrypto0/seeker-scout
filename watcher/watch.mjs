/**
 * Seeker Scout — on-chain dApp Store mint-watcher (Track B, independent route).
 *
 * Streams Token Metadata program transactions via Triton Yellowstone gRPC.
 * For each NFT-metadata create, decodes the metadata URI; when the URI is
 * hosted on the dApp Store CDN (r2.solanamobiledappstore.com), it's a dApp
 * Store release — extract the publisher (update authority), expand to all of
 * that publisher's apps via DAS, and accumulate ../indexer/publishers.json.
 *
 * This detects NEW apps/releases at mint time with NObody's permission — the
 * discovery source a competitor's feed can be, but the chain cannot.
 *
 * Config (env):
 *   TRITON_GRPC_ENDPOINT   e.g. https://bilalal-mainnet-c2d8.mainnet.rpcpool.com
 *   TRITON_X_TOKEN         the path token from the Triton HTTP RPC URL
 *   RPC_URL (optional)     HTTP RPC for DAS/self-test (defaults to Triton HTTP)
 *
 * Usage:
 *   node watch.mjs --selftest   # validate decode+extract on our own NFT (no stream)
 *   node watch.mjs              # live stream
 */
import grpcPkg from '@triton-one/yellowstone-grpc';
import { Connection, PublicKey } from '@solana/web3.js';

// CJS→ESM interop: the Client class is nested at pkg.default.default here.
const Client =
  typeof grpcPkg === 'function'
    ? grpcPkg
    : (grpcPkg?.default ?? grpcPkg);
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const TOKEN_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const DAPP_STORE_CDN = 'r2.solanamobiledappstore.com';
const PUBLISHERS_PATH = new URL('../indexer/publishers.json', import.meta.url);

// HTTP RPC comes from the environment only (Triton embeds the key in the path).
const HTTP_RPC =
  process.env.RPC_URL ||
  (process.env.TRITON_X_TOKEN && process.env.TRITON_GRPC_ENDPOINT
    ? `${process.env.TRITON_GRPC_ENDPOINT.replace(/\/$/, '')}/${process.env.TRITON_X_TOKEN}`
    : null);
if (!HTTP_RPC) {
  throw new Error(
    'watch.mjs: set RPC_URL, or TRITON_GRPC_ENDPOINT + TRITON_X_TOKEN (no hard-coded endpoint)',
  );
}

// ── metadata instruction decode ──────────────────────────────────────────
// Token Metadata create instructions carry name/symbol/uri as sequential
// borsh strings. Two families, different string offset AND account layout:
//   legacy CreateMetadataAccount 0 / V2 16 / V3 33 → strings@1; mint=acct[1], updateAuth=acct[4]
//   unified Create 42 (CreateArgs::V1)             → strings@2; mint=acct[2], updateAuth=acct[5]
// The dApp Store CLI uses the unified Create (42), verified on our own NFT.
const STRING_OFFSET = { 0: 1, 16: 1, 33: 1, 42: 2 };
const ACCT = {
  0: { mint: 1, auth: 4 }, 16: { mint: 1, auth: 4 },
  33: { mint: 1, auth: 4 }, 42: { mint: 2, auth: 5 },
};

function readBorshString(buf, offset) {
  const len = buf.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  return { value: buf.slice(start, end).toString('utf8'), next: end };
}

/** Returns {tag, name, symbol, uri} for a create-metadata instruction, else null. */
export function decodeMetadataCreate(data) {
  if (!data || data.length < 6) return null;
  const tag = data[0];
  const off = STRING_OFFSET[tag];
  if (off === undefined) return null;
  try {
    const name = readBorshString(data, off);
    const symbol = readBorshString(data, name.next);
    const uri = readBorshString(data, symbol.next);
    return {
      tag,
      name: name.value.replace(/\0+$/, ''),
      symbol: symbol.value.replace(/\0+$/, ''),
      uri: uri.value.replace(/\0+$/, ''),
    };
  } catch {
    return null;
  }
}

export function isDappStoreUri(uri) {
  try {
    return new URL(uri).host === DAPP_STORE_CDN;
  } catch {
    return false;
  }
}

// ── DAS publisher expansion (reuses the Track A resolver logic) ───────────
async function das(method, params) {
  const res = await fetch(HTTP_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`rpc: ${body.error.message}`);
  return body.result;
}

/** Publisher (update authority / verified creator) for a release NFT mint. */
async function publisherOfMint(mint) {
  const asset = await das('getAsset', { id: mint });
  const auth = asset?.authorities?.find((a) => a.scopes?.includes('full'));
  if (auth?.address) return auth.address;
  const creator = asset?.creators?.find((c) => c.verified);
  return creator?.address ?? null;
}

function loadPublishers() {
  return existsSync(PUBLISHERS_PATH)
    ? JSON.parse(readFileSync(PUBLISHERS_PATH, 'utf8'))
    : {};
}
function savePublishers(map) {
  writeFileSync(PUBLISHERS_PATH, JSON.stringify(map, null, 1));
}

/** Given a confirmed dApp Store release mint, expand + persist its publisher. */
async function onDappStoreRelease(mint, uriName) {
  try {
    const publisher = await publisherOfMint(mint);
    if (!publisher) return;
    const map = loadPublishers();
    // Expand to ALL of this publisher's apps (catches their back-catalog too).
    let added = 0;
    let page = 1;
    for (; page < 20; page++) {
      const r = await das('getAssetsByOwner', {
        ownerAddress: publisher, page, limit: 100,
      });
      for (const a of r.items ?? []) {
        const uri = a?.content?.json_uri;
        if (uri && isDappStoreUri(uri)) {
          const asset = await das('getAsset', { id: a.id });
          const pkg = extractPackage(asset);
          if (pkg && map[pkg] !== publisher) { map[pkg] = publisher; added++; }
        }
      }
      if (!r.items || r.items.length < 100) break;
    }
    if (added) {
      savePublishers(map);
      console.log(
        `[discover] ${uriName || mint}: publisher ${publisher.slice(0, 8)}… → +${added} package(s) (total ${Object.keys(map).length})`,
      );
    }
  } catch (e) {
    console.warn(`[discover] ${mint} expand failed: ${e.message}`);
  }
}

function extractPackage(asset) {
  // android_package lives in the off-chain JSON; getAsset carries it only if
  // indexed. Fall back to the json_uri fetch when absent.
  const attrs = asset?.content?.metadata?.attributes ?? [];
  const a = attrs.find((x) => /package/i.test(x?.trait_type ?? ''));
  return a?.value ?? null;
}

// ── account-key resolution for a Yellowstone transaction ──────────────────
function toB58(bytes) {
  return new PublicKey(bytes).toBase58();
}

function resolveAccountKeys(tx) {
  const msg = tx?.transaction?.message;
  if (!msg) return null;
  const staticKeys = (msg.accountKeys ?? []).map(toB58);
  const meta = tx?.meta ?? {};
  const loadedW = (meta.loadedWritableAddresses ?? []).map(toB58);
  const loadedR = (meta.loadedReadonlyAddresses ?? []).map(toB58);
  return [...staticKeys, ...loadedW, ...loadedR];
}

/** Walk a transaction's instructions for a dApp Store metadata create. */
function scanTransaction(tx) {
  const keys = resolveAccountKeys(tx);
  const msg = tx?.transaction?.message;
  if (!keys || !msg) return [];
  const hits = [];
  const instrs = msg.instructions ?? [];
  for (const ix of instrs) {
    const programId = keys[ix.programIdIndex];
    if (programId !== TOKEN_METADATA_PROGRAM) continue;
    const data = Buffer.isBuffer(ix.data) ? ix.data : Buffer.from(ix.data ?? []);
    const decoded = decodeMetadataCreate(data);
    if (!decoded || !isDappStoreUri(decoded.uri)) continue;
    const accIdx = ix.accounts ?? [];
    const layout = ACCT[decoded.tag];
    const mint = keys[accIdx[layout.mint]];
    const updateAuthority = keys[accIdx[layout.auth]];
    hits.push({ mint, updateAuthority, ...decoded });
  }
  return hits;
}

// ── self-test: validate the whole pipeline on our own release NFT ─────────
async function selfTest() {
  console.log('self-test: validating decode+extract against our v0.2.0 release NFT\n');
  const OUR_RELEASE = 'B4kY1UWpdY8PBt7G3FaguSxXBgEV2S6A8Tm6LRNuHeYh';
  const OUR_PUBLISHER = '5G6jUyK2kAWiEdYPbwauSq7HqZirLRt7X7JqQu2oHU1B';
  const conn = new Connection(HTTP_RPC, 'confirmed');

  const sigs = await conn.getSignaturesForAddress(new PublicKey(OUR_RELEASE), { limit: 20 });
  if (!sigs.length) throw new Error('no signatures for our release NFT');
  const createSig = sigs[sigs.length - 1].signature; // earliest = creation
  const tx = await conn.getTransaction(createSig, {
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) throw new Error('could not fetch creation transaction');

  // Reconstruct the full account list (static + LUT-loaded).
  const msg = tx.transaction.message;
  const staticKeys = msg.staticAccountKeys.map((k) => k.toBase58());
  const loadedW = (tx.meta?.loadedAddresses?.writable ?? []).map((k) => k.toBase58());
  const loadedR = (tx.meta?.loadedAddresses?.readonly ?? []).map((k) => k.toBase58());
  const keys = [...staticKeys, ...loadedW, ...loadedR];

  let found = null;
  for (const ix of msg.compiledInstructions) {
    if (keys[ix.programIdIndex] !== TOKEN_METADATA_PROGRAM) continue;
    const decoded = decodeMetadataCreate(Buffer.from(ix.data));
    if (!decoded) continue;
    const accIdx = ix.accountKeyIndexes;
    const layout = ACCT[decoded.tag];
    found = {
      mint: keys[accIdx[layout.mint]],
      updateAuthority: keys[accIdx[layout.auth]],
      ...decoded,
    };
    break;
  }

  if (!found) throw new Error('FAIL: no metadata-create instruction decoded');
  console.log('decoded name   :', found.name);
  console.log('decoded uri    :', found.uri);
  console.log('uri is dApp Store:', isDappStoreUri(found.uri));
  console.log('extracted publisher:', found.updateAuthority);
  console.log('expected publisher :', OUR_PUBLISHER);

  const ok =
    isDappStoreUri(found.uri) && found.updateAuthority === OUR_PUBLISHER;
  console.log('\nDAS publisher check:', await publisherOfMint(OUR_RELEASE));
  console.log(ok ? '\n✅ SELF-TEST PASS — decode + publisher extraction correct' : '\n❌ SELF-TEST FAIL');
  if (!ok) process.exit(1);
}

// ── live stream ───────────────────────────────────────────────────────────
async function live() {
  const endpoint = process.env.TRITON_GRPC_ENDPOINT;
  const token = process.env.TRITON_X_TOKEN;
  if (!endpoint || !token) {
    console.error(
      'Set TRITON_GRPC_ENDPOINT (host, no path) and TRITON_X_TOKEN (the path token from the HTTP RPC URL).',
    );
    process.exit(1);
  }
  let backoff = 1000;
  for (;;) {
    try {
      console.log(`[watch] connecting to ${endpoint}`);
      const client = new Client(endpoint, token, undefined);
      const stream = await client.subscribe();
      const request = {
        transactions: {
          dappstore: {
            vote: false,
            failed: false,
            accountInclude: [TOKEN_METADATA_PROGRAM],
            accountExclude: [],
            accountRequired: [],
          },
        },
        commitment: 1, // confirmed
        accounts: {}, slots: {}, blocks: {}, blocksMeta: {}, entry: {},
        accountsDataSlice: [], transactionsStatus: {},
      };
      let seen = 0;
      await new Promise((resolve, reject) => {
        stream.on('data', (u) => {
          seen++;
          if (seen === 1) console.log('[watch] stream live — receiving Token Metadata txns');
          if (seen % 5000 === 0) console.log(`[watch] healthy — ${seen} txns scanned`);
          if (!u?.transaction) return;
          backoff = 1000;
          try {
            for (const hit of scanTransaction(u.transaction)) {
              console.log(`[hit] dApp Store release ${hit.name} mint=${hit.mint}`);
              onDappStoreRelease(hit.mint, hit.name);
            }
          } catch (e) {
            console.warn('[watch] scan error:', e.message);
          }
        });
        stream.on('error', reject);
        stream.on('end', () => reject(new Error('stream ended')));
        stream.write(request, (e) => e && reject(e));
      });
    } catch (e) {
      console.warn(`[watch] ${e.message}; reconnecting in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

const mode = process.argv.includes('--selftest') ? selfTest : live;
mode().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
