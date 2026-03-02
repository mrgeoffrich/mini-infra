import {
  GitHubAppPackage,
  GitHubAppPackageVersion,
  GitHubAppRepository,
  GitHubAppActionsRun,
} from "@mini-infra/types";
import { GITHUB_API_BASE, SETTING_KEYS, GitHubAppContext } from "./github-app-constants";
import { GitHubAppAuth } from "./github-app-auth";
import { GitHubAppOAuth } from "./github-app-oauth";

/**
 * Handles listing GitHub resources: packages, package versions,
 * repositories, and GitHub Actions workflow runs.
 */
export class GitHubAppResources {
  constructor(
    private ctx: GitHubAppContext,
    private auth: GitHubAppAuth,
    private oauth: GitHubAppOAuth,
  ) {}

  /**
   * List container packages accessible to the GitHub App.
   * Uses OAuth user token (for GHCR container packages) if available,
   * falls back to installation token with docker type.
   *
   * @returns Array of package metadata
   */
  async listPackages(): Promise<GitHubAppPackage[]> {
    const owner = await this.ctx.getSetting(SETTING_KEYS.OWNER);
    const ownerType = await this.ctx.getSetting(SETTING_KEYS.OWNER_TYPE);

    if (!owner) {
      throw new Error("GitHub App owner not configured");
    }

    // Try user token (PAT or OAuth) first — only classic PATs with read:packages
    // scope can list GHCR container packages. GitHub App tokens (both installation
    // and OAuth user-to-server) cannot access package_type=container.
    const userToken = await this.oauth.getValidOAuthToken();
    if (userToken) {
      const endpoint =
        ownerType === "Organization"
          ? `${GITHUB_API_BASE}/orgs/${owner}/packages?package_type=container`
          : `${GITHUB_API_BASE}/users/${owner}/packages?package_type=container`;

      const response = await this.ctx.fetchGitHub(endpoint, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${userToken}`,
        },
      });

      if (response.ok) {
        const packages = await response.json();
        this.ctx.logger.debug(
          { count: packages.length, tokenType: "pat", endpoint },
          "Listed container packages via user token",
        );
        return this.mapPackages(packages, owner);
      }

      this.ctx.logger.warn(
        { status: response.status },
        "User token failed to list packages, falling back to installation token",
      );
    }

    // Fallback: installation token with package_type=docker (legacy Docker Hub type).
    // This works but only returns Docker Hub packages, not GHCR containers.
    const { token } = await this.auth.generateInstallationToken();
    const fallbackEndpoint =
      ownerType === "Organization"
        ? `${GITHUB_API_BASE}/orgs/${owner}/packages?package_type=docker`
        : `${GITHUB_API_BASE}/users/${owner}/packages?package_type=docker`;

    const response = await this.ctx.fetchGitHub(fallbackEndpoint, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Failed to list packages (${response.status}): ${errorBody}`,
      );
    }

    const packages = await response.json();
    this.ctx.logger.debug(
      { count: packages.length, tokenType: "installation" },
      "Listed packages via installation token (docker type only)",
    );
    return this.mapPackages(packages, owner);
  }

  private mapPackages(packages: any[], owner: string): GitHubAppPackage[] {
    return packages.map((pkg: any) => ({
      id: pkg.id,
      name: pkg.name,
      packageType: pkg.package_type,
      visibility: pkg.visibility,
      htmlUrl: pkg.html_url,
      createdAt: pkg.created_at,
      updatedAt: pkg.updated_at,
      owner: pkg.owner?.login || owner,
      repository: pkg.repository?.full_name || null,
    }));
  }

  /**
   * List versions for a specific container package.
   *
   * @param packageName - Name of the package
   * @returns Array of package version metadata
   */
  async listPackageVersions(
    packageName: string,
  ): Promise<GitHubAppPackageVersion[]> {
    const { token } = await this.auth.generateInstallationToken();
    const owner = await this.ctx.getSetting(SETTING_KEYS.OWNER);
    const ownerType = await this.ctx.getSetting(SETTING_KEYS.OWNER_TYPE);

    if (!owner) {
      throw new Error("GitHub App owner not configured");
    }

    const endpoint =
      ownerType === "Organization"
        ? `${GITHUB_API_BASE}/orgs/${owner}/packages/container/${encodeURIComponent(packageName)}/versions`
        : `${GITHUB_API_BASE}/users/${owner}/packages/container/${encodeURIComponent(packageName)}/versions`;

    const response = await this.ctx.fetchGitHub(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Failed to list package versions (${response.status}): ${errorBody}`,
      );
    }

    const versions = await response.json();

    return versions.map((v: any) => ({
      id: v.id,
      name: v.name,
      tags: v.metadata?.container?.tags || [],
      createdAt: v.created_at,
      updatedAt: v.updated_at,
      htmlUrl: v.html_url,
      metadata: v.metadata,
    }));
  }

  /**
   * List repositories accessible to the GitHub App installation.
   *
   * @returns Array of repository metadata
   */
  async listRepositories(): Promise<GitHubAppRepository[]> {
    const { token } = await this.auth.generateInstallationToken();

    const response = await this.ctx.fetchGitHub(
      `${GITHUB_API_BASE}/installation/repositories`,
      {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Failed to list repositories (${response.status}): ${errorBody}`,
      );
    }

    const data = await response.json();

    return (data.repositories || []).map((repo: any) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      description: repo.description,
      private: repo.private,
      htmlUrl: repo.html_url,
      language: repo.language,
      defaultBranch: repo.default_branch,
      updatedAt: repo.updated_at,
      pushedAt: repo.pushed_at,
      hasActions: repo.has_actions ?? true,
    }));
  }

  /**
   * List GitHub Actions workflow runs for a specific repository.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @returns Array of workflow run metadata
   */
  async listActionRuns(
    owner: string,
    repo: string,
  ): Promise<GitHubAppActionsRun[]> {
    const { token } = await this.auth.generateInstallationToken();

    const response = await this.ctx.fetchGitHub(
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs`,
      {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Failed to list action runs (${response.status}): ${errorBody}`,
      );
    }

    const data = await response.json();

    return (data.workflow_runs || []).map((run: any) => ({
      id: run.id,
      name: run.name || run.display_title,
      status: run.status,
      conclusion: run.conclusion,
      workflowName: run.name,
      headBranch: run.head_branch,
      headSha: run.head_sha,
      htmlUrl: run.html_url,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      runNumber: run.run_number,
      event: run.event,
    }));
  }
}
