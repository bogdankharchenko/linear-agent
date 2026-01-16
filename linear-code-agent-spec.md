# Linear Code Agent - Technical Specification

## Overview

A standalone service that integrates with Linear's native Agent system to automatically implement tickets using Claude Code, running as GitHub Actions. When a user assigns a ticket to the agent in Linear, it triggers a workflow that analyzes the issue, writes code, and opens a pull request.

### Key Components

1. **Cloudflare Worker** - Webhook receiver and orchestrator
2. **Cloudflare D1** - SQLite database for configuration and state
3. **GitHub App** - Authentication and webhook integration
4. **GitHub Actions** - Runs Claude Code to implement tickets
5. **Linear Agent API** - Native agent integration

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              User Flow                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   1. User assigns ticket to agent in Linear                                 │
│   2. Linear sends AgentSessionEvent webhook to Worker                       │
│   3. Worker checks if team is configured                                    │
│      - If not: starts onboarding conversation                               │
│      - If yes: triggers GitHub Action                                       │
│   4. GitHub Action runs Claude Code                                         │
│   5. GitHub sends workflow webhooks back to Worker                          │
│   6. Worker updates Linear with progress and final PR link                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│     Linear      │────▶│  Cloudflare      │────▶│     GitHub      │
│                 │     │  Worker          │     │                 │
│  Webhooks:      │     │                  │     │  Receives:      │
│  - AgentSession │     │  - Routes        │     │  - workflow_    │
│    (created,    │     │  - D1 Database   │     │    dispatch     │
│    prompted)    │     │  - GitHub App    │     │                 │
│  - Inbox        │     │    client        │     │  Sends:         │
│    (unassign)   │     │                  │     │  - workflow_run │
│                 │     │                  │◀────│  - pull_request │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

---

## Project Structure

```
linear-code-agent/
├── src/
│   ├── index.ts                    # Worker entry point, Hono app
│   ├── types.ts                    # TypeScript interfaces
│   │
│   ├── handlers/
│   │   ├── linear-webhook.ts       # Linear webhook routing
│   │   ├── github-webhook.ts       # GitHub webhook routing
│   │   ├── session-created.ts      # New agent session handler
│   │   ├── session-prompted.ts     # User replied to agent
│   │   └── inbox-notification.ts   # Unassign detection
│   │
│   ├── services/
│   │   ├── linear.ts               # Linear API helpers
│   │   ├── github-app.ts           # GitHub App auth & API
│   │   ├── onboarding.ts           # Onboarding state machine
│   │   └── workflow.ts             # Workflow trigger logic
│   │
│   ├── db/
│   │   ├── schema.sql              # D1 schema
│   │   └── queries.ts              # Database query functions
│   │
│   └── utils/
│       ├── crypto.ts               # Webhook signature verification
│       └── branch.ts               # Branch name generation
│
├── migrations/
│   └── 0001_initial.sql            # D1 migration
│
├── .github/
│   └── workflows/
│       ├── linear-agent.yml        # Main implementation workflow
│       └── linear-onboard.yml      # Codebase onboarding workflow
│
├── wrangler.toml                   # Cloudflare config
├── package.json
├── tsconfig.json
└── README.md
```

---

## Database Schema

### File: `migrations/0001_initial.sql`

