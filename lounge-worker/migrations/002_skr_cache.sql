-- ---------------------------------------------------------------------------
-- SKR staking read cache and PDA store (SPEC-skr-final 1.7, the D6 read path).
-- APPLY BY HAND after 001_vouches.sql, same runner-less contract:
--   npm run migrate:skr          (remote, production D1, interactive confirm)
--   npm run migrate:skr:local    (wrangler dev's local D1)
-- Every statement is IF NOT EXISTS, so re-running is safe. There is no ALTER:
-- a later column change is a new migration file, never an edit to this one.
-- skr_cache: one row per wallet read inside a signed flow (today POST /vouch,
--   via src/skr.js readStakeWeight). 'unknown' reads are never stored, so a
--   failed read is retried on the next request instead of being served.
-- wallet_pdas: UserStake PDA per (wallet, pinned pool), written on the
--   wallet's first read (INSERT OR IGNORE of skr.js's own derivation); later
--   reads never re-derive it (0.27 ms each).
-- Left for the migrations of later days, because only they read them:
--   skr_read_slots (POST /skr/read rate limit, SPEC-skr-final 1.11) and the
--   settings re-declaration plus its skr_read_enabled row (read by the D16
--   cron and by /skr/read; 001_vouches.sql already inserts that row).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skr_cache (
  wallet TEXT PRIMARY KEY,
  status TEXT NOT NULL,              -- 'ok' | 'none'
  staked_raw TEXT NOT NULL,          -- u64 as decimal string (SQLite INTEGER is 63-bit signed)
  unstaking_raw TEXT NOT NULL,
  unstake_ts INTEGER NOT NULL,       -- unix seconds, 0 = nothing pending
  cooldown_seconds INTEGER NOT NULL,
  share_price TEXT NOT NULL,         -- u128 as decimal string, 1e9 scale
  weight REAL NOT NULL,              -- weightFor(staked), undivided; the routers divide per wallet
  slot INTEGER NOT NULL,
  checked_at TEXT NOT NULL           -- JS toISOString(), never SQLite datetime()
);

CREATE TABLE IF NOT EXISTS wallet_pdas (
  wallet TEXT NOT NULL,
  pool TEXT NOT NULL,                -- pinned GuardianDelegationPool address
  pda TEXT NOT NULL,
  bump INTEGER NOT NULL,
  PRIMARY KEY (wallet, pool)
);
