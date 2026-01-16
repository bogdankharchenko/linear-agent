import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import * as db from '../db/queries';

// Helper to run schema migrations before each test
async function setupDatabase() {
  // Use batch() for multiple statements - exec() only supports single statements
  await env.DB.batch([
    env.DB.prepare('DROP TABLE IF EXISTS run_log'),
    env.DB.prepare('DROP TABLE IF EXISTS workflow_runs'),
    env.DB.prepare('DROP TABLE IF EXISTS processed_webhooks'),
    env.DB.prepare('DROP TABLE IF EXISTS pending_configs'),
    env.DB.prepare('DROP TABLE IF EXISTS pending_workflow_triggers'),
    env.DB.prepare('DROP TABLE IF EXISTS team_configs'),
    env.DB.prepare('DROP TABLE IF EXISTS github_installations'),
    env.DB.prepare('DROP TABLE IF EXISTS oauth_tokens'),
  ]);

  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE github_installations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        installation_id INTEGER NOT NULL UNIQUE,
        account_login TEXT NOT NULL,
        account_type TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `),
    env.DB.prepare(`
      CREATE TABLE team_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        linear_workspace_id TEXT NOT NULL,
        linear_team_id TEXT NOT NULL,
        linear_team_name TEXT,
        github_installation_id INTEGER,
        github_owner TEXT,
        github_repo TEXT,
        github_branch TEXT DEFAULT 'main',
        onboarded INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(linear_workspace_id, linear_team_id)
      )
    `),
    env.DB.prepare(`
      CREATE TABLE workflow_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        github_run_id INTEGER NOT NULL UNIQUE,
        github_owner TEXT NOT NULL,
        github_repo TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        linear_issue_id TEXT NOT NULL,
        linear_issue_identifier TEXT NOT NULL,
        linear_workspace_id TEXT,
        workflow_type TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        status TEXT DEFAULT 'queued',
        conclusion TEXT,
        pr_number INTEGER,
        pr_url TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `),
    env.DB.prepare(`
      CREATE TABLE processed_webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id TEXT NOT NULL UNIQUE,
        webhook_type TEXT NOT NULL,
        processed_at TEXT DEFAULT (datetime('now'))
      )
    `),
    env.DB.prepare(`
      CREATE TABLE pending_workflow_triggers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_session_id TEXT NOT NULL,
        linear_workspace_id TEXT,
        linear_issue_id TEXT NOT NULL,
        linear_issue_identifier TEXT,
        workflow_type TEXT NOT NULL,
        github_owner TEXT NOT NULL,
        github_repo TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        matched_at TEXT,
        UNIQUE(agent_session_id, workflow_type)
      )
    `),
    env.DB.prepare(`
      CREATE TABLE pending_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_session_id TEXT NOT NULL UNIQUE,
        linear_workspace_id TEXT NOT NULL,
        linear_team_id TEXT NOT NULL,
        pending_issue_id TEXT NOT NULL,
        pending_issue_identifier TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `),
    env.DB.prepare(`
      CREATE TABLE run_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_run_id INTEGER,
        agent_session_id TEXT,
        event_type TEXT NOT NULL,
        message TEXT,
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `),
    env.DB.prepare(`
      CREATE TABLE oauth_tokens (
        workspace_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        scope TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `),
  ]);
}

describe('Team Configs', () => {
  beforeEach(async () => {
    await setupDatabase();
  });

  it('should create and retrieve a team config', async () => {
    const config = await db.createTeamConfig(env.DB, {
      linearWorkspaceId: 'workspace-1',
      linearTeamId: 'team-1',
      linearTeamName: 'Engineering',
      githubInstallationId: 12345,
      githubOwner: 'acme',
      githubRepo: 'backend',
      githubBranch: 'main',
    });

    expect(config).toBeDefined();
    expect(config.linear_workspace_id).toBe('workspace-1');
    expect(config.linear_team_id).toBe('team-1');
    expect(config.github_owner).toBe('acme');
    expect(config.github_repo).toBe('backend');

    const retrieved = await db.getTeamConfig(env.DB, 'team-1');
    expect(retrieved).toBeDefined();
    expect(retrieved?.github_owner).toBe('acme');
  });

  it('should retrieve team config by workspace and team', async () => {
    await db.createTeamConfig(env.DB, {
      linearWorkspaceId: 'workspace-1',
      linearTeamId: 'team-1',
      githubOwner: 'acme',
      githubRepo: 'frontend',
    });

    await db.createTeamConfig(env.DB, {
      linearWorkspaceId: 'workspace-1',
      linearTeamId: 'team-2',
      githubOwner: 'acme',
      githubRepo: 'backend',
    });

    const config = await db.getTeamConfigByWorkspace(env.DB, 'workspace-1', 'team-2');
    expect(config).toBeDefined();
    expect(config?.github_repo).toBe('backend');
  });

  it('should update team config', async () => {
    await db.createTeamConfig(env.DB, {
      linearWorkspaceId: 'workspace-1',
      linearTeamId: 'team-1',
      githubOwner: 'acme',
      githubRepo: 'old-repo',
    });

    await db.updateTeamConfig(env.DB, 'team-1', {
      githubRepo: 'new-repo',
      githubBranch: 'develop',
    });

    const updated = await db.getTeamConfig(env.DB, 'team-1');
    expect(updated?.github_repo).toBe('new-repo');
    expect(updated?.github_branch).toBe('develop');
  });

  it('should return null for non-existent team', async () => {
    const config = await db.getTeamConfig(env.DB, 'non-existent');
    expect(config).toBeNull();
  });
});

describe('GitHub Installations', () => {
  beforeEach(async () => {
    await setupDatabase();
  });

  it('should create and retrieve a GitHub installation', async () => {
    const installation = await db.createGitHubInstallation(env.DB, {
      installationId: 12345,
      accountLogin: 'acme-org',
      accountType: 'Organization',
    });

    expect(installation).toBeDefined();
    expect(installation.installation_id).toBe(12345);
    expect(installation.account_login).toBe('acme-org');

    const retrieved = await db.getGitHubInstallation(env.DB, 12345);
    expect(retrieved).toBeDefined();
    expect(retrieved?.account_login).toBe('acme-org');
  });

  it('should retrieve installation by account login', async () => {
    await db.createGitHubInstallation(env.DB, {
      installationId: 12345,
      accountLogin: 'acme-org',
      accountType: 'Organization',
    });

    const installation = await db.getGitHubInstallationByAccount(env.DB, 'acme-org');
    expect(installation).toBeDefined();
    expect(installation?.installation_id).toBe(12345);
  });

  it('should delete a GitHub installation', async () => {
    await db.createGitHubInstallation(env.DB, {
      installationId: 12345,
      accountLogin: 'acme-org',
      accountType: 'Organization',
    });

    await db.deleteGitHubInstallation(env.DB, 12345);

    const deleted = await db.getGitHubInstallation(env.DB, 12345);
    expect(deleted).toBeNull();
  });
});

describe('Workflow Runs', () => {
  beforeEach(async () => {
    await setupDatabase();
  });

  it('should create and retrieve a workflow run', async () => {
    const run = await db.createWorkflowRun(env.DB, {
      githubRunId: 987654,
      githubOwner: 'acme',
      githubRepo: 'backend',
      agentSessionId: 'session-123',
      linearIssueId: 'issue-456',
      linearIssueIdentifier: 'ABC-123',
      linearWorkspaceId: 'workspace-1',
      workflowType: 'implement',
      branchName: 'agent/abc-123',
    });

    expect(run).toBeDefined();
    expect(run.github_run_id).toBe(987654);
    expect(run.status).toBe('queued');

    const retrieved = await db.getWorkflowRun(env.DB, 987654);
    expect(retrieved).toBeDefined();
    expect(retrieved?.agent_session_id).toBe('session-123');
  });

  it('should retrieve workflow run by session', async () => {
    await db.createWorkflowRun(env.DB, {
      githubRunId: 111,
      githubOwner: 'acme',
      githubRepo: 'backend',
      agentSessionId: 'session-123',
      linearIssueId: 'issue-1',
      linearIssueIdentifier: 'ABC-1',
      workflowType: 'implement',
      branchName: 'agent/abc-1',
    });

    const run = await db.getWorkflowRunBySession(env.DB, 'session-123');
    expect(run).toBeDefined();
    expect(run?.github_run_id).toBe(111);
    expect(run?.agent_session_id).toBe('session-123');
  });

  it('should return null for session with no workflow runs', async () => {
    const run = await db.getWorkflowRunBySession(env.DB, 'non-existent-session');
    expect(run).toBeNull();
  });

  it('should get active workflow run by issue', async () => {
    await db.createWorkflowRun(env.DB, {
      githubRunId: 111,
      githubOwner: 'acme',
      githubRepo: 'backend',
      agentSessionId: 'session-1',
      linearIssueId: 'issue-1',
      linearIssueIdentifier: 'ABC-1',
      workflowType: 'implement',
      branchName: 'agent/abc-1',
    });

    const active = await db.getActiveWorkflowRunByIssue(env.DB, 'issue-1');
    expect(active).toBeDefined();
    expect(active?.status).toBe('queued');
  });

  it('should not return completed workflow as active', async () => {
    const run = await db.createWorkflowRun(env.DB, {
      githubRunId: 111,
      githubOwner: 'acme',
      githubRepo: 'backend',
      agentSessionId: 'session-1',
      linearIssueId: 'issue-1',
      linearIssueIdentifier: 'ABC-1',
      workflowType: 'implement',
      branchName: 'agent/abc-1',
    });

    await db.updateWorkflowRun(env.DB, 111, {
      status: 'completed',
      conclusion: 'success',
    });

    const active = await db.getActiveWorkflowRunByIssue(env.DB, 'issue-1');
    expect(active).toBeNull();
  });

  it('should update workflow run with PR info', async () => {
    await db.createWorkflowRun(env.DB, {
      githubRunId: 111,
      githubOwner: 'acme',
      githubRepo: 'backend',
      agentSessionId: 'session-1',
      linearIssueId: 'issue-1',
      linearIssueIdentifier: 'ABC-1',
      workflowType: 'implement',
      branchName: 'agent/abc-1',
    });

    await db.updateWorkflowRun(env.DB, 111, {
      status: 'completed',
      conclusion: 'success',
      prNumber: 42,
      prUrl: 'https://github.com/acme/backend/pull/42',
    });

    const updated = await db.getWorkflowRun(env.DB, 111);
    expect(updated?.pr_number).toBe(42);
    expect(updated?.pr_url).toBe('https://github.com/acme/backend/pull/42');
  });
});

describe('Processed Webhooks', () => {
  beforeEach(async () => {
    await setupDatabase();
  });

  it('should track processed webhooks', async () => {
    const webhookId = 'linear-session-123-created';

    // Should not be processed initially
    const before = await db.isWebhookProcessed(env.DB, webhookId, 'linear');
    expect(before).toBe(false);

    // Mark as processed
    await db.markWebhookProcessed(env.DB, webhookId, 'linear');

    // Should now be processed
    const after = await db.isWebhookProcessed(env.DB, webhookId, 'linear');
    expect(after).toBe(true);
  });

  it('should handle duplicate webhook marking gracefully', async () => {
    const webhookId = 'github-workflow-456';

    await db.markWebhookProcessed(env.DB, webhookId, 'github');
    // Should not throw when marking again
    await db.markWebhookProcessed(env.DB, webhookId, 'github');

    const isProcessed = await db.isWebhookProcessed(env.DB, webhookId, 'github');
    expect(isProcessed).toBe(true);
  });

  it('should distinguish between webhook types', async () => {
    const webhookId = 'same-id-123';

    await db.markWebhookProcessed(env.DB, webhookId, 'linear');

    // Different type should not be marked
    const isGitHubProcessed = await db.isWebhookProcessed(env.DB, webhookId, 'github');
    expect(isGitHubProcessed).toBe(false);

    // Same type should be marked
    const isLinearProcessed = await db.isWebhookProcessed(env.DB, webhookId, 'linear');
    expect(isLinearProcessed).toBe(true);
  });
});

describe('Pending Workflow Triggers', () => {
  beforeEach(async () => {
    await setupDatabase();
  });

  it('should create and match pending trigger', async () => {
    await db.createPendingWorkflowTrigger(env.DB, {
      agentSessionId: 'session-123',
      linearWorkspaceId: 'workspace-1',
      linearIssueId: 'issue-456',
      linearIssueIdentifier: 'ABC-123',
      workflowType: 'implement',
      githubOwner: 'acme',
      githubRepo: 'backend',
      branchName: 'main',
    });

    const matched = await db.matchPendingWorkflowTrigger(
      env.DB,
      'acme',
      'backend',
      'main'
    );

    expect(matched).toBeDefined();
    expect(matched?.agent_session_id).toBe('session-123');
    expect(matched?.linear_issue_identifier).toBe('ABC-123');
  });

  it('should not match already matched trigger', async () => {
    await db.createPendingWorkflowTrigger(env.DB, {
      agentSessionId: 'session-123',
      linearWorkspaceId: 'workspace-1',
      linearIssueId: 'issue-456',
      linearIssueIdentifier: 'ABC-123',
      workflowType: 'implement',
      githubOwner: 'acme',
      githubRepo: 'backend',
      branchName: 'main',
    });

    const firstMatch = await db.matchPendingWorkflowTrigger(env.DB, 'acme', 'backend', 'main');
    expect(firstMatch).toBeDefined();

    // Mark as matched
    await db.markPendingWorkflowMatched(env.DB, firstMatch!.id);

    // Should not match again
    const secondMatch = await db.matchPendingWorkflowTrigger(env.DB, 'acme', 'backend', 'main');
    expect(secondMatch).toBeNull();
  });

  it('should match by owner/repo/branch', async () => {
    await db.createPendingWorkflowTrigger(env.DB, {
      agentSessionId: 'session-1',
      linearIssueId: 'issue-1',
      workflowType: 'implement',
      githubOwner: 'acme',
      githubRepo: 'frontend',
      branchName: 'main',
    });

    await db.createPendingWorkflowTrigger(env.DB, {
      agentSessionId: 'session-2',
      linearIssueId: 'issue-2',
      workflowType: 'implement',
      githubOwner: 'acme',
      githubRepo: 'backend',
      branchName: 'main',
    });

    const match = await db.matchPendingWorkflowTrigger(env.DB, 'acme', 'backend', 'main');
    expect(match).toBeDefined();
    expect(match?.agent_session_id).toBe('session-2');
  });
});

describe('Pending Configs', () => {
  beforeEach(async () => {
    await setupDatabase();
  });

  it('should create and retrieve pending config', async () => {
    await db.createPendingConfig(env.DB, {
      agentSessionId: 'session-123',
      linearWorkspaceId: 'workspace-1',
      linearTeamId: 'team-1',
      pendingIssueId: 'issue-456',
      pendingIssueIdentifier: 'ABC-123',
    });

    const config = await db.getPendingConfig(env.DB, 'session-123');
    expect(config).toBeDefined();
    expect(config?.linear_team_id).toBe('team-1');
    expect(config?.pending_issue_identifier).toBe('ABC-123');
  });

  it('should delete pending config', async () => {
    await db.createPendingConfig(env.DB, {
      agentSessionId: 'session-123',
      linearWorkspaceId: 'workspace-1',
      linearTeamId: 'team-1',
      pendingIssueId: 'issue-456',
      pendingIssueIdentifier: 'ABC-123',
    });

    await db.deletePendingConfig(env.DB, 'session-123');

    const config = await db.getPendingConfig(env.DB, 'session-123');
    expect(config).toBeNull();
  });

  it('should return null for non-existent session', async () => {
    const config = await db.getPendingConfig(env.DB, 'non-existent');
    expect(config).toBeNull();
  });
});

describe('Event Logging', () => {
  beforeEach(async () => {
    await setupDatabase();
  });

  it('should log events with metadata', async () => {
    await db.logEvent(env.DB, {
      agentSessionId: 'session-123',
      eventType: 'workflow_trigger',
      message: 'Starting implementation',
      metadata: { branch: 'agent/abc-123', owner: 'acme' },
    });

    // Verify by querying directly
    const result = await env.DB.prepare(
      'SELECT * FROM run_log WHERE agent_session_id = ?'
    ).bind('session-123').first();

    expect(result).toBeDefined();
    expect(result?.event_type).toBe('workflow_trigger');
    expect(result?.message).toBe('Starting implementation');
    expect(JSON.parse(result?.metadata as string)).toEqual({
      branch: 'agent/abc-123',
      owner: 'acme',
    });
  });

  it('should log events without optional fields', async () => {
    await db.logEvent(env.DB, {
      eventType: 'app_installed',
    });

    const result = await env.DB.prepare(
      'SELECT * FROM run_log WHERE event_type = ?'
    ).bind('app_installed').first();

    expect(result).toBeDefined();
    expect(result?.agent_session_id).toBeNull();
    expect(result?.message).toBeNull();
    expect(result?.metadata).toBeNull();
  });
});