```sql
-- GitHub App installations
-- Tracks which GitHub accounts have installed the app
CREATE TABLE github_installations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    installation_id INTEGER NOT NULL UNIQUE,
    account_login TEXT NOT NULL,
    account_type TEXT NOT NULL,  -- 'Organization' or 'User'
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_github_installations_account ON github_installations(account_login);

-- Team configurations
-- Maps Linear teams to GitHub repositories
CREATE TABLE team_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    linear_workspace_id TEXT NOT NULL,
    linear_team_id TEXT NOT NULL,
    linear_team_name TEXT,
    github_installation_id INTEGER REFERENCES github_installations(installation_id),
    github_owner TEXT,
    github_repo TEXT,
    github_branch TEXT DEFAULT 'main',
    onboarded INTEGER DEFAULT 0,  -- 0 = no, 1 = yes (CLAUDE.md exists)
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(linear_workspace_id, linear_team_id)
);

CREATE INDEX idx_team_configs_team ON team_configs(linear_team_id);

-- Onboarding sessions
-- Tracks multi-step onboarding conversations
CREATE TABLE onboarding_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_session_id TEXT NOT NULL UNIQUE,
    linear_workspace_id TEXT NOT NULL,
    linear_team_id TEXT NOT NULL,
    state TEXT NOT NULL,  -- See: Onboarding States
    pending_data TEXT,    -- JSON blob for in-progress data
    pending_issue_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Workflow runs
-- Tracks GitHub Action runs and their Linear context
CREATE TABLE workflow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    github_run_id INTEGER NOT NULL UNIQUE,
    github_owner TEXT NOT NULL,
    github_repo TEXT NOT NULL,
    agent_session_id TEXT NOT NULL,
    linear_issue_id TEXT NOT NULL,
    linear_issue_identifier TEXT NOT NULL,  -- e.g., "ABC-123"
    workflow_type TEXT NOT NULL,  -- 'onboard' or 'implement'
    branch_name TEXT NOT NULL,
    status TEXT DEFAULT 'queued',  -- 'queued', 'in_progress', 'completed'
    conclusion TEXT,  -- 'success', 'failure', 'cancelled', etc.
    pr_number INTEGER,
    pr_url TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_workflow_runs_session ON workflow_runs(agent_session_id);
CREATE INDEX idx_workflow_runs_github ON workflow_runs(github_run_id);

-- Processed webhooks
-- For idempotency - prevents duplicate processing
CREATE TABLE processed_webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id TEXT NOT NULL UNIQUE,
    webhook_type TEXT NOT NULL,  -- 'linear' or 'github'
    processed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_processed_webhooks_id ON processed_webhooks(webhook_id);

-- Run log
-- Append-only log for observability
CREATE TABLE run_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER REFERENCES workflow_runs(id),
    agent_session_id TEXT,
    event_type TEXT NOT NULL,
    message TEXT,
    metadata TEXT,  -- JSON blob
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_run_log_session ON run_log(agent_session_id);
CREATE INDEX idx_run_log_workflow ON run_log(workflow_run_id);
```

### Onboarding States

The `onboarding_sessions.state` field follows this state machine:

```
awaiting_repo          User needs to provide owner/repo
    │
    ▼
awaiting_app_install   GitHub App not installed, waiting for user
    │
    ▼
awaiting_branch        User needs to confirm default branch
    │
    ▼
awaiting_confirmation  Show summary, ask user to confirm
    │
    ▼
triggering_onboard     About to trigger onboarding workflow
    │
    ▼
complete               Onboarding finished
```

---

## Environment Variables

### Cloudflare Worker Secrets

Set via `wrangler secret put <NAME>`:

```bash
# Linear
LINEAR_API_KEY              # Linear API key for the agent
LINEAR_WEBHOOK_SECRET       # Secret for verifying Linear webhooks

# GitHub App
GITHUB_APP_ID               # GitHub App ID
GITHUB_APP_PRIVATE_KEY      # GitHub App private key (PEM format)
GITHUB_WEBHOOK_SECRET       # Secret for verifying GitHub webhooks
GITHUB_APP_CLIENT_ID        # For OAuth flow if needed
GITHUB_APP_CLIENT_SECRET    # For OAuth flow if needed
```

### Cloudflare Worker Bindings

Set in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "linear-code-agent"
database_id = "<your-database-id>"
```

---

## API Endpoints

### Worker Routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhook/linear` | Receives Linear webhooks |
| POST | `/webhook/github` | Receives GitHub webhooks |
| GET | `/health` | Health check endpoint |

### Webhook Payloads

#### Linear AgentSessionEvent (created)

```typescript
interface LinearAgentSessionCreatedWebhook {
  type: 'AgentSessionEvent';
  action: 'created';
  organizationId: string;
  agentSession: {
    id: string;
    issue: {
      id: string;
      identifier: string;  // e.g., "ABC-123"
      title: string;
      description?: string;
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
  guidance?: string;  // Workspace/team agent guidance
  promptContext?: string;  // Formatted context string
}
```

#### Linear AgentSessionEvent (prompted)

```typescript
interface LinearAgentSessionPromptedWebhook {
  type: 'AgentSessionEvent';
  action: 'prompted';
  organizationId: string;
  agentSession: {
    id: string;
    issue: {
      id: string;
      identifier: string;
      title: string;
    };
  };
  agentActivity: {
    id: string;
    type: 'prompt';
    body: string;  // User's message
  };
}
```

