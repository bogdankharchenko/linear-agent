import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import type { Context } from 'hono';
import type { Bindings, LinearAgentSessionWebhook, TeamConfig } from '../types';
import { handleSessionCreated } from '../handlers/session-created';
import { handleSessionPrompted } from '../handlers/session-prompted';
import * as linearModule from '../services/linear';
import * as githubModule from '../services/github-app';
import * as workflowModule from '../services/workflow';
import * as db from '../db/queries';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Setup database before tests
async function setupDatabase() {
  await env.DB.batch([
    env.DB.prepare('DROP TABLE IF EXISTS run_log'),
    env.DB.prepare('DROP TABLE IF EXISTS workflow_runs'),
    env.DB.prepare('DROP TABLE IF EXISTS pending_workflow_triggers'),
    env.DB.prepare('DROP TABLE IF EXISTS pending_configs'),
    env.DB.prepare('DROP TABLE IF EXISTS team_configs'),
    env.DB.prepare('DROP TABLE IF EXISTS github_installations'),
    env.DB.prepare('DROP TABLE IF EXISTS oauth_tokens'),
    env.DB.prepare(`
      CREATE TABLE github_installations (
        installation_id INTEGER PRIMARY KEY,
        account_login TEXT NOT NULL,
        account_type TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `),
    env.DB.prepare(`
      CREATE TABLE oauth_tokens (
        workspace_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at TEXT,
        scope TEXT,
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
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(linear_workspace_id, linear_team_id)
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
  ]);
}

// Create mock context
function createMockContext(): Context<{ Bindings: Bindings }> {
  return {
    env: {
      DB: env.DB,
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY: 'fake-key',
      GITHUB_WEBHOOK_SECRET: 'test-secret',
      LINEAR_WEBHOOK_SECRET: 'test-secret',
    },
  } as unknown as Context<{ Bindings: Bindings }>;
}

// Create mock Linear payload
function createSessionPayload(overrides: Partial<LinearAgentSessionWebhook> = {}): LinearAgentSessionWebhook {
  return {
    action: 'created',
    organizationId: 'workspace-1',
    type: 'AgentSession',
    agentSession: {
      id: 'session-123',
      issue: {
        id: 'issue-456',
        identifier: 'ABC-123',
        title: 'Add login feature',
        team: {
          id: 'team-1',
        },
      },
    },
    ...overrides,
  } as LinearAgentSessionWebhook;
}

describe('handleSessionCreated', () => {
  let mockLinearService: {
    sendThought: ReturnType<typeof vi.fn>;
    sendElicitation: ReturnType<typeof vi.fn>;
    sendAction: ReturnType<typeof vi.fn>;
    getIssueContext: ReturnType<typeof vi.fn>;
  };

  let mockGitHubService: {
    listBranches: ReturnType<typeof vi.fn>;
    triggerWorkflow: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    await setupDatabase();
    mockFetch.mockReset();

    // Add OAuth token
    await env.DB.prepare(
      'INSERT INTO oauth_tokens (workspace_id, access_token) VALUES (?, ?)'
    ).bind('workspace-1', 'oauth-token').run();

    // Mock Linear service methods
    mockLinearService = {
      sendThought: vi.fn().mockResolvedValue(undefined),
      sendElicitation: vi.fn().mockResolvedValue(undefined),
      sendAction: vi.fn().mockResolvedValue(undefined),
      getIssueContext: vi.fn().mockResolvedValue({
        identifier: 'ABC-123',
        title: 'Add login feature',
        description: 'Description',
        comments: [],
        linkedIssues: [],
        parentIssue: null,
        attachments: [],
      }),
    };

    mockGitHubService = {
      listBranches: vi.fn().mockResolvedValue(['main']),
      triggerWorkflow: vi.fn().mockResolvedValue(undefined),
    };

    // Spy on service constructors
    vi.spyOn(linearModule, 'LinearService').mockImplementation(() => mockLinearService as any);
    vi.spyOn(githubModule, 'GitHubAppService').mockImplementation(() => mockGitHubService as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should send initial thought message', async () => {
    // Configure team
    await db.createTeamConfig(env.DB, {
      linearWorkspaceId: 'workspace-1',
      linearTeamId: 'team-1',
      githubInstallationId: 12345,
      githubOwner: 'acme',
      githubRepo: 'backend',
      githubBranch: 'main',
    });

    const ctx = createMockContext();
    const payload = createSessionPayload();

    await handleSessionCreated(ctx, payload);

    expect(mockLinearService.sendThought).toHaveBeenCalledWith(
      'session-123',
      'Looking at this issue...'
    );
  });

  it('should trigger implementation when team is configured', async () => {
    // Configure team
    await db.createTeamConfig(env.DB, {
      linearWorkspaceId: 'workspace-1',
      linearTeamId: 'team-1',
      githubInstallationId: 12345,
      githubOwner: 'acme',
      githubRepo: 'backend',
      githubBranch: 'main',
    });

    const ctx = createMockContext();
    const payload = createSessionPayload();

    await handleSessionCreated(ctx, payload);

    // Should trigger workflow
    expect(mockGitHubService.triggerWorkflow).toHaveBeenCalled();
  });

  it('should ask for repository when team not configured', async () => {
    const ctx = createMockContext();
    const payload = createSessionPayload();

    await handleSessionCreated(ctx, payload);

    // Should ask for repo
    expect(mockLinearService.sendElicitation).toHaveBeenCalledWith(
      'session-123',
      expect.stringContaining('owner/repo')
    );

    // Should NOT trigger workflow
    expect(mockGitHubService.triggerWorkflow).not.toHaveBeenCalled();

    // Should create pending config
    const pending = await db.getPendingConfig(env.DB, 'session-123');
    expect(pending).toBeDefined();
    expect(pending?.linear_team_id).toBe('team-1');
  });

  it('should log session created event', async () => {
    await db.createTeamConfig(env.DB, {
      linearWorkspaceId: 'workspace-1',
      linearTeamId: 'team-1',
      githubInstallationId: 12345,
      githubOwner: 'acme',
      githubRepo: 'backend',
    });

    const ctx = createMockContext();
    const payload = createSessionPayload();

    await handleSessionCreated(ctx, payload);

    const log = await env.DB.prepare(
      "SELECT * FROM run_log WHERE event_type = 'session_created'"
    ).first();

    expect(log).toBeDefined();
    expect(log?.agent_session_id).toBe('session-123');
  });

  it('should do nothing without OAuth token', async () => {
    // Remove OAuth token
    await env.DB.prepare('DELETE FROM oauth_tokens WHERE workspace_id = ?')
      .bind('workspace-1').run();

    const ctx = createMockContext();
    const payload = createSessionPayload();

    await handleSessionCreated(ctx, payload);

    // Should not interact with Linear
    expect(mockLinearService.sendThought).not.toHaveBeenCalled();
  });
});

describe('handleSessionPrompted', () => {
  let mockLinearService: {
    sendThought: ReturnType<typeof vi.fn>;
    sendElicitation: ReturnType<typeof vi.fn>;
    sendResponse: ReturnType<typeof vi.fn>;
    sendAction: ReturnType<typeof vi.fn>;
    getIssueContext: ReturnType<typeof vi.fn>;
  };

  let mockGitHubService: {
    getRepoInstallation: ReturnType<typeof vi.fn>;
    getDefaultBranch: ReturnType<typeof vi.fn>;
    listBranches: ReturnType<typeof vi.fn>;
    triggerWorkflow: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    await setupDatabase();
    mockFetch.mockReset();

    // Add OAuth token
    await env.DB.prepare(
      'INSERT INTO oauth_tokens (workspace_id, access_token) VALUES (?, ?)'
    ).bind('workspace-1', 'oauth-token').run();

    // Mock Linear service methods
    mockLinearService = {
      sendThought: vi.fn().mockResolvedValue(undefined),
      sendElicitation: vi.fn().mockResolvedValue(undefined),
      sendResponse: vi.fn().mockResolvedValue(undefined),
      sendAction: vi.fn().mockResolvedValue(undefined),
      getIssueContext: vi.fn().mockResolvedValue({
        identifier: 'ABC-123',
        title: 'Add login feature',
        description: 'Description',
        comments: [],
        linkedIssues: [],
        parentIssue: null,
        attachments: [],
      }),
    };

    mockGitHubService = {
      getRepoInstallation: vi.fn().mockResolvedValue(12345),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      listBranches: vi.fn().mockResolvedValue(['main']),
      triggerWorkflow: vi.fn().mockResolvedValue(undefined),
      getInstallUrl: vi.fn().mockReturnValue('https://github.com/apps/linear-code-agent/installations/new'),
    };

    // Spy on service constructors
    vi.spyOn(linearModule, 'LinearService').mockImplementation(() => mockLinearService as any);
    vi.spyOn(githubModule, 'GitHubAppService').mockImplementation(() => mockGitHubService as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('config response handling', () => {
    it('should configure team when valid repo provided', async () => {
      // Create pending config
      await db.createPendingConfig(env.DB, {
        agentSessionId: 'session-123',
        linearWorkspaceId: 'workspace-1',
        linearTeamId: 'team-1',
        pendingIssueId: 'issue-456',
        pendingIssueIdentifier: 'ABC-123',
      });

      const ctx = createMockContext();
      const payload = createSessionPayload({
        action: 'prompted',
        agentActivity: {
          content: { body: 'acme/backend' },
        },
      } as any);

      await handleSessionPrompted(ctx, payload);

      // Should verify GitHub installation
      expect(mockGitHubService.getRepoInstallation).toHaveBeenCalledWith('acme', 'backend');

      // Should get default branch
      expect(mockGitHubService.getDefaultBranch).toHaveBeenCalledWith(12345, 'acme', 'backend');

      // Should create team config
      const config = await db.getTeamConfig(env.DB, 'team-1');
      expect(config).toBeDefined();
      expect(config?.github_owner).toBe('acme');
      expect(config?.github_repo).toBe('backend');

      // Should delete pending config
      const pending = await db.getPendingConfig(env.DB, 'session-123');
      expect(pending).toBeNull();

      // Should send confirmation
      expect(mockLinearService.sendThought).toHaveBeenCalledWith(
        'session-123',
        expect.stringContaining('Configured')
      );

      // Should trigger implementation
      expect(mockGitHubService.triggerWorkflow).toHaveBeenCalled();
    });

    it('should ask again for invalid repo format', async () => {
      await db.createPendingConfig(env.DB, {
        agentSessionId: 'session-123',
        linearWorkspaceId: 'workspace-1',
        linearTeamId: 'team-1',
        pendingIssueId: 'issue-456',
        pendingIssueIdentifier: 'ABC-123',
      });

      const ctx = createMockContext();
      const payload = createSessionPayload({
        action: 'prompted',
        agentActivity: {
          content: { body: 'invalid format' },
        },
      } as any);

      await handleSessionPrompted(ctx, payload);

      expect(mockLinearService.sendElicitation).toHaveBeenCalledWith(
        'session-123',
        expect.stringContaining("couldn't parse")
      );
    });

    it('should prompt for GitHub App install when not installed', async () => {
      await db.createPendingConfig(env.DB, {
        agentSessionId: 'session-123',
        linearWorkspaceId: 'workspace-1',
        linearTeamId: 'team-1',
        pendingIssueId: 'issue-456',
        pendingIssueIdentifier: 'ABC-123',
      });

      mockGitHubService.getRepoInstallation.mockResolvedValue(null);

      const ctx = createMockContext();
      const payload = createSessionPayload({
        action: 'prompted',
        agentActivity: {
          content: { body: 'acme/private-repo' },
        },
      } as any);

      await handleSessionPrompted(ctx, payload);

      expect(mockLinearService.sendElicitation).toHaveBeenCalledWith(
        'session-123',
        expect.stringContaining("don't have access")
      );
    });
  });

  describe('active workflow handling', () => {
    it('should report status for active workflow', async () => {
      await db.createTeamConfig(env.DB, {
        linearWorkspaceId: 'workspace-1',
        linearTeamId: 'team-1',
        githubInstallationId: 12345,
        githubOwner: 'acme',
        githubRepo: 'backend',
      });

      await db.createWorkflowRun(env.DB, {
        githubRunId: 111,
        githubOwner: 'acme',
        githubRepo: 'backend',
        agentSessionId: 'session-123',
        linearIssueId: 'issue-456',
        linearIssueIdentifier: 'ABC-123',
        workflowType: 'implement',
        branchName: 'agent/abc-123',
      });

      const ctx = createMockContext();
      const payload = createSessionPayload({
        action: 'prompted',
        agentActivity: {
          content: { body: 'status?' },
        },
      } as any);

      await handleSessionPrompted(ctx, payload);

      expect(mockLinearService.sendThought).toHaveBeenCalledWith(
        'session-123',
        expect.stringContaining('queued')
      );
    });
  });

  describe('intent detection', () => {
    beforeEach(async () => {
      await db.createTeamConfig(env.DB, {
        linearWorkspaceId: 'workspace-1',
        linearTeamId: 'team-1',
        githubInstallationId: 12345,
        githubOwner: 'acme',
        githubRepo: 'backend',
        githubBranch: 'main',
      });
    });

    it('should trigger implementation for "implement" keyword', async () => {
      const ctx = createMockContext();
      const payload = createSessionPayload({
        action: 'prompted',
        agentActivity: {
          content: { body: 'Please implement this feature' },
        },
      } as any);

      await handleSessionPrompted(ctx, payload);

      expect(mockGitHubService.triggerWorkflow).toHaveBeenCalled();
    });

    it('should trigger implementation for "fix" keyword', async () => {
      const ctx = createMockContext();
      const payload = createSessionPayload({
        action: 'prompted',
        agentActivity: {
          content: { body: 'Please fix this bug' },
        },
      } as any);

      await handleSessionPrompted(ctx, payload);

      expect(mockGitHubService.triggerWorkflow).toHaveBeenCalled();
    });

    it('should respond no active work for status query', async () => {
      const ctx = createMockContext();
      const payload = createSessionPayload({
        action: 'prompted',
        agentActivity: {
          content: { body: "what's the status?" },
        },
      } as any);

      await handleSessionPrompted(ctx, payload);

      expect(mockLinearService.sendResponse).toHaveBeenCalledWith(
        'session-123',
        expect.stringContaining("don't have any active work")
      );
    });

    it('should ask for clarification on unclear intent', async () => {
      const ctx = createMockContext();
      const payload = createSessionPayload({
        action: 'prompted',
        agentActivity: {
          content: { body: 'hello there' },
        },
      } as any);

      await handleSessionPrompted(ctx, payload);

      expect(mockLinearService.sendElicitation).toHaveBeenCalledWith(
        'session-123',
        expect.stringContaining("not sure what you'd like")
      );
    });
  });

  describe('unconfigured team handling', () => {
    it('should ask user to assign to ticket for unconfigured team', async () => {
      const ctx = createMockContext();
      const payload = createSessionPayload({
        action: 'prompted',
        agentActivity: {
          content: { body: 'help me' },
        },
      } as any);

      await handleSessionPrompted(ctx, payload);

      expect(mockLinearService.sendElicitation).toHaveBeenCalledWith(
        'session-123',
        expect.stringContaining("isn't configured")
      );
    });
  });
});
