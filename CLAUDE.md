# Linear Code Agent

A Cloudflare Worker that integrates Linear's Agent API with GitHub Actions to automatically implement Linear tickets using Claude Code.

## Architecture Overview

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Linear    │────▶│ Cloudflare Worker│────▶│  GitHub Actions │
│  (Webhooks) │     │  (Orchestrator)  │     │  (Claude Code)  │
└─────────────┘     └──────────────────┘     └─────────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │  D1 Database │
                    └──────────────┘
```

## Project Structure

```
src/
├── index.ts              # Hono app entry point, routes
├── types.ts              # TypeScript type definitions
├── handlers/
│   ├── linear-webhook.ts    # Linear webhook dispatcher
│   ├── github-webhook.ts    # GitHub webhook handler
│   ├── session-created.ts   # New agent session handler
│   ├── session-prompted.ts  # User prompt handler
│   └── inbox-notification.ts # Inbox notification handler
├── services/
│   ├── linear.ts         # Linear API client (GraphQL)
│   ├── github-app.ts     # GitHub App authentication & API
│   └── workflow.ts       # Workflow orchestration
├── db/
│   ├── queries.ts        # Database query functions
│   └── schema.sql        # Reference schema
├── utils/
│   ├── crypto.ts         # Webhook signature verification
│   └── branch.ts         # Branch name utilities
└── __tests__/            # Vitest test files
```

## Key Concepts

### Flow: Ticket Implementation

1. User assigns the Linear agent to a ticket
2. Linear sends `AgentSession.created` webhook
3. Worker checks team configuration (github owner/repo)
4. If configured: triggers `linear-agent.yml` workflow via GitHub API
5. GitHub Actions runs Claude Code to implement the ticket
6. On completion: Worker finds PR, creates Linear attachment, notifies user

### Authentication

- **Linear**: OAuth tokens stored per workspace in D1
- **GitHub**: GitHub App with JWT signing (RS256) for installation tokens

### Database Tables

- `oauth_tokens` - Linear OAuth tokens per workspace
- `oauth_states` - OAuth CSRF protection state parameters
- `github_installations` - GitHub App installation records
- `team_configs` - GitHub repo configuration per Linear team
- `workflow_runs` - Active/completed workflow tracking
- `pending_workflow_triggers` - Correlate workflow dispatch with GitHub webhook
- `pending_configs` - Teams awaiting repository configuration
- `processed_webhooks` - Idempotency for webhook processing
- `run_log` - Event logging for debugging

## Development

### Commands

```bash
npm run dev          # Start local dev server
npm run deploy       # Deploy to Cloudflare
npm run test         # Run tests (watch mode)
npm run test:run     # Run tests once
npm run test:coverage # Run tests with coverage
npm run typecheck    # TypeScript check
```

## Deployment

### Pre-Deployment Checklist

**IMPORTANT: Always run tests before deploying to ensure code integrity.**

```bash
# 1. Run all tests - must pass before deploying
npm run test:run

# 2. Type check - ensure no TypeScript errors
npm run typecheck

# 3. Deploy only if steps 1-2 pass
npm run deploy
```

### Deployment Process

```bash
# Full deployment workflow
npm run test:run && npm run typecheck && npm run deploy
```

If tests fail:
1. Do NOT deploy
2. Fix the failing tests
3. Re-run the test suite
4. Only deploy once all 113 tests pass

### Production Migrations

When deploying database changes:

```bash
# 1. Run tests first
npm run test:run

# 2. Deploy the code
npm run deploy

# 3. Run the migration
npm run db:migrate
```

**Never run migrations without deploying the corresponding code first.**

### Environment Variables

Required in `wrangler.toml` or Cloudflare dashboard:
- `GITHUB_APP_ID` - GitHub App ID
- `GITHUB_APP_PRIVATE_KEY` - GitHub App private key (PEM)
- `GITHUB_WEBHOOK_SECRET` - Secret for verifying GitHub webhooks
- `LINEAR_WEBHOOK_SECRET` - Secret for verifying Linear webhooks

### Database Migrations

```bash
# Local development
npm run db:migrate:dev

# Production
npm run db:migrate
```

## Key Files to Understand

1. **`src/handlers/session-created.ts`** - Entry point when agent is assigned
2. **`src/services/workflow.ts`** - Core orchestration logic
3. **`src/handlers/github-webhook.ts`** - Handles workflow completion
4. **`.github/workflows/linear-agent.yml`** - The Claude Code workflow

## Testing

Tests use Vitest with `@cloudflare/vitest-pool-workers` for D1 database mocking.

```bash
npm run test:run  # 113 tests across 8 files
```

Test files cover:
- Signature verification (crypto)
- Branch name generation
- Database queries
- Linear API service
- GitHub App service
- Workflow orchestration
- Session handlers
- OAuth security (CSRF, XSS prevention)

## Common Tasks

### Adding a new webhook handler

1. Add type to `src/types.ts`
2. Create handler in `src/handlers/`
3. Register in `src/handlers/linear-webhook.ts`
4. Add tests in `src/__tests__/`
5. **Run `npm run test:run` to verify all tests pass**

### Modifying workflow inputs

1. Update `src/services/workflow.ts` `triggerImplementation()`
2. Update `.github/workflows/linear-agent.yml` inputs
3. Update any dependent tests
4. **Run `npm run test:run` to verify all tests pass**

### Adding database fields

1. Create new migration in `migrations/`
2. Update `src/db/queries.ts` with new functions
3. Update `src/types.ts` if needed
4. Add tests for new query functions
5. **Run `npm run test:run` to verify all tests pass**
6. Deploy code, then run migration

### Making any code changes

Always follow this workflow:

1. Make your changes
2. Run `npm run test:run` - all 113 tests must pass
3. Run `npm run typecheck` - no TypeScript errors
4. Only then deploy with `npm run deploy`
