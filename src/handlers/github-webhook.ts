import type { Context } from 'hono';
import type {
  Bindings,
  GitHubWebhook,
  GitHubWorkflowRunWebhook,
  GitHubInstallationWebhook,
  GitHubPullRequestWebhook,
} from '../types';
import { verifyGitHubSignature } from '../utils/crypto';
import { GitHubAppService } from '../services/github-app';
import { LinearService, getOAuthToken } from '../services/linear';
import { WorkflowService } from '../services/workflow';
import * as db from '../db/queries';

/**
 * Main GitHub webhook handler
 * Routes webhooks to appropriate handlers based on event type
 */
export async function handleGitHubWebhook(
  c: Context<{ Bindings: Bindings }>
): Promise<Response> {
  const body = await c.req.text();
  const signature = c.req.header('x-hub-signature-256') || '';
  const eventType = c.req.header('x-github-event') || '';

  // Verify webhook signature
  const isValid = await verifyGitHubSignature(
    body,
    signature,
    c.env.GITHUB_WEBHOOK_SECRET
  );

  if (!isValid) {
    console.error('Invalid GitHub webhook signature');
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const payload = JSON.parse(body) as GitHubWebhook;

  // Generate webhook ID for idempotency
  const deliveryId = c.req.header('x-github-delivery') || `${Date.now()}`;
  const webhookId = `github-${eventType}-${deliveryId}`;

  // Check if already processed
  const isProcessed = await db.isWebhookProcessed(c.env.DB, webhookId, 'github');
  if (isProcessed) {
    console.log(`Webhook ${webhookId} already processed, skipping`);
    return c.json({ status: 'already_processed' });
  }

  // Mark as processed
  await db.markWebhookProcessed(c.env.DB, webhookId, 'github');

  try {
    // Route based on event type
    switch (eventType) {
      case 'workflow_run':
        await handleWorkflowRun(c, payload as GitHubWorkflowRunWebhook);
        break;

      case 'installation':
        await handleInstallation(c, payload as GitHubInstallationWebhook);
        break;

      case 'pull_request':
        await handlePullRequest(c, payload as GitHubPullRequestWebhook);
        break;

      default:
        console.log('Unhandled GitHub event type:', eventType);
    }

    return c.json({ status: 'ok' });
  } catch (error) {
    console.error('Error handling GitHub webhook:', error);
    return c.json({ status: 'error', message: String(error) });
  }
}

/**
 * Handle workflow_run events
 * Updates workflow status and notifies Linear on completion
 */
async function handleWorkflowRun(
  c: Context<{ Bindings: Bindings }>,
  payload: GitHubWorkflowRunWebhook
): Promise<void> {
  const { action, workflow_run, installation } = payload;
  const owner = workflow_run.repository.owner.login;
  const repo = workflow_run.repository.name;
  const branch = workflow_run.head_branch;

  console.log(
    `Workflow run ${workflow_run.id}: ${action} (${workflow_run.status}/${workflow_run.conclusion}) on ${owner}/${repo}:${branch}`
  );

  // Find the workflow run record
  let workflowRun = await db.getWorkflowRun(c.env.DB, workflow_run.id);

  if (!workflowRun) {
    // Try to match a pending trigger
    const pendingTrigger = await db.matchPendingWorkflowTrigger(
      c.env.DB,
      owner,
      repo,
      branch
    );

    if (pendingTrigger) {
      console.log(`Matched pending trigger ${pendingTrigger.id} for workflow run ${workflow_run.id}`);

      // Create the workflow run record
      workflowRun = await db.createWorkflowRun(c.env.DB, {
        githubRunId: workflow_run.id,
        githubOwner: owner,
        githubRepo: repo,
        agentSessionId: pendingTrigger.agent_session_id,
        linearIssueId: pendingTrigger.linear_issue_id,
        linearIssueIdentifier: pendingTrigger.linear_issue_identifier || '',
        linearWorkspaceId: pendingTrigger.linear_workspace_id || undefined,
        workflowType: 'implement',
        branchName: branch,
      });

      // Mark the pending trigger as matched
      await db.markPendingWorkflowMatched(c.env.DB, pendingTrigger.id);

      console.log(`Created workflow run record ${workflowRun.id}`);
    } else {
      console.log(`No pending trigger found for ${owner}/${repo}:${branch} (${workflow_run.name})`);
      return;
    }
  }

  // Get OAuth token for Linear API calls
  const oauthToken = workflowRun.linear_workspace_id
    ? await getOAuthToken(c.env.DB, workflowRun.linear_workspace_id)
    : null;

  if (!oauthToken) {
    console.error(`No OAuth token found for workflow run ${workflowRun.id}`);
    return;
  }

  // Update status based on action
  if (action === 'in_progress') {
    await db.updateWorkflowRun(c.env.DB, workflow_run.id, {
      status: 'in_progress',
    });

    // Notify Linear
    const linear = new LinearService(oauthToken);
    await linear.sendAction(
      workflowRun.agent_session_id,
      'Running',
      'Claude Code'
    );
  } else if (action === 'completed') {
    // Initialize services
    const github = new GitHubAppService(
      c.env.GITHUB_APP_ID,
      c.env.GITHUB_APP_PRIVATE_KEY
    );
    const linear = new LinearService(oauthToken);
    const workflow = new WorkflowService(github, linear, c.env.DB);

    // Handle completion
    await workflow.handleWorkflowComplete(
      workflowRun,
      installation.id,
      workflow_run.conclusion || 'unknown'
    );
  }
}

/**
 * Handle installation events
 * Tracks GitHub App installations for repository access
 */
async function handleInstallation(
  c: Context<{ Bindings: Bindings }>,
  payload: GitHubInstallationWebhook
): Promise<void> {
  const { action, installation } = payload;

  if (action === 'created') {
    // Store the installation
    await db.createGitHubInstallation(c.env.DB, {
      installationId: installation.id,
      accountLogin: installation.account.login,
      accountType: installation.account.type,
    });

    console.log(
      `GitHub App installed for ${installation.account.login} (${installation.id})`
    );

    // Log the event
    await db.logEvent(c.env.DB, {
      eventType: 'github_app_installed',
      message: `GitHub App installed for ${installation.account.login}`,
      metadata: {
        installationId: installation.id,
        accountLogin: installation.account.login,
        accountType: installation.account.type,
      },
    });
  } else if (action === 'deleted') {
    // Remove the installation
    await db.deleteGitHubInstallation(c.env.DB, installation.id);

    console.log(
      `GitHub App uninstalled from ${installation.account.login} (${installation.id})`
    );

    // Log the event
    await db.logEvent(c.env.DB, {
      eventType: 'github_app_uninstalled',
      message: `GitHub App uninstalled from ${installation.account.login}`,
      metadata: {
        installationId: installation.id,
        accountLogin: installation.account.login,
      },
    });
  }
}

/**
 * Handle pull_request events
 * Links PRs to workflow runs for tracking
 */
async function handlePullRequest(
  c: Context<{ Bindings: Bindings }>,
  payload: GitHubPullRequestWebhook
): Promise<void> {
  const { action, pull_request, repository } = payload;

  if (action !== 'opened') {
    return; // Only care about new PRs
  }

  // Check if this PR's branch matches any of our workflow runs
  const branchName = pull_request.head.ref;

  // This is a simplification - in practice we'd query by branch name
  // For now, the PR link is established in the workflow completion handler
  console.log(
    `PR #${pull_request.number} opened for branch ${branchName} in ${repository.owner.login}/${repository.name}`
  );
}
