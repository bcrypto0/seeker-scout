/**
 * On-chain release resolver (Track A foundation — also the core Track B will
 * reuse). Given a publisher wallet, reads the immutable dApp Store Release
 * NFTs via DAS on our Triton RPC and returns structured, verified release
 * history per app — data seekertracker's feed does NOT carry.
 *
 * There is no global on-chain registry (each app NFT is signed by its own
 * publisher), so this resolves by KNOWN publisher wallet. Publishers we learn
 * accumulate in indexer/publishers.json (package -> publisher), which is how
 * coverage grows without an enumeration endpoint.
 *
 * Usage:
 *   node indexer/onchain.mjs <publisherWallet>          # print release history
 *   RPC_URL=<url> node indexer/onchain.mjs <wallet>     # or TRITON_GRPC_ENDPOINT+TRITON_X_TOKEN
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// RPC endpoint comes from the environment only. Triton embeds the API key in
// the URL path, so a default here would be a credential committed to git.
const RPC_URL = resolveRpcUrl();

function resolveRpcUrl() {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  const { TRITON_GRPC_ENDPOINT: endpoint, TRITON_X_TOKEN: token } = process.env;
  if (endpoint && token) return `${endpoint.replace(/\/$/, '')}/${token}`;
  throw new Error(
    'onchain.mjs: set RPC_URL, or TRITON_GRPC_ENDPOINT + TRITON_X_TOKEN (no hard-coded endpoint)',
  );
}

async function das(method, params) {
  const res = await fetch(RPC_URL, {
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

/**
 * All dApp Store NFTs a publisher minted, split into apps (collections) and
 * releases (collection members). Paginates DAS getAssetsByOwner.
 */
export async function getPublisherAssets(publisher) {
  const apps = new Map(); // collectionMint -> { mint, name }
  const releases = []; // { mint, name, collection }
  for (let page = 1; page < 20; page++) {
    const r = await das('getAssetsByOwner', {
      ownerAddress: publisher,
      page,
      limit: 100,
    });
    for (const a of r.items ?? []) {
      const coll = (a.grouping ?? []).find((g) => g.group_key === 'collection');
      const name = a.content?.metadata?.name ?? '';
      if (coll) {
        releases.push({ mint: a.id, name, collection: coll.group_value });
      } else {
        apps.set(a.id, { mint: a.id, name });
      }
    }
    if (!r.items || r.items.length < 100) break;
  }
  return { apps, releases };
}

/** Release metadata JSON (r2 CDN) → the fields the feed omits. */
async function releaseMeta(mint) {
  const asset = await das('getAsset', { id: mint });
  const uri = asset?.content?.json_uri;
  if (!uri) return null;
  try {
    const res = await fetch(uri, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const j = await res.json();
    const sd = j?.extensions?.solana_dapp_store ?? {};
    return {
      package: sd.android_details?.android_package,
      version: sd.android_details?.version,
      versionCode: sd.android_details?.version_code,
      minSdk: sd.android_details?.min_sdk,
      certFingerprint: sd.android_details?.cert_fingerprint,
    };
  } catch {
    return null;
  }
}

/**
 * Verified on-chain release history for a publisher, grouped by app:
 * { package, appName, appMint, releaseCount, versions[], mints[] }.
 */
export async function getPublisherReleases(publisher) {
  const { apps, releases } = await getPublisherAssets(publisher);
  const byApp = new Map();
  for (const rel of releases) {
    const meta = await releaseMeta(rel.mint);
    const app = apps.get(rel.collection);
    const key = rel.collection;
    if (!byApp.has(key)) {
      byApp.set(key, {
        appName: app?.name ?? rel.name.replace(/\s+v[\d.]+.*$/, ''),
        appMint: rel.collection,
        package: meta?.package,
        releaseCount: 0,
        versions: [],
        mints: [],
      });
    }
    const e = byApp.get(key);
    e.releaseCount += 1;
    e.mints.push(rel.mint);
    if (meta?.package && !e.package) e.package = meta.package;
    if (meta?.version) e.versions.push(meta.version);
  }
  return [...byApp.values()];
}

/** Accumulating package -> publisher map (grows coverage over time). */
export function loadPublisherMap() {
  const path = new URL('./publishers.json', import.meta.url);
  return existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : {};
}

export function savePublisherMap(map) {
  writeFileSync(
    new URL('./publishers.json', import.meta.url),
    JSON.stringify(map, null, 1),
  );
}

async function main() {
  const publisher = process.argv[2];
  if (!publisher) {
    console.error('usage: node indexer/onchain.mjs <publisherWallet>');
    process.exit(1);
  }
  const apps = await getPublisherReleases(publisher);
  for (const a of apps) {
    console.log(
      `${a.appName}  [${a.package ?? '?'}]  ${a.releaseCount} release(s): ${a.versions.join(', ')}`,
    );
    console.log(`  app NFT: ${a.appMint}`);
  }
  // Update the accumulating map with what we learned.
  const map = loadPublisherMap();
  let added = 0;
  for (const a of apps) {
    if (a.package && map[a.package] !== publisher) {
      map[a.package] = publisher;
      added += 1;
    }
  }
  savePublisherMap(map);
  console.log(`\npublisher map: +${added} (total ${Object.keys(map).length})`);
}

// Exact basename match — 'enrich-onchain.mjs' also endsWith 'onchain.mjs',
// which would fire this CLI on import.
if (process.argv[1]?.replace(/\\/g, '/').split('/').pop() === 'onchain.mjs') {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
