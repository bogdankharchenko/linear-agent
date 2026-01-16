import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// Import the app for testing
import app from '../index';

// Setup database before tests
async function setupDatabase() {
  await env.DB.batch([
    env.DB.prepare('DROP TABLE IF EXISTS oauth_states'),
    env.DB.prepare('DROP TABLE IF EXISTS oauth_tokens'),
    env.DB.prepare(`
      CREATE TABLE oauth_states (
        state TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `),
    env.DB.prepare(`
      CREATE TABLE oauth_tokens (
        workspace_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        scope TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `),
  ]);
}

// Helper to create mock request
function createRequest(path: string, options: RequestInit = {}) {
  return new Request(`https://test.workers.dev${path}`, options);
}

describe('OAuth Security', () => {
  beforeEach(async () => {
    await setupDatabase();
  });

  describe('escapeHtml', () => {
    // Test the escapeHtml function indirectly through the OAuth callback
    it('should escape HTML special characters in workspace name', async () => {
      // Insert a valid state
      const state = 'test-state-123';
      await env.DB.prepare('INSERT INTO oauth_states (state) VALUES (?)').bind(state).run();

      // Mock fetch to return malicious workspace name
      const originalFetch = global.fetch;
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'test-token', scope: 'read' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              organization: {
                id: 'org-123',
                name: '<script>alert("xss")</script>',
              },
            },
          }),
        });

      const mockEnv = {
        ...env,
        LINEAR_CLIENT_ID: 'test-client-id',
        LINEAR_CLIENT_SECRET: 'test-client-secret',
      };

      const request = createRequest(`/oauth/callback?code=test-code&state=${state}`);
      const response = await app.fetch(request, mockEnv);
      const html = await response.text();

      // Should contain escaped HTML, not raw script tag
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<script>alert');

      global.fetch = originalFetch;
    });

    it('should escape ampersands in workspace name', async () => {
      const state = 'test-state-456';
      await env.DB.prepare('INSERT INTO oauth_states (state) VALUES (?)').bind(state).run();

      const originalFetch = global.fetch;
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'test-token', scope: 'read' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              organization: {
                id: 'org-123',
                name: 'Acme & Co',
              },
            },
          }),
        });

      const mockEnv = {
        ...env,
        LINEAR_CLIENT_ID: 'test-client-id',
        LINEAR_CLIENT_SECRET: 'test-client-secret',
      };

      const request = createRequest(`/oauth/callback?code=test-code&state=${state}`);
      const response = await app.fetch(request, mockEnv);
      const html = await response.text();

      expect(html).toContain('Acme &amp; Co');

      global.fetch = originalFetch;
    });
  });

  describe('CSRF Protection (State Parameter)', () => {
    it('should reject callback without state parameter', async () => {
      const mockEnv = {
        ...env,
        LINEAR_CLIENT_ID: 'test-client-id',
        LINEAR_CLIENT_SECRET: 'test-client-secret',
      };

      const request = createRequest('/oauth/callback?code=test-code');
      const response = await app.fetch(request, mockEnv);

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain('Missing required parameters');
    });

    it('should reject callback with invalid state', async () => {
      const mockEnv = {
        ...env,
        LINEAR_CLIENT_ID: 'test-client-id',
        LINEAR_CLIENT_SECRET: 'test-client-secret',
      };

      const request = createRequest('/oauth/callback?code=test-code&state=invalid-state');
      const response = await app.fetch(request, mockEnv);

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain('expired or is invalid');
    });

    it('should reject reused state (one-time use)', async () => {
      const state = 'one-time-state';
      await env.DB.prepare('INSERT INTO oauth_states (state) VALUES (?)').bind(state).run();

      const originalFetch = global.fetch;
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'test-token', scope: 'read' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              organization: { id: 'org-123', name: 'Test Org' },
            },
          }),
        });

      const mockEnv = {
        ...env,
        LINEAR_CLIENT_ID: 'test-client-id',
        LINEAR_CLIENT_SECRET: 'test-client-secret',
      };

      // First request should succeed
      const request1 = createRequest(`/oauth/callback?code=test-code&state=${state}`);
      const response1 = await app.fetch(request1, mockEnv);
      expect(response1.status).toBe(200);

      // Second request with same state should fail
      const request2 = createRequest(`/oauth/callback?code=test-code&state=${state}`);
      const response2 = await app.fetch(request2, mockEnv);
      expect(response2.status).toBe(400);
      const html = await response2.text();
      expect(html).toContain('expired or is invalid');

      global.fetch = originalFetch;
    });

    it('should accept valid state and delete it after use', async () => {
      const state = 'valid-state-123';
      await env.DB.prepare('INSERT INTO oauth_states (state) VALUES (?)').bind(state).run();

      // Verify state exists before
      const beforeState = await env.DB.prepare(
        'SELECT state FROM oauth_states WHERE state = ?'
      ).bind(state).first();
      expect(beforeState).toBeDefined();

      const originalFetch = global.fetch;
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'test-token', scope: 'read' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              organization: { id: 'org-123', name: 'Test Org' },
            },
          }),
        });

      const mockEnv = {
        ...env,
        LINEAR_CLIENT_ID: 'test-client-id',
        LINEAR_CLIENT_SECRET: 'test-client-secret',
      };

      const request = createRequest(`/oauth/callback?code=test-code&state=${state}`);
      const response = await app.fetch(request, mockEnv);
      expect(response.status).toBe(200);

      // Verify state is deleted after use
      const afterState = await env.DB.prepare(
        'SELECT state FROM oauth_states WHERE state = ?'
      ).bind(state).first();
      expect(afterState).toBeNull();

      global.fetch = originalFetch;
    });
  });

  describe('Error Information Disclosure', () => {
    it('should not expose OAuth error details to user', async () => {
      const state = 'test-state-err';
      await env.DB.prepare('INSERT INTO oauth_states (state) VALUES (?)').bind(state).run();

      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        text: async () => '{"error":"invalid_grant","error_description":"Code expired"}',
      });

      const mockEnv = {
        ...env,
        LINEAR_CLIENT_ID: 'test-client-id',
        LINEAR_CLIENT_SECRET: 'test-client-secret',
      };

      const request = createRequest(`/oauth/callback?code=expired-code&state=${state}`);
      const response = await app.fetch(request, mockEnv);

      expect(response.status).toBe(400);
      const html = await response.text();

      // Should NOT contain detailed error info
      expect(html).not.toContain('invalid_grant');
      expect(html).not.toContain('Code expired');
      expect(html).not.toContain('error_description');

      // Should contain generic message
      expect(html).toContain('Authorization Failed');
      expect(html).toContain('Please try again');

      global.fetch = originalFetch;
    });

    it('should handle Linear error parameter gracefully', async () => {
      const mockEnv = {
        ...env,
        LINEAR_CLIENT_ID: 'test-client-id',
        LINEAR_CLIENT_SECRET: 'test-client-secret',
      };

      const request = createRequest('/oauth/callback?error=access_denied&error_description=User%20denied');
      const response = await app.fetch(request, mockEnv);

      expect(response.status).toBe(400);
      const html = await response.text();

      // Should NOT contain error details
      expect(html).not.toContain('access_denied');
      expect(html).not.toContain('User denied');

      // Should contain generic message
      expect(html).toContain('Authorization Failed');
    });
  });

  describe('OAuth Authorize Endpoint', () => {
    it('should create state and redirect to Linear', async () => {
      const mockEnv = {
        ...env,
        LINEAR_CLIENT_ID: 'test-client-id',
        LINEAR_CLIENT_SECRET: 'test-client-secret',
      };

      const request = createRequest('/oauth/authorize');
      const response = await app.fetch(request, mockEnv);

      // Should redirect
      expect(response.status).toBe(302);

      const location = response.headers.get('Location');
      expect(location).toContain('linear.app/oauth/authorize');
      expect(location).toContain('client_id=test-client-id');
      expect(location).toContain('state=');
      expect(location).toContain('response_type=code');

      // Should have stored state in database
      const states = await env.DB.prepare('SELECT COUNT(*) as count FROM oauth_states').first<{ count: number }>();
      expect(states?.count).toBeGreaterThan(0);
    });

    it('should generate unique state for each request', async () => {
      const mockEnv = {
        ...env,
        LINEAR_CLIENT_ID: 'test-client-id',
        LINEAR_CLIENT_SECRET: 'test-client-secret',
      };

      const response1 = await app.fetch(createRequest('/oauth/authorize'), mockEnv);
      const response2 = await app.fetch(createRequest('/oauth/authorize'), mockEnv);

      const location1 = response1.headers.get('Location') || '';
      const location2 = response2.headers.get('Location') || '';

      const state1 = new URL(location1).searchParams.get('state');
      const state2 = new URL(location2).searchParams.get('state');

      expect(state1).not.toBe(state2);
    });
  });
});
