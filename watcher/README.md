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

## Run live
```
# gRPC endpoint = the Triton HTTP RPC host on :443; token = the URL path token
set TRITON_GRPC_ENDPOINT=https://<your-triton-host>.mainnet.rpcpool.com
set TRITON_X_TOKEN=<the-path-token-from-your-triton-rpc-url>
npm run watch
```
Long-lived process with auto-reconnect + backoff. Discoveries are logged and
written to `../indexer/publishers.json`. Best run as a background service /
scheduled task on the same box as the daily indexer.

Note: the Triton gRPC token is a credential — it's read from env, never
committed. dApp Store mints are infrequent (a handful/day), so a live "hit"
may take a while; the self-test is the correctness proof.
