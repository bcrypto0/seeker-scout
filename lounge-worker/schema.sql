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
