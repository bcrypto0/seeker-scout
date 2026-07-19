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
