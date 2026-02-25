import jwt from "jsonwebtoken";
import prisma, { PrismaClient } from "../lib/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  ConnectivityStatusType,
  GitHubAppSettingResponse,
  GitHubAppPackage,
  GitHubAppPackageVersion,
  GitHubAppRepository,
  GitHubAppActionsRun,
} from "@mini-infra/types";
import { ConfigurationService } from "./configuration-base";
import { servicesLogger } from "../lib/logger-factory";
import { CircuitBreaker, ErrorMapper } from "./circuit-breaker";
import { RegistryCredentialService } from "./registry-credential";

// ====================
// Constants
// ====================

const GITHUB_API_BASE = "https://api.github.com";
const TIMEOUT_MS = 15000;

// ====================
// Error Mappers
// ====================

/**
 * GitHub App-specific error mappers for the circuit breaker.
 */
const GITHUB_APP_ERROR_MAPPERS: ErrorMapper[] = [
  {
    pattern: /Bad credentials|Unauthorized|401/,
    errorCode: "AUTH_ERROR",
    connectivityStatus: "failed",
    isRetriable: false,
  },
  {
    pattern: /Forbidden|403/,
    errorCode: "FORBIDDEN",
    connectivityStatus: "failed",
    isRetriable: false,
  },
  {
    pattern: /Not Found|404/,
    errorCode: "NOT_FOUND",
    connectivityStatus: "failed",
    isRetriable: false,
  },
  {
    pattern: /rate limit|429/,
    errorCode: "RATE_LIMITED",
    connectivityStatus: "failed",
    isRetriable: true,
  },
  {
    pattern: /timeout|ETIMEDOUT/,
    errorCode: "TIMEOUT",
    connectivityStatus: "unreachable",
    isRetriable: true,
  },
  {
    pattern: /ENOTFOUND|ECONNREFUSED|ECONNRESET|network/i,
    errorCode: "NETWORK_ERROR",
    connectivityStatus: "unreachable",
    isRetriable: true,
  },
];

// ====================
// Setting Keys
// ====================

const SETTING_KEYS = {
  APP_ID: "app_id",
  PRIVATE_KEY: "private_key",
  INSTALLATION_ID: "installation_id",
  WEBHOOK_SECRET: "webhook_secret",
  APP_SLUG: "app_slug",
  OWNER: "owner",
  OWNER_TYPE: "owner_type",
  PERMISSIONS: "permissions",
  CLIENT_ID: "client_id",
  CLIENT_SECRET: "client_secret",
} as const;

/**
 * All setting keys for iteration during removal.
 */
const ALL_SETTING_KEYS = Object.values(SETTING_KEYS);

// ====================
// GitHub App Service
// ====================

/**
 * GitHubAppService manages GitHub App integration via the manifest flow.
 *
 * This service handles:
 * - GitHub App manifest-based registration
 * - JWT generation for App authentication
 * - Installation token generation for API access
 * - GHCR registry credential management
 * - Package, repository, and actions run listing
 *
 * Extends ConfigurationService for persistent settings storage
 * and implements circuit breaker pattern for resilient API communication.
 */
export class GitHubAppService extends ConfigurationService {
  private circuitBreaker: CircuitBreaker;

  constructor(prisma: PrismaClient) {
    super(prisma, "github-app");

    this.circuitBreaker = new CircuitBreaker({
      serviceName: "GitHubApp",
      failureThreshold: 5,
      cooldownPeriodMs: 5 * 60 * 1000,
      dedupWindowMs: 1000,
      errorMappers: GITHUB_APP_ERROR_MAPPERS,
      defaultErrorCode: "GITHUB_APP_API_ERROR",
      tokenRedactPatterns: [
        /ghs_[a-zA-Z0-9]{36,}/g, // installation tokens
        /v[0-9]\.[0-9a-f]{40}/g, // GitHub App JWTs (rough match)
      ],
      sensitiveKeys: [
        "private_key",
        "privateKey",
        "webhook_secret",
        "webhookSecret",
        "client_secret",
        "clientSecret",
        "token",
        "secret",
        "password",
        "pem",
      ],
    });
  }

