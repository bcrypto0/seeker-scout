import { AppPerk, DappEntry, PromoBanner, RewardEntry } from './types';

/**
 * Hosted catalog produced by `npm run index-catalog` (indexer/catalog.json),
 * deployed to Cloudflare Pages. Re-run the indexer + redeploy to update live.
 */
const CATALOG_URL = 'https://seeker-scout-catalog.pages.dev/catalog.json';
const BANNERS_URL = 'https://seeker-scout-catalog.pages.dev/banners.json';
const REWARDS_URL = 'https://seeker-scout-catalog.pages.dev/rewards.json';
const PERKS_URL = 'https://seeker-scout-catalog.pages.dev/perks.json';

/**
 * Real seed data captured from the dApp Store explore feed (July 2026) —
 * top apps per category by review volume, so the app is useful even before
 * the hosted catalog is live. trendScore here = quick approximation.
 */
export const SEED_CATALOG: DappEntry[] = [
  { id: 'ag.jup.jupiter.android', name: 'Jupiter Mobile', subtitle: 'Leading Solana DeFi Platform', category: 'Wallets', lastUpdated: '2026-07-01', rating: 4.8, reviews: 7083, trendScore: 95, seedVaultNative: true },
  { id: 'com.tokenrun.app', name: 'TokenRun', subtitle: 'Collect Real Treasures', category: 'Games', lastUpdated: '2026-06-24', rating: 4.5, reviews: 6406, trendScore: 88 },
  { id: 'com.bringyour.network', name: 'URnetwork', subtitle: 'Goodbye VPN!', category: 'Privacy & Security', lastUpdated: '2026-03-25', rating: 4.4, reviews: 5926, trendScore: 84 },
  { id: 'fun.cfl.www.twa', name: 'Crypto Fantasy League', subtitle: 'Social & Fair Trading Platform', category: 'Games', lastUpdated: '2025-12-06', rating: 4.2, reviews: 5920, trendScore: 78 },
  { id: 'fun.mattle.twa', name: 'MattleFun', subtitle: 'Trade smarter, survive longer!', category: 'Games', lastUpdated: '2026-06-14', rating: 4.6, reviews: 5615, trendScore: 89 },
  { id: 'com.ddgaming.scrolly', name: 'Scrolly', subtitle: 'Play. Scroll. Repeat.', category: 'Games', lastUpdated: '2025-09-06', rating: 3.9, reviews: 5477, trendScore: 68 },
  { id: 'com.lootgo.app', name: 'LootGO', subtitle: 'The Crypto Treasure Hunt', category: 'Lifestyle', lastUpdated: '2026-03-20', rating: 4.5, reviews: 4785, trendScore: 85 },
  { id: 'app.backpack.mobile.standalone', name: 'Backpack', subtitle: 'Buy & Trade Crypto', category: 'Wallets', lastUpdated: '2026-06-17', rating: 4.6, reviews: 4733, trendScore: 90, seedVaultNative: true },
  { id: 'network.jito.www.twa', name: 'Jito', subtitle: 'Liquid staking for Solana', category: 'DeFi & Trading', lastUpdated: '2025-08-29', rating: 4.6, reviews: 4683, trendScore: 80 },
  { id: 'fun.cherry', name: 'Cherry Messenger', subtitle: 'Wallet-to-wallet messenger', category: 'Social & Identity', lastUpdated: '2026-04-24', rating: 4.8, reviews: 4583, trendScore: 91 },
  { id: 'io.candy.android.app', name: 'Candy Studio', subtitle: 'Create Beyond Reality', category: 'Content & Streaming', lastUpdated: '2026-03-25', rating: 4.1, reviews: 4504, trendScore: 75 },
  { id: 'finance.save.twa', name: 'Save', subtitle: 'Deposit and borrow on mobile!', category: 'DeFi & Trading', lastUpdated: '2025-08-20', rating: 4.4, reviews: 4325, trendScore: 76 },
  { id: 'com.batonresearch.pump', name: 'PumpFun', subtitle: 'Browse coins, follow creators, and more', category: 'DeFi & Trading', lastUpdated: '2026-06-29', rating: 4.3, reviews: 4097, trendScore: 82 },
  { id: 'finance.lince.app', name: 'Lince', subtitle: 'Your DeFi Robo-Advisor', category: 'DeFi & Trading', lastUpdated: '2025-11-07', rating: 4.3, reviews: 4044, trendScore: 74 },
  { id: 'fit.moonwalk.mobile.app', name: 'Moonwalk Fitness', subtitle: 'Track steps & compete daily!', category: 'Lifestyle', lastUpdated: '2026-06-17', rating: 4.3, reviews: 3516, trendScore: 83 },
  { id: 'io.getgrass.www', name: 'Grass', subtitle: 'Earn a stake in AI', category: 'DePIN', lastUpdated: '2026-03-12', rating: 4.3, reviews: 3330, trendScore: 78 },
  { id: 'com.baxus.app', name: 'Baxus', subtitle: 'Seek Bottles, Earn Rewards', category: 'Lifestyle', lastUpdated: '2026-03-13', rating: 4.2, reviews: 3149, trendScore: 74 },
  { id: 'com.moonpay.commerceapp', name: 'MoonPay Commerce', subtitle: 'Shop your favorite stores with crypto!', category: 'Lifestyle', lastUpdated: '2025-12-15', rating: 4.3, reviews: 3038, trendScore: 73 },
  { id: 'app.phantom', name: 'Phantom', subtitle: 'The friendly crypto wallet', category: 'Wallets', lastUpdated: '2026-02-23', rating: 4.8, reviews: 3002, trendScore: 87, seedVaultNative: true },
  { id: 'com.uprock.mining', name: 'UpRock', subtitle: 'The #1 DePIN App for Solana', category: 'DePIN', lastUpdated: '2026-06-03', rating: 4.1, reviews: 2983, trendScore: 75 },
  { id: 'trade.tensor.www.twa', name: 'Tensor', subtitle: 'Solana Leading NFT Marketplace', category: 'NFTs', lastUpdated: '2025-08-13', rating: 4.5, reviews: 2981, trendScore: 74 },
  { id: 'com.solflare.mobile', name: 'Solflare', subtitle: 'Tailor made for Solana', category: 'Wallets', lastUpdated: '2026-06-18', rating: 4.7, reviews: 2928, trendScore: 88, seedVaultNative: true },
  { id: 'cash.bonknado.twa', name: 'Bonknado Cash', subtitle: 'Tornado Cash on Solana', category: 'Privacy & Security', lastUpdated: '2026-03-16', rating: 4.3, reviews: 2341, trendScore: 74 },
  { id: 'com.stepfinance.solanafloormobile', name: 'SolanaFloor', subtitle: "Solana's Number 1 News Source", category: 'Content & Streaming', lastUpdated: '2025-12-19', rating: 4.6, reviews: 2302, trendScore: 77 },
  { id: 'com.bluntbrain.NearMe', name: 'NearMe', subtitle: 'Google Maps for Solana', category: 'Productivity', lastUpdated: '2025-08-05', rating: 4.3, reviews: 2273, trendScore: 68 },
  { id: 'meme.gib.app', name: 'Gib Meme', subtitle: 'Memecoin TCG with Cash Rewards', category: 'NFTs', lastUpdated: '2026-06-17', rating: 3.9, reviews: 2268, trendScore: 70 },
  { id: 'market.dare.app.twa', name: 'Dare Market', subtitle: 'Complete dares. Go viral.', category: 'Social & Identity', lastUpdated: '2026-04-01', rating: 3.8, reviews: 2171, trendScore: 66 },
  { id: 'ai.bitcoinvision.app', name: 'Bitcoin Vision AI', subtitle: 'Bitcoin insights', category: 'AI & Agents', lastUpdated: '2026-01-01', rating: 4.3, reviews: 2121, trendScore: 70 },
  { id: 'org.privacycash.twa', name: 'Privacy Cash', subtitle: 'Transfer tokens privately', category: 'Privacy & Security', lastUpdated: '2026-01-22', rating: 4.3, reviews: 2088, trendScore: 71 },
  { id: 'art.mallow.twa', name: 'mallow', subtitle: 'A home for you and your art', category: 'NFTs', lastUpdated: '2025-08-25', rating: 4.2, reviews: 1978, trendScore: 66 },
  { id: 'com.storj_mobile', name: 'Storj Mobile', subtitle: 'Decentralized file storage', category: 'DePIN', lastUpdated: '2024-02-01', rating: 4.2, reviews: 1949, trendScore: 58 },
  { id: 'com.bluzaq.converter', name: 'Converter', subtitle: 'Convert fiat and crypto', category: 'Productivity', lastUpdated: '2025-08-27', rating: 4.4, reviews: 1879, trendScore: 68 },
  { id: 'id.sns.www.twa', name: 'Solana Name Service', subtitle: 'Claim your .sol identity', category: 'Social & Identity', lastUpdated: '2025-10-10', rating: 4.5, reviews: 1779, trendScore: 70 },
  { id: 'com.ai375.go', name: '375go', subtitle: 'Move, SCAN, earn, repeat!', category: 'DePIN', lastUpdated: '2026-04-05', rating: 4.2, reviews: 1686, trendScore: 71 },
  { id: 'io.contentos.costv', name: 'COS.TV', subtitle: 'Web3 content platform', category: 'Content & Streaming', lastUpdated: '2025-06-20', rating: 4.0, reviews: 1626, trendScore: 60 },
  { id: 'co.electriccoin.zcash.foss', name: 'Zashi', subtitle: 'Private Zcash wallet', category: 'Privacy & Security', lastUpdated: '2026-03-04', rating: 4.3, reviews: 1542, trendScore: 71 },
  { id: 'com.app.huddle01', name: 'Huddle01', subtitle: 'web3 video meetings on the go', category: 'Productivity', lastUpdated: '2025-09-02', rating: 3.9, reviews: 1517, trendScore: 61 },
  { id: 'com.arnacon.app', name: 'Arnacon', subtitle: 'Decentralized Communication', category: 'Social & Identity', lastUpdated: '2026-01-29', rating: 3.9, reviews: 1457, trendScore: 64 },
  { id: 'com.hio.music', name: 'HIO', subtitle: 'Social music streaming', category: 'Content & Streaming', lastUpdated: '2025-05-22', rating: 4.0, reviews: 1445, trendScore: 59 },
  { id: 'com.fxtec.rosewood', name: 'Unbound', subtitle: 'Stay connected. Get rewarded.', category: 'Productivity', lastUpdated: '2026-06-09', rating: 4.2, reviews: 1225, trendScore: 72 },
  { id: 'com.tiexo', name: 'TIEXO', subtitle: 'NFT Marketplace & Data Indexer', category: 'NFTs', lastUpdated: '2024-02-09', rating: 4.3, reviews: 2344, trendScore: 60 },
  { id: 'com.nodesphere.mobile', name: 'Node Sphere AI', subtitle: 'AI Agent Platform', category: 'AI & Agents', lastUpdated: '2025-03-19', rating: 3.9, reviews: 1698, trendScore: 58 },
  { id: 'com.ai.ainoshaapp', name: 'Ainosha AI', subtitle: 'AI-powered crypto analytics', category: 'AI & Agents', lastUpdated: '2025-09-29', rating: 3.9, reviews: 1448, trendScore: 60 },
  { id: 'com.solclaw.app', name: 'SolClaw', subtitle: 'Your Solana-Native Agent', category: 'AI & Agents', lastUpdated: '2026-06-02', rating: 3.7, reviews: 821, trendScore: 62 },
];

