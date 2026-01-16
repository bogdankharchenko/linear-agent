-- Pending config requests for initial team setup
CREATE TABLE IF NOT EXISTS pending_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_session_id TEXT NOT NULL UNIQUE,
  linear_workspace_id TEXT NOT NULL,
  linear_team_id TEXT NOT NULL,
  pending_issue_id TEXT NOT NULL,
  pending_issue_identifier TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pending_configs_session ON pending_configs(agent_session_id);
