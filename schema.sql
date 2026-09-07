-- D1 schema for the number-picker vote log.
-- Apply with: wrangler d1 execute number-picker-db --file=./schema.sql

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  num_a INTEGER NOT NULL,
  num_b INTEGER NOT NULL,
  choice INTEGER NOT NULL CHECK (choice IN (1, 2)),
  nonce TEXT NOT NULL UNIQUE, -- ties row to the exact token issued; blocks replay
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_votes_session ON votes(session_id);
CREATE INDEX IF NOT EXISTS idx_votes_created ON votes(created_at);