#### Linear AppUserNotification (unassign)

```typescript
interface LinearUnassignWebhook {
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
```

#### GitHub Workflow Run

```typescript
interface GitHubWorkflowRunWebhook {
  action: 'queued' | 'in_progress' | 'completed';
  workflow_run: {
    id: number;
    name: string;
    status: 'queued' | 'in_progress' | 'completed';
    conclusion?: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out';
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
```

---

## Linear Agent Activities

The agent communicates with Linear using these activity types:

### Thought (ephemeral progress)

```typescript
await linear.createAgentActivity({
  agentSessionId: sessionId,
  content: {
    type: 'thought',
    body: 'Analyzing the codebase...',
  },
});
```

### Action (with optional result)

```typescript
await linear.createAgentActivity({
  agentSessionId: sessionId,
  content: {
    type: 'action',
    action: 'Running',
    parameter: 'Implementation workflow',
    result: undefined,  // Or string when complete
  },
});
```

### Elicitation (asking user for input)

```typescript
await linear.createAgentActivity({
  agentSessionId: sessionId,
  content: {
    type: 'elicitation',
    body: 'Which GitHub repository should I use?\n\nReply with `owner/repo`',
  },
});
```

### Response (work complete)

```typescript
await linear.createAgentActivity({
  agentSessionId: sessionId,
  content: {
    type: 'response',
    body: '✅ PR ready for review\n\n[#42 Add user authentication](https://github.com/...)',
  },
});
```

### Error

```typescript
await linear.createAgentActivity({
  agentSessionId: sessionId,
  content: {
    type: 'error',
    body: 'Workflow failed. [View logs](https://github.com/...)',
  },
});
```

---

## Core Flows

### Flow 1: First-Time Onboarding

**Trigger:** Agent assigned to ticket, no config exists for team

```
1. Receive AgentSessionEvent (created)
2. Acknowledge within 10 seconds with thought: "Looking at this issue..."
3. Query team_configs for linear_team_id
4. No config found → Start onboarding
5. Create onboarding_session record with state='awaiting_repo'
6. Emit elicitation: "Which GitHub repository should I use?"
7. User replies with "owner/repo"
8. Receive AgentSessionEvent (prompted)
9. Parse owner/repo from user message
10. Check if GitHub App is installed for that repo
    - If not: emit elicitation with install link, state='awaiting_app_install'
    - If yes: continue
11. Ask for default branch, state='awaiting_branch'
12. User confirms branch
13. Show summary, ask for confirmation, state='awaiting_confirmation'
14. User confirms
15. Save team_config record
16. Trigger onboarding workflow
17. Workflow generates CLAUDE.md and opens PR
18. On workflow complete: update team_config.onboarded=1
19. Emit response with onboarding PR link
20. Now handle the original ticket (trigger implementation workflow)
```

### Flow 2: Normal Implementation

**Trigger:** Agent assigned to ticket, config exists and onboarded

```
1. Receive AgentSessionEvent (created)
2. Acknowledge within 10 seconds with thought: "Looking at this issue..."
3. Query team_configs for linear_team_id
4. Config found and onboarded=1
5. Fetch full issue context from Linear:
   - Description
   - All comments
   - Linked issues
   - Parent issue
   - Attachments
6. Determine branch name:
   - Check if agent/{identifier} exists
   - If yes, find next available: agent/{identifier}-2, agent/{identifier}-3, etc.
7. Create workflow_runs record
8. Emit action: "Starting implementation workflow"
9. Trigger GitHub Action with inputs:
   - agent_session_id
   - ticket_id (identifier)
   - ticket_title
   - ticket_description
   - ticket_context (JSON with comments, links, etc.)
   - branch_name
   - callback_url (optional, for future use)
10. Wait for GitHub webhook: workflow_run.in_progress
11. Update workflow_runs.status='in_progress'
12. Emit action: "Running Claude Code"
13. Wait for GitHub webhook: workflow_run.completed
14. If conclusion='success':
    - Find PR created by workflow
    - Update workflow_runs with PR info
    - Emit response with PR link
    - Create Linear attachment linking to PR
15. If conclusion='failure':
    - Emit error with link to workflow run
```

### Flow 3: Cancellation (Unassign)

**Trigger:** User unassigns agent from ticket while workflow running