/** Bundled fallback — mirrors the initial hosted rewards.json. */
export const REWARDS_SEED: RewardEntry[] = [
  {
    id: 'skr-season-2', kind: 'season', app: 'Seeker',
    title: 'SKR Season 2 is live',
    detail: 'Your Activity Tracker score (onchain activity, daily use, dApps explored) sets your tier for future SKR seasons. Exploring apps counts.',
    url: 'https://solanamobile.com/skr', verified: '2026-07-17',
  },
  {
    id: 'skr-staking', kind: 'season', app: 'Seeker',
    title: 'Stake SKR natively',
    detail: 'Native SKR staking directly from the Seeker — currently around 16% APY.',
    url: 'https://stake.solanamobile.com', verified: '2026-07-17',
  },
  {
    id: 'xplace-membership', app: 'XPlace Credit Card', packageId: 'x.place',
    title: '20% off memberships + 2.5% XP airdrop',
    detail: 'Seeker owners unlock 20% off all memberships, a 2.5% XP airdrop allocation, bonus XP on upgrades, and custom Seeker cards.',
    verified: '2026-07-17',
  },
  {
    id: 'zabana-skr-delivery', app: 'Zabana', packageId: 'com.example.zabana',
    title: 'Free delivery paying with SKR',
    detail: 'Free delivery on all products when paying with SKR, plus a 2× rewards points boost. Update to the latest version to claim.',
    verified: '2026-07-17',
  },
];

