import type { IssueContext, TeamConfig } from '../types';
import { GitHubAppService } from './github-app';
import { LinearService } from './linear';
import { findAvailableBranchName } from '../utils/branch';
import * as db from '../db/queries';

/**
 * Workflow orchestration service
 * Handles triggering GitHub Actions and managing workflow state
 */
export class WorkflowService {
  private github: GitHubAppService;
  private linear: LinearService;
  private database: D1Database;

  constructor(
    github: GitHubAppService,
    linear: LinearService,
    database: D1Database
  ) {
    this.github = github;
    this.linear = linear;
    this.database = database;
  }

  /**
   * Trigger the implementation workflow for a Linear issue
   */
  async triggerImplementation(
    agentSessionId: string,
    issueId: string,
    issueIdentifier: string,
    config: TeamConfig
  ): Promise<void> {
    if (!config.github_owner || !config.github_repo || !config.github_installation_id) {
      throw new Error('Team config missing GitHub configuration');
    }

    // Fetch full issue context from Linear
    const issueContext = await this.linear.getIssueContext(issueId);

    // Find available branch name
    const existingBranches = await this.github.listBranches(
      config.github_installation_id,
      config.github_owner,
      config.github_repo
    );
    const branchName = await findAvailableBranchName(
      issueIdentifier,
      existingBranches
    );

    // Log the event
    await db.logEvent(this.database, {
      agentSessionId,
      eventType: 'workflow_trigger',
      message: `Triggering implementation workflow for ${issueIdentifier}`,
      metadata: {
        branchName,
        owner: config.github_owner,
        repo: config.github_repo,
      },
    });

    // Notify Linear that we're starting
    await this.linear.sendAction(
      agentSessionId,
      'Starting',
      'Implementation workflow'
    );

    // Store pending trigger so we can match the GitHub webhook
    // The workflow runs on the base branch (not the feature branch it creates)
    await db.createPendingWorkflowTrigger(this.database, {
      agentSessionId,
      linearWorkspaceId: config.linear_workspace_id,
      linearIssueId: issueId,
      linearIssueIdentifier: issueIdentifier,
      workflowType: 'implement',
      githubOwner: config.github_owner,
      githubRepo: config.github_repo,
      branchName: config.github_branch, // The branch where workflow_dispatch runs
    });

    // Trigger the workflow
    await this.github.triggerWorkflow(
      config.github_installation_id,
      config.github_owner,
      config.github_repo,
      'linear-agent.yml',
      config.github_branch,
      {
        agent_session_id: agentSessionId,
        ticket_id: issueIdentifier,
        ticket_title: issueContext.title,
        ticket_description: issueContext.description || '',
        ticket_context: JSON.stringify(this.formatIssueContext(issueContext)),
        branch_name: branchName,
      }
    );
  }

  /**
   * Cancel an active workflow run
   */
  async cancelWorkflow(
    workflowRun: {
      github_run_id: number;
      github_owner: string;
      github_repo: string;
      agent_session_id: string;
    },
    installationId: number
  ): Promise<void> {
    await this.github.cancelWorkflowRun(
      installationId,
      workflowRun.github_owner,
      workflowRun.github_repo,
      workflowRun.github_run_id
    );

    // Update the workflow run status
    await db.updateWorkflowRun(this.database, workflowRun.github_run_id, {
      status: 'completed',
      conclusion: 'cancelled',
    });

    // Notify Linear
    await this.linear.sendThought(
      workflowRun.agent_session_id,
      'Workflow cancelled'
    );

    // Log the event
    await db.logEvent(this.database, {
      agentSessionId: workflowRun.agent_session_id,
      eventType: 'workflow_cancelled',
      message: 'Workflow cancelled by user unassign',
    });
  }

  /**
   * Handle workflow completion - find PR and notify Linear
   */
  async handleWorkflowComplete(
    workflowRun: {
      id: number;
      github_run_id: number;
      github_owner: string;
      github_repo: string;
      agent_session_id: string;
      linear_issue_id: string;
      linear_issue_identifier: string;
      workflow_type: 'implement';
      branch_name: string;
    },
    installationId: number,
    conclusion: string
  ): Promise<void> {
    if (conclusion === 'success') {
      // Find the PR created by the workflow
      // First try by branch, then search by ticket ID in title
      let prs = await this.github.listPullRequestsForBranch(
        installationId,
        workflowRun.github_owner,
        workflowRun.github_repo,
        workflowRun.branch_name
      );

      // If no PR found by branch, search by ticket ID in title
      if (prs.length === 0 && workflowRun.linear_issue_identifier) {
        const prsByTitle = await this.github.searchPullRequestsByTitle(
          installationId,
          workflowRun.github_owner,
          workflowRun.github_repo,
          workflowRun.linear_issue_identifier
        );
        prs = prsByTitle.map((pr) => ({ number: pr.number, html_url: pr.html_url }));
      }

      if (prs.length > 0) {
        const pr = prs[0];

        // Update workflow run with PR info
        await db.updateWorkflowRun(this.database, workflowRun.github_run_id, {
          status: 'completed',
          conclusion,
          prNumber: pr.number,
          prUrl: pr.html_url,
        });

        // Create attachment in Linear
        await this.linear.createAttachment(
          workflowRun.linear_issue_id,
          `PR #${pr.number}`,
          pr.html_url
        );

        // Send success response
        await this.linear.sendResponse(
          workflowRun.agent_session_id,
          `✅ Implementation complete!\n\n[PR #${pr.number}: ${workflowRun.linear_issue_identifier}](${pr.html_url})`
        );
      } else {
        // Workflow succeeded but no PR found
        await db.updateWorkflowRun(this.database, workflowRun.github_run_id, {
          status: 'completed',
          conclusion,
        });

        await this.linear.sendResponse(
          workflowRun.agent_session_id,
          '✅ Analysis complete! No code changes were necessary.'
        );
      }
    } else {
      // Workflow failed
      await db.updateWorkflowRun(this.database, workflowRun.github_run_id, {
        status: 'completed',
        conclusion,
      });

      const workflowUrl = `https://github.com/${workflowRun.github_owner}/${workflowRun.github_repo}/actions/runs/${workflowRun.github_run_id}`;

      await this.linear.sendError(
        workflowRun.agent_session_id,
        `❌ Workflow ${conclusion}.\n\n[View logs](${workflowUrl})`
      );
    }

    // Log the event
    await db.logEvent(this.database, {
      workflowRunId: workflowRun.id,
      agentSessionId: workflowRun.agent_session_id,
      eventType: 'workflow_completed',
      message: `Workflow completed with conclusion: ${conclusion}`,
      metadata: { conclusion },
    });
  }

  /**
   * Format issue context for the workflow input
   */
  private formatIssueContext(context: IssueContext): Record<string, unknown> {
    return {
      comments: context.comments.map((c) => ({
        author: c.author,
        body: c.body,
        createdAt: c.createdAt,
      })),
      linkedIssues: context.linkedIssues.map((i) => ({
        identifier: i.identifier,
        title: i.title,
        relation: i.relation,
      })),
      parentIssue: context.parentIssue
        ? {
            identifier: context.parentIssue.identifier,
            title: context.parentIssue.title,
          }
        : null,
      attachments: context.attachments.map((a) => ({
        title: a.title,
        url: a.url,
      })),
    };
  }
}
