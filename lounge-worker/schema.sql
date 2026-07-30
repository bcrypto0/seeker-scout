-- Founding-number registry: plain INTEGER PRIMARY KEY (NOT AUTOINCREMENT —
-- AUTOINCREMENT burns a number on every ignored duplicate insert, which
-- would let replays wipe out the founding-100 tier; plain rowid reuses
-- max(rowid)+1 with no gaps).
-- genesis_mint UNIQUE = one claim per physical Seeker, forever. If a Seeker
-- changes hands, the new holder retrieves the SAME number (first-claim
-- lineage; wallet column records the original claimant).
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY,
  genesis_mint TEXT UNIQUE NOT NULL,
  wallet TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);

-- Owners' Lounge chat. Only Genesis-verified members (a claimed founding
-- number) can post; anyone may read. Moderation: link-stripped text, per-
-- wallet rate limit, report-based auto-hide.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL,        -- author's founding number
  wallet TEXT NOT NULL,
  tier TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reports INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id);

-- One row per wallet: last post time (rate limit) + block flag (moderation).
CREATE TABLE IF NOT EXISTS chat_members (
  wallet TEXT PRIMARY KEY,
  last_post_at TEXT,
  blocked INTEGER NOT NULL DEFAULT 0
);

-- Dedup reports so one wallet can't spam-report a message.
CREATE TABLE IF NOT EXISTS reports (
  message_id INTEGER NOT NULL,
  reporter TEXT NOT NULL,
  PRIMARY KEY (message_id, reporter)
);

-- Anonymous daily app-open counter (DAU/impressions proxy for ad sales).
-- No device id, no PII — just a per-day tally the app POSTs on launch.
CREATE TABLE IF NOT EXISTS opens (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Scout Alpha (docs/SCOUT_ALPHA_SPEC.md §2).
-- APPLY BY HAND — there is no migration runner in this worker:
--   wrangler d1 execute seeker-lounge --remote --file=./schema.sql
-- Every statement here is CREATE ... IF NOT EXISTS, so re-running is safe.
-- ---------------------------------------------------------------------------

-- Ingested digests. id = 'latest' (the live feed) or 'YYYY-MM-DD' (the dated
-- snapshot the free teaser is served from, >=24h delayed). status mirrors
-- payload.freshness.status so the sales gate is one indexed read.
CREATE TABLE IF NOT EXISTS alpha_digests (
  id TEXT PRIMARY KEY,
  generated_ts INTEGER NOT NULL,   -- unix SECONDS
  status TEXT,                     -- 'live' | 'stale' | 'degraded'
  payload TEXT NOT NULL            -- the normalized digest JSON
);
CREATE INDEX IF NOT EXISTS idx_alpha_digests_ts ON alpha_digests(generated_ts);

-- Paid subscriptions. One row per wallet; paid_until is an ISO-8601 UTC
-- string (JS toISOString format — do NOT write SQLite datetime() output here,
-- the two formats do not compare lexicographically).
CREATE TABLE IF NOT EXISTS alpha_subs (
  wallet TEXT PRIMARY KEY,
  paid_until TEXT NOT NULL,
  last_tx TEXT,
  updated_at TEXT NOT NULL
);

-- Replay guard: a payment signature can be redeemed exactly once, forever.
CREATE TABLE IF NOT EXISTS alpha_tx_used (
  signature TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  used_at TEXT NOT NULL
);
