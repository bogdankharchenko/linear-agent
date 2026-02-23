import type { IssueContext, LinearAgentActivity, Bindings } from '../types';

interface OAuthTokenRow {
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
}

/**
 * Get OAuth token for a workspace from database.
 * Automatically refreshes expired tokens if a refresh_token is available.
 */
export async function getOAuthToken(
  db: D1Database,
  workspaceId: string,
  env?: Pick<Bindings, 'LINEAR_CLIENT_ID' | 'LINEAR_CLIENT_SECRET'>
): Promise<string | null> {
  const result = await db
    .prepare('SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE workspace_id = ?')
    .bind(workspaceId)
    .first<OAuthTokenRow>();

  if (!result) return null;

  // Check if token is expired and we have a refresh token
  if (result.refresh_token && result.expires_at && env) {
    const expiresAt = new Date(result.expires_at).getTime();
    const now = Date.now();
    // Refresh 5 minutes before actual expiry to avoid race conditions
    const bufferMs = 5 * 60 * 1000;

    if (now >= expiresAt - bufferMs) {
      console.log(`OAuth token expired for workspace ${workspaceId}, refreshing...`);
      const refreshed = await refreshOAuthToken(
        db,
        workspaceId,
        result.refresh_token,
        env.LINEAR_CLIENT_ID,
        env.LINEAR_CLIENT_SECRET
      );
      if (refreshed) {
        return refreshed;
      }
      // If refresh failed, try the existing token anyway (might still work)
      console.error(`Token refresh failed for workspace ${workspaceId}, trying existing token`);
    }
  }

  return result.access_token;
}

/**
 * Refresh all tokens that are expired or expiring soon.
 * Intended to be called from a cron trigger.
 */
export async function refreshAllTokens(
  db: D1Database,
  clientId: string,
  clientSecret: string
): Promise<{ refreshed: number; failed: number }> {
  const bufferMs = 5 * 60 * 1000;
  const threshold = new Date(Date.now() + bufferMs).toISOString();

  const rows = await db
    .prepare(
      `SELECT workspace_id, refresh_token, expires_at FROM oauth_tokens
       WHERE refresh_token IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= ?`
    )
    .bind(threshold)
    .all<{ workspace_id: string; refresh_token: string; expires_at: string }>();

  let refreshed = 0;
  let failed = 0;

  for (const row of rows.results) {
    const result = await refreshOAuthToken(
      db, row.workspace_id, row.refresh_token, clientId, clientSecret
    );
    if (result) {
      refreshed++;
    } else {
      failed++;
    }
  }

  return { refreshed, failed };
}

/**
 * Refresh an OAuth token using the refresh token
 * Linear uses refresh token rotation - both tokens are replaced
 */
