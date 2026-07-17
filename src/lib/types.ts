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

export interface RewardOpportunity {
  id: string;
  app: string;
  title: string;
  detail: string;
  /** ISO date; undefined = ongoing */
  deadline?: string;
  url?: string;
}
