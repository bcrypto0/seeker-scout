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

export interface RewardOpportunity {
  id: string;
  app: string;
  title: string;
  detail: string;
  /** ISO date; undefined = ongoing */
  deadline?: string;
  url?: string;
}
