import type {
  TeamConfig,
  GitHubInstallation,
  WorkflowRun,
} from '../types';

/**
 * Database query functions for D1
 */

// =============================================================================
// Team Configs
// =============================================================================

export async function getTeamConfig(
  db: D1Database,
  linearTeamId: string
): Promise<TeamConfig | null> {
  return db
    .prepare('SELECT * FROM team_configs WHERE linear_team_id = ?')
    .bind(linearTeamId)
    .first<TeamConfig>();
}

export async function getTeamConfigByWorkspace(
  db: D1Database,
  linearWorkspaceId: string,
  linearTeamId: string
): Promise<TeamConfig | null> {
  return db
    .prepare(
      'SELECT * FROM team_configs WHERE linear_workspace_id = ? AND linear_team_id = ?'
    )
    .bind(linearWorkspaceId, linearTeamId)
    .first<TeamConfig>();
}

export async function createTeamConfig(
  db: D1Database,
  config: {
    linearWorkspaceId: string;
    linearTeamId: string;
    linearTeamName?: string;
    githubInstallationId?: number;
    githubOwner?: string;
    githubRepo?: string;
    githubBranch?: string;
  }
): Promise<TeamConfig> {
  const result = await db
    .prepare(
      `INSERT INTO team_configs (
        linear_workspace_id, linear_team_id, linear_team_name,
        github_installation_id, github_owner, github_repo, github_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING *`
    )
    .bind(
      config.linearWorkspaceId,
      config.linearTeamId,
      config.linearTeamName || null,
      config.githubInstallationId || null,
      config.githubOwner || null,
      config.githubRepo || null,
      config.githubBranch || 'main'
    )
    .first<TeamConfig>();

  if (!result) {
    throw new Error('Failed to create team config');
  }
  return result;
}

export async function updateTeamConfig(
  db: D1Database,
  linearTeamId: string,
  updates: Partial<{
    linearTeamName: string;
    githubInstallationId: number;
    githubOwner: string;
    githubRepo: string;
    githubBranch: string;
  }>
): Promise<void> {
  const setClauses: string[] = [];
  const values: (string | number)[] = [];

  if (updates.linearTeamName !== undefined) {
    setClauses.push('linear_team_name = ?');
    values.push(updates.linearTeamName);
  }
  if (updates.githubInstallationId !== undefined) {
    setClauses.push('github_installation_id = ?');
    values.push(updates.githubInstallationId);
  }
  if (updates.githubOwner !== undefined) {
    setClauses.push('github_owner = ?');
    values.push(updates.githubOwner);
  }
  if (updates.githubRepo !== undefined) {
    setClauses.push('github_repo = ?');
    values.push(updates.githubRepo);
  }
  if (updates.githubBranch !== undefined) {
    setClauses.push('github_branch = ?');
    values.push(updates.githubBranch);
  }

  if (setClauses.length === 0) {
    return;
  }

  setClauses.push("updated_at = datetime('now')");
  values.push(linearTeamId);

  await db
    .prepare(
      `UPDATE team_configs SET ${setClauses.join(', ')} WHERE linear_team_id = ?`
    )
    .bind(...values)
    .run();
}

// =============================================================================
// GitHub Installations
// =============================================================================

export async function getGitHubInstallation(
  db: D1Database,
  installationId: number
): Promise<GitHubInstallation | null> {
  return db
    .prepare('SELECT * FROM github_installations WHERE installation_id = ?')
    .bind(installationId)
    .first<GitHubInstallation>();
}

export async function getGitHubInstallationByAccount(
  db: D1Database,
  accountLogin: string
): Promise<GitHubInstallation | null> {
  return db
    .prepare('SELECT * FROM github_installations WHERE account_login = ?')
    .bind(accountLogin)
    .first<GitHubInstallation>();
}

export async function createGitHubInstallation(
  db: D1Database,
  installation: {
    installationId: number;
    accountLogin: string;
    accountType: string;
  }
): Promise<GitHubInstallation> {
  const result = await db
    .prepare(
      `INSERT INTO github_installations (installation_id, account_login, account_type)
       VALUES (?, ?, ?)
       RETURNING *`
    )
    .bind(
      installation.installationId,
      installation.accountLogin,
      installation.accountType
    )
    .first<GitHubInstallation>();

  if (!result) {
    throw new Error('Failed to create GitHub installation');
  }
  return result;
}

