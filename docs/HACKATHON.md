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
| 2026-09-26 | ads | Audit of the live banner carousel: an expired promo removed, three false ad claims corrected, banners now drop off automatically after their `expires` date. |
| 2026-09-26 | Scout Daily (worker) | Two daily games served by the worker: Guess the dApp and Higher or Lower. The day's answer is picked by an HMAC of the date from a public pool, so it is fixed and cannot be read ahead. Ranked play needs a Lounge seat, which is one claim per Seeker Genesis Token, so each Seeker gets one ranked run a day. Weekly public board (founding numbers, never wallets), chat reactions, unread count. Server-side fix for the store's September move from 11 to 18 categories, which had emptied 7 of v0.9's 11 category chips. |
| 2026-09-26 | Scout Daily (app), v0.10.0 | Game screens, practice mode anyone can play, results shared into the Lounge chat as cards, unread badge on the Lounge tab, reactions. |
| 2026-09-26 | hardening | A move made across UTC midnight is refused (409, nothing recorded) instead of landing on the next day's puzzle; the board counts only members who scored. |
| 2026-09-27 | device fixes | Five fixes found on the Seeker: seat badge, streak wording, suggestions above the keyboard, Higher or Lower question wording, chip clipping. |
| 2026-09-27 | retention, v0.10.1 | Once a day per install the open ping adds a days-since-install bucket and a first-launch flag, computed on the phone, no id; the worker counts them so drop-off can be measured. The privacy policy was rewritten to list what the app actually sends. `scripts/retention.mjs` reads it out. |
| 2026-09-28 | data | Daily catalog snapshots Sep 10 to Sep 28, one batched commit. |
| 2026-09-29 | Scout Vouch (worker) | Live in production. `POST /vouch`: a Seed Vault signature over a domain-separated message that names the wallet and the Genesis Token mint, verified on the worker (freshness, ed25519, Token-2022 SGT fingerprint and holder check), one vouch per Genesis Token per app, newer signatures only (monotonic), a kill switch served to the app by `GET /flags`, notes refused if they carry a link, hidden ones included. Reads: per app, per mint, aggregate and this week's top. A per-minute budget in front of every chain check protects the paid RPC for claims, chat and alpha logins too. Tests: 13 unit, 32 end-to-end against a local worker with a fake RPC. |
| 2026-09-29 | Scout Vouch (app) | A vouch card and sheet on every app page: works or broken, tags, an optional note, one Seed Vault prompt per vouch (signed once and re-sent unchanged through retries, so a retry never asks the wallet again), honest weight copy (1.00x until the SKR stake reader ships), the kill switch read from `GET /flags`, and the owner's own answer kept on the phone. A "Most vouched this week" card in the Lounge lists catalog apps only. Tests: 35 (unit, plus byte-for-byte parity with the live worker's message and note rules over a 6,000+ string corpus) and 18 end-to-end against a local worker. Android backup off; the privacy policy now covers vouching. |
| 2026-09-30 | SKR stake reader (worker) | Vouch weight now comes from the SKR staked in Solana Mobile's staking program: one `getMultipleAccounts` read of the signer's own stake account (PDA derived without web3.js), every account checked for owner, exact length, discriminator and keys, and any failure counts 1.00x. Clean reads are cached 60 s per wallet in D1 (`migrations/002_skr_cache.sql`) and the read sits behind the signature, the SGT check and the existing RPC budget. Public vouch payloads now carry no per-owner weight or stake (notes, app totals, the weekly list); weights still rank apps. Layouts pinned against the on-chain IDL (`program/`), tested on live mainnet fixtures and an in-memory D1 (17 reader tests, 41 integration scenarios). |
| 2026-09-30 | SKR stake reader (app) | Weight copy for the live reader. Before signing, the sheet says staked SKR can raise a voice up to 4x and is read when you sign; after, it prints the worker's own number ("Your voice counts 3.06x on 11,355.88 SKR staked."), or 1.00x with the reason when the stake was not read. The card's weight follows the worker's re-stamp of the wallet's other vouches, and the app keeps no weighted totals. |
| 2026-09-30 | SKR stake reader, live | Deployed to production (worker `337cdf90`) after migration 002, with the updated privacy page on seekerscout.com; every live check passed on the first round and public vouch data carries no weight. First live read on a Seeker: the owner re-signed his vouch on Seeker Scout and the worker weighed it from his staked SKR, read on chain (a weight above 1.00x, matching the curve for the amount the app showed him). The stub-era 1.00x on that vouch was replaced by the same signature. |
| 2026-09-30 | SKR re-weight (worker) | An hourly job re-reads the SKR staked by every wallet that vouched and re-stamps its vouches in both directions, so a stake removed after vouching stops counting; weekly vote weights can only go down. At most 99 wallets per `getMultipleAccounts` call, set-based D1 writes, a D1 kill switch, and a failed read changes nothing. Notes that would end in half an emoji are refused. |

## Headline feature: Scout Vouch

One Genesis Token, one voice per app. A vouch is a Seed Vault signature verified on the worker against the Token-2022 Genesis Token. Its weight is read from the SKR staked in Solana Mobile's own staking program, capped so SKR is a multiplier and the Genesis Token stays the Sybil key. Detail lands here as it ships.

## Verification notes for judges

- Same author identity across the whole history. Commits carry `Co-Authored-By: Claude` trailers where Claude Code was used; that is stated rather than hidden.
- The history rewrite on 2026-09-10 replaced one RPC URL with `***REMOVED***` and removed four internal business-planning documents from `docs/`. Commit dates, authorship and code are unchanged.
