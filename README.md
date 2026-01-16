# Linear Code Agent

A Cloudflare Worker that integrates with Linear's Agent API to automatically implement tickets using Claude Code via GitHub Actions.

## How It Works

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Linear    │────▶│ Cloudflare Worker│────▶│  GitHub Actions │
│   Agent     │     │  (Orchestrator)  │     │  (Claude Code)  │
└─────────────┘     └──────────────────┘     └─────────────────┘
```

1. User assigns the Linear agent to a ticket
2. Linear sends webhook → Cloudflare Worker
3. Worker triggers GitHub Actions workflow
4. Claude Code implements the changes
5. PR is created and linked back to Linear

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [GitHub account](https://github.com)
- [Linear workspace](https://linear.app) (admin access)
- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`)

## Setup

### Step 1: Clone and Install

```bash
git clone https://github.com/YOUR_USERNAME/linear-agent.git
cd linear-agent
npm install
```

### Step 2: Create Cloudflare D1 Database

```bash
# Login to Cloudflare
npx wrangler login

# Create the database
npx wrangler d1 create linear-code-agent
```

Copy the `database_id` from the output and create `wrangler.production.toml`:

```toml
name = "linear-code-agent"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
ENVIRONMENT = "production"

[[d1_databases]]
binding = "DB"
database_name = "linear-code-agent"
database_id = "your-database-id-here"  # ← Replace with your ID
```

Note: `wrangler.production.toml` is gitignored to keep your database ID private.

### Step 3: Deploy the Worker (First Deploy)

Deploy first to get your worker URL:

```bash
npm run deploy
```

Your worker URL will be: `https://linear-code-agent.<your-subdomain>.workers.dev`

Note this URL - you'll need it for the next steps.

### Step 4: Create GitHub App

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
2. Fill in:
   - **App name**: `linear-code-agent` (or your preferred name)
   - **Homepage URL**: Your worker URL
   - **Webhook URL**: `https://linear-code-agent.<your-subdomain>.workers.dev/webhook/github`
   - **Webhook secret**: Generate a secure random string (save this!)
3. Set permissions:
   - **Repository: Contents** → Read and write
   - **Repository: Metadata** → Read-only
   - **Repository: Pull requests** → Read and write
   - **Repository: Actions** → Read and write
4. Subscribe to events:
   - ✅ Workflow run
   - ✅ Pull request
   - ✅ Installation
5. Click **Create GitHub App**
6. Note the **App ID** (shown at top of page)
7. Scroll down and click **Generate a private key** (downloads a `.pem` file)

### Step 5: Create Linear OAuth Application

1. Go to **Linear → Settings → API → OAuth applications → New**
2. Fill in:
   - **Application name**: `Linear Code Agent`
   - **Callback URL**: `https://linear-code-agent.<your-subdomain>.workers.dev/oauth/callback`
3. Under **Webhooks**:
   - Enable **Agent session events**
   - Enable **Inbox notifications**
4. Click **Create**
5. Note the following (you'll need these):
   - **Client ID**
   - **Client Secret**
   - **Webhook signing secret**

### Step 6: Configure Secrets

```bash
# GitHub App secrets
npx wrangler secret put GITHUB_APP_ID
# Enter: Your GitHub App ID (numeric)

npx wrangler secret put GITHUB_APP_PRIVATE_KEY
# Enter: Contents of the .pem file (paste the entire key including BEGIN/END lines)

npx wrangler secret put GITHUB_WEBHOOK_SECRET
# Enter: The webhook secret you created in Step 4

# Linear OAuth secrets
npx wrangler secret put LINEAR_CLIENT_ID
# Enter: Linear OAuth Client ID

npx wrangler secret put LINEAR_CLIENT_SECRET
# Enter: Linear OAuth Client Secret

npx wrangler secret put LINEAR_WEBHOOK_SECRET
# Enter: Linear webhook signing secret
```

### Step 7: Run Database Migrations

```bash
npm run db:migrate
```

### Step 8: Redeploy

```bash
npm run deploy
```

## Connecting a Linear Workspace

Each Linear workspace needs to authorize the OAuth app:

1. Visit: `https://linear-code-agent.<your-subdomain>.workers.dev/oauth/authorize`
2. Click **Authorize** in Linear
3. You'll be redirected back with a success message

## Setting Up a Repository

For each repository you want the agent to work with:

### 1. Install the GitHub App

Go to your GitHub App's public page and click **Install**:
```
https://github.com/apps/YOUR-APP-NAME/installations/new
```

Select the repositories you want to enable.

### 2. Add the Workflow File

Copy the workflow to your repository:

```bash
# From the linear-agent repo
cp .github/workflows/linear-agent.yml /path/to/your-repo/.github/workflows/
```

### 3. Add Repository Secret

First, generate a Claude Code OAuth token:

```bash
claude setup-token
```

Then in your repository, go to **Settings → Secrets → Actions** and add:

- **Name**: `CLAUDE_CODE_OAUTH_TOKEN`
- **Value**: The token from the command above

## Usage

1. Open a Linear ticket
2. Assign the **Linear Code Agent** to the ticket
3. First time for a team: Agent asks which repo to use (reply with `owner/repo`)
4. Agent analyzes the ticket and triggers implementation
5. Claude Code creates a PR with the implementation
6. PR link appears as a comment on the Linear ticket

## Development

```bash
npm run dev          # Start local dev server
npm run test:run     # Run tests (113 tests)
npm run test         # Run tests in watch mode
npm run typecheck    # Type check
npm run deploy       # Deploy to Cloudflare
```

## Project Structure

```
src/
├── index.ts              # Hono app, routes, OAuth flow
├── types.ts              # TypeScript types
├── handlers/             # Webhook handlers
├── services/             # Linear, GitHub, Workflow services
├── db/                   # Database queries
├── utils/                # Crypto, branch utilities
└── __tests__/            # Test files
```

See [CLAUDE.md](./CLAUDE.md) for detailed documentation.

## Troubleshooting

### Agent not appearing in Linear assignee dropdown
- Ensure your Linear OAuth app has **Agent session events** webhook enabled
- Verify the webhook URL is correct: `https://your-worker.workers.dev/webhook/linear`
- Re-authorize by visiting `/oauth/authorize` to get the `app:assignable` scope

### "No OAuth token found for workspace"
The Linear workspace hasn't been authorized. Visit `/oauth/authorize` to connect.

### "GitHub App not installed"
Install the GitHub App on the repository via the GitHub App's installation page.

### Workflow not triggering
- Check that `linear-agent.yml` exists in the repo's `.github/workflows/`
- Verify `CLAUDE_CODE_OAUTH_TOKEN` secret is set
- Check the worker logs: `npx wrangler tail --config wrangler.production.toml`

## License

MIT
