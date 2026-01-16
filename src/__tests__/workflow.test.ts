import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { WorkflowService } from '../services/workflow';
import { GitHubAppService } from '../services/github-app';
import { LinearService } from '../services/linear';
import type { TeamConfig, IssueContext } from '../types';
import * as db from '../db/queries';

// Setup database before tests
async function setupDatabase() {
  await env.DB.batch([
    env.DB.prepare('DROP TABLE IF EXISTS run_log'),
    env.DB.prepare('DROP TABLE IF EXISTS workflow_runs'),
    env.DB.prepare('DROP TABLE IF EXISTS pending_workflow_triggers'),
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

describe('WorkflowService', () => {
  let service: WorkflowService;
  let mockGitHub: GitHubAppService;
  let mockLinear: LinearService;

  const mockConfig: TeamConfig = {
    id: 1,
    linear_workspace_id: 'workspace-1',
    linear_team_id: 'team-1',
    linear_team_name: 'Engineering',
    github_installation_id: 12345,
    github_owner: 'acme',
    github_repo: 'backend',
    github_branch: 'main',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  const mockIssueContext: IssueContext = {
    identifier: 'ABC-123',
    title: 'Add login feature',
    description: 'Users should be able to login',
    comments: [
      {
        id: 'comment-1',
        author: 'John Doe',
        body: 'Please add SSO support',
        createdAt: '2024-01-15T10:00:00Z',
      },
    ],
    linkedIssues: [
      {
        identifier: 'ABC-124',
        title: 'Dashboard feature',
        relation: 'blocks',
      },
    ],
    parentIssue: {
      identifier: 'ABC-100',
      title: 'Epic: Authentication',
    },
    attachments: [
      {
        title: 'Design mockup',
        url: 'https://figma.com/file/abc',
      },
    ],
  };

  beforeEach(async () => {
    await setupDatabase();

    // Create mock instances
    mockGitHub = new GitHubAppService('12345', 'fake-key');
    mockLinear = new LinearService('fake-token');

    // Mock GitHub methods
    vi.spyOn(mockGitHub, 'listBranches').mockResolvedValue(['main', 'develop']);
    vi.spyOn(mockGitHub, 'triggerWorkflow').mockResolvedValue(undefined);
    vi.spyOn(mockGitHub, 'cancelWorkflowRun').mockResolvedValue(undefined);
    vi.spyOn(mockGitHub, 'listPullRequestsForBranch').mockResolvedValue([]);
    vi.spyOn(mockGitHub, 'searchPullRequestsByTitle').mockResolvedValue([]);

    // Mock Linear methods
    vi.spyOn(mockLinear, 'getIssueContext').mockResolvedValue(mockIssueContext);
    vi.spyOn(mockLinear, 'sendAction').mockResolvedValue(undefined);
    vi.spyOn(mockLinear, 'sendThought').mockResolvedValue(undefined);
    vi.spyOn(mockLinear, 'sendResponse').mockResolvedValue(undefined);
    vi.spyOn(mockLinear, 'sendError').mockResolvedValue(undefined);
    vi.spyOn(mockLinear, 'createAttachment').mockResolvedValue(undefined);

    service = new WorkflowService(mockGitHub, mockLinear, env.DB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('triggerImplementation', () => {
    it('should trigger workflow with correct inputs', async () => {
      await service.triggerImplementation(
        'session-123',
        'issue-456',
        'ABC-123',
        mockConfig
      );

      // Should fetch issue context
      expect(mockLinear.getIssueContext).toHaveBeenCalledWith('issue-456');

      // Should list branches to find available name
      expect(mockGitHub.listBranches).toHaveBeenCalledWith(
        12345,
        'acme',
        'backend'
      );

      // Should notify Linear
      expect(mockLinear.sendAction).toHaveBeenCalledWith(
        'session-123',
        'Starting',
        'Implementation workflow'
      );

      // Should trigger workflow with proper inputs
      expect(mockGitHub.triggerWorkflow).toHaveBeenCalledWith(
        12345,
        'acme',
        'backend',
        'linear-agent.yml',
        'main',
        expect.objectContaining({
          agent_session_id: 'session-123',
          ticket_id: 'ABC-123',
          ticket_title: 'Add login feature',
          branch_name: 'agent/abc-123',
        })
      );

      // Should create pending trigger
      const trigger = await db.matchPendingWorkflowTrigger(
        env.DB,
        'acme',
        'backend',
        'main'
      );
      expect(trigger).toBeDefined();
      expect(trigger?.agent_session_id).toBe('session-123');
    });

    it('should find available branch name when base exists', async () => {
      vi.spyOn(mockGitHub, 'listBranches').mockResolvedValue([
        'main',
        'agent/abc-123',
      ]);

      await service.triggerImplementation(
        'session-123',
        'issue-456',
        'ABC-123',
        mockConfig
      );

      // Should use -2 suffix since base branch exists
      expect(mockGitHub.triggerWorkflow).toHaveBeenCalledWith(
        12345,
        'acme',
        'backend',
        'linear-agent.yml',
        'main',
        expect.objectContaining({
          branch_name: 'agent/abc-123-2',
        })
      );
    });

    it('should throw if config missing GitHub owner', async () => {
      const incompleteConfig = { ...mockConfig, github_owner: undefined };

      await expect(
        service.triggerImplementation(
          'session-123',
          'issue-456',
          'ABC-123',
          incompleteConfig as TeamConfig
        )
      ).rejects.toThrow('Team config missing GitHub configuration');
    });

    it('should throw if config missing GitHub installation ID', async () => {
      const incompleteConfig = { ...mockConfig, github_installation_id: undefined };

      await expect(
        service.triggerImplementation(
          'session-123',
          'issue-456',
          'ABC-123',
          incompleteConfig as TeamConfig
        )
      ).rejects.toThrow('Team config missing GitHub configuration');
    });

    it('should log workflow trigger event', async () => {
      await service.triggerImplementation(
        'session-123',
        'issue-456',
        'ABC-123',
        mockConfig
      );

      const log = await env.DB.prepare(
        'SELECT * FROM run_log WHERE event_type = ?'
      ).bind('workflow_trigger').first();

      expect(log).toBeDefined();
      expect(log?.agent_session_id).toBe('session-123');
      expect(log?.message).toContain('ABC-123');
    });
  });

  describe('cancelWorkflow', () => {
    it('should cancel workflow and update status', async () => {
      // Create a workflow run first
      await db.createWorkflowRun(env.DB, {
        githubRunId: 987654,
        githubOwner: 'acme',
        githubRepo: 'backend',
        agentSessionId: 'session-123',
        linearIssueId: 'issue-456',
        linearIssueIdentifier: 'ABC-123',
        workflowType: 'implement',
        branchName: 'agent/abc-123',
      });

      await service.cancelWorkflow(
        {
          github_run_id: 987654,
          github_owner: 'acme',
          github_repo: 'backend',
          agent_session_id: 'session-123',
        },
        12345
      );

      // Should call GitHub to cancel
      expect(mockGitHub.cancelWorkflowRun).toHaveBeenCalledWith(
        12345,
        'acme',
        'backend',
        987654
      );

      // Should update workflow run status
      const run = await db.getWorkflowRun(env.DB, 987654);
      expect(run?.status).toBe('completed');
      expect(run?.conclusion).toBe('cancelled');

      // Should notify Linear
      expect(mockLinear.sendThought).toHaveBeenCalledWith(
        'session-123',
        'Workflow cancelled'
      );

      // Should log the event
      const log = await env.DB.prepare(
        'SELECT * FROM run_log WHERE event_type = ?'
      ).bind('workflow_cancelled').first();
      expect(log).toBeDefined();
    });
  });

  describe('handleWorkflowComplete', () => {
    const workflowRun = {
      id: 1,
      github_run_id: 987654,
      github_owner: 'acme',
      github_repo: 'backend',
      agent_session_id: 'session-123',
      linear_issue_id: 'issue-456',
      linear_issue_identifier: 'ABC-123',
      workflow_type: 'implement' as const,
      branch_name: 'agent/abc-123',
    };

    beforeEach(async () => {
      // Create workflow run in DB
      await db.createWorkflowRun(env.DB, {
        githubRunId: 987654,
        githubOwner: 'acme',
        githubRepo: 'backend',
        agentSessionId: 'session-123',
        linearIssueId: 'issue-456',
        linearIssueIdentifier: 'ABC-123',
        workflowType: 'implement',
        branchName: 'agent/abc-123',
      });
    });

    it('should handle success with PR found by branch', async () => {
      vi.spyOn(mockGitHub, 'listPullRequestsForBranch').mockResolvedValue([
        { number: 42, html_url: 'https://github.com/acme/backend/pull/42' },
      ]);

      await service.handleWorkflowComplete(workflowRun, 12345, 'success');

      // Should search for PR by branch
      expect(mockGitHub.listPullRequestsForBranch).toHaveBeenCalledWith(
        12345,
        'acme',
        'backend',
        'agent/abc-123'
      );

      // Should update workflow run with PR info
      const run = await db.getWorkflowRun(env.DB, 987654);
      expect(run?.status).toBe('completed');
      expect(run?.conclusion).toBe('success');
      expect(run?.pr_number).toBe(42);
      expect(run?.pr_url).toBe('https://github.com/acme/backend/pull/42');

      // Should create Linear attachment
      expect(mockLinear.createAttachment).toHaveBeenCalledWith(
        'issue-456',
        'PR #42',
        'https://github.com/acme/backend/pull/42'
      );

      // Should send success response
      expect(mockLinear.sendResponse).toHaveBeenCalledWith(
        'session-123',
        expect.stringContaining('Implementation complete')
      );
    });

    it('should search by title if no PR found by branch', async () => {
      vi.spyOn(mockGitHub, 'listPullRequestsForBranch').mockResolvedValue([]);
      vi.spyOn(mockGitHub, 'searchPullRequestsByTitle').mockResolvedValue([
        {
          number: 43,
          html_url: 'https://github.com/acme/backend/pull/43',
          title: 'ABC-123: Add login feature',
        },
      ]);

      await service.handleWorkflowComplete(workflowRun, 12345, 'success');

      // Should search by ticket ID
      expect(mockGitHub.searchPullRequestsByTitle).toHaveBeenCalledWith(
        12345,
        'acme',
        'backend',
        'ABC-123'
      );

      // Should update with found PR
      const run = await db.getWorkflowRun(env.DB, 987654);
      expect(run?.pr_number).toBe(43);
    });

    it('should handle success with no PR (analysis only)', async () => {
      vi.spyOn(mockGitHub, 'listPullRequestsForBranch').mockResolvedValue([]);
      vi.spyOn(mockGitHub, 'searchPullRequestsByTitle').mockResolvedValue([]);

      await service.handleWorkflowComplete(workflowRun, 12345, 'success');

      // Should update status without PR
      const run = await db.getWorkflowRun(env.DB, 987654);
      expect(run?.status).toBe('completed');
      expect(run?.conclusion).toBe('success');
      expect(run?.pr_number).toBeNull();

      // Should send "no changes" response
      expect(mockLinear.sendResponse).toHaveBeenCalledWith(
        'session-123',
        expect.stringContaining('No code changes were necessary')
      );

      // Should NOT create attachment
      expect(mockLinear.createAttachment).not.toHaveBeenCalled();
    });

    it('should handle workflow failure', async () => {
      await service.handleWorkflowComplete(workflowRun, 12345, 'failure');

      // Should update status
      const run = await db.getWorkflowRun(env.DB, 987654);
      expect(run?.status).toBe('completed');
      expect(run?.conclusion).toBe('failure');

      // Should send error message with link to logs
      expect(mockLinear.sendError).toHaveBeenCalledWith(
        'session-123',
        expect.stringContaining('failure')
      );
      expect(mockLinear.sendError).toHaveBeenCalledWith(
        'session-123',
        expect.stringContaining('github.com/acme/backend/actions/runs/987654')
      );
    });

    it('should handle workflow cancelled conclusion', async () => {
      await service.handleWorkflowComplete(workflowRun, 12345, 'cancelled');

      const run = await db.getWorkflowRun(env.DB, 987654);
      expect(run?.conclusion).toBe('cancelled');

      expect(mockLinear.sendError).toHaveBeenCalledWith(
        'session-123',
        expect.stringContaining('cancelled')
      );
    });

    it('should log workflow completion event', async () => {
      await service.handleWorkflowComplete(workflowRun, 12345, 'success');

      const log = await env.DB.prepare(
        'SELECT * FROM run_log WHERE event_type = ?'
      ).bind('workflow_completed').first();

      expect(log).toBeDefined();
      expect(log?.agent_session_id).toBe('session-123');
      expect(log?.message).toContain('success');
    });
  });
});
