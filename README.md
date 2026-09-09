# Seeker Scout

**Your radar for the Solana dApp Store.** Live on the store since 2026-07-13, now v0.9.0 (versionCode 11).

The dApp Store lists ~1,500 apps and gives you little signal about which ones are maintained, which are Seed Vault-native, and which are worth your time. Seeker Scout is a Seeker-only companion that ranks the catalog, tracks it daily, and gates its community features behind the Seeker Genesis Token so that every voice belongs to a real device.

- **Store listing:** open `solanadappstore://details?id=com.bilal.seekerscout` on a Seeker
- **Site:** [seekerscout.com](https://seekerscout.com)
- **Hackathon (CLOCK IN, Sep 8 to Oct 9 2026):** see [docs/HACKATHON.md](docs/HACKATHON.md) for the pre-hackathon boundary tag and everything built during the window

## What is shipped (v0.9.0)

Six tabs: Discover, Search, Rewards, Alpha, Lounge, Profile.

- **Discover.** The catalog ranked by a Bayesian rating with freshness and volume terms. Freshness badges (green / yellow / red from last release date), a hide-stale filter, rank-delta chips and sparklines from daily snapshots, Scout Pick and movers, remote-config banners.
- **Search** across the full catalog.
- **App Detail.** Rating histogram, What's New, try-later list, share, watch button (local notifications when an app you watch updates), and an on-chain release badge where the publisher's Release NFTs have been resolved.
- **Rewards.** Seeker Season rewards and app perks in one feed, with a freshness pipeline so expired offers do not linger.
- **Alpha.** A paid intel tab. Free tier is a delayed digest; the paid tier unlocks with a USDC transfer signed by the user through Mobile Wallet Adapter, or is free for Lounge founders. Freshness is shown honestly and the paid switch is server-gated off when the feed is stale.
- **Lounge.** The Owners' Lounge: Genesis-gated founding numbers (one claim per Genesis Token, signed on device and verified on the worker) and a members' chat.
- **Profile.** Mobile Wallet Adapter connect, Genesis Token verification, founding-number claim, notification settings.

**Seed Vault badges** on Discover are currently hand-curated in `indexer/overrides.json`. They are not yet measured from the APKs; that is on the roadmap.

## Architecture

```
seeker-scout/
├── App.tsx                 # Six bottom tabs + AppDetail / Chat stack
├── src/
│   ├── lib/
│   │   ├── wallet.ts       # MWA connect, signMessages, Genesis Token check (Token-2022 SGT)
│   │   ├── lounge.ts       # Worker client: claim, chat, ping, stats
│   │   ├── alpha.ts        # Alpha digest + USDC unlock (the app's only on-chain write)
│   │   ├── catalog.ts      # catalog.json / banners / rewards / perks from Cloudflare Pages
│   │   └── types.ts
│   ├── screens/            # Discover, Search, Rewards, Alpha, Lounge, Chat, Profile, AppDetail
│   └── components/
├── lounge-worker/          # Cloudflare Worker + D1: claims, chat, alpha, ping/metrics
├── indexer/                # Catalog fetch, ranking, overrides, perks, rewards, first-seen, daily history
├── watcher/                # Yellowstone gRPC watcher for new dApp Store mints
├── scripts/                # Daily refresh (scheduled task), watchdog, publisher-key helpers
├── web/                    # seekerscout.com + assetlinks.json
└── docs/                   # PUBLISHING.md, SCOUT_ALPHA_SPEC.md, ONCHAIN_INDEXER_SPIKE.md, HACKATHON.md
```

**Catalog source, stated plainly.** The store's "explore" GraphQL feed returns the whole catalog with ratings, review histograms and `updatedOn` in one response. Seeker Scout currently mirrors it through seekertracker.com's public proxy (`DAPPSTORE_URL` overrides the endpoint) and never queries the store's own persisted-query endpoint. Official catalog access is pending with Solana Mobile. On top of the feed, `indexer/` keeps its own first-seen dates and daily rank history (`indexer/history/`), which cannot be backfilled from any source, and `indexer/onchain.mjs` resolves Release NFTs by publisher wallet through DAS for the apps whose publisher is known.

**Backend.** One Cloudflare Worker (`seeker-lounge`) with a D1 database. It stores no PII: founding claims keyed by Genesis mint, chat messages, Alpha entitlements, and an anonymous per-day opens counter.

## Security posture

- **Wallet:** Mobile Wallet Adapter only. The app never sees a seed phrase or private key and never asks for one.
- **Genesis Token:** verified as a Token-2022 asset against the official mint authority, metadata pointer and group, per the [Seeker Genesis Token docs](https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token). The client check is for UX; every write on the worker re-verifies the signature and the token server-side.
- **RPC keys:** none in the app. The APK talks to the public mainnet RPC and to the worker. The paid RPC endpoint exists only as a worker secret (`wrangler secret put RPC_URL`) and as environment variables for the indexer and watcher; nothing in this repository carries a key.
- **On-chain writes:** exactly one today, the Alpha unlock (a USDC transfer the user signs on device). Everything else is read-only or a signed message.

## Setup

Requires Node 20+, Android Studio + SDK, a physical Android device (a Seeker for MWA and Seed Vault).

```bash
npm install
npx expo prebuild
npx expo run:android
```

> Mobile Wallet Adapter does not work in Expo Go. Use the dev client (`expo-dev-client` is a dependency) or `expo run:android`.

Build the catalog (no API key needed for the feed itself):

```bash
npm run index-catalog
```

On-chain enrichment and the watcher need an RPC endpoint from the environment (`RPC_URL`, or `TRITON_GRPC_ENDPOINT` + `TRITON_X_TOKEN`). They fail loudly without one; there is no default.

Worker:

```bash
cd lounge-worker && npx wrangler deploy
```

Secrets (`RPC_URL`, `CHAT_SECRET`, `ALPHA_INGEST_SECRET`) are set with `wrangler secret put`, never in `wrangler.toml`.

## Publishing

See [docs/PUBLISHING.md](docs/PUBLISHING.md). The reusable parts of that flow are open-sourced separately as [expo-dapp-store-kit](https://github.com/bcrypto0/expo-dapp-store-kit).

## Resolved (so you do not re-research)

- **Genesis Token verification:** SGT is Token-2022, not Metaplex. Check mint authority `GT2zu…p3A4`, the metadata pointer and group `GT22s…99Te`. Implemented in `src/lib/wallet.ts` and in `lounge-worker/src/index.js`.
- **No global on-chain registry** for the store. Publisher NFT, App NFT and Release NFT are Metaplex collections authored by each publisher's own wallet; discovery is by known publisher. See `docs/ONCHAIN_INDEXER_SPIKE.md`.
- **Listing deep link:** `solanadappstore://details?id=<package>`.
- **Lockfile:** intentionally not committed; EAS builds on npm 10, whose strict `npm ci` rejects a lock produced by npm 11.
