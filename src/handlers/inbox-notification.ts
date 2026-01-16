import type { Context } from 'hono';
import type { Bindings, LinearUnassignWebhook } from '../types';
import { GitHubAppService } from '../services/github-app';
import { LinearService, getOAuthToken } from '../services/linear';
import { WorkflowService } from '../services/workflow';
import * as db from '../db/queries';

/**
 * Handle inbox notifications (primarily unassignment)
 * Cancels any running workflows when agent is unassigned
 */
export async function handleInboxNotification(
  c: Context<{ Bindings: Bindings }>,
  payload: LinearUnassignWebhook
): Promise<void> {
  const { notification } = payload;
  const { issue } = notification;

  console.log(`Agent unassigned from issue ${issue.identifier}`);

  // Log the event
  await db.logEvent(c.env.DB, {
    eventType: 'agent_unassigned',
    message: `Agent unassigned from ${issue.identifier}`,
    metadata: {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
    },
  });

  // Find any active workflow runs for this issue
  const activeWorkflow = await db.getActiveWorkflowRunByIssue(
    c.env.DB,
    issue.id
  );

  if (!activeWorkflow) {
    console.log(`No active workflow found for issue ${issue.id}`);
    return;
  }

  // Get the team config to find the installation ID
  // We need to look up by owner/repo from the workflow run
  const installation = await db.getGitHubInstallationByAccount(
    c.env.DB,
    activeWorkflow.github_owner
  );

  if (!installation) {
    console.error(
      `No GitHub installation found for ${activeWorkflow.github_owner}`
    );
    return;
  }

  // Get OAuth token for Linear API
  if (!activeWorkflow.linear_workspace_id) {
    console.error('No workspace ID found for workflow run');
    return;
  }

  const oauthToken = await getOAuthToken(c.env.DB, activeWorkflow.linear_workspace_id);
  if (!oauthToken) {
    console.error(`No OAuth token found for workspace ${activeWorkflow.linear_workspace_id}`);
    return;
  }

  // Initialize services
  const github = new GitHubAppService(
    c.env.GITHUB_APP_ID,
    c.env.GITHUB_APP_PRIVATE_KEY
  );
  const linear = new LinearService(oauthToken);
  const workflow = new WorkflowService(github, linear, c.env.DB);

  // Cancel the workflow
  console.log(
    `Cancelling workflow run ${activeWorkflow.github_run_id} for issue ${issue.identifier}`
  );

  await workflow.cancelWorkflow(activeWorkflow, installation.installation_id);

  // Also clean up any pending config requests
  await db.deletePendingConfig(c.env.DB, activeWorkflow.agent_session_id);
}
