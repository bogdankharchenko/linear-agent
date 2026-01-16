-- Pending workflow triggers table
-- Tracks workflows that have been dispatched but not yet received from GitHub
CREATE TABLE IF NOT EXISTS pending_workflow_triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_session_id TEXT NOT NULL,
  linear_workspace_id TEXT,
  linear_issue_id TEXT NOT NULL,
  linear_issue_identifier TEXT,
  linear_team_id TEXT,
  workflow_type TEXT NOT NULL CHECK (workflow_type IN ('onboard', 'implement')),
  github_owner TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  matched_at TEXT,
  UNIQUE(agent_session_id, workflow_type)
);

CREATE INDEX idx_pending_workflows_match ON pending_workflow_triggers(github_owner, github_repo, branch_name, matched_at);
