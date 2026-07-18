# On-chain indexer — Phase 1 spike (2026-07-18)

Goal: stop depending on seekertracker.com (a competitor + proved unreliable
2026-07-18) for the catalog. Findings from probing the dApp Store's on-chain
structure via our paid Triton RPC + DAS.

## What's confirmed

1. **No global on-chain registry exists.** The dApp Store is Publisher NFT →
   App NFT → Release NFT, all Metaplex collections. Each app NFT's update
   authority AND verified creator is the **publisher's own wallet** (verified:
   our app collection `4MeS1dcE…brTfnb3G` is authored by our publisher
   `5G6j…HU1B`). There is NO shared dApp-Store-wide authority/creator/marker.
   → You cannot enumerate all ~1,166 apps purely on-chain without already
   knowing every publisher address. (Spec confirms: no global registry.)

2. **DAS works on Triton — this is the real win.** Confirmed methods:
   - `getAssetsByOwner(publisherWallet)` → every App + Release NFT that
     publisher minted, with collection grouping.
   - `getAsset(mint)` → `content.json_uri` → full release metadata JSON on the
     `r2.solanamobiledappstore.com` CDN. Fields under
     `extensions.solana_dapp_store`: publisher_details, release_details, media,
     files, android_details (version, version_code, apk sha256, cert
     fingerprint, permissions, min_sdk, icon, screenshots).
   - Release NFTs are immutable + timestamped on-chain.

3. **Store frontend loads assets from Arweave** (`turbo.ar.io` referenced by
   solanamobiledappstore.com) — decentralized/permanent, worth deeper probe as
   an alternate discovery source.

## Revised plan (better than the original "pure on-chain indexer")

The original framing isn't achievable (no global registry), but the GOAL
splits into two wins:

**A. On-chain ENRICHMENT layer (build now, high value, low risk).** For every
app already in our catalog, resolve its publisher wallet once, then use DAS
`getAssetsByOwner` to pull the immutable on-chain release history +
timestamps + verified freshness. Unlocks: "on-chain verified" freshness
badge (marketing SolanaFloor can't match), real release timeline on the
detail page (feeds v0.3 sparkline story), "more by this publisher," and a
cross-check that catches any bad seekertracker data. Independent of the
discovery source; ships as an indexer add-on.

**B. Replace the DISCOVERY source (the seekertracker dependency).** Options,
in order of preference:
   1. Find the store's OWN explore GraphQL backend (seekertracker just proxies
      it — the `data.explore.units` shape is the store's, not theirs). Probe
      the on-device dApp Store app's network calls or the web frontend's XHRs.
   2. Arweave/AR.IO tag-query enumeration (if publishing tags releases).
   3. Accumulate publishers over time from (A) + on-chain mint-event watching
      via Triton Yellowstone (we have gRPC access from the IT project) →
      eventually a self-sustaining publisher set that detects new apps
      BEFORE seekertracker.

## Next action
Build (A) as an indexer module (no app release needed — pure catalog
enrichment). Decide (B) discovery path — needs one more probe session on the
official backend endpoint. NOT a tonight task; ~1–2 weeks background.
