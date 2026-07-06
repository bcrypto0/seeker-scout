# Seeker Scout

**A better way to discover apps on the Solana Seeker.**

The Solana dApp Store has ~1,500 apps, but the official store gives you little signal about which ones are good, maintained, or Seed Vault-native. A Cointelegraph analysis found barely 60% of listed apps had been updated within a year; some are just browser shortcuts. Solana Mobile shipped "dApp Spotlight" (June 2026) — a centrally curated fix. Seeker Scout is the community-driven one.

## What makes it better

- **Freshness badges** — green/yellow/red based on last release date. Instantly spot abandoned apps.
- **Seed Vault badge** — flags apps with true wallet-native onboarding vs. email/Google login walls.
- **Verified-owner reviews** — reviews gated to wallets holding a Seeker Genesis Token (soulbound NFT every Seeker owner has). No bot reviews, no paid shills.
- **Trending** — ranked by real activity signals, not marketing.
- **Rewards tab** — active Seeker Season boosts, airdrops, and claim deadlines in one place, with push notifications (planned).

## Architecture

```
seeker-scout/
├── App.tsx               # Bottom tabs: Discover / Search / Rewards / Profile
├── index.ts              # Entry + web3.js polyfills
├── src/
│   ├── lib/
│   │   ├── types.ts      # DappEntry, RewardOpportunity
│   │   ├── catalog.ts    # Fetch catalog JSON (bundled seed data fallback)
│   │   └── wallet.ts     # Mobile Wallet Adapter connect + Genesis Token check
│   ├── screens/          # Discover, Search, Rewards, Profile
│   └── theme.ts
├── indexer/
│   └── fetch-catalog.mjs # Node script: build catalog.json from on-chain data
└── docs/
    └── PUBLISHING.md     # How to ship to the Solana dApp Store
```

**Catalog strategy (verified working, July 2026):** the dApp Store's "explore" GraphQL feed returns the full catalog (~1,100+ apps, 12 categories) in one unpaginated response, including ratings, review histograms, `updatedOn` dates, icons, and publisher info. The `indexer/` script fetches it (currently via seekertracker.com's public proxy `/api/dappstore` — swap in the official endpoint via `DAPPSTORE_URL` if you find one), ranks apps (Bayesian rating + freshness + volume), and emits `catalog.json` to host anywhere static. The app fetches that JSON — no backend server needed for v1. Real seed data for 44 top apps is bundled as fallback.

## Setup

Requires Node 20+, Android Studio + SDK, a physical Android device or emulator.

```bash
npm install
npx expo prebuild          # generate android/ project
npx expo run:android       # build + install dev client
```

> **Important:** Mobile Wallet Adapter does NOT work in Expo Go. You must use a
> development build (`expo-dev-client`, already in deps) or `expo run:android`.

Build the catalog (no API key needed):

```bash
npm run index-catalog
```

## Roadmap

1. **v0.1** — browse/search catalog, freshness + Seed Vault badges, rewards tab (manual feed), wallet connect.
2. **v0.2** — Genesis Token verification, on-chain attested reviews, push notifications for reward deadlines.
3. **v0.3** — usage-based trending (indexer heuristics), personalized recommendations.
4. **Publish** — see `docs/PUBLISHING.md`. 0% store fees.

## Open TODOs (marked in code)

- `RPC_URL` in `src/lib/wallet.ts` — add your Helius API key (free tier fine; `getTokenAccountsByOwnerV2` used for Genesis Token checks is Helius-specific).
- `CATALOG_URL` in `src/lib/catalog.ts` — host `indexer/catalog.json` (GitHub Pages/Cloudflare) and point this at it.
- `seedVaultNative` flags — community-curated via `indexer/overrides.json` (the store feed doesn't expose this; that's exactly why the badge is valuable).
- Reviews storage (v0.2): tiny serverless API that verifies a wallet signature + Genesis Token (mint address = anti-sybil key, per official SGT docs) before accepting a review.

## Resolved (so you don't re-research)

- **Genesis Token verification**: SGT is Token-2022 (not Metaplex). Check mint authority `GT2zu…p3A4` + metadata pointer + group `GT22s…99Te` — implemented in `src/lib/wallet.ts` per [official docs](https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token).
- **Catalog source**: full store feed with ratings/updatedOn confirmed working — see `indexer/fetch-catalog.mjs` header for the schema.
- **Publishing flow (2026)**: Publisher Portal for first submit, CLI for updates — see `docs/PUBLISHING.md`.
- **Listing deep link**: `solanadappstore://details?id=<package>` (used in `AppCard`).
