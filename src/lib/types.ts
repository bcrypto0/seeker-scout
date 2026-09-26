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
  /**
   * Reviews gained over the trailing ~30 days (indexer, from daily
   * snapshots). ABSENT = unknown (app too new for the window, or an old
   * cached catalog) — never treat missing as zero.
   */
  reviews30d?: number;
  /**
   * DISTINCT days in the trailing ~30 on which new reviews arrived. The
   * farm-resistant aliveness signal: a burst of templated reviews lands on
   * one day, real use spreads across many. Absent = unknown.
   */
  reviewDays30?: number;
  /**
   * The dApp Store's own, current category (18 of them since Sep 2026).
   * `category` is kept as the pre-September name so v0.9's hardcoded chips
   * keep working; read this one via catOf() everywhere in v0.10+.
   */
  storeCategory?: string;
  /** True when release history was verified on-chain (DAS/Triton) */
  onchainVerified?: boolean;
  /** Count of immutable on-chain Release NFTs for this app */
  onchainReleaseCount?: number;
  /**
   * 1★..5★ review counts, oldest-to-newest star order. Present on ~98% of
   * apps — shows whether a middling average is mediocre or polarizing.
   */
  ratingHistogram?: number[];
  /** Publisher's changelog for the current release (word-clipped ~240 chars) */
  whatsNew?: string;
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
  /**
   * Optional artwork shown at the left of the card. When absent and
   * storePackage is set, the app's own catalog icon is used automatically —
   * so promoting a dApp Store app needs no artwork at all.
   */
  imageUrl?: string;
}

/** Reward-signal kinds emitted by indexer/detect-perks.mjs (display order). */
export type PerkKind =
  | 'airdrop'
  | 'play-to-earn'
  | 'staking'
  | 'earn'
  | 'cashback'
  | 'rewards'
  | 'points'
  | 'mining';

/**
 * Auto-detected app perk (hosted perks.json, regenerated on every catalog
 * refresh) — v0.4's "all the rewards from all the apps" (pulamea.skr's
 * review ask). Detection heuristics live in the indexer, so tuning ships
 * without an app release.
 */
export interface AppPerk {
  /** Android package id — joins back to the catalog entry */
  id: string;
  name: string;
  category: Category | string;
  iconUrl?: string;
  /** Detected signal kinds, strongest first */
  kinds: PerkKind[] | string[];
  /** First sentence of store copy that matched (display blurb) */
  snippet: string;
  trendScore: number;
  rating: number;
  reviews: number;
}

/* ------------------------------------------------------------------ *
 * Alpha (v0.6) — the War Room intel digest. Shapes are frozen by
 * docs/SCOUT_ALPHA_SPEC.md §1; the exporter, the worker and this app all
 * implement to them. Every field the worker can redact for the free teaser
 * is nullable/optional HERE too, so the teaser and the live feed share one
 * renderer.
 * ------------------------------------------------------------------ */

/** live = newest signal <2h, stale = <48h, degraded = older/unknown. */
export type AlphaStatusLevel = 'live' | 'stale' | 'degraded';

/**
 * Honest freshness stamp from the exporter. The app SHOWS this — it never
 * infers "live" on its own, and an unparseable/absent block degrades to
 * 'degraded' rather than being filled in.
 */
export interface AlphaFreshness {
  /** Heuristic: newest signal_log ts is under 2h old. */
  bot_running: boolean;
  /** Unix seconds of the newest signal_log row; null when unknown. */
  newest_signal_ts: number | null;
  /** Age of the STALEST contributing source, in seconds; null when unknown. */
  oldest_source_stale_seconds: number | null;
  status: AlphaStatusLevel;
}

/** A VIP wallet inside a cluster buy. `addr` is nulled in the free teaser. */
export interface AlphaTopWallet {
  addr: string | null;
  /**
   * Grade from wallet_tiers.json. null for a wallet we have never graded —
   * the exporter deliberately sends null rather than a fake zero-grade, and
   * an ungraded wallet still has an address a subscriber is paying for.
   */
  tier: string | null;
  win_rate: number | null;
  pnl_usd: number | null;
}

/** Recent smart-money cluster buy (yellowstone_vip / YELLOWSTONE_VIP_CLUSTER). */
export interface AlphaSmartMoney {
  /** Token mint — nulled in the free teaser (symbol still shown). */
  mint: string | null;
  symbol: string;
  chain: string;
  wallet_count: number;
  buy_count: number;
  /** Cluster detection window, in seconds. */
  window_sec: number;
  grade: string;
  score: number;
  top_wallets: AlphaTopWallet[];
  /** Unix seconds. */
  ts: number;
}