```
1. Receive AppUserNotification (issueUnassignedFromYou)
2. Find workflow_runs record by linear_issue_id where status != 'completed'
3. If found:
   - Call GitHub API to cancel workflow run
   - Update workflow_runs.status='completed', conclusion='cancelled'
   - Emit thought: "Workflow cancelled"
4. Clean up any onboarding_session if exists
```

### Flow 4: Respond to @mention in Issue Comment

**Trigger:** User @mentions agent in a Linear issue comment

```
1. Receive AgentSessionEvent (created) with comment context
2. Check if this is a new assignment or just a mention
   - If comment but no assignment change: it's a mention
3. Load existing workflow context if any
4. Determine intent from comment:
   - Is this a follow-up request?
   - Is this asking for status?
   - Is this new instructions?
5. If follow-up/new instructions:
   - Trigger new implementation workflow with updated context
   - Use incremented branch name
6. Respond appropriately
```

---

## GitHub Actions

### Workflow: `linear-agent.yml`

Main implementation workflow. Must be added to each repository that wants to use the agent.

```yaml
name: Linear Agent - Implement

on:
  workflow_dispatch:
    inputs:
      agent_session_id:
        description: 'Linear agent session ID'
        required: true
        type: string
      ticket_id:
        description: 'Linear ticket identifier (e.g., ABC-123)'
        required: true
        type: string
      ticket_title:
        description: 'Ticket title'
        required: true
        type: string
      ticket_description:
        description: 'Ticket description'
        required: false
        type: string
        default: ''
      ticket_context:
        description: 'JSON with comments, links, parent, attachments'
        required: false
        type: string
        default: '{}'
      branch_name:
        description: 'Branch name to use'
        required: true
        type: string

jobs:
  implement:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 1
          ref: ${{ github.event.repository.default_branch }}

      - name: Create feature branch
        run: |
          git checkout -b ${{ inputs.branch_name }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies (if package.json exists)
        run: |
          if [ -f package.json ]; then
            npm ci || npm install
          fi

      - name: Run Claude Code
        id: claude
        uses: anthropics/claude-code-action@beta
        with:
          model: claude-sonnet-4-20250514
          prompt: |
            You are implementing a ticket from Linear.

            ## Ticket: ${{ inputs.ticket_id }}
            
            **Title:** ${{ inputs.ticket_title }}
            
            **Description:**
            ${{ inputs.ticket_description }}
            
            **Additional Context:**
            ```json
            ${{ inputs.ticket_context }}
            ```
            
            ## Instructions
            
            1. Read CLAUDE.md if it exists for project-specific guidance
            2. Analyze the codebase to understand patterns and conventions
            3. Implement the requested changes
            4. Ensure code follows existing style and patterns
            5. Add or update tests if the project has them
            6. Do not commit - changes will be committed automatically
            
            Focus on producing clean, working code that fits naturally into this codebase.
          allowed_tools: |
            mcp__shell__execute_command
            mcp__filesystem__read_file
            mcp__filesystem__write_file
            mcp__filesystem__list_directory
          max_turns: 50
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      - name: Check for changes
        id: changes
        run: |
          if [ -n "$(git status --porcelain)" ]; then
            echo "has_changes=true" >> $GITHUB_OUTPUT
          else
            echo "has_changes=false" >> $GITHUB_OUTPUT
          fi

      - name: Commit changes
        if: steps.changes.outputs.has_changes == 'true'
        run: |
          git config user.name "linear-code-agent[bot]"
          git config user.email "linear-code-agent[bot]@users.noreply.github.com"
          git add -A
          git commit -m "${{ inputs.ticket_id }}: ${{ inputs.ticket_title }}"

      - name: Push branch
        if: steps.changes.outputs.has_changes == 'true'
        run: |
          git push origin ${{ inputs.branch_name }}

      - name: Create Pull Request
        if: steps.changes.outputs.has_changes == 'true'
        id: pr
        uses: peter-evans/create-pull-request@v6
        with:
          branch: ${{ inputs.branch_name }}
          base: ${{ github.event.repository.default_branch }}
          title: "${{ inputs.ticket_id }}: ${{ inputs.ticket_title }}"
          body: |
            ## Summary
            
            Implements [${{ inputs.ticket_id }}](https://linear.app/issue/${{ inputs.ticket_id }})
            
            **${{ inputs.ticket_title }}**
            
            ${{ inputs.ticket_description }}
            
            ---
            
            *This PR was automatically generated by [Linear Code Agent](https://github.com/your-org/linear-code-agent)*
          draft: false

      - name: Output PR URL
        if: steps.changes.outputs.has_changes == 'true'
        run: |
          echo "PR created: ${{ steps.pr.outputs.pull-request-url }}"

      - name: No changes detected
        if: steps.changes.outputs.has_changes == 'false'
        run: |
          echo "No changes were made by Claude Code"
          exit 1
```

