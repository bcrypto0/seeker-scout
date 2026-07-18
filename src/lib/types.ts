/** Real dApp Store categories (verified from the store's explore feed, July 2026). */
export type Category =
  | 'DeFi & Trading'
  | 'Games'
  | 'DePIN'
  | 'NFTs'
  | 'Privacy & Security'
  | 'Content & Streaming'
  | 'Wallets'
  | 'Productivity'
  | 'Social & Identity'
  | 'AI & Agents'
  | 'Lifestyle'
  | 'Other';

export interface DappEntry {
  /** Android package id — unique key, also used for store deep links */
  id: string;
  name: string;
  subtitle: string;
  description?: string;
  category: Category | string;
  /** Featured in the store's "Top Picks" unit */
  topPick?: boolean;
  /** ISO date of last release (updatedOn) */
  lastUpdated: string;
  /**
   * ISO date the indexer first saw this app in the store feed (tracked from
   * 2026-07-14). Absent for apps that predate tracking.
   */
  firstSeen?: string;
  /** Store rating 0-5 */
  rating: number;
  /** Total review count */
  reviews: number;
  /** True wallet-native onboarding (Seed Vault / MWA) — community-curated flag */
  seedVaultNative?: boolean;
  iconUrl?: string;
  publisher?: string;
  website?: string;
  version?: string;
  /** Composite ranking: Bayesian rating + freshness + volume (see indexer) */
  trendScore: number;
  /** Rank movement vs the previous daily snapshot; positive = climbed */
  rankDelta?: number;
  /** Up to 7 daily ranks, oldest→newest (sparkline data; UI lands v0.3) */
  rankHistory?: number[];
  /** True when release history was verified on-chain (DAS/Triton) */
  onchainVerified?: boolean;
  /** Count of immutable on-chain Release NFTs for this app */
  onchainReleaseCount?: number;
}

/**
 * Remote-configured promo/ad banner (hosted banners.json) — lets us rotate
 * house promos and sold ad slots without shipping an app update.
 */
export interface PromoBanner {
  id: string;
  /** Bold headline */
  title: string;
  /** One-liner under the title */
  tagline?: string;
  /** Small corner chip, e.g. "Our apps" | "Sponsored" | "Ad slot" */
  label?: string;
  /** Optional accent (hex) for the card border */
  color?: string;
  /** dApp Store package — opens solanadappstore://details?id=<pkg> */
  storePackage?: string;
  /** External URL fallback when no storePackage */
  url?: string;
}

/**
 * Structured reward entry (hosted rewards.json, remote-config like banners) —
 * the anti-SolanaFloor design: status is DATA (endsAt/verified), not prose,
 * and every entry can deep-link both the announcement and the store listing.
 */
export interface RewardEntry {
  id: string;
  /** App or program name shown on the card */
  app: string;
  title: string;
  detail: string;
  /** 'perk' = partner offer (default); 'season' = SKR season module, pinned */
  kind?: 'perk' | 'season';
  iconUrl?: string;
  /** dApp Store package — enables the "Get app" deep link */
  packageId?: string;
  /** Announcement / details URL */
  url?: string;
  /** ISO date the offer ends; past date auto-moves the card to "Past" */
  endsAt?: string;
  /** ISO date we last confirmed the offer is real and live */
  verified?: string;
}