/** Wallet-quality leaderboard row. `addr` is dropped in the free teaser. */
export interface AlphaWalletRow {
  addr?: string;
  /** null for a graded-but-untiered wallet (the exporter allows both). */
  tier: string | null;
  wins: number;
  losses: number;
  win_rate: number;
  pnl_usd: number;
  avg_pnl: number;
  is_founding_vip: boolean;
  /** ISO timestamp, or null when the wallet has no closed trade yet. */
  last_trade_at: string | null;
}

/** CEX listing radar row — `is_pre_listing` is the edge, flag it loudly. */
export interface AlphaListing {
  coin: string;
  exchange: string;
  kind: string;
  is_pre_listing: boolean;
  title: string;
  /** Unix seconds. */
  ts: number;
  source: string;
}

export interface AlphaCatalyst {
  type: string;
  symbol: string;
  title: string;
  score: number;
  /** Unix seconds. */
  ts: number;
}

export interface AlphaUnlock {
  coin: string;
  /** ISO date (YYYY-MM-DD). */
  unlock_date: string;
  pct_supply: number;
  days_until: number;
}

/**
 * Full-array row counts. The teaser keeps only the first 2 rows of each
 * array but reports the real totals — that gap IS the sales pitch, so the
 * screen renders "+N more" from here rather than from the trimmed arrays.
 */
export interface AlphaCounts {
  smart_money?: number;
  wallet_leaderboard?: number;
  listing_radar?: number;
  catalysts?: number;
  unlock_watch?: number;
}

/** The digest itself — same shape for the free teaser and the paid feed. */
export interface AlphaDigest {
  version: number;
  /** ISO timestamp the digest was built. */
  generated_at: string;
  /** Unix seconds the digest was built. */
  generated_ts: number;
  freshness: AlphaFreshness;
  smart_money: AlphaSmartMoney[];
  wallet_leaderboard: AlphaWalletRow[];
  listing_radar: AlphaListing[];
  catalysts: AlphaCatalyst[];
  unlock_watch: AlphaUnlock[];
  /** True when this is the delayed + redacted free snapshot. */
  teaser: boolean;
  /**
   * False ONLY when the worker has never ingested a digest at all — "nothing
   * has ever been published" is a different answer from "nothing fired in
   * this window", and the screen must not conflate them. The live feed omits
   * the flag, so an absent value means available.
   */
  available: boolean;
  /**
   * True when the teaser is the ≥24h-old snapshot; false when the worker fell
   * back to redacting `latest` (nothing is 24h old yet), which is NOT
   * "yesterday's digest".
   */
  delayed: boolean;
  /**
   * Status of the CURRENT live feed at response time, carried on the teaser
   * envelope only. Lets the free preview report the feed's real state instead
   * of the delayed snapshot's own (possibly much rosier) stamp.
   */
  feed_status?: AlphaStatusLevel | 'unknown';
  /**
   * Whether the worker is currently selling access, carried on the teaser
   * envelope only. Public and refetched on every pull-to-refresh, so it is
   * the freshest sales signal available without a wallet.
   */
  sales_open?: boolean;
  /** Real totals behind a trimmed teaser; empty object when unreported. */
  counts: AlphaCounts;
}

/**
 * The worker's authoritative payment terms, returned on /alpha/auth and
 * /alpha/status. The app must never spend USDC on its compiled-in constants
 * alone: the worker verifies against ITS treasury and ITS price, and refuses
 * new subs entirely while the feed isn't live.
 */
export interface AlphaTerms {
  /** Worker's configured treasury, or null while sales are unconfigured. */
  treasury: string | null;
  /** Worker's configured price in USDC, or null when unreported. */
  price_usdc: number | null;
  /** Tri-state: true/false from the worker, null = it didn't tell us. */
  sales_open: boolean | null;
  /** Freshness of the live feed, or null when unreported. */
  feed_status: AlphaStatusLevel | 'unknown' | null;
}

/** Membership tier from the Owners' Lounge claim (mirrors LoungeTier). */
export type AlphaTier = 'founding' | 'early' | 'member';

/** Result of POST /alpha/auth — bearer token plus the entitlement it carries. */
export interface AlphaSession extends AlphaTerms {
  token: string;
  /** Lounge founding number, or null if this wallet never claimed one. */
  number: number | null;
  wallet: string;
  tier: AlphaTier | null;
  /** True when founding (#≤100) OR an active paid sub. */
  alpha: boolean;
  /** Entitlement expiry, epoch ms; null when not entitled. */
  alphaExp: number | null;
  /** Token expiry, epoch ms. */
  exp: number | null;
}

/** Result of GET /alpha/status?wallet= — no signature needed. */
export interface AlphaEntitlement extends AlphaTerms {
  founding: boolean;
  /** ISO timestamp the paid sub runs to, or null if never paid. */
  paid_until: string | null;
  active: boolean;
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