### Workflow: `linear-onboard.yml`

Onboarding workflow that analyzes the codebase and generates `CLAUDE.md`.

```yaml
name: Linear Agent - Onboard

on:
  workflow_dispatch:
    inputs:
      agent_session_id:
        description: 'Linear agent session ID'
        required: true
        type: string
      linear_issue_id:
        description: 'Linear issue ID that triggered onboarding'
        required: true
        type: string

jobs:
  onboard:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: Check if CLAUDE.md already exists
        id: check
        run: |
          if [ -f CLAUDE.md ]; then
            echo "exists=true" >> $GITHUB_OUTPUT
          else
            echo "exists=false" >> $GITHUB_OUTPUT
          fi

      - name: Run Claude Code for onboarding
        if: steps.check.outputs.exists == 'false'
        uses: anthropics/claude-code-action@beta
        with:
          model: claude-sonnet-4-20250514
          prompt: |
            You are onboarding to a new codebase. Your task is to analyze this repository
            and create a CLAUDE.md file that will help AI agents (including yourself) 
            work effectively on future tasks.
            
            ## Instructions
            
            1. Explore the repository structure
            2. Identify the tech stack, frameworks, and languages used
            3. Understand the project's purpose and architecture
            4. Note coding conventions and patterns
            5. Find how to run tests, build, and lint
            6. Identify any important configuration or setup requirements
            
            ## Create CLAUDE.md with these sections:
            
            ### Project Overview
            Brief description of what this project does.
            
            ### Tech Stack
            - Languages
            - Frameworks
            - Key dependencies
            
            ### Architecture
            High-level overview of how the code is organized.
            
            ### Development
            - How to install dependencies
            - How to run the project locally
            - How to run tests
            - How to build for production
            
            ### Code Style
            - Formatting conventions
            - Naming conventions
            - Patterns used in this codebase
            
            ### Important Files
            Key files an agent should know about.
            
            ### Common Tasks
            Examples of how to do common things in this codebase.
            
            Be concise but thorough. This file will be read by AI on every task.
          allowed_tools: |
            mcp__filesystem__read_file
            mcp__filesystem__write_file
            mcp__filesystem__list_directory
          max_turns: 30
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      - name: Commit CLAUDE.md
        if: steps.check.outputs.exists == 'false'
        run: |
          if [ -f CLAUDE.md ]; then
            git config user.name "linear-code-agent[bot]"
            git config user.email "linear-code-agent[bot]@users.noreply.github.com"
            git checkout -b agent/onboarding
            git add CLAUDE.md
            git commit -m "Add CLAUDE.md for AI agent onboarding"
            git push origin agent/onboarding
          fi

      - name: Create onboarding PR
        if: steps.check.outputs.exists == 'false'
        uses: peter-evans/create-pull-request@v6
        with:
          branch: agent/onboarding
          base: ${{ github.event.repository.default_branch }}
          title: "🤖 Add CLAUDE.md for AI agent onboarding"
          body: |
            This PR adds a `CLAUDE.md` file that helps AI agents understand and work
            effectively in this codebase.
            
            ## What's included
            
            - Project overview and tech stack
            - Architecture documentation
            - Development setup instructions
            - Code style and conventions
            - Common task examples
            
            ## Next steps
            
            1. Review the generated documentation
            2. Edit as needed to improve accuracy
            3. Merge to enable the Linear Code Agent for this repository
            
            ---
            
            *Generated by [Linear Code Agent](https://github.com/your-org/linear-code-agent)*
          draft: false
```

---

## GitHub App Configuration

### App Settings

Create at: https://github.com/settings/apps/new

**Basic Information:**
- Name: `Linear Code Agent` (or your preferred name)
- Description: AI agent that implements Linear tickets
- Homepage URL: Your documentation URL

**Webhook:**
- Active: Yes
- Webhook URL: `https://<your-worker>.workers.dev/webhook/github`
- Webhook secret: Generate a strong secret
- SSL verification: Enabled

