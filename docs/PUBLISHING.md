# Publishing to the Solana dApp Store

Official docs: https://docs.solanamobile.com/dapp-store/intro
(0% platform fees; every submission is reviewed by Solana Mobile.)

**The flow changed in 2026:** new apps are submitted through the **Publisher
Portal** web UI, and version updates ship via a portal-backed CLI with an API
key. The old config.yaml / `create publisher|app|release` NFT-minting flow is
deprecated.

## 1. Build a signed release APK

The store requires an APK (not AAB), signed with your release key:

```bash
npx expo prebuild                 # generates android/
cd android && ./gradlew assembleRelease
```

Set up a release keystore in `android/app` first (keep it out of git —
losing it means you can't update the app). Docs:
https://docs.solanamobile.com/dapp-store/build-and-sign-an-apk

## 2. First submission — Publisher Portal

1. Go to https://publish.solanamobile.com and create your publisher account.
2. Create the app (this mints the App NFT; you'll need a Solana keypair with
   a little SOL).
3. Upload the APK + assets: 512×512 icon, screenshots, description, privacy
   policy URL (required — the catalog exposes `privacyPolicyUrl`).
4. Submit for review and watch for reviewer feedback by email.

Policy bar: working app, no misleading claims —
https://docs.solanamobile.com/dapp-store/publisher-policy

## 3. Updates — CLI (CI-friendly)

```bash
npm install -g @solana-mobile/dapp-store-cli

# API key from https://publish.solanamobile.com/dashboard/settings/api-keys
export DAPP_STORE_API_KEY=<your-key>

dapp-store --apk-file ./android/app/build/outputs/apk/release/app-release.apk \
  --keypair ./publisher-keypair.json \
  --whats-new "Bug fixes and improvements"
```

The portal matches the APK's package name (`com.bilal.seekerscout`) to your
app automatically — no app id needed. RPC submission is handled by the portal.

## 4. After listing

Deep-link to your listing (works from any Android app):

```
solanadappstore://details?id=com.bilal.seekerscout
```

Marketing/promo resources: https://docs.solanamobile.com/marketing/overview
Also consider Solana Mobile Builder Grants ($10k) for mobile-first dApps.