/** Remote promo banners — [] on any failure (no banner is a fine banner). */
export async function fetchBanners(): Promise<PromoBanner[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(BANNERS_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`banners ${res.status}`);
    const data = (await res.json()) as PromoBanner[];
    return Array.isArray(data) ? data.filter((b) => b && b.id && b.title) : [];
  } catch {
    return [];
  }
}

/** Live rewards feed — falls back to the bundled seed on any failure. */
export async function fetchRewards(): Promise<RewardEntry[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(REWARDS_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`rewards ${res.status}`);
    const data = (await res.json()) as RewardEntry[];
    // Strict per-entry validation: rewards.json is hand-edited remote config,
    // and one malformed entry must never crash the Rewards tab.
    const valid = Array.isArray(data)
      ? data.filter(
          (r) =>
            r &&
            typeof r.id === 'string' &&
            typeof r.app === 'string' &&
            typeof r.title === 'string' &&
            typeof r.detail === 'string',
        )
      : [];
    if (valid.length === 0) throw new Error('no valid entries');
    return valid;
  } catch {
    return REWARDS_SEED;
  }
}

/**
 * Auto-detected app perks (v0.4) — [] on any failure; the Rewards screen
 * simply hides the section. Machine-generated remote config, but validate
 * per-entry anyway (one malformed row must never crash the tab).
 */
