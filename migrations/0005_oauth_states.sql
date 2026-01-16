-- OAuth state parameters for CSRF protection
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for cleanup of expired states
CREATE INDEX IF NOT EXISTS idx_oauth_states_created ON oauth_states(created_at);
