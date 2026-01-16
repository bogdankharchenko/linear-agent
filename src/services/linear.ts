import type { IssueContext, LinearAgentActivity } from '../types';

/**
 * Get OAuth token for a workspace from database
 */
export async function getOAuthToken(
  db: D1Database,
  workspaceId: string
): Promise<string | null> {
  const result = await db
    .prepare('SELECT access_token FROM oauth_tokens WHERE workspace_id = ?')
    .bind(workspaceId)
    .first<{ access_token: string }>();
  return result?.access_token || null;
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
      throw new Error(`Linear API error: ${response.status}`);
    }

    const json = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      throw new Error(`Linear GraphQL error: ${json.errors[0].message}`);
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
