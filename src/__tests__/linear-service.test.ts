import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LinearService, getOAuthToken } from '../services/linear';
import { env } from 'cloudflare:test';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('LinearService', () => {
  let service: LinearService;

  beforeEach(() => {
    mockFetch.mockReset();
    service = new LinearService('test-oauth-token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createAgentActivity', () => {
    it('should send a thought activity', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { agentActivityCreate: { success: true } },
        }),
      });

      await service.sendThought('session-123', 'Processing your request...');

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];

      expect(url).toBe('https://api.linear.app/graphql');
      expect(options.method).toBe('POST');
      expect(options.headers.Authorization).toBe('test-oauth-token');

      const body = JSON.parse(options.body);
      expect(body.variables.input.agentSessionId).toBe('session-123');
      expect(body.variables.input.content.type).toBe('thought');
      expect(body.variables.input.content.body).toBe('Processing your request...');
    });

    it('should send an action activity', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { agentActivityCreate: { success: true } },
        }),
      });

      await service.sendAction('session-123', 'Running', 'Claude Code', 'Success');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.variables.input.content.type).toBe('action');
      expect(body.variables.input.content.action).toBe('Running');
      expect(body.variables.input.content.parameter).toBe('Claude Code');
      expect(body.variables.input.content.result).toBe('Success');
    });

    it('should send an elicitation activity', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { agentActivityCreate: { success: true } },
        }),
      });

      await service.sendElicitation('session-123', 'Which repo should I use?');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.variables.input.content.type).toBe('elicitation');
      expect(body.variables.input.content.body).toBe('Which repo should I use?');
    });

    it('should send a response activity', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { agentActivityCreate: { success: true } },
        }),
      });

      await service.sendResponse('session-123', 'PR #42 created successfully!');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.variables.input.content.type).toBe('response');
      expect(body.variables.input.content.body).toBe('PR #42 created successfully!');
    });

    it('should send an error activity', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { agentActivityCreate: { success: true } },
        }),
      });

      await service.sendError('session-123', 'Workflow failed');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.variables.input.content.type).toBe('error');
      expect(body.variables.input.content.body).toBe('Workflow failed');
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      await expect(service.sendThought('session-123', 'test')).rejects.toThrow(
        'Linear API error: 401'
      );
    });

    it('should throw on GraphQL error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          errors: [{ message: 'Invalid session ID' }],
        }),
      });

      await expect(service.sendThought('session-123', 'test')).rejects.toThrow(
        'Linear GraphQL error: Invalid session ID'
      );
    });
  });

  describe('getIssueContext', () => {
    it('should fetch full issue context', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            issue: {
              identifier: 'ABC-123',
              title: 'Add login feature',
              description: 'Users should be able to login',
              comments: {
                nodes: [
                  {
                    id: 'comment-1',
                    body: 'Please also add SSO',
                    user: { name: 'John Doe' },
                    createdAt: '2024-01-15T10:00:00Z',
                  },
                ],
              },
              relations: {
                nodes: [
                  {
                    type: 'blocks',
                    relatedIssue: {
                      identifier: 'ABC-124',
                      title: 'Dashboard feature',
                    },
                  },
                ],
              },
              parent: {
                identifier: 'ABC-100',
                title: 'Epic: Authentication',
              },
              attachments: {
                nodes: [
                  {
                    title: 'Design mockup',
                    url: 'https://figma.com/file/abc',
                  },
                ],
              },
            },
          },
        }),
      });

      const context = await service.getIssueContext('issue-id-123');

      expect(context.identifier).toBe('ABC-123');
      expect(context.title).toBe('Add login feature');
      expect(context.description).toBe('Users should be able to login');

      expect(context.comments).toHaveLength(1);
      expect(context.comments[0].author).toBe('John Doe');
      expect(context.comments[0].body).toBe('Please also add SSO');

      expect(context.linkedIssues).toHaveLength(1);
      expect(context.linkedIssues[0].identifier).toBe('ABC-124');
      expect(context.linkedIssues[0].relation).toBe('blocks');

      expect(context.parentIssue).toBeDefined();
      expect(context.parentIssue?.identifier).toBe('ABC-100');

      expect(context.attachments).toHaveLength(1);
      expect(context.attachments[0].url).toBe('https://figma.com/file/abc');
    });

    it('should handle issue without parent', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            issue: {
              identifier: 'ABC-123',
              title: 'Standalone issue',
              description: null,
              comments: { nodes: [] },
              relations: { nodes: [] },
              parent: null,
              attachments: { nodes: [] },
            },
          },
        }),
      });

      const context = await service.getIssueContext('issue-id');

      expect(context.parentIssue).toBeNull();
      expect(context.description).toBeNull();
      expect(context.comments).toHaveLength(0);
    });

    it('should handle comments without user', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            issue: {
              identifier: 'ABC-123',
              title: 'Test',
              description: null,
              comments: {
                nodes: [
                  {
                    id: 'comment-1',
                    body: 'Automated comment',
                    user: null,
                    createdAt: '2024-01-15T10:00:00Z',
                  },
                ],
              },
              relations: { nodes: [] },
              parent: null,
              attachments: { nodes: [] },
            },
          },
        }),
      });

      const context = await service.getIssueContext('issue-id');

      expect(context.comments[0].author).toBe('Unknown');
    });
  });

  describe('createAttachment', () => {
    it('should create an attachment linking PR to issue', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { attachmentCreate: { success: true } },
        }),
      });

      await service.createAttachment(
        'issue-123',
        'PR #42',
        'https://github.com/acme/repo/pull/42'
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.query).toContain('attachmentCreate');
      expect(body.variables.input.issueId).toBe('issue-123');
      expect(body.variables.input.title).toBe('PR #42');
      expect(body.variables.input.url).toBe('https://github.com/acme/repo/pull/42');
    });
  });
});

describe('getOAuthToken', () => {
  beforeEach(async () => {
    // Set up database using batch() - exec() only supports single statements
    await env.DB.batch([
      env.DB.prepare('DROP TABLE IF EXISTS oauth_tokens'),
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
  });

  it('should retrieve OAuth token for workspace', async () => {
    await env.DB.prepare(
      'INSERT INTO oauth_tokens (workspace_id, access_token) VALUES (?, ?)'
    ).bind('workspace-123', 'oauth-token-abc').run();

    const token = await getOAuthToken(env.DB, 'workspace-123');
    expect(token).toBe('oauth-token-abc');
  });

  it('should return null for non-existent workspace', async () => {
    const token = await getOAuthToken(env.DB, 'non-existent');
    expect(token).toBeNull();
  });
});