export async function fetchPerks(): Promise<AppPerk[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(PERKS_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`perks ${res.status}`);
    const data = (await res.json()) as AppPerk[];
    return Array.isArray(data)
      ? data.filter(
          (p) =>
            p &&
            typeof p.id === 'string' &&
            typeof p.name === 'string' &&
            typeof p.snippet === 'string' &&
            Array.isArray(p.kinds) &&
            p.kinds.length > 0,
        )
      : [];
  } catch {
    return [];
  }
}

// One session-scoped catalog fetch shared by Discover, Search, and the
// detail screen (rank lookups) — the hosted file is ~1MB, don't re-pull it.
let catalogCache: DappEntry[] | null = null;
// In-flight dedup: concurrent callers (Discover mount + Rewards prefetch)
// share ONE download instead of racing two ~1MB fetches.
let catalogInflight: Promise<DappEntry[]> | null = null;

/** True when the live catalog is already in memory (skip skeletons). */
export function isCatalogCached(): boolean {
  return catalogCache !== null;
}

export async function fetchCatalog(force = false): Promise<DappEntry[]> {
  if (catalogCache && !force) return catalogCache;
  if (catalogInflight && !force) return catalogInflight;
  const attempt = doFetchCatalog();
  catalogInflight = attempt;
  try {
    return await attempt;
  } finally {
    if (catalogInflight === attempt) catalogInflight = null;
  }
}

async function doFetchCatalog(): Promise<DappEntry[]> {
  try {
    const controller = new AbortController();
    // 15s, not 8: the catalog grew ~21% (histograms + changelogs, ~1.24MB)
    // and a slow-but-alive connection that aborts here silently falls back
    // to the 43-app seed — a much worse outcome than a longer spinner.
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(CATALOG_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`catalog ${res.status}`);
    const data = (await res.json()) as DappEntry[];
    // Guard against a hosted file that's empty or not an array.
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('empty catalog');
    }
    catalogCache = data;
    return data;
  } catch {
    return SEED_CATALOG; // not cached — retry live on next screen mount
  }
}
