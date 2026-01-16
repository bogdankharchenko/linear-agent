import type { Context } from 'hono';
import type { Bindings, LinearAgentSessionWebhook } from '../types';
import { GitHubAppService } from '../services/github-app';
import { LinearService, getOAuthToken } from '../services/linear';
import { WorkflowService } from '../services/workflow';
import * as db from '../db/queries';

/**
 * Handle user prompt/reply to agent
 * Routes to config setup or implementation based on context
 */
export async function handleSessionPrompted(
  c: Context<{ Bindings: Bindings }>,
  payload: LinearAgentSessionWebhook
): Promise<void> {
  const { organizationId, agentSession, agentActivity } = payload;
  const { id: sessionId, issue } = agentSession;
  // The message is nested in content.body, not directly in body
  const content = agentActivity?.content as { body?: string } | undefined;
  const userMessage = content?.body || agentActivity?.body || '';

  console.log(
    `User prompt in session ${sessionId}: "${userMessage.substring(0, 100)}..."`
  );

  // Get OAuth token for this workspace
  const oauthToken = await getOAuthToken(c.env.DB, organizationId);
  if (!oauthToken) {
    console.error(`No OAuth token found for workspace ${organizationId}`);
    return;
  }

  // Initialize services
  const github = new GitHubAppService(
    c.env.GITHUB_APP_ID,
    c.env.GITHUB_APP_PRIVATE_KEY
  );
  const linear = new LinearService(oauthToken);
  const workflow = new WorkflowService(github, linear, c.env.DB);

  // Log the event
  await db.logEvent(c.env.DB, {
    agentSessionId: sessionId,
    eventType: 'session_prompted',
    message: `User replied: ${userMessage.substring(0, 200)}`,
    metadata: {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
    },
  });

  // Check if this is a pending config request
  const pendingConfig = await db.getPendingConfig(c.env.DB, sessionId);

  if (pendingConfig) {
    // User is responding to config request - parse repo
    await handleConfigResponse(
      c,
      github,
      linear,
      workflow,
      pendingConfig,
      userMessage
    );
    return;
  }

  // Check if there's an active workflow for this issue
  const activeWorkflow = await db.getActiveWorkflowRunByIssue(
    c.env.DB,
    issue.id
  );

  if (activeWorkflow) {
    // User is asking about an in-progress workflow
    const statusMessages: Record<string, string> = {
      queued: 'is queued and will start shortly',
      in_progress: 'is currently running',
      completed: 'has completed',
    };

    const statusMsg =
      statusMessages[activeWorkflow.status] || 'is being processed';

    await linear.sendThought(
      sessionId,
      `The implementation workflow ${statusMsg}. I'll update you when it's done.`
    );
    return;
  }

  // No active workflow - check if the team is configured
  const teamId = issue.team.id;
  const config = await db.getTeamConfigByWorkspace(
    c.env.DB,
    payload.organizationId,
    teamId
  );

  if (!config || !config.github_owner) {
    // Team not configured
    await linear.sendElicitation(
      sessionId,
      "It looks like this team isn't configured yet. Please assign me to a ticket to start the setup process."
    );
    return;
  }

  // Determine if this is a request for additional work
  const lowerMessage = userMessage.toLowerCase();

  if (
    lowerMessage.includes('implement') ||
    lowerMessage.includes('work on') ||
    lowerMessage.includes('fix') ||
    lowerMessage.includes('add') ||
    lowerMessage.includes('update') ||
    lowerMessage.includes('change')
  ) {
    // User wants additional work - trigger a new implementation
    await linear.sendThought(sessionId, 'Starting a new implementation...');

    await workflow.triggerImplementation(
      sessionId,
      issue.id,
      issue.identifier,
      config
    );
    return;
  }

  if (
    lowerMessage.includes('status') ||
    lowerMessage.includes('progress') ||
    lowerMessage.includes("how's it going")
  ) {
    // User asking for status - no active workflow
    await linear.sendResponse(
      sessionId,
      "I don't have any active work on this ticket. Let me know if you'd like me to implement something!"
    );
    return;
  }

  // Default response for unclear intent
  await linear.sendElicitation(
    sessionId,
    "I'm not sure what you'd like me to do. Would you like me to:\n\n1. **Implement** a feature or fix based on this ticket\n2. **Check status** of any previous work\n\nJust let me know!"
  );
}

/**
 * Handle user's response to config request (owner/repo)
 */
async function handleConfigResponse(
  c: Context<{ Bindings: Bindings }>,
  github: GitHubAppService,
  linear: LinearService,
  workflow: WorkflowService,
  pendingConfig: {
    agent_session_id: string;
    linear_workspace_id: string;
    linear_team_id: string;
    pending_issue_id: string;
    pending_issue_identifier: string;
  },
  userMessage: string
): Promise<void> {
  const sessionId = pendingConfig.agent_session_id;

  // Parse owner/repo from message
  const repoMatch = userMessage.match(/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/);

  if (!repoMatch) {
    await linear.sendElicitation(
      sessionId,
      `I couldn't parse that. Please reply with the repository in \`owner/repo\` format.\n\nFor example: \`acme/backend\``
    );
    return;
  }

  const [, owner, repo] = repoMatch;

  // Check if GitHub App is installed
  const installationId = await github.getRepoInstallation(owner, repo);

  if (!installationId) {
    const installUrl = github.getInstallUrl('linear-code-agent');
    await linear.sendElicitation(
      sessionId,
      `I don't have access to \`${owner}/${repo}\` yet.\n\nPlease install the GitHub App:\n${installUrl}\n\nOnce installed, reply with \`${owner}/${repo}\` again.`
    );
    return;
  }

  // Get the default branch
  const defaultBranch = await github.getDefaultBranch(installationId, owner, repo);

  // Ensure the GitHub installation exists in our database
  await db.upsertGitHubInstallation(c.env.DB, {
    installationId,
    accountLogin: owner,
    accountType: 'User', // Could be 'Organization' but we don't have that info here
  });

  // Create team config
  const config = await db.createTeamConfig(c.env.DB, {
    linearWorkspaceId: pendingConfig.linear_workspace_id,
    linearTeamId: pendingConfig.linear_team_id,
    githubInstallationId: installationId,
    githubOwner: owner,
    githubRepo: repo,
    githubBranch: defaultBranch,
  });

  // Delete pending config
  await db.deletePendingConfig(c.env.DB, sessionId);

  // Notify and trigger implementation
  await linear.sendThought(
    sessionId,
    `✅ Configured! Using \`${owner}/${repo}\` (branch: \`${defaultBranch}\`). Starting implementation...`
  );

  // Log the event
  await db.logEvent(c.env.DB, {
    agentSessionId: sessionId,
    eventType: 'team_configured',
    message: `Team configured with ${owner}/${repo}`,
    metadata: { owner, repo, branch: defaultBranch },
  });

  // Trigger implementation for the pending issue
  await workflow.triggerImplementation(
    sessionId,
    pendingConfig.pending_issue_id,
    pendingConfig.pending_issue_identifier,
    config
  );
}
