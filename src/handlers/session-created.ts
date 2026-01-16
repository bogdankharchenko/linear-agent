import type { Context } from 'hono';
import type { Bindings, LinearAgentSessionWebhook } from '../types';
import { GitHubAppService } from '../services/github-app';
import { LinearService, getOAuthToken } from '../services/linear';
import { WorkflowService } from '../services/workflow';
import * as db from '../db/queries';

/**
 * Handle new agent session (agent assigned to ticket)
 * Checks if team is configured, then triggers implementation
 */
export async function handleSessionCreated(
  c: Context<{ Bindings: Bindings }>,
  payload: LinearAgentSessionWebhook
): Promise<void> {
  const { organizationId, agentSession } = payload;
  const { id: sessionId, issue } = agentSession;
  const teamId = issue.team.id;

  console.log(
    `New agent session ${sessionId} for issue ${issue.identifier} in team ${teamId}`
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

  // Acknowledge quickly (within 10 seconds requirement)
  await linear.sendThought(sessionId, 'Looking at this issue...');

  // Log the event
  await db.logEvent(c.env.DB, {
    agentSessionId: sessionId,
    eventType: 'session_created',
    message: `Agent assigned to ${issue.identifier}`,
    metadata: {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      teamId,
      workspaceId: organizationId,
    },
  });

  // Check if team is configured
  const config = await db.getTeamConfigByWorkspace(
    c.env.DB,
    organizationId,
    teamId
  );

  if (!config || !config.github_owner || !config.github_repo) {
    // Team not configured - ask for repository
    console.log(`Team ${teamId} not configured, asking for repository`);

    // Store pending config request
    await db.createPendingConfig(c.env.DB, {
      agentSessionId: sessionId,
      linearWorkspaceId: organizationId,
      linearTeamId: teamId,
      pendingIssueId: issue.id,
      pendingIssueIdentifier: issue.identifier,
    });

    await linear.sendElicitation(
      sessionId,
      `👋 I need to configure this team before I can implement tickets.\n\nWhich GitHub repository should I use?\n\nReply with \`owner/repo\` (e.g., \`acme/backend\`)`
    );
    return;
  }

  // Team is configured - trigger implementation
  console.log(
    `Team ${teamId} configured, triggering implementation for ${issue.identifier}`
  );

  await workflow.triggerImplementation(
    sessionId,
    issue.id,
    issue.identifier,
    config
  );
}
