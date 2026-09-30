# program/: the pinned SKR staking IDL

Seeker Scout reads Solana Mobile's SKR staking program. It never deploys, signs for or holds anything on it. This folder pins the facts that the worker's stake reader (`lounge-worker/src/skr.js`) hard-codes, so an upgrade of the program can be caught before a decoder reads the wrong bytes.

`idl.json` is the program's Anchor IDL, inflated from the on-chain IDL account and stored exactly as inflated: one line with no trailing newline. Do not reformat, pretty-print or re-save it. Its SHA-256 is the pin. The repo's `.gitattributes` marks it `-text` (the file has no CR or LF today, so line-ending conversion cannot touch it, but the attribute keeps it that way).

## Pinned values (read 2026-09-30 from mainnet, public RPC, slot 451853276)

| Item | Value |
|---|---|
| Program id | `SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ` (owner `BPFLoaderUpgradeab1e11111111111111111111111`, executable) |
| ProgramData account | `7f1KoiGPFFouvAafZtVmtdpgGJuADprihB9Pdzut3gaJ` |
| Deploy slot (ProgramData offset 4, u64 LE) | `393714625` (deployed 2026-01-15T18:11:10Z) |
| Upgrade authority | `Hgbea5UFVXD3dQoL2mJbXLVnnFFRqyJJis9vfm69w5oQ` (set 2026-01-20 by `SetAuthority`; the program is upgradeable by this one key) |
| IDL account | `4aAEUKCcju9iAEAgdeaNz4RC7sCPv63q5g714nw4QY68` (= `createWithSeed(findProgramAddress([], program), "anchor:idl", program)`, owner = program) |
| IDL authority | `8NFCRCK2SCw4nBXdCjvgEzvFidSoaNcwpBM7rkUxooqx` |
| IDL account layout | 8-byte discriminator `[24,70,98,191,58,144,123,158]` (`sha256("internal:IdlAccount")`), 32-byte authority, u32 LE `data_len` at offset 40, zlib payload from offset 44 |
| IDL account size / payload | 8586 bytes / `data_len` 4271 (compressed) |
| `idl.json` | 20,854 bytes, `address` = the program id, `metadata`: `staking` 0.1.0, spec 0.1.0, 11 instructions |
| **SHA-256 of `idl.json`** | **`6b5086f57a412d07ee5d9c839a7fc8723f592cc2bbc7771573133e68b411c843`** |
| Last write to the IDL account | 2026-01-22T22:10:21Z (slot 395274256); nothing has written it since |

Account layouts the code depends on (Anchor borsh, no padding; derived from `idl.json` and checked against live accounts):

| Account | Length | Discriminator | Fields the code reads |
|---|---|---|---|
| StakeConfig | 193 | `[238,151,43,3,11,151,63,176]` | `share_price` u128 @137, `cooldown_seconds` u64 @113, `mint` @41, `stake_vault` @73 |
| GuardianDelegationPool | 188 | `[133,238,255,214,215,11,189,23]` | `active` bool @171, `commission_bps` u16 @168 |
| UserStake | 169 | `[102,53,163,107,9,138,87,153]` | `bump` @8, `stake_config` @9, `user` @41, `guardian_pool` @73, `shares` u128 @105, `unstaking_amount` u64 @153, `unstake_timestamp` i64 @161 |

Instruction discriminators: `stake` `[206,176,202,18,200,209,179,108]`, `unstake` `[90,95,107,42,205,124,50,225]`, `cancel_unstake` `[64,65,53,227,125,153,3,167]`, `withdraw` `[183,18,70,156,148,109,161,34]`. UserStake PDA seeds (from the IDL): `["user_stake", stake_config, user, guardian_pool]`.

## How to re-verify

Read-only, public RPC, no keys, Node 18 or later with no packages: `node program/verify.mjs program/idl.json` from the repo root. It exits 0 when nothing changed and 1 on drift. It makes two calls:

1. `getAccountInfo` on the ProgramData account, base64, `dataSlice` `{ offset: 0, length: 45 }`. Byte 0 to 3 is the loader tag (3), bytes 4 to 11 are the deploy slot as u64 little-endian. Compare with `393714625`.
2. `getAccountInfo` on the IDL account, base64. Read `data_len` = u32 LE at offset 40, take bytes `44 .. 44 + data_len`, zlib-inflate them (`zlib.inflateSync`), SHA-256 the inflated bytes. Compare with the hash above, and with `sha256sum program/idl.json` (PowerShell: `Get-FileHash program/idl.json -Algorithm SHA256`).

If either value changes, the program or its IDL was changed after 2026-09-30:

1. Pause vouching: `vouch_enabled` = `'0'` in the D1 `settings` table (`GET /flags` then reports `vouch: false` and the app stops offering the vouch). The stake read inside a vouch is deliberately not gated by `skr_read_enabled` (SPEC-skr-final 6.2): pausing only the read would stamp 1.00x on every new vouch. The decoders also check owner, exact length and discriminator, so most layout changes already fail closed to 1.00x.
2. Inflate the new IDL, re-derive every offset, length and discriminator above, and diff it against this `idl.json`.
3. Re-capture `lounge-worker/test/fixtures/skr_fixtures.json` from mainnet and re-run `npm test` (worker) and `npm run test:app` (app) before switching anything back on.

No automatic drift check runs yet: the hourly re-weight cron and its `checkDrift` (SPEC-skr-final 1.10) are not built. Run `verify.mjs` before each worker deploy. The deploy slot is the signal that matters for decoding, because the program binary, not the IDL, fixes the account layouts. The IDL authority (`8NFCRC...`, a different key from the upgrade authority) can rewrite the IDL without an upgrade, so a changed IDL hash with an unchanged deploy slot means the documentation changed, not the bytes. Check that case by hand.