  // ====================
  // Manifest Flow
  // ====================

  /**
   * Generate a GitHub App manifest for the manifest flow registration.
   * This manifest is POSTed to GitHub to create a new GitHub App.
   *
   * @param callbackUrl - The URL GitHub should redirect to after app creation
   * @returns The manifest object to be POSTed to GitHub
   */
  generateManifest(callbackUrl: string): object {
    const randomSuffix = Math.random().toString(36).substring(2, 8);

    return {
      name: `mini-infra-${randomSuffix}`,
      url: callbackUrl,
      callback_urls: [callbackUrl],
      redirect_url: callbackUrl,
      public: false,
      default_events: [],
      default_permissions: {
        packages: "read",
        actions: "read",
        contents: "read",
        metadata: "read",
      },
    };
  }

  /**
   * Complete the GitHub App manifest flow by exchanging the temporary code
   * for the App credentials, then discover installations and set up GHCR.
   *
   * @param code - Temporary code from GitHub's redirect after manifest creation
   * @param userId - The user performing the setup (for audit trails)
   * @returns Object containing the app slug and owner
   */
  async completeSetup(
    code: string,
    userId: string,
  ): Promise<{ appSlug: string; owner: string }> {
    servicesLogger().info("Starting GitHub App manifest code exchange");

    // Step 1: Exchange the code for app credentials
    const conversionResponse = await this.fetchGitHub(
      `${GITHUB_API_BASE}/app-manifests/${code}/conversions`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (!conversionResponse.ok) {
      const errorBody = await conversionResponse.text();
      throw new Error(
        `GitHub App manifest conversion failed (${conversionResponse.status}): ${errorBody}`,
      );
    }

    const appData = await conversionResponse.json();

    servicesLogger().info(
      { appSlug: appData.slug, appId: appData.id },
      "GitHub App created from manifest",
    );

    // Step 2: Store all credentials
    const ownerLogin = appData.owner?.login || "";
    const ownerType = appData.owner?.type || "User";

    await Promise.all([
      this.set(SETTING_KEYS.APP_ID, String(appData.id), userId),
      this.set(SETTING_KEYS.PRIVATE_KEY, appData.pem, userId),
      this.set(
        SETTING_KEYS.WEBHOOK_SECRET,
        appData.webhook_secret || "",
        userId,
      ),
      this.set(SETTING_KEYS.APP_SLUG, appData.slug, userId),
      this.set(SETTING_KEYS.OWNER, ownerLogin, userId),
      this.set(SETTING_KEYS.OWNER_TYPE, ownerType, userId),
      this.set(SETTING_KEYS.CLIENT_ID, appData.client_id || "", userId),
      this.set(SETTING_KEYS.CLIENT_SECRET, appData.client_secret || "", userId),
    ]);

    // Step 3: Find and store installation ID
    try {
      const appJwt = this.generateJWT(String(appData.id), appData.pem);

      const installationsResponse = await this.fetchGitHub(
        `${GITHUB_API_BASE}/app/installations`,
        {
          method: "GET",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${appJwt}`,
          },
        },
      );

      if (installationsResponse.ok) {
        const installations = await installationsResponse.json();
        if (installations.length > 0) {
          const installationId = String(installations[0].id);
          await this.set(SETTING_KEYS.INSTALLATION_ID, installationId, userId);

          // Store permissions from the installation
          const permissions = installations[0].permissions || {};
          await this.set(
            SETTING_KEYS.PERMISSIONS,
            JSON.stringify(permissions),
            userId,
          );

          servicesLogger().info(
            { installationId, permissionCount: Object.keys(permissions).length },
            "GitHub App installation found and stored",
          );
        } else {
          servicesLogger().warn(
            "No installations found for newly created GitHub App",
          );
        }
      } else {
        servicesLogger().warn(
          { status: installationsResponse.status },
          "Failed to fetch installations after app creation",
        );
      }
    } catch (installError) {
      servicesLogger().error(
        {
          error:
            installError instanceof Error
              ? installError.message
              : String(installError),
        },
        "Error finding installations, continuing setup",
      );
    }

    // Step 4: Auto-create GHCR registry credential
    try {
      await this.createOrUpdateGhcrCredential(userId);
    } catch (ghcrError) {
      servicesLogger().warn(
        {
          error:
            ghcrError instanceof Error
              ? ghcrError.message
              : String(ghcrError),
        },
        "Failed to auto-create GHCR credential, can be done manually later",
      );
    }

    return {
      appSlug: appData.slug,
      owner: ownerLogin,
    };
  }

  // ====================
  // JWT & Token Generation
  // ====================

  /**
   * Generate a JWT for GitHub App authentication.
   * The JWT is signed with the App's private key using RS256.
   *
   * @param appId - Optional app ID override (used during setup before settings are stored)
   * @param privateKey - Optional private key override (used during setup)
   * @returns Signed JWT string
   */
  generateJWT(appId?: string, privateKey?: string): string {
    const issuer = appId;
    const key = privateKey;

    if (!issuer || !key) {
      throw new Error(
        "GitHub App is not configured: missing app_id or private_key",
      );
    }

    const now = Math.floor(Date.now() / 1000);

    const payload = {
      iss: issuer,
      iat: now - 60, // Issued 60 seconds in the past to account for clock drift
      exp: now + 600, // Expires in 10 minutes (GitHub maximum)
    };

    return jwt.sign(payload, key, { algorithm: "RS256" });
  }

  /**
   * Generate a JWT using stored credentials.
   * Convenience wrapper around generateJWT that loads settings from the database.
   *
   * @returns Signed JWT string
   */
  async generateStoredJWT(): Promise<string> {
    const appId = await this.get(SETTING_KEYS.APP_ID);
    const privateKey = await this.get(SETTING_KEYS.PRIVATE_KEY);

    if (!appId || !privateKey) {
      throw new Error(
        "GitHub App is not configured: missing app_id or private_key",
      );
    }

    return this.generateJWT(appId, privateKey);
  }

  /**
   * Generate an installation access token for GitHub API calls.
   * Installation tokens have the permissions granted to the App
   * and are scoped to the specific installation.
   *
   * @returns Object containing the token and its expiry time
   */
  async generateInstallationToken(): Promise<{
    token: string;
    expiresAt: string;
  }> {
    const installationId = await this.get(SETTING_KEYS.INSTALLATION_ID);

    if (!installationId) {
      throw new Error(
        "GitHub App is not configured: missing installation_id",
      );
    }

    const appJwt = await this.generateStoredJWT();

    const response = await this.fetchGitHub(
      `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${appJwt}`,
        },
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Failed to generate installation token (${response.status}): ${errorBody}`,
      );
    }

    const data = await response.json();

    servicesLogger().debug(
      { expiresAt: data.expires_at },
      "Generated GitHub App installation token",
    );

    return {
      token: data.token,
      expiresAt: data.expires_at,
    };
  }

  // ====================
  // Validation
  // ====================

  /**
   * Validate GitHub App configuration by testing API connectivity.
   * Generates a JWT, obtains an installation token, then lists repositories.
   * Implements circuit breaker pattern and request deduplication.
   *
   * @param settings - Optional settings override (not used for App auth)
   * @returns ValidationResult with connectivity status and details
   */
  async validate(settings?: Record<string, string>): Promise<ValidationResult> {
    return this.circuitBreaker.validateWithDedup(
      (startTime, s) => this.performValidation(startTime, s),
      settings,
    );
  }

  /**
   * Perform the actual validation logic.
   */
  private async performValidation(
    startTime: number,
    _settings?: Record<string, string>,
  ): Promise<ValidationResult> {
    try {
      const appId = await this.get(SETTING_KEYS.APP_ID);
      const privateKey = await this.get(SETTING_KEYS.PRIVATE_KEY);
      const installationId = await this.get(SETTING_KEYS.INSTALLATION_ID);

      servicesLogger().debug(
        {
          hasAppId: !!appId,
          hasPrivateKey: !!privateKey,
          hasInstallationId: !!installationId,
          circuitState: this.circuitBreaker.state,
        },
        "Starting GitHub App validation",
      );

      if (!appId || !privateKey) {
        const result: ValidationResult = {
          isValid: false,
          message: "GitHub App not configured: missing app_id or private_key",
          errorCode: "NOT_CONFIGURED",
          responseTimeMs: Date.now() - startTime,
        };

        await this.recordConnectivityStatus(
          "failed",
          result.responseTimeMs,
          result.message,
          result.errorCode,
        );

        return result;
      }

      if (!installationId) {
        const result: ValidationResult = {
          isValid: false,
          message:
            "GitHub App not configured: missing installation_id",
          errorCode: "NOT_CONFIGURED",
          responseTimeMs: Date.now() - startTime,
        };

        await this.recordConnectivityStatus(
          "failed",
          result.responseTimeMs,
          result.message,
          result.errorCode,
        );

        return result;
      }

      // Generate installation token to verify everything works end-to-end
      const { token } = await this.generateInstallationToken();

      // Test with a lightweight API call
      const repoResponse = await this.fetchGitHub(
        `${GITHUB_API_BASE}/installation/repositories?per_page=1`,
        {
          method: "GET",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
          },
        },
      );

      if (!repoResponse.ok) {
        const errorBody = await repoResponse.text();
        throw new Error(
          `GitHub App API test failed (${repoResponse.status}): ${errorBody}`,
        );
      }

      const repoData = await repoResponse.json();
      const responseTime = Date.now() - startTime;

      const appSlug = await this.get(SETTING_KEYS.APP_SLUG);

      const metadata: Record<string, any> = {
        appSlug,
        appId,
        installationId,
        totalRepositories: repoData.total_count,
      };

      this.circuitBreaker.recordSuccess();

      const result: ValidationResult = {
        isValid: true,
        message: `GitHub App connected (${appSlug || appId}), ${repoData.total_count} repositories accessible`,
        responseTimeMs: responseTime,
        metadata,
      };

      await this.recordConnectivityStatus(
        "connected",
        responseTime,
        result.message,
      );

      servicesLogger().info(
        {
          responseTime,
          appSlug,
          totalRepositories: repoData.total_count,
        },
        "GitHub App validation successful",
      );

      return result;
    } catch (error) {
      const { errorCode, connectivityStatus, isRetriable } =
        this.circuitBreaker.parseError(error);

      const responseTime = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.circuitBreaker.recordFailure(errorCode);

      const result: ValidationResult = {
        isValid: false,
        message: `GitHub App validation failed: ${errorMessage}`,
        errorCode,
        responseTimeMs: responseTime,
      };

      await this.recordConnectivityStatus(
        connectivityStatus,
        responseTime,
        result.message,
        errorCode,
      );

      servicesLogger().error(
        this.circuitBreaker.redact({
          error: errorMessage,
          errorCode,
          connectivityStatus,
          isRetriable,
          responseTime,
          circuitState: this.circuitBreaker.state,
          consecutiveFailures: this.circuitBreaker.consecutiveFailures,
        }),
        "GitHub App validation failed",
      );

      return result;
    }
  }

  // ====================
  // Resource Methods
  // ====================

  /**
   * List container packages accessible to the GitHub App installation.
   * Routes to user or org endpoint based on owner_type.
   *
   * @returns Array of package metadata
   */
  async listPackages(): Promise<GitHubAppPackage[]> {
    const { token } = await this.generateInstallationToken();
    const owner = await this.get(SETTING_KEYS.OWNER);
    const ownerType = await this.get(SETTING_KEYS.OWNER_TYPE);

    if (!owner) {
      throw new Error("GitHub App owner not configured");
    }

    // Installation tokens must use /users/{username}/packages (not /user/packages
    // which is for PAT/OAuth user tokens)
    const endpoint =
      ownerType === "Organization"
        ? `${GITHUB_API_BASE}/orgs/${owner}/packages?package_type=docker`
        : `${GITHUB_API_BASE}/users/${owner}/packages?package_type=docker`;

    const response = await this.fetchGitHub(endpoint, {
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
    const { token } = await this.generateInstallationToken();
    const owner = await this.get(SETTING_KEYS.OWNER);
    const ownerType = await this.get(SETTING_KEYS.OWNER_TYPE);

    if (!owner) {
      throw new Error("GitHub App owner not configured");
    }

    const endpoint =
      ownerType === "Organization"
        ? `${GITHUB_API_BASE}/orgs/${owner}/packages/container/${encodeURIComponent(packageName)}/versions`
        : `${GITHUB_API_BASE}/users/${owner}/packages/container/${encodeURIComponent(packageName)}/versions`;

    const response = await this.fetchGitHub(endpoint, {
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
    const { token } = await this.generateInstallationToken();

    const response = await this.fetchGitHub(
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
    const { token } = await this.generateInstallationToken();

    const response = await this.fetchGitHub(
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

  // ====================
  // GHCR Credential Management
  // ====================

  /**
   * Create or update a GHCR (GitHub Container Registry) credential.
   * Uses the installation token as the password with username "x-access-token".
   *
   * @param userId - The user performing the operation (for audit trails)
   */
  async createOrUpdateGhcrCredential(userId: string): Promise<void> {
    const { token, expiresAt } = await this.generateInstallationToken();

    const registryCredentialService = new RegistryCredentialService(this.prisma);

    // Check if any GHCR credential already exists (by registryUrl, regardless of name)
    const existingCredentials =
      await registryCredentialService.getAllCredentials();
    const existingGhcr = existingCredentials.find(
      (c) => c.registryUrl === "ghcr.io",
    );

    if (existingGhcr) {
      // Update existing credential with new token
      await registryCredentialService.updateCredential(
        existingGhcr.id,
        {
          username: "x-access-token",
          password: token,
          description: `Auto-managed by GitHub App. Token expires at ${expiresAt}`,
        },
        userId,
      );

      servicesLogger().info(
        { credentialId: existingGhcr.id, expiresAt },
        "Updated GHCR credential with new installation token",
      );
    } else {
      // Create new GHCR credential
      const credential = await registryCredentialService.createCredential(
        {
          name: "GitHub App (auto-managed)",
          registryUrl: "ghcr.io",
          username: "x-access-token",
          password: token,
          description: `Auto-managed by GitHub App. Token expires at ${expiresAt}`,
          isDefault: false,
        },
        userId,
      );

      servicesLogger().info(
        { credentialId: credential.id, expiresAt },
        "Created GHCR credential from GitHub App installation token",
      );
    }
  }

  // ====================
  // Installation Management
  // ====================

  /**
   * Re-check GitHub for app installations. Called after the user installs
   * the app on their account/org via the GitHub UI.
   *
   * @param userId - The user performing the refresh (for audit trails)
   * @returns Whether an installation was found and stored
   */
  async refreshInstallation(userId: string): Promise<{ found: boolean; installationId?: string }> {
    const appId = await this.get(SETTING_KEYS.APP_ID);
    const privateKey = await this.get(SETTING_KEYS.PRIVATE_KEY);

    if (!appId || !privateKey) {
      throw new Error("GitHub App not configured - missing app ID or private key");
    }

    const appJwt = this.generateJWT(appId, privateKey);

    const installationsResponse = await this.fetchGitHub(
      `${GITHUB_API_BASE}/app/installations`,
      {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${appJwt}`,
        },
      },
    );

    if (!installationsResponse.ok) {
      throw new Error(`Failed to fetch installations (${installationsResponse.status})`);
    }

    const installations = await installationsResponse.json();
    if (installations.length === 0) {
      return { found: false };
    }

    const installationId = String(installations[0].id);
    await this.set(SETTING_KEYS.INSTALLATION_ID, installationId, userId);

    const permissions = installations[0].permissions || {};
    await this.set(SETTING_KEYS.PERMISSIONS, JSON.stringify(permissions), userId);

    servicesLogger().info(
      { installationId, permissionCount: Object.keys(permissions).length },
      "GitHub App installation found and stored via refresh",
    );

    // Now that we have an installation, auto-create GHCR credential
    try {
      await this.createOrUpdateGhcrCredential(userId);
    } catch (ghcrError) {
      servicesLogger().warn(
        { error: ghcrError instanceof Error ? ghcrError.message : String(ghcrError) },
        "Failed to auto-create GHCR credential after installation refresh",
      );
    }

    return { found: true, installationId };
  }

  // ====================
  // Config Status
  // ====================

  /**
   * Get the current configuration status of the GitHub App.
   * Returns non-sensitive information suitable for API responses.
   *
   * @returns Configuration status with basic info (no secrets)
   */
  async getConfigStatus(): Promise<GitHubAppSettingResponse> {
    const appId = await this.get(SETTING_KEYS.APP_ID);
    const appSlug = await this.get(SETTING_KEYS.APP_SLUG);
    const owner = await this.get(SETTING_KEYS.OWNER);
    const installationId = await this.get(SETTING_KEYS.INSTALLATION_ID);
    const permissionsJson = await this.get(SETTING_KEYS.PERMISSIONS);

    let permissions: string[] | null = null;
    if (permissionsJson) {
      try {
        const parsed = JSON.parse(permissionsJson);
        permissions = Object.keys(parsed);
      } catch {
        permissions = null;
      }
    }

    const isConfigured = !!appId && !!installationId;
    const needsInstallation = !!appId && !installationId;
    const installUrl = needsInstallation && appSlug
      ? `https://github.com/apps/${appSlug}/installations/new`
      : null;

    return {
      isConfigured,
      needsInstallation,
      installUrl,
      appSlug: appSlug || null,
      appId: appId || null,
      owner: owner || null,
      installationId: installationId || null,
      permissions,
    };
  }

  // ====================
  // Health Status
  // ====================

  /**
   * Get health status of the GitHub App integration.
   *
   * @returns ServiceHealthStatus with current connectivity information
   */
  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const latestStatus = await this.getLatestConnectivityStatus();

    if (!latestStatus) {
      const validationResult = await this.validate();

      return {
        service: "github-app",
        status: validationResult.isValid ? "connected" : "failed",
        lastChecked: new Date(),
        responseTime: validationResult.responseTimeMs,
        errorMessage: validationResult.isValid
          ? undefined
          : validationResult.message,
        errorCode: validationResult.errorCode,
        metadata: validationResult.metadata,
      };
    }

    return {
      service: "github-app",
      status: latestStatus.status as ConnectivityStatusType,
      lastChecked: latestStatus.checkedAt,
      lastSuccessful: latestStatus.lastSuccessfulAt,
      responseTime: latestStatus.responseTimeMs || undefined,
      errorMessage: latestStatus.errorMessage || undefined,
      errorCode: latestStatus.errorCode || undefined,
      metadata: latestStatus.metadata
        ? JSON.parse(latestStatus.metadata)
        : undefined,
    };
  }

  // ====================
  // Configuration Removal
  // ====================

  /**
   * Remove all GitHub App configuration.
   * Deletes all stored settings. Does not remove GHCR credentials
   * as they may have been manually modified.
   *
   * @param userId - The user performing the removal (for audit trails)
   */
  async removeConfiguration(userId: string): Promise<void> {
    servicesLogger().info({ userId }, "Removing GitHub App configuration");

    const deletePromises = ALL_SETTING_KEYS.map(async (key) => {
      try {
        await this.delete(key, userId);
      } catch (error) {
        // Ignore errors for keys that don't exist
        servicesLogger().debug(
          { key },
          "Setting key not found during removal, skipping",
        );
      }
    });

    await Promise.all(deletePromises);

    // Reset circuit breaker since configuration is gone
    this.circuitBreaker.reset();

    servicesLogger().info("GitHub App configuration removed successfully");
  }

  // ====================
  // HTTP Helper
  // ====================

  /**
   * Fetch wrapper with timeout for GitHub API calls.
   * Uses Node.js native fetch with an AbortController timeout.
   *
   * @param url - The URL to fetch
   * @param options - Standard fetch RequestInit options
   * @returns The fetch Response
   */
  private async fetchGitHub(
    url: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "User-Agent": "mini-infra",
          ...options.headers,
        },
      });

      return response;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`GitHub API request timeout after ${TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// Export singleton instance
export const githubAppService = new GitHubAppService(prisma);
