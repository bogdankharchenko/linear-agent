-- GitHub App installations
-- Tracks which GitHub accounts have installed the app
CREATE TABLE github_installations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    installation_id INTEGER NOT NULL UNIQUE,
    account_login TEXT NOT NULL,
    account_type TEXT NOT NULL,  -- 'Organization' or 'User'
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_github_installations_account ON github_installations(account_login);

-- Team configurations
-- Maps Linear teams to GitHub repositories
CREATE TABLE team_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    linear_workspace_id TEXT NOT NULL,
    linear_team_id TEXT NOT NULL,
    linear_team_name TEXT,
    github_installation_id INTEGER REFERENCES github_installations(installation_id),
    github_owner TEXT,
    github_repo TEXT,
    github_branch TEXT DEFAULT 'main',
    onboarded INTEGER DEFAULT 0,  -- 0 = no, 1 = yes (CLAUDE.md exists)
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(linear_workspace_id, linear_team_id)
);

CREATE INDEX idx_team_configs_team ON team_configs(linear_team_id);

-- Onboarding sessions
-- Tracks multi-step onboarding conversations
CREATE TABLE onboarding_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_session_id TEXT NOT NULL UNIQUE,
    linear_workspace_id TEXT NOT NULL,
    linear_team_id TEXT NOT NULL,
    state TEXT NOT NULL,  -- See: Onboarding States
    pending_data TEXT,    -- JSON blob for in-progress data
    pending_issue_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Workflow runs
-- Tracks GitHub Action runs and their Linear context
CREATE TABLE workflow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    github_run_id INTEGER NOT NULL UNIQUE,
    github_owner TEXT NOT NULL,
    github_repo TEXT NOT NULL,
    agent_session_id TEXT NOT NULL,
    linear_issue_id TEXT NOT NULL,
    linear_issue_identifier TEXT NOT NULL,  -- e.g., "ABC-123"
    workflow_type TEXT NOT NULL,  -- 'onboard' or 'implement'
    branch_name TEXT NOT NULL,
    status TEXT DEFAULT 'queued',  -- 'queued', 'in_progress', 'completed'
    conclusion TEXT,  -- 'success', 'failure', 'cancelled', etc.
    pr_number INTEGER,
    pr_url TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_workflow_runs_session ON workflow_runs(agent_session_id);
CREATE INDEX idx_workflow_runs_github ON workflow_runs(github_run_id);

-- Processed webhooks
-- For idempotency - prevents duplicate processing
CREATE TABLE processed_webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id TEXT NOT NULL UNIQUE,
    webhook_type TEXT NOT NULL,  -- 'linear' or 'github'
    processed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_processed_webhooks_id ON processed_webhooks(webhook_id);

-- Run log
-- Append-only log for observability
CREATE TABLE run_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER REFERENCES workflow_runs(id),
    agent_session_id TEXT,
    event_type TEXT NOT NULL,
    message TEXT,
    metadata TEXT,  -- JSON blob
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_run_log_session ON run_log(agent_session_id);
CREATE INDEX idx_run_log_workflow ON run_log(workflow_run_id);