export async function upsertGitHubInstallation(
  db: D1Database,
  installation: {
    installationId: number;
    accountLogin: string;
    accountType: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO github_installations (installation_id, account_login, account_type)
       VALUES (?, ?, ?)
       ON CONFLICT(installation_id) DO UPDATE SET
         account_login = excluded.account_login,
         account_type = excluded.account_type`
    )
    .bind(
      installation.installationId,
      installation.accountLogin,
      installation.accountType
    )
    .run();
}

export async function deleteGitHubInstallation(
  db: D1Database,
  installationId: number
): Promise<void> {
  await db
    .prepare('DELETE FROM github_installations WHERE installation_id = ?')
    .bind(installationId)
    .run();
}

// =============================================================================
// Workflow Runs
// =============================================================================

export async function getWorkflowRun(
  db: D1Database,
  githubRunId: number
): Promise<WorkflowRun | null> {
  return db
    .prepare('SELECT * FROM workflow_runs WHERE github_run_id = ?')
    .bind(githubRunId)
    .first<WorkflowRun>();
}

export async function getWorkflowRunBySession(
  db: D1Database,
  agentSessionId: string
): Promise<WorkflowRun | null> {
  return db
    .prepare(
      'SELECT * FROM workflow_runs WHERE agent_session_id = ? ORDER BY created_at DESC LIMIT 1'
    )
    .bind(agentSessionId)
    .first<WorkflowRun>();
}

export async function getActiveWorkflowRunByIssue(
  db: D1Database,
  linearIssueId: string
): Promise<WorkflowRun | null> {
  return db
    .prepare(
      "SELECT * FROM workflow_runs WHERE linear_issue_id = ? AND status != 'completed' ORDER BY created_at DESC LIMIT 1"
    )
    .bind(linearIssueId)
    .first<WorkflowRun>();
}

export async function createWorkflowRun(
  db: D1Database,
  run: {
    githubRunId: number;
    githubOwner: string;
    githubRepo: string;
    agentSessionId: string;
    linearIssueId: string;
    linearIssueIdentifier: string;
    linearWorkspaceId?: string;
    workflowType: 'implement';
    branchName: string;
  }
): Promise<WorkflowRun> {
  const result = await db
    .prepare(
      `INSERT INTO workflow_runs (
        github_run_id, github_owner, github_repo, agent_session_id,
        linear_issue_id, linear_issue_identifier, linear_workspace_id, workflow_type, branch_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *`
    )
    .bind(
      run.githubRunId,
      run.githubOwner,
      run.githubRepo,
      run.agentSessionId,
      run.linearIssueId,
      run.linearIssueIdentifier,
      run.linearWorkspaceId || null,
      run.workflowType,
      run.branchName
    )
    .first<WorkflowRun>();

  if (!result) {
    throw new Error('Failed to create workflow run');
  }
  return result;
}

export async function updateWorkflowRun(
  db: D1Database,
  githubRunId: number,
  updates: {
    status?: 'queued' | 'in_progress' | 'completed';
    conclusion?: string | null;
    prNumber?: number | null;
    prUrl?: string | null;
  }
): Promise<void> {
  const setClauses: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    values.push(updates.status);
  }
  if (updates.conclusion !== undefined) {
    setClauses.push('conclusion = ?');
    values.push(updates.conclusion);
  }
  if (updates.prNumber !== undefined) {
    setClauses.push('pr_number = ?');
    values.push(updates.prNumber);
  }
  if (updates.prUrl !== undefined) {
    setClauses.push('pr_url = ?');
    values.push(updates.prUrl);
  }

  if (setClauses.length === 0) {
    return;
  }

  setClauses.push("updated_at = datetime('now')");
  values.push(githubRunId);

  await db
    .prepare(
      `UPDATE workflow_runs SET ${setClauses.join(', ')} WHERE github_run_id = ?`
    )
    .bind(...values)
    .run();
}

// =============================================================================
// Processed Webhooks (Idempotency)
// =============================================================================

export async function isWebhookProcessed(
  db: D1Database,
  webhookId: string,
  webhookType: 'linear' | 'github'
): Promise<boolean> {
  const result = await db
    .prepare(
      'SELECT 1 FROM processed_webhooks WHERE webhook_id = ? AND webhook_type = ?'
    )
    .bind(webhookId, webhookType)
    .first();
  return result !== null;
}

export async function markWebhookProcessed(
  db: D1Database,
  webhookId: string,
  webhookType: 'linear' | 'github'
): Promise<void> {
  await db
    .prepare(
      'INSERT OR IGNORE INTO processed_webhooks (webhook_id, webhook_type) VALUES (?, ?)'
    )
    .bind(webhookId, webhookType)
    .run();
}

// =============================================================================
// Pending Workflow Triggers
// =============================================================================

export interface PendingWorkflowTrigger {
  id: number;
  agent_session_id: string;
  linear_workspace_id: string | null;
  linear_issue_id: string;
  linear_issue_identifier: string | null;
  workflow_type: 'implement';
  github_owner: string;
  github_repo: string;
  branch_name: string;
  created_at: string;
  matched_at: string | null;
}

export async function createPendingWorkflowTrigger(
  db: D1Database,
  trigger: {
    agentSessionId: string;
    linearWorkspaceId?: string;
    linearIssueId: string;
    linearIssueIdentifier?: string;
    workflowType: 'implement';
    githubOwner: string;
    githubRepo: string;
    branchName: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO pending_workflow_triggers (
        agent_session_id, linear_workspace_id, linear_issue_id, linear_issue_identifier,
        workflow_type, github_owner, github_repo, branch_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      trigger.agentSessionId,
      trigger.linearWorkspaceId || null,
      trigger.linearIssueId,
      trigger.linearIssueIdentifier || null,
      trigger.workflowType,
      trigger.githubOwner,
      trigger.githubRepo,
      trigger.branchName
    )
    .run();
}

export async function matchPendingWorkflowTrigger(
  db: D1Database,
  githubOwner: string,
  githubRepo: string,
  branchName: string
): Promise<PendingWorkflowTrigger | null> {
  const result = await db
    .prepare(
      `SELECT * FROM pending_workflow_triggers
       WHERE github_owner = ? AND github_repo = ? AND branch_name = ?
       AND matched_at IS NULL
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(githubOwner, githubRepo, branchName)
    .first<PendingWorkflowTrigger>();

  return result || null;
}

export async function markPendingWorkflowMatched(
  db: D1Database,
  id: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE pending_workflow_triggers SET matched_at = datetime('now') WHERE id = ?`
    )
    .bind(id)
    .run();
}

// =============================================================================
// Pending Configs (for initial team setup)
// =============================================================================

export interface PendingConfig {
  id: number;
  agent_session_id: string;
  linear_workspace_id: string;
  linear_team_id: string;
  pending_issue_id: string;
  pending_issue_identifier: string;
  created_at: string;
}

export async function createPendingConfig(
  db: D1Database,
  config: {
    agentSessionId: string;
    linearWorkspaceId: string;
    linearTeamId: string;
    pendingIssueId: string;
    pendingIssueIdentifier: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO pending_configs (
        agent_session_id, linear_workspace_id, linear_team_id,
        pending_issue_id, pending_issue_identifier
      ) VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      config.agentSessionId,
      config.linearWorkspaceId,
      config.linearTeamId,
      config.pendingIssueId,
      config.pendingIssueIdentifier
    )
    .run();
}

export async function getPendingConfig(
  db: D1Database,
  agentSessionId: string
): Promise<PendingConfig | null> {
  return db
    .prepare('SELECT * FROM pending_configs WHERE agent_session_id = ?')
    .bind(agentSessionId)
    .first<PendingConfig>();
}

export async function deletePendingConfig(
  db: D1Database,
  agentSessionId: string
): Promise<void> {
  await db
    .prepare('DELETE FROM pending_configs WHERE agent_session_id = ?')
    .bind(agentSessionId)
    .run();
}

// =============================================================================
// Run Log
// =============================================================================

export async function logEvent(
  db: D1Database,
  event: {
    workflowRunId?: number;
    agentSessionId?: string;
    eventType: string;
    message?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO run_log (workflow_run_id, agent_session_id, event_type, message, metadata)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      event.workflowRunId || null,
      event.agentSessionId || null,
      event.eventType,
      event.message || null,
      event.metadata ? JSON.stringify(event.metadata) : null
    )
    .run();
}
