# CLOCK IN hackathon (Solana Mobile, Sep 8 to Oct 9 2026)

This file is the map for judges: what existed before the hackathon, where the boundary is in git, and what was built inside the window.

## Project age and boundary

- First commit: `8d9b5c7`, 2026-07-06 (repository created for this app; the hackathon rules require a start no earlier than three months before launch).
- Live on the dApp Store since 2026-07-13 (v0.1.0). Eleven store releases up to v0.9.0 (versionCode 11) on 2026-09-04.
- **Pre-hackathon boundary tag: `v0.9.0-pre-clockin`** on the last commit before the window opened.
- Everything after the tag is hackathon work:

```bash
git log --oneline v0.9.0-pre-clockin..HEAD
git diff --stat v0.9.0-pre-clockin..HEAD
```

## What existed before Sep 8

Discover with ranking, freshness badges, hide-stale filter, rank deltas and sparklines; Search; App Detail with histogram, What's New, try-later, share, watch notifications, on-chain release badge; Rewards and perks feed; Alpha (paid intel, USDC unlock via MWA); the Owners' Lounge with Genesis-gated founding numbers and chat; Profile with MWA connect and Genesis Token verification; the Cloudflare Worker + D1 backend; the catalog indexer with daily history snapshots; the Yellowstone mint watcher.

Solana Mobile Stack in use before the window: Mobile Wallet Adapter (connect, signMessages, signAndSendTransactions) and Seeker Genesis Token verification on client and server.

## Built during the window

This section is appended as work lands, in commit order. Dates are the commit dates.

| Date | Area | What |
|---|---|---|
| 2026-09-10 | repo hygiene | RPC endpoint moved to environment only in the indexer and watcher (no default in code); history scrubbed of the old endpoint; README truth pass; version alignment; `x-ss` derived from the native build version instead of a hand-bumped constant. |

## Headline feature: Scout Vouch

One Genesis Token, one voice per app. A vouch is a Seed Vault signature verified on the worker against the Token-2022 Genesis Token. Its weight is read from the SKR staked in Solana Mobile's own staking program, capped so SKR is a multiplier and the Genesis Token stays the Sybil key. Detail lands here as it ships.

## Verification notes for judges

- Same author identity across the whole history. Commits carry `Co-Authored-By: Claude` trailers where Claude Code was used; that is stated rather than hidden.
- The history rewrite on 2026-09-10 replaced one RPC URL with `***REMOVED***` and removed four internal business-planning documents from `docs/`. Commit dates, authorship and code are unchanged.