**Permissions:**

| Category | Permission | Access |
|----------|------------|--------|
| Repository | Contents | Read and write |
| Repository | Metadata | Read-only |
| Repository | Pull requests | Read and write |
| Repository | Actions | Read and write |

**Subscribe to events:**
- Workflow run
- Pull request
- Installation and installation repositories

**Where can this app be installed:**
- Any account (for public distribution)
- Only on this account (for private use)

### Installation Flow

When a user provides a repo during onboarding:

1. Check if app is installed: `GET /repos/{owner}/{repo}/installation`
2. If 404, provide install URL:
   ```
   https://github.com/apps/{app-name}/installations/new/permissions?target_id={owner}
   ```
3. After installation, GitHub sends `installation.created` webhook
4. Store installation in `github_installations` table
5. Resume onboarding flow

---

## Linear OAuth App Configuration

Create at: https://linear.app/settings/api/applications/new

**Basic Information:**
- Application name: `Linear Code Agent`
- Description: AI agent that implements tickets using Claude Code
- Developer name: Your name/org
- Developer URL: Your documentation URL

**OAuth Settings:**
- Redirect URLs: `https://<your-worker>.workers.dev/oauth/callback` (if implementing OAuth flow)

**Webhooks:**
- Webhook URL: `https://<your-worker>.workers.dev/webhook/linear`
- Enable: Agent session events
- Enable: Inbox notifications (for unassign detection)
- Enable: Permission changes (optional, for tracking access changes)

**OAuth Scopes (for actor=app):**
- `app:assignable` - Allow assignment as delegate
- `app:mentionable` - Allow @mentions
- `read` - Read access to workspace data
- `write` - Write access (comments, attachments, issue updates)

---

## Type Definitions

### File: `src/types.ts`

```typescript
// Environment bindings
export interface Bindings {
  DB: D1Database;
  LINEAR_API_KEY: string;
  LINEAR_WEBHOOK_SECRET: string;
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
  onboarded: number;  // 0 or 1
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

export interface OnboardingSession {
  id: number;
  agent_session_id: string;
  linear_workspace_id: string;
  linear_team_id: string;
  state: OnboardingState;
  pending_data: string | null;  // JSON
  pending_issue_id: string | null;
  created_at: string;
  updated_at: string;
}

export type OnboardingState =
  | 'awaiting_repo'
  | 'awaiting_app_install'
  | 'awaiting_branch'
  | 'awaiting_confirmation'
  | 'triggering_onboard'
  | 'complete';

export interface WorkflowRun {
  id: number;
  github_run_id: number;
  github_owner: string;
  github_repo: string;
  agent_session_id: string;
  linear_issue_id: string;
  linear_issue_identifier: string;
  workflow_type: 'onboard' | 'implement';
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
    body: string;
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
    relation: string;  // 'blocks', 'blocked_by', 'related', 'duplicate'
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
```

---

## Wrangler Configuration

### File: `wrangler.toml`

```toml
name = "linear-code-agent"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
ENVIRONMENT = "production"

[[d1_databases]]
binding = "DB"
database_name = "linear-code-agent"
database_id = "<your-database-id>"

# For local development
[env.dev]
name = "linear-code-agent-dev"

[env.dev.vars]
ENVIRONMENT = "development"

[[env.dev.d1_databases]]
binding = "DB"
database_name = "linear-code-agent-dev"
database_id = "<your-dev-database-id>"
```

---

## Deployment Instructions

### 1. Create Cloudflare Resources

```bash
# Login to Cloudflare
npx wrangler login

# Create D1 database
npx wrangler d1 create linear-code-agent

# Note the database_id and update wrangler.toml

# Run migrations
npx wrangler d1 execute linear-code-agent --file=migrations/0001_initial.sql
```

### 2. Create GitHub App

1. Go to https://github.com/settings/apps/new
2. Configure as specified in "GitHub App Configuration" section
3. Generate and download private key
4. Note the App ID

### 3. Create Linear OAuth App

1. Go to https://linear.app/settings/api/applications/new
2. Configure as specified in "Linear OAuth App Configuration" section
3. Note the webhook signing secret
4. Create an API key for the agent

### 4. Set Secrets

