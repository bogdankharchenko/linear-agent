/**
 * GitHub App service for authentication and API interactions
 */
export class GitHubAppService {
  private appId: string;
  private privateKey: string;
  private baseUrl = 'https://api.github.com';

  constructor(appId: string, privateKey: string) {
    this.appId = appId;
    this.privateKey = privateKey;
  }

  /**
   * Generate a JWT for authenticating as the GitHub App
   */
  private async generateJWT(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now - 60, // Issued 60 seconds ago
      exp: now + 600, // Expires in 10 minutes
      iss: this.appId,
    };

    const header = { alg: 'RS256', typ: 'JWT' };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));

    const signature = await this.signRS256(
      `${encodedHeader}.${encodedPayload}`,
      this.privateKey
    );

    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }

  /**
   * Sign data using RS256
   */
  private async signRS256(data: string, privateKey: string): Promise<string> {
    // Parse PEM to get the key data
    const pemContents = privateKey
      .replace(/-----BEGIN RSA PRIVATE KEY-----/, '')
      .replace(/-----END RSA PRIVATE KEY-----/, '')
      .replace(/-----BEGIN PRIVATE KEY-----/, '')
      .replace(/-----END PRIVATE KEY-----/, '')
      .replace(/\s/g, '');

    const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

    const key = await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const encoder = new TextEncoder();
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      encoder.encode(data)
    );

    return base64UrlEncode(
      String.fromCharCode(...new Uint8Array(signature))
    );
  }

  /**
   * Get an installation access token for a specific installation
   */
  async getInstallationToken(installationId: number): Promise<string> {
    const jwt = await this.generateJWT();

    const response = await fetch(
      `${this.baseUrl}/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'linear-code-agent',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to get installation token: ${response.status} - ${error}`
      );
    }

    const data = (await response.json()) as { token: string };
    return data.token;
  }

  /**
   * Check if the app is installed for a specific repository
   * Returns the installation ID if found, null otherwise
   */
  async getRepoInstallation(
    owner: string,
    repo: string
  ): Promise<number | null> {
    console.log(`Checking GitHub App installation for ${owner}/${repo}`);
    const jwt = await this.generateJWT();

    const response = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/installation`,
      {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'linear-code-agent',
        },
      }
    );

    if (response.status === 404) {
      console.log(`GitHub App not installed on ${owner}/${repo}`);
      return null;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`GitHub API error ${response.status} for ${owner}/${repo}:`, errorBody);
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = (await response.json()) as { id: number };
    return data.id;
  }

  /**
   * List branches for a repository
   */
  async listBranches(
    installationId: number,
    owner: string,
    repo: string
  ): Promise<string[]> {
    const token = await this.getInstallationToken(installationId);

    const response = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/branches`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'linear-code-agent',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = (await response.json()) as Array<{ name: string }>;
    return data.map((b) => b.name);
  }

  /**
   * Get the default branch for a repository
   */
  async getDefaultBranch(
    installationId: number,
    owner: string,
    repo: string
  ): Promise<string> {
    const token = await this.getInstallationToken(installationId);

    const response = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'linear-code-agent',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = (await response.json()) as { default_branch: string };
    return data.default_branch;
  }

  /**
   * Trigger a workflow dispatch event
   */
  async triggerWorkflow(
    installationId: number,
    owner: string,
    repo: string,
    workflowId: string,
    ref: string,
    inputs: Record<string, string>
  ): Promise<void> {
    const token = await this.getInstallationToken(installationId);

    const response = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'linear-code-agent',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref, inputs }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to trigger workflow: ${response.status} - ${error}`
      );
    }
  }

  /**
   * Cancel a workflow run
   */
  async cancelWorkflowRun(
    installationId: number,
    owner: string,
    repo: string,
    runId: number
  ): Promise<void> {
    const token = await this.getInstallationToken(installationId);

    const response = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/actions/runs/${runId}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'linear-code-agent',
        },
      }
    );

    // 202 = Accepted, 409 = Already cancelled/completed
    if (!response.ok && response.status !== 409) {
      throw new Error(`Failed to cancel workflow: ${response.status}`);
    }
  }

  /**
   * List pull requests for a branch
   */
  async listPullRequestsForBranch(
    installationId: number,
    owner: string,
    repo: string,
    branch: string
  ): Promise<Array<{ number: number; html_url: string }>> {
    const token = await this.getInstallationToken(installationId);

    const response = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'linear-code-agent',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    return (await response.json()) as Array<{
      number: number;
      html_url: string;
    }>;
  }

  /**
   * Search for open PRs by title pattern (e.g., ticket ID)
   */
  async searchPullRequestsByTitle(
    installationId: number,
    owner: string,
    repo: string,
    searchTerm: string
  ): Promise<Array<{ number: number; html_url: string; title: string }>> {
    const token = await this.getInstallationToken(installationId);

    const response = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/pulls?state=open&per_page=10`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'linear-code-agent',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const prs = (await response.json()) as Array<{
      number: number;
      html_url: string;
      title: string;
    }>;

    // Filter PRs that contain the search term in the title
    return prs.filter((pr) =>
      pr.title.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }

  /**
   * Check if a file exists in the repository
   */
  async fileExists(
    installationId: number,
    owner: string,
    repo: string,
    path: string,
    ref?: string
  ): Promise<boolean> {
    const token = await this.getInstallationToken(installationId);

    const url = new URL(
      `${this.baseUrl}/repos/${owner}/${repo}/contents/${path}`
    );
    if (ref) {
      url.searchParams.set('ref', ref);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    return response.ok;
  }

  /**
   * Get the app's public installation URL
   */
  getInstallUrl(appSlug: string): string {
    return `https://github.com/apps/${appSlug}/installations/new`;
  }
}

/**
 * Base64 URL encode a string (JWT-safe encoding)
 */
function base64UrlEncode(str: string): string {
  const base64 = btoa(str);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