async function refreshOAuthToken(
  db: D1Database,
  workspaceId: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<string | null> {
  try {
    const response = await fetch('https://api.linear.app/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`OAuth token refresh failed (${response.status}): ${errorText}`);
      return null;
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    // Calculate new expiry
    const expiresAt = data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null;

    // Store the new tokens (Linear uses rotation - old tokens are invalidated)
    await db.prepare(
      `UPDATE oauth_tokens
       SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = datetime('now')
       WHERE workspace_id = ?`
    ).bind(
      data.access_token,
      data.refresh_token || null,
      expiresAt,
      workspaceId
    ).run();

    console.log(`OAuth token refreshed for workspace ${workspaceId}`);
    return data.access_token;
  } catch (error) {
    console.error(`OAuth token refresh error for workspace ${workspaceId}:`, error);
    return null;
  }
}

/**
 * Linear API service for agent interactions
 */
export class LinearService {
  private token: string;
  private baseUrl = 'https://api.linear.app/graphql';

  constructor(token: string) {
    this.token = token;
  }

  /**
   * Make a GraphQL request to Linear API
   */
  private async graphql<T>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.token,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch {
        // ignore if text() not available
      }
      throw new Error(`Linear API error: ${response.status}${errorBody ? ` - ${errorBody}` : ''}`);
    }

    const json = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      throw new Error(`Linear GraphQL error: ${json.errors.map(e => e.message).join(', ')}`);
    }

    return json.data as T;
  }

  /**
   * Create an agent activity in Linear
   */
  async createAgentActivity(
    agentSessionId: string,
    content: LinearAgentActivity
  ): Promise<void> {
    const mutation = `
      mutation CreateAgentActivity($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) {
          success
        }
      }
    `;

    await this.graphql(mutation, {
      input: {
        agentSessionId,
        content,
      },
    });
  }

  /**
   * Send a thought (ephemeral progress indicator)
   */
  async sendThought(agentSessionId: string, body: string): Promise<void> {
    await this.createAgentActivity(agentSessionId, {
      type: 'thought',
      body,
    });
  }

  /**
   * Send an action activity
   */
  async sendAction(
    agentSessionId: string,
    action: string,
    parameter: string,
    result?: string
  ): Promise<void> {
    await this.createAgentActivity(agentSessionId, {
      type: 'action',
      action,
      parameter,
      result,
    });
  }

  /**
   * Send an elicitation (ask user for input)
   */
  async sendElicitation(agentSessionId: string, body: string): Promise<void> {
    await this.createAgentActivity(agentSessionId, {
      type: 'elicitation',
      body,
    });
  }

  /**
   * Send a response (work complete)
   */
  async sendResponse(agentSessionId: string, body: string): Promise<void> {
    await this.createAgentActivity(agentSessionId, {
      type: 'response',
      body,
    });
  }

  /**
   * Send an error message
   */
  async sendError(agentSessionId: string, body: string): Promise<void> {
    await this.createAgentActivity(agentSessionId, {
      type: 'error',
      body,
    });
  }

  /**
   * Fetch full issue context for implementation
   */
  async getIssueContext(issueId: string): Promise<IssueContext> {
    const query = `
      query GetIssueContext($id: String!) {
        issue(id: $id) {
          identifier
          title
          description
          comments {
            nodes {
              id
              body
              user {
                name
              }
              createdAt
            }
          }
          relations {
            nodes {
              type
              relatedIssue {
                identifier
                title
              }
            }
          }
          parent {
            identifier
            title
          }
          attachments {
            nodes {
              title
              url
            }
          }
        }
      }
    `;

    const data = await this.graphql<{
      issue: {
        identifier: string;
        title: string;
        description: string | null;
        comments: {
          nodes: Array<{
            id: string;
            body: string;
            user: { name: string } | null;
            createdAt: string;
          }>;
        };
        relations: {
          nodes: Array<{
            type: string;
            relatedIssue: {
              identifier: string;
              title: string;
            };
          }>;
        };
        parent: {
          identifier: string;
          title: string;
        } | null;
        attachments: {
          nodes: Array<{
            title: string;
            url: string;
          }>;
        };
      };
    }>(query, { id: issueId });

    return {
      identifier: data.issue.identifier,
      title: data.issue.title,
      description: data.issue.description,
      comments: data.issue.comments.nodes.map((c) => ({
        id: c.id,
        body: c.body,
        author: c.user?.name || 'Unknown',
        createdAt: c.createdAt,
      })),
      linkedIssues: data.issue.relations.nodes.map((r) => ({
        identifier: r.relatedIssue.identifier,
        title: r.relatedIssue.title,
        relation: r.type,
      })),
      parentIssue: data.issue.parent,
      attachments: data.issue.attachments.nodes,
    };
  }

  /**
   * Create an attachment linking a PR to an issue
   */
  async createAttachment(
    issueId: string,
    title: string,
    url: string
  ): Promise<void> {
    const mutation = `
      mutation CreateAttachment($input: AttachmentCreateInput!) {
        attachmentCreate(input: $input) {
          success
        }
      }
    `;

    await this.graphql(mutation, {
      input: {
        issueId,
        title,
        url,
      },
    });
  }
}
