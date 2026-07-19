# Seeker Scout — on-chain mint-watcher

The **independent** dApp Store discovery source (Track B). Streams Solana
Token Metadata transactions via Triton Yellowstone gRPC and detects new dApp
Store app/release NFTs **at mint time** — no third-party feed, no partner key,
nobody's permission. A competitor can revoke a feed; they can't revoke the
chain.

## How it works
1. Subscribe to Token Metadata program (`metaqbxx…518x1s`) transactions.
2. Decode each create instruction's `name / symbol / uri` (handles the unified
   `Create` tag 42 and legacy `CreateMetadataAccount` 0/16/33).
3. Filter: URI host == `r2.solanamobiledappstore.com` → it's a dApp Store
   release. (~99.99% of NFT mints are discarded here, before any RPC call.)
4. Extract the publisher (update authority), then DAS-expand to **all** that
   publisher's apps and accumulate `../indexer/publishers.json` — which the
   Track A enrichment pass (`indexer/enrich-onchain.mjs`) consumes.

Coverage compounds: every new publisher we see hands us their whole
back-catalog, so over time the on-chain map approaches full independence from
seekertracker.

## Validate (no stream needed)
```
npm install
npm run selftest
```
Runs the full decode + publisher-extraction pipeline against our own v0.2.0
release NFT's real on-chain creation transaction. Must print
`✅ SELF-TEST PASS`.

## Run live (one-off)
```
set TRITON_GRPC_ENDPOINT=https://<your-triton-host>.mainnet.rpcpool.com
set TRITON_X_TOKEN=<the-path-token-from-your-triton-rpc-url>
npm run watch
```
Long-lived process with auto-reconnect + backoff. Logs `stream live` once
connected; writes discoveries to `../indexer/publishers.json`.

## Permanent service (installed 2026-07-19)
Runs at every logon, hidden, self-restarting — no admin required:

1. **Config in the registry (once), not in any file:**
   ```powershell
   [Environment]::SetEnvironmentVariable("TRITON_GRPC_ENDPOINT","https://<host>.mainnet.rpcpool.com","User")
   [Environment]::SetEnvironmentVariable("TRITON_X_TOKEN","<path-token>","User")
   ```
2. **`run-watcher.bat`** (this dir) reads those from `HKCU\Environment` at
   runtime, `cd`s here, runs the watcher, self-restarts on exit. No secret in
   the file.
3. **`%APPDATA%\...\Start Menu\Programs\Startup\SeekerScoutWatcher.vbs`**
   launches the bat hidden at logon (machine-local; not in the repo). This
   sidesteps Task Scheduler's 72h execution limit and needs no elevation.
4. Log: `%LOCALAPPDATA%\SeekerScout\watcher.log`.

The Triton token lives ONLY in the user registry — never committed. dApp
Store mints are infrequent (a handful/day), so a live `[hit]` may take a
while; `npm run selftest` is the correctness proof.
