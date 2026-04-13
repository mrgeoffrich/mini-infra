import {
  ValidationResult,
  ServiceHealthStatus,
  ConnectivityStatusType,
  GitHubAppSettingResponse,
  GitHubAgentAccessStatus,
} from "@mini-infra/types";
import { GITHUB_API_BASE, SETTING_KEYS, GitHubAppValidationContext } from "./github-app-constants";
import { GitHubAppAuth } from "./github-app-auth";
import { GitHubAppOAuth } from "./github-app-oauth";

/**
 * Handles GitHub App validation, health status checks,
 * and configuration status reporting.
 */
export class GitHubAppValidation {
  constructor(
    private ctx: GitHubAppValidationContext,
    private auth: GitHubAppAuth,
    private oauth: GitHubAppOAuth,
  ) {}

  /**
   * Validate GitHub App configuration by testing API connectivity.
   * Generates a JWT, obtains an installation token, then lists repositories.
   * Implements circuit breaker pattern and request deduplication.
   *
   * @param settings - Optional settings override (not used for App auth)
   * @returns ValidationResult with connectivity status and details
   */
  async validate(settings?: Record<string, string>): Promise<ValidationResult> {
    return this.ctx.circuitBreaker.validateWithDedup(
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
      const appId = await this.ctx.getSetting(SETTING_KEYS.APP_ID);
      const privateKey = await this.ctx.getSetting(SETTING_KEYS.PRIVATE_KEY);
      const installationId = await this.ctx.getSetting(SETTING_KEYS.INSTALLATION_ID);

      this.ctx.logger.debug(
        {
          hasAppId: !!appId,
          hasPrivateKey: !!privateKey,
          hasInstallationId: !!installationId,
          circuitState: this.ctx.circuitBreaker.state,
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

        await this.ctx.recordConnectivityStatus(
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

        await this.ctx.recordConnectivityStatus(
          "failed",
          result.responseTimeMs,
          result.message,
          result.errorCode,
        );

        return result;
      }

      // Generate installation token to verify everything works end-to-end
      const { token } = await this.auth.generateInstallationToken();

      // Test with a lightweight API call
      const repoResponse = await this.ctx.fetchGitHub(
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

      const appSlug = await this.ctx.getSetting(SETTING_KEYS.APP_SLUG);

      const metadata: Record<string, unknown> = {
        appSlug,
        appId,
        installationId,
        totalRepositories: repoData.total_count,
      };

      this.ctx.circuitBreaker.recordSuccess();

      const result: ValidationResult = {
        isValid: true,
        message: `GitHub App connected (${appSlug || appId}), ${repoData.total_count} repositories accessible`,
        responseTimeMs: responseTime,
        metadata,
      };

      await this.ctx.recordConnectivityStatus(
        "connected",
        responseTime,
        result.message,
      );

      this.ctx.logger.info(
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
        this.ctx.circuitBreaker.parseError(error);

      const responseTime = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.ctx.circuitBreaker.recordFailure(errorCode);

      const result: ValidationResult = {
        isValid: false,
        message: `GitHub App validation failed: ${errorMessage}`,
        errorCode,
        responseTimeMs: responseTime,
      };

      await this.ctx.recordConnectivityStatus(
        connectivityStatus,
        responseTime,
        result.message,
        errorCode,
      );

      this.ctx.logger.error(
        this.ctx.circuitBreaker.redact({
          error: errorMessage,
          errorCode,
          connectivityStatus,
          isRetriable,
          responseTime,
          circuitState: this.ctx.circuitBreaker.state,
          consecutiveFailures: this.ctx.circuitBreaker.consecutiveFailures,
        }),
        "GitHub App validation failed",
      );

      return result;
    }
  }

  /**
   * Get health status of the GitHub App integration.
   *
   * @returns ServiceHealthStatus with current connectivity information
   */
  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const latestStatus = await this.ctx.getLatestConnectivityStatus();

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

    const row = latestStatus as {
      status: string;
      checkedAt: Date;
      lastSuccessfulAt?: Date;
      responseTimeMs?: number;
      errorMessage?: string;
      errorCode?: string;
      metadata?: string;
    };
    return {
      service: "github-app",
      status: row.status as ConnectivityStatusType,
      lastChecked: row.checkedAt,
      lastSuccessful: row.lastSuccessfulAt,
      responseTime: row.responseTimeMs || undefined,
      errorMessage: row.errorMessage || undefined,
      errorCode: row.errorCode || undefined,
      metadata: row.metadata
        ? JSON.parse(row.metadata)
        : undefined,
    };
  }

  /**
   * Get the current configuration status of the GitHub App.
   * Returns non-sensitive information suitable for API responses.
   *
   * @param agentAccess - Agent access status (provided by the facade)
   * @returns Configuration status with basic info (no secrets)
   */
  async getConfigStatus(agentAccess: GitHubAgentAccessStatus): Promise<GitHubAppSettingResponse> {
    const appId = await this.ctx.getSetting(SETTING_KEYS.APP_ID);
    const appSlug = await this.ctx.getSetting(SETTING_KEYS.APP_SLUG);
    const owner = await this.ctx.getSetting(SETTING_KEYS.OWNER);
    const installationId = await this.ctx.getSetting(SETTING_KEYS.INSTALLATION_ID);
    const permissionsJson = await this.ctx.getSetting(SETTING_KEYS.PERMISSIONS);

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

    const oauthStatus = await this.oauth.getOAuthStatus();

    return {
      isConfigured,
      needsInstallation,
      installUrl,
      appSlug: appSlug || null,
      appId: appId || null,
      owner: owner || null,
      installationId: installationId || null,
      permissions,
      oauth: oauthStatus,
      agentAccess,
    };
  }
}
