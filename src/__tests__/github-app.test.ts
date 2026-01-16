import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubAppService } from '../services/github-app';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('GitHubAppService', () => {
  let service: GitHubAppService;

  beforeEach(() => {
    mockFetch.mockReset();
    service = new GitHubAppService('12345', 'fake-private-key');

    // Mock the private generateJWT method to avoid actual crypto operations
    vi.spyOn(service as any, 'generateJWT').mockResolvedValue('mock-jwt-token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getInstallationToken', () => {
    it('should fetch installation token', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'ghs_installation_token_abc' }),
      });

      const token = await service.getInstallationToken(67890);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];

      expect(url).toBe('https://api.github.com/app/installations/67890/access_tokens');
      expect(options.method).toBe('POST');
      expect(options.headers.Authorization).toMatch(/^Bearer /);
      expect(options.headers['X-GitHub-Api-Version']).toBe('2022-11-28');

      expect(token).toBe('ghs_installation_token_abc');
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Installation not found',
      });

      await expect(service.getInstallationToken(99999)).rejects.toThrow(
        'Failed to get installation token: 404'
      );
    });
  });

  describe('getRepoInstallation', () => {
    it('should return installation ID for installed repo', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 12345 }),
      });

      const installationId = await service.getRepoInstallation('acme', 'backend');

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.github.com/repos/acme/backend/installation');

      expect(installationId).toBe(12345);
    });

    it('should return null for non-installed repo', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const installationId = await service.getRepoInstallation('acme', 'not-installed');
      expect(installationId).toBeNull();
    });

    it('should throw on other API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal server error',
      });

      await expect(service.getRepoInstallation('acme', 'backend')).rejects.toThrow(
        'GitHub API error: 500'
      );
    });
  });

  describe('listBranches', () => {
    it('should list branch names', async () => {
      // First call for installation token
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'ghs_token' }),
      });

      // Second call for branches
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { name: 'main' },
          { name: 'develop' },
          { name: 'agent/abc-123' },
        ],
      });

      const branches = await service.listBranches(12345, 'acme', 'backend');

      expect(branches).toEqual(['main', 'develop', 'agent/abc-123']);
    });
  });

  describe('getDefaultBranch', () => {
    it('should return the default branch name', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'ghs_token' }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ default_branch: 'main' }),
      });

      const branch = await service.getDefaultBranch(12345, 'acme', 'backend');
      expect(branch).toBe('main');
    });
  });

  describe('triggerWorkflow', () => {
    it('should trigger workflow dispatch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'ghs_token' }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
      });

      await service.triggerWorkflow(
        12345,
        'acme',
        'backend',
        'linear-agent.yml',
        'main',
        {
          ticket_id: 'ABC-123',
          ticket_title: 'Add feature',
        }
      );

      const [url, options] = mockFetch.mock.calls[1];

      expect(url).toBe(
        'https://api.github.com/repos/acme/backend/actions/workflows/linear-agent.yml/dispatches'
      );
      expect(options.method).toBe('POST');

      const body = JSON.parse(options.body);
      expect(body.ref).toBe('main');
      expect(body.inputs.ticket_id).toBe('ABC-123');
    });

    it('should throw on trigger failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'ghs_token' }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => 'Workflow not found',
      });

      await expect(
        service.triggerWorkflow(12345, 'acme', 'backend', 'missing.yml', 'main', {})
      ).rejects.toThrow('Failed to trigger workflow: 422');
    });
  });

  describe('cancelWorkflowRun', () => {
    it('should cancel a running workflow', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'ghs_token' }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 202,
      });

      await service.cancelWorkflowRun(12345, 'acme', 'backend', 987654);

      const [url, options] = mockFetch.mock.calls[1];
      expect(url).toBe(
        'https://api.github.com/repos/acme/backend/actions/runs/987654/cancel'
      );
      expect(options.method).toBe('POST');
    });

    it('should handle already completed workflow (409)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'ghs_token' }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
      });

      // Should not throw - 409 means already cancelled/completed
      await service.cancelWorkflowRun(12345, 'acme', 'backend', 987654);
    });
  });

  describe('listPullRequestsForBranch', () => {
    it('should list PRs for a branch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'ghs_token' }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { number: 42, html_url: 'https://github.com/acme/backend/pull/42' },
        ],
      });

      const prs = await service.listPullRequestsForBranch(
        12345,
        'acme',
        'backend',
        'agent/abc-123'
      );

      expect(prs).toHaveLength(1);
      expect(prs[0].number).toBe(42);

      const [url] = mockFetch.mock.calls[1];
      expect(url).toContain('head=acme:agent/abc-123');
      expect(url).toContain('state=open');
    });
  });

  describe('searchPullRequestsByTitle', () => {
    it('should search PRs by title containing term', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'ghs_token' }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { number: 41, html_url: 'url1', title: 'ABC-122: Other issue' },
          { number: 42, html_url: 'url2', title: 'ABC-123: Add feature' },
          { number: 43, html_url: 'url3', title: 'DEF-456: Different' },
        ],
      });

      const prs = await service.searchPullRequestsByTitle(
        12345,
        'acme',
        'backend',
        'ABC-123'
      );

      expect(prs).toHaveLength(1);
      expect(prs[0].number).toBe(42);
      expect(prs[0].title).toBe('ABC-123: Add feature');
    });

    it('should be case-insensitive', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'ghs_token' }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { number: 42, html_url: 'url', title: 'abc-123: lowercase' },
        ],
      });

      const prs = await service.searchPullRequestsByTitle(
        12345,
        'acme',
        'backend',
        'ABC-123'
      );

      expect(prs).toHaveLength(1);
    });
  });

  describe('fileExists', () => {
    it('should return true for existing file', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'ghs_token' }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
      });

      const exists = await service.fileExists(12345, 'acme', 'backend', 'CLAUDE.md');
      expect(exists).toBe(true);
    });

    it('should return false for missing file', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'ghs_token' }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const exists = await service.fileExists(12345, 'acme', 'backend', 'MISSING.md');
      expect(exists).toBe(false);
    });

    it('should check file on specific branch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'ghs_token' }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
      });

      await service.fileExists(12345, 'acme', 'backend', 'README.md', 'develop');

      const [url] = mockFetch.mock.calls[1];
      expect(url).toContain('ref=develop');
    });
  });

  describe('getInstallUrl', () => {
    it('should return correct installation URL', () => {
      const url = service.getInstallUrl('my-github-app');
      expect(url).toBe('https://github.com/apps/my-github-app/installations/new');
    });
  });
});
