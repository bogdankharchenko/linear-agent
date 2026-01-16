// Environment bindings
export interface Bindings {
  DB: D1Database;
  LINEAR_WEBHOOK_SECRET: string;
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
}

// Database models
export interface TeamConfig {
  id: number;
  linear_workspace_id: string;
  linear_team_id: string;
  linear_team_name: string | null;
  github_installation_id: number | null;
  github_owner: string | null;
  github_repo: string | null;
  github_branch: string;
  created_at: string;
  updated_at: string;
}

export interface GitHubInstallation {
  id: number;
  installation_id: number;
  account_login: string;
  account_type: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRun {
  id: number;
  github_run_id: number;
  github_owner: string;
  github_repo: string;
  agent_session_id: string;
  linear_issue_id: string;
  linear_issue_identifier: string;
  linear_workspace_id: string | null;
  workflow_type: 'implement';
  branch_name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  pr_number: number | null;
  pr_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProcessedWebhook {
  id: number;
  webhook_id: string;
  webhook_type: 'linear' | 'github';
  processed_at: string;
}

export interface RunLog {
  id: number;
  workflow_run_id: number | null;
  agent_session_id: string | null;
  event_type: string;
  message: string | null;
  metadata: string | null; // JSON
  created_at: string;
}

// Linear webhook payloads
export interface LinearAgentSessionWebhook {
  type: 'AgentSessionEvent';
  action: 'created' | 'prompted';
  organizationId: string;
  agentSession: {
    id: string;
    issue: {
      id: string;
      identifier: string;
      title: string;
      description?: string;
      team: {
        id: string;
        name: string;
      };
    };
    comment?: {
      id: string;
      body: string;
    };
  };
  previousComments?: Array<{
    id: string;
    body: string;
    userId: string;
    createdAt: string;
  }>;
  guidance?: string;
  promptContext?: string;
  agentActivity?: {
    id: string;
    type: string;
    body?: string;
    content?: {
      type: string;
      body: string;
    };
  };
}

export interface LinearUnassignWebhook {
  type: 'AppUserNotification';
  action: 'issueUnassignedFromYou';
  organizationId: string;
  notification: {
    issue: {
      id: string;
      identifier: string;
    };
  };
}

export type LinearWebhook = LinearAgentSessionWebhook | LinearUnassignWebhook;

// GitHub webhook payloads
export interface GitHubWorkflowRunWebhook {
  action: 'queued' | 'in_progress' | 'completed';
  workflow_run: {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    html_url: string;
    head_branch: string;
    repository: {
      owner: { login: string };
      name: string;
    };
  };
  installation: {
    id: number;
  };
}

export interface GitHubInstallationWebhook {
  action: 'created' | 'deleted';
  installation: {
    id: number;
    account: {
      login: string;
      type: string;
    };
  };
}

export interface GitHubPullRequestWebhook {
  action: string;
  number: number;
  pull_request: {
    id: number;
    number: number;
    html_url: string;
    head: {
      ref: string;
    };
  };
  repository: {
    owner: { login: string };
    name: string;
  };
  installation?: {
    id: number;
  };
}

export type GitHubWebhook =
  | GitHubWorkflowRunWebhook
  | GitHubInstallationWebhook
  | GitHubPullRequestWebhook;

// Issue context for implementation
export interface IssueContext {
  identifier: string;
  title: string;
  description: string | null;
  comments: Array<{
    id: string;
    body: string;
    author: string;
    createdAt: string;
  }>;
  linkedIssues: Array<{
    identifier: string;
    title: string;
    relation: string; // 'blocks', 'blocked_by', 'related', 'duplicate'
  }>;
  parentIssue: {
    identifier: string;
    title: string;
  } | null;
  attachments: Array<{
    title: string;
    url: string;
  }>;
}

// Linear agent activity types
export interface LinearAgentThought {
  type: 'thought';
  body: string;
}

export interface LinearAgentAction {
  type: 'action';
  action: string;
  parameter: string;
  result?: string;
}

export interface LinearAgentElicitation {
  type: 'elicitation';
  body: string;
}

export interface LinearAgentResponse {
  type: 'response';
  body: string;
}

export interface LinearAgentError {
  type: 'error';
  body: string;
}

export type LinearAgentActivity =
  | LinearAgentThought
  | LinearAgentAction
  | LinearAgentElicitation
  | LinearAgentResponse
  | LinearAgentError;
