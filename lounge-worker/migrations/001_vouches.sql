-- ---------------------------------------------------------------------------
-- Scout Vouch (docs/HACKATHON.md "Headline feature"). One Genesis Token, one
-- voice per app; SKR staked in Solana Mobile's program is a capped multiplier.
-- APPLY BY HAND, same runner-less contract as schema.sql:
--   npm run migrate            (remote, production D1)
--   npm run migrate:local      (wrangler dev's local D1)
-- Every statement is IF NOT EXISTS / OR IGNORE, so re-running is safe.
-- Timestamps are JS toISOString() text (24 chars, ms, Z), never datetime():
-- the worker refuses any other `ts` form (vouch-lib.js TS_RE), so string
-- order == time order in every WHERE below.
-- ---------------------------------------------------------------------------

-- One row per (Genesis mint, Android package). The mint is the Sybil key
-- (schema.sql:5-7 reasoning); `wallet` is whoever signed the LATEST version,
-- so a resold Seeker's new holder can overwrite the old holder's opinion.
-- `signature` + `signed_ts` are the receipt of exactly what Seed Vault signed.
-- `weight` = weightFor(staked / n) where n = distinct mints this wallet has
-- vouched with (one stake backs one voice); stamped at write time and by the
-- nightly cron once D6 lands (weight_checked_at moves).
-- Moderation is two flags with different owners:
--   note_hidden: 3 distinct founding numbers reported it; the note and tags
--                leave public reads. The verdict and weight still count.
--   excluded:    operator only (runbook). Removes the row from every
--                aggregate, the chip and the ballot. Reports NEVER set it.
CREATE TABLE IF NOT EXISTS vouches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- referenced by vouch_reports; never reuse
  genesis_mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  package TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('works', 'broken')),
  tags INTEGER NOT NULL DEFAULT 0,        -- bitmask: 1 wallet_ok, 2 crashes, 4 needs_update
  note TEXT NOT NULL DEFAULT '',          -- <= 140 chars, link-stripped, single line, never '-'
  signature TEXT NOT NULL,                -- base58, 64 bytes, over vouchMessage()
  signed_ts TEXT NOT NULL,                -- the `ts:` line the wallet signed (canonical ISO)
  weight REAL NOT NULL DEFAULT 1,
  staked_skr REAL,                        -- NULL = unknown at write time (stub / RPC down)
  weight_checked_at TEXT,                 -- ISO of the last chain read behind `weight`
  reports INTEGER NOT NULL DEFAULT 0,     -- distinct reporter count (see vouch_reports)
  note_hidden INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,               -- server time of the last accepted write
  UNIQUE (genesis_mint, package)
);
CREATE INDEX IF NOT EXISTS idx_vouches_package ON vouches(package, excluded);
CREATE INDEX IF NOT EXISTS idx_vouches_mint ON vouches(genesis_mint);
CREATE INDEX IF NOT EXISTS idx_vouches_wallet ON vouches(wallet);   -- distinct-mint count + D6 cron
CREATE INDEX IF NOT EXISTS idx_vouches_updated ON vouches(updated_at);

-- Report dedupe keyed by the reporter's FOUNDING NUMBER (claims.id), which is
-- 1:1 with a Genesis mint (schema.sql:9-10 UNIQUE), so "3 distinct reporters"
-- means 3 distinct Seekers, never 3 wallets of one owner. Created now so the
-- D16-D17 report route needs no migration.
CREATE TABLE IF NOT EXISTS vouch_reports (
  vouch_id INTEGER NOT NULL,
  reporter_number INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (vouch_id, reporter_number)
);

-- Per-wallet rate limit + block flag for vouching and voting. Separate from
-- chat_members so chat moderation and vouch moderation stay independent.
-- Two slots so a vouch and a vote inside 10 s both succeed.
CREATE TABLE IF NOT EXISTS vouch_members (
  wallet TEXT PRIMARY KEY,
  last_vouch_at TEXT,
  last_vote_at TEXT,
  blocked INTEGER NOT NULL DEFAULT 0
);

-- Weekly Lounge vote: one row per (ISO week, Genesis mint). Re-voting inside
-- the week overwrites the row under the same monotonic signed_ts guard as
-- vouches. `week` is 'YYYY-Www' computed in UTC (vouch-lib.js isoWeek()).
-- weight follows the vouch rule: staked / (distinct mints this wallet voted
-- with this week).
CREATE TABLE IF NOT EXISTS votes (
  week TEXT NOT NULL,
  genesis_mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  package TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  staked_skr REAL,
  signature TEXT NOT NULL,
  signed_ts TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (week, genesis_mint)
);
CREATE INDEX IF NOT EXISTS idx_votes_week_package ON votes(week, package);
CREATE INDEX IF NOT EXISTS idx_votes_week_wallet ON votes(week, wallet);

-- Per-minute budget for chain checks (index.js takeRpcBudget, called from
-- verifyGenesisSig step 2b). Every key starts with the UTC minute: the bare
-- minute is the open pool, '<minute>k' the members' pool, '<minute>m<mint>'
-- one Genesis mint's share of the members' pool and '<minute>i<address>' one
-- client address's share of the open pool. Rows older than two minutes are
-- deleted by the same code.
CREATE TABLE IF NOT EXISTS rpc_budget (
  minute TEXT PRIMARY KEY,                -- 'YYYY-MM-DDTHH:MM', plus the pool suffix above
  n INTEGER NOT NULL DEFAULT 0
);

-- Server-side kill switches, also served to the app by GET /flags. Only '1'
-- is on and any other value is off, on both sides (vouch-lib.js settingOn);
-- a missing row reads as on, except withdraw_enabled (off). Flip with
--   wrangler d1 execute seeker-lounge --remote --command "UPDATE settings SET value='0', updated_at='<iso>' WHERE key='vouch_enabled'"
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('vouch_enabled',    '1', '2026-09-11T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('vote_enabled',     '1', '2026-09-11T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('stake_enabled',    '1', '2026-09-11T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('skr_read_enabled', '1', '2026-09-11T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('withdraw_enabled', '0', '2026-09-11T00:00:00.000Z');
