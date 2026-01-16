import { Hono } from 'hono';
import type { Bindings } from './types';
import { handleLinearWebhook } from './handlers/linear-webhook';
import { handleGitHubWebhook } from './handlers/github-webhook';

// Create Hono app with typed bindings
const app = new Hono<{ Bindings: Bindings }>();

// HTML escape to prevent XSS
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// OAuth state TTL in minutes
const OAUTH_STATE_TTL_MINUTES = 10;

// Start OAuth flow - redirects to Linear with state parameter
app.get('/oauth/authorize', async (c) => {
  // Generate cryptographically secure state parameter
  const state = crypto.randomUUID();

  // Store state in database for validation
  await c.env.DB.prepare(
    'INSERT INTO oauth_states (state) VALUES (?)'
  ).bind(state).run();

  // Clean up expired states (older than TTL)
  await c.env.DB.prepare(
    `DELETE FROM oauth_states WHERE created_at < datetime('now', '-${OAUTH_STATE_TTL_MINUTES} minutes')`
  ).run();

  // Build Linear OAuth URL
  const redirectUri = new URL(c.req.url).origin + '/oauth/callback';
  const params = new URLSearchParams({
    client_id: c.env.LINEAR_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    state: state,
    scope: 'read,write,issues:create,comments:create,app:assignable',
    actor: 'app',
  });

  const linearAuthUrl = `https://linear.app/oauth/authorize?${params.toString()}`;

  return c.redirect(linearAuthUrl);
});

// OAuth callback for Linear agent installation
app.get('/oauth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  // Handle OAuth errors from Linear
  if (error) {
    console.error('OAuth error from Linear:', error);
    return c.html(`
      <html>
        <body style="font-family: system-ui; padding: 40px; text-align: center;">
          <h1>❌ Authorization Failed</h1>
          <p>The authorization was denied or an error occurred.</p>
          <p><a href="/oauth/authorize">Try again</a></p>
        </body>
      </html>
    `, 400);
  }

  if (!code || !state) {
    return c.html(`
      <html>
        <body style="font-family: system-ui; padding: 40px; text-align: center;">
          <h1>❌ Invalid Request</h1>
          <p>Missing required parameters.</p>
          <p><a href="/oauth/authorize">Start over</a></p>
        </body>
      </html>
    `, 400);
  }

  // Validate state parameter to prevent CSRF
  const storedState = await c.env.DB.prepare(
    'SELECT state FROM oauth_states WHERE state = ?'
  ).bind(state).first<{ state: string }>();

  if (!storedState) {
    console.error('Invalid OAuth state:', state);
    return c.html(`
      <html>
        <body style="font-family: system-ui; padding: 40px; text-align: center;">
          <h1>❌ Invalid Request</h1>
          <p>The authorization request has expired or is invalid.</p>
          <p><a href="/oauth/authorize">Start over</a></p>
        </body>
      </html>
    `, 400);
  }

  // Delete used state (one-time use)
  await c.env.DB.prepare(
    'DELETE FROM oauth_states WHERE state = ?'
  ).bind(state).run();

  // Build redirect URI from request origin (not hardcoded)
  const redirectUri = new URL(c.req.url).origin + '/oauth/callback';

  // Exchange code for access token
  const response = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: c.env.LINEAR_CLIENT_ID,
      client_secret: c.env.LINEAR_CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('OAuth token exchange failed:', errorText);
    // Don't expose error details to user
    return c.html(`
      <html>
        <body style="font-family: system-ui; padding: 40px; text-align: center;">
          <h1>❌ Authorization Failed</h1>
          <p>Could not complete the authorization. Please try again.</p>
          <p><a href="/oauth/authorize">Try again</a></p>
        </body>
      </html>
    `, 400);
  }

  const data = await response.json() as { access_token: string; scope?: string };

  // Get the workspace ID using the access token
  const orgResponse = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': data.access_token,
    },
    body: JSON.stringify({
      query: '{ organization { id name } }',
    }),
  });

  const orgData = await orgResponse.json() as {
    data?: { organization: { id: string; name: string } };
  };

  const workspaceId = orgData.data?.organization.id;
  const workspaceName = orgData.data?.organization.name || 'Unknown';

  if (!workspaceId) {
    console.error('Could not get workspace ID from Linear');
    return c.html(`
      <html>
        <body style="font-family: system-ui; padding: 40px; text-align: center;">
          <h1>❌ Authorization Failed</h1>
          <p>Could not retrieve workspace information.</p>
          <p><a href="/oauth/authorize">Try again</a></p>
        </body>
      </html>
    `, 400);
  }

  // Store the token in the database
  await c.env.DB.prepare(
    `INSERT INTO oauth_tokens (workspace_id, access_token, scope)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       access_token = excluded.access_token,
       scope = excluded.scope,
       updated_at = datetime('now')`
  ).bind(workspaceId, data.access_token, data.scope || '').run();

  console.log(`OAuth token stored for workspace ${workspaceName} (${workspaceId})`);

  // Success! HTML-escape workspace name to prevent XSS
  const safeWorkspaceName = escapeHtml(workspaceName);

  return c.html(`
    <html>
      <body style="font-family: system-ui; padding: 40px; text-align: center;">
        <h1>✅ Linear Agent Installed!</h1>
        <p>Your Linear Code Agent is now installed in <strong>${safeWorkspaceName}</strong>.</p>
        <p>Go back to Linear and assign a ticket to the agent to test it.</p>
      </body>
    </html>
  `);
});

// Linear webhook endpoint
app.post('/webhook/linear', handleLinearWebhook);

// GitHub webhook endpoint
app.post('/webhook/github', handleGitHubWebhook);

// Catch-all for unmatched routes
app.all('*', (c) => {
  return c.json({ error: 'Not found' }, 404);
});

// Export for Cloudflare Workers
export default app;