```bash
# Linear secrets
npx wrangler secret put LINEAR_API_KEY
npx wrangler secret put LINEAR_WEBHOOK_SECRET

# GitHub secrets
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

### 5. Deploy Worker

```bash
# Deploy to production
npx wrangler deploy

# Or deploy to dev environment
npx wrangler deploy --env dev
```

### 6. Configure Webhooks

Update webhook URLs in both Linear and GitHub with your worker URL:
- Linear: `https://linear-code-agent.<your-subdomain>.workers.dev/webhook/linear`
- GitHub: `https://linear-code-agent.<your-subdomain>.workers.dev/webhook/github`

### 7. Install GitHub App

1. Go to your GitHub App's public page
2. Click "Install"
3. Select repositories to enable

### 8. Test

1. Create a test ticket in Linear
2. Assign it to the agent
3. Follow onboarding prompts
4. Verify PR is created

---

## Error Handling

### Webhook Signature Verification

Both Linear and GitHub sign webhooks. Verify before processing:

```typescript
// Linear - HMAC SHA256
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyLinearSignature(body: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// GitHub - SHA256 with prefix
function verifyGitHubSignature(body: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

### Idempotency

Check processed_webhooks before handling:

```typescript
async function isWebhookProcessed(db: D1Database, webhookId: string, type: string): Promise<boolean> {
  const result = await db.prepare(
    'SELECT 1 FROM processed_webhooks WHERE webhook_id = ? AND webhook_type = ?'
  ).bind(webhookId, type).first();
  return result !== null;
}

async function markWebhookProcessed(db: D1Database, webhookId: string, type: string): Promise<void> {
  await db.prepare(
    'INSERT OR IGNORE INTO processed_webhooks (webhook_id, webhook_type) VALUES (?, ?)'
  ).bind(webhookId, type).run();
}
```

### Common Errors

| Error | Cause | Resolution |
|-------|-------|------------|
| 401 from Linear | Invalid API key or webhook secret | Verify secrets are set correctly |
| 404 from GitHub | App not installed or no repo access | Prompt user to install app |
| Workflow not found | Repo missing workflow files | Prompt user to add workflow files |
| Branch already exists | Previous run didn't clean up | Use incremented branch name |

---

## Testing

### Local Development

```bash
# Start local dev server
npx wrangler dev

# In another terminal, use ngrok for webhook testing
ngrok http 8787

# Update webhook URLs in Linear and GitHub to ngrok URL
```

### Manual Testing Checklist

- [ ] Assign ticket to agent - onboarding starts
- [ ] Complete onboarding flow - config saved
- [ ] Assign another ticket - implementation runs
- [ ] Unassign ticket mid-run - workflow cancels
- [ ] Assign ticket with existing branch - increments suffix
- [ ] @mention agent in comment - responds appropriately
- [ ] Workflow fails - error reported to Linear
- [ ] Workflow succeeds - PR created and linked

---

## Decisions Summary

| Topic | Decision |
|-------|----------|
| Concurrent assignments | Parallel with `agent/{identifier}` branches |
| Unassigned mid-work | Cancel the GitHub workflow |
| Branch conflicts | Increment suffix (`agent/ABC-123-2`) |
| Large repos | Shallow clone (`fetch-depth: 1`) |
| Claude Code fails | Fail and report error to Linear |
| Prompt injection | Trust Claude Code + PR-only guardrail |
| Secrets in repos | Not a concern |
| Webhook idempotency | Track IDs and dedupe |
| Progress visibility | Update on started/completed/failed only |
| Cancel mechanism | Unassign the agent |
| PR feedback loop | Respond only if @mentioned (future) |
| Multiple repos per team | One team = one repo |
| Observability | Console logs + D1 run history |
| GitHub rate limits | Not monitored |
| Linear rate limits | Not monitored |
| Retry logic | Fail immediately, no retries |
| Issue comment feedback | Respond only if @mentioned |
| Test running | Let existing CI handle it |
| Draft vs ready PRs | Always ready for review |
| Issue context | Full (comments, links, parent, attachments) |

---

## Future Enhancements

1. **PR review iteration** - Agent responds to @mentions in PR comments
2. **Multi-repo support** - Allow team to configure multiple repos with label-based routing
3. **Custom prompts** - Allow users to configure agent behavior per team
4. **Metrics dashboard** - Track success rates, time to PR, etc.
5. **Slack notifications** - Notify on completion/failure
6. **Auto-merge** - Option to auto-merge if CI passes
