# Scout Alpha — build contract (v0.6.0)
*Frozen 2026-07-30. All three build tracks implement to THIS. Source of truth for shapes + API.*

## What it is
A paid **Alpha** intel tab in Seeker Scout. Surfaces the War Room's intel (VIP smart-money cluster buys, wallet-quality leaderboard, CEX listing radar, catalysts, unlock watch). **Free tier** = yesterday's digest, delayed + partially blurred (the marketing surface). **Paid tier** = live digest, unlocked with a USDC payment to the treasury OR free for Lounge founders (#1–100). Sells INFORMATION only — never execution, never custody. Legal lane: accepting USDC for our own data service (verified clean).

> Revises `BATTLE_PLAN_V02.md §5` ("no payment flows inside the app"). That rule was written pre-standing to minimize review risk; the dApp Store's whole pitch is 0%-fee crypto payments and COOK (a token launcher) passed review. Consciously revised, dated 2026-07-30.

## Freshness is non-negotiable
The exporter stamps real freshness; the app SHOWS it honestly. Never fake "live". If the bot is stale, the tab says "as of <time> — bot offline" and the paid switch is server-gated off when `status != "live"`.

---

## 1. Digest JSON (exporter output → worker ingest → app)
`data/team/alpha_digest.json` (latest) + rolling `data/alpha_digest/YYYYMMDD_HHMM.json` (7-day self-trim).

```jsonc
{
  "version": 1,
  "generated_at": "2026-07-30T06:00:00Z",
  "generated_ts": 1785....,
  "freshness": {
    "bot_running": false,            // heuristic: newest signal_log ts < 2h old
    "newest_signal_ts": 1783726673,
    "oldest_source_stale_seconds": 1640000,
    "status": "live" | "stale" | "degraded"   // live<2h, stale<48h, degraded otherwise
  },
  "smart_money": [                   // recent VIP cluster buys (yellowstone_vip / YELLOWSTONE_VIP_CLUSTER)
    { "mint","symbol","chain","wallet_count","buy_count","window_sec","grade","score",
      "top_wallets":[{"addr","tier","win_rate","pnl_usd"}], "ts" }
  ],
  "wallet_leaderboard": [            // wallet_tiers.json ⋈ signal_accuracy.wallet_performance, top N by pnl
    { "addr","tier","wins","losses","win_rate","pnl_usd","avg_pnl","is_founding_vip","last_trade_at" }
  ],
  "listing_radar": [                 // listing_events + coin_config(is_pre_listing) + upbit/bithumb + announcements, dedup (coin, ts±120s)
    { "coin","exchange","kind","is_pre_listing","title","ts","source" }
  ],
  "catalysts": [ { "type","symbol","title","score","ts" } ],
  "unlock_watch": [ { "coin","unlock_date","pct_supply","days_until" } ]
}
```
**Teaser transform (worker-side, served free):** take the snapshot that is ≥24h old; keep counts + first 2 rows of each array; null out `top_wallets[].addr` (→ tier + stats only), `smart_money[].mint` (→ symbol only), and drop `wallet_leaderboard[].addr`. Everything else visible. The teaser must be genuinely useful — it's the sales pitch.

---

## 2. Worker API (`lounge-worker/src/alpha.js`, routed from index.js like `/chat/*`)
Base: `https://seeker-lounge.bcrypto-eth.workers.dev`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/alpha/ingest` | header `x-alpha-key: <ALPHA_INGEST_SECRET>` | exporter pushes a digest; stores `latest` + dated row |
| GET  | `/alpha/teaser` | none | free/delayed/blurred digest (marketing) |
| POST | `/alpha/auth` | Genesis sig (reuse verifyGenesisSig) | returns bearer `{number,wallet,tier,alpha:bool,alphaExp,exp}`; alpha=true if founding(#≤100) OR active sub |
| GET  | `/alpha/feed` | Bearer w/ `alpha:true` & alphaExp>now | full live digest |
| POST | `/alpha/subscribe` | Genesis sig + `{txSignature}` | verify on-chain USDC transfer → write sub → return entitlement |
| GET  | `/alpha/status?wallet=` | none | `{founding:bool, paid_until:string|null, active:bool}` |

**Token:** extend the existing `chat.js` HMAC payload with `alpha` + `alphaExp` (or a parallel issuer in alpha.js reusing `hmacKey`/`issueToken` shape). TTL 24h; `alphaExp` = min(24h, sub paid_until).

**Payment verify (`/alpha/subscribe`)** — reuse `rpc(env, method, params)` from index.js:
1. Reject if `alpha_tx_used` already has `txSignature` (replay guard).
2. `getTransaction(txSignature, {maxSupportedTransactionVersion:0, encoding:'jsonParsed'})`, require `meta.err == null`, confirmed.
3. Find a USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) transfer whose destination ATA owner == `ALPHA_TREASURY` and uiAmount ≥ `ALPHA_PRICE_USDC` (compare via token balance deltas in meta.pre/postTokenBalances — robust to instruction shape). Require the signer/source owner == the authenticated `wallet`.
4. Write `alpha_tx_used(signature,...)` + upsert `alpha_subs(wallet, paid_until = max(now, current)+30d, last_tx, updated_at)`.
5. Founding #≤100 → always entitled regardless of payment (their first month gift; a sub extends beyond).

**Config (wrangler secrets/vars):** `ALPHA_INGEST_SECRET` (secret), `ALPHA_TREASURY` (var — CEO's USDC-receiving wallet, PLACEHOLDER `<<TREASURY_PUBKEY>>` until CEO sets), `ALPHA_PRICE_USDC` (var, default `"9.99"`). Reuse existing `RPC_URL` secret + `DB`.

**D1 additions (`schema.sql`, apply by hand — no migration runner):**
```sql
alpha_digests (id TEXT PRIMARY KEY, generated_ts INTEGER NOT NULL, status TEXT, payload TEXT NOT NULL);      -- id='latest' | 'YYYY-MM-DD'
alpha_subs    (wallet TEXT PRIMARY KEY, paid_until TEXT NOT NULL, last_tx TEXT, updated_at TEXT NOT NULL);
alpha_tx_used (signature TEXT PRIMARY KEY, wallet TEXT NOT NULL, used_at TEXT NOT NULL);
```

---

## 3. App (`src/screens/AlphaScreen.tsx`, `src/lib/alpha.ts`, `wallet.ts` addition, `App.tsx` tab)
- **Tab:** `ICONS` entry `Alpha: '◆'` (purple accent = members surface), `<Tab.Screen name="Alpha" component={AlphaScreen}/>` placed after Rewards. (6 tabs; if crowded, Alpha replaces nothing — verify bar fit on device.)
- **`src/lib/alpha.ts`** mirrors `lounge.ts`/`chat.ts`: `BASE`, `ALPHA_TOKEN_KEY='seekerscout.alpha.token.v1'`, `cachedAlphaToken()`, `getTeaser()`, `getAlphaStatus(wallet)`, `authAlpha(address,authToken,mint)`, `getFeed(token)`, `subscribeAlpha(address,authToken,mint,txSignature)`. Copy the AbortController+timeout+per-field-validate fetch pattern from `catalog.ts`. Never let one bad row crash the tab.
- **`wallet.ts` new export `payAlpha(address, authToken, treasury, amountUi): Promise<string>`** — build USDC `createTransferCheckedInstruction` (from ATA→treasury ATA, 6 decimals), add a `MemoProgram`/reference for traceability, `transact` → reauthorize-then-authorize fallback (mirror `signMessageBytes`) → `wallet.signAndSendTransactions({transactions:[tx]})`, return signature. Get latest blockhash from `RPC_URL`. USDC mint const `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
- **Screen states:** teaser (always, for everyone) → if wallet connected + entitled: live feed → else "Unlock — 9.99 USDC / 30 days" button (founders see "Free — you're Founder #N"). Flow: connectWallet → findGenesisToken → authAlpha; if not entitled, payAlpha → subscribeAlpha → re-auth. Reuse LoungeScreen's `sessionRef`/`claimingRef` re-entrancy guards. Disclaimer footer: "Informational only. Not financial advice." Honor `freshness.status` — show the "as of / bot offline" banner when not live.
- **Bug to fix in passing:** `lounge.ts pingOpen` sends `'x-ss':'6'` — bump to `'8'` (this release = versionCode 8). `app.json` → version `0.6.0`, versionCode `8`. `package.json` version is stale (0.2.0) — leave or align, app.json is source of truth.

## Exporter (`core/alpha_digest.py` + `scripts/export_alpha_digest.py` in the IT repo)
- `build_alpha_digest(hours=24) -> dict` to the §1 shape. Tail-read `signal_log.jsonl` (2–8MB window, NEVER full-read 404MB). Smart-money ← `yellowstone_vip`/`YELLOWSTONE_VIP_CLUSTER` rows, join `wallet_tiers.json` + `signal_accuracy.json.wallet_performance`. Leaderboard ← same join, top N by pnl, flag the 51 `SmartMoneyScout.VIP_WALLETS` as `is_founding_vip`. Listing radar ← merge `listing_events.jsonl`+`coin_config_signals.jsonl`(is_pre_listing_signal)+`upbit/bithumb_listings.jsonl`+`announcement_signals.jsonl` dedup (coin, ts±120s). Catalysts ← `active_catalysts.json` + signal_log catalyst_sources. Unlocks ← `data/cache/token_unlocks.json`. Freshness ← `intel_health.json` last_success + newest signal_log ts.
- Graceful when files are empty/stale (they ARE today) — emit valid JSON with `status:"stale"`, never crash, never zero-fill fake data.
- `write_alpha_digest()` → `data/team/alpha_digest.json` + rolling dated file; then POST to `/alpha/ingest` with `x-alpha-key`. Standalone CLI (`-X utf8 -u -m scripts.export_alpha_digest [--push] [--dry-run]`), `os.chdir(ROOT)` + `sys.path.insert`. Read-only DB (`sqlite3.connect(settings.database_url path)` ok alongside writer). Later: orchestrator hook (CronTrigger hourly + boot twin) — leave a commented stub, don't wire into a bot that's off.

## Out of scope this pass (CEO-hands / later)
Treasury pubkey · running the bot · EAS build · portal submit + Solflare mint · on-device verification (mandatory before "done" — typecheck-clean UI has failed on hardware 3×) · price experiments · founders'-free vs discount final call.
