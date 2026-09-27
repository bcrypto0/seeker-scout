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

-- Where installs drop off (v0.10.1+). At most one row-bump per install per
-- day: kind = 'first' (first launch ever on that phone) | 'return';
-- bucket = days since install, bucketed ON THE PHONE ('0','1','2','3','4-7',
-- '8-14','15-30','31+'). Still no device id: it counts installs by age.
-- Read it:
--   SELECT day, kind, bucket, count FROM opens_age ORDER BY day DESC, kind, bucket;
-- First opens with bucket '0' vs the portal's installs = how many installers
-- open the app at all; 'return' rows in '1' / '2'-'3' / '4-7' = who comes back.
-- A v0.9 user updating also sends one 'first' (with their real install age),
-- so 'first' rows in older buckets are upgraders, not new installs.
CREATE TABLE IF NOT EXISTS opens_age (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, bucket)
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

-- Scout Daily (v0.10). One row per UTC day, created on the first request of
-- the day and never changed after: `data` snapshots the answer and the
-- Higher or Lower chain so the puzzle plays the same all day.
CREATE TABLE IF NOT EXISTS game_daily (
  day TEXT PRIMARY KEY,
  answer_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One run per seat per game per day. `moves` guards concurrent writes;
-- `score` holds weekly-board points (max 10 per game per day).
CREATE TABLE IF NOT EXISTS game_plays (
  day TEXT NOT NULL,
  game TEXT NOT NULL,              -- 'guess' | 'hol'
  number INTEGER NOT NULL,         -- the player's Lounge number
  wallet TEXT NOT NULL,
  state TEXT NOT NULL,             -- JSON: {guesses:[]} or {picks:[]}
  moves INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, game, number)
);
CREATE INDEX IF NOT EXISTS idx_game_plays_number ON game_plays (number, game, day);

-- Lounge reactions: a closed emoji set, one of each per member per message.
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, number, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions (message_id);
