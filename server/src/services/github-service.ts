import prisma, { PrismaClient } from "../lib/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  ConnectivityStatusType,
  CreateGitHubIssueRequest,
  GitHubIssue,
} from "@mini-infra/types";
import { ConfigurationService } from "./configuration-base";
import { toServiceError } from "../lib/service-error-mapper";
import { servicesLogger } from "../lib/logger-factory";
import { Octokit } from "@octokit/rest";
import { CircuitBreaker, ErrorMapper } from "./circuit-breaker";

/**
 * GitHub-specific error mappers for the circuit breaker.
 */
const GITHUB_ERROR_MAPPERS: ErrorMapper[] = [
  {
    pattern: /timeout|ETIMEDOUT/,
    errorCode: "TIMEOUT",
    connectivityStatus: "unreachable",
    isRetriable: true,
  },
  {
    pattern: /Bad credentials|Unauthorized|401/,
    errorCode: "INVALID_CREDENTIALS",
    connectivityStatus: "failed",
    isRetriable: false,
  },
  {
    pattern: /Not Found|404/,
    errorCode: "REPOSITORY_NOT_FOUND",
    connectivityStatus: "failed",
    isRetriable: false,
  },
  {
    pattern: /ENOTFOUND|ECONNREFUSED/,
    errorCode: "NETWORK_ERROR",
    connectivityStatus: "unreachable",
    isRetriable: true,
  },
  {
    pattern: /rate limit/,
    errorCode: "RATE_LIMITED",
    connectivityStatus: "failed",
    isRetriable: true,
  },
];

/**
 * GitHubService handles GitHub API configuration management
 * Extends the base ConfigurationService to provide GitHub-specific functionality
 * Implements circuit breaker pattern for resilient API communication
 */
export class GitHubService extends ConfigurationService {
  private static readonly TIMEOUT_MS = 10000; // 10 second timeout
  private static readonly PERSONAL_ACCESS_TOKEN_KEY = "personal_access_token";
  private static readonly REPO_OWNER_KEY = "repo_owner";
  private static readonly REPO_NAME_KEY = "repo_name";

  private circuitBreaker: CircuitBreaker;

  constructor(prisma: PrismaClient) {
    super(prisma, "github");

    this.circuitBreaker = new CircuitBreaker({
      serviceName: "GitHub",
      failureThreshold: 5,
      cooldownPeriodMs: 5 * 60 * 1000,
      dedupWindowMs: 1000,
      errorMappers: GITHUB_ERROR_MAPPERS,
      defaultErrorCode: "GITHUB_API_ERROR",
      tokenRedactPatterns: [/gh[a-z]_[a-zA-Z0-9]{36,}/g],
      sensitiveKeys: [
        "personalAccessToken",
        "personal_access_token",
        "token",
        "secret",
        "password",
        "key",
      ],
    });
  }

  /**
   * Validate GitHub API configuration by testing API connectivity
   * Implements circuit breaker pattern and request deduplication
   * @param settings - Optional settings to validate with (overrides stored settings)
   * @returns ValidationResult with connectivity status and details
   */
  async validate(settings?: Record<string, string>): Promise<ValidationResult> {
    return this.circuitBreaker.validateWithDedup(
      (startTime, s) => this.performValidation(startTime, s),
      settings,
    );
  }

  /**
   * Perform the actual validation logic
   * @param startTime The start time of the validation request
   * @param settings Optional settings to validate with (overrides stored settings)
   * @returns ValidationResult with connectivity status and details
   */
  private async performValidation(
    startTime: number,
    settings?: Record<string, string>,
  ): Promise<ValidationResult> {
    try {
      // Use provided settings or fallback to stored settings
      const personalAccessToken = settings?.personalAccessToken ||
        (await this.get(GitHubService.PERSONAL_ACCESS_TOKEN_KEY));
      const repoOwner = settings?.repoOwner ||
        (await this.get(GitHubService.REPO_OWNER_KEY));
      const repoName = settings?.repoName ||
        (await this.get(GitHubService.REPO_NAME_KEY));

      servicesLogger().debug(
        this.circuitBreaker.redact({
          hasToken: !!personalAccessToken,
          tokenLength: personalAccessToken?.length,
          repoOwner,
          repoName,
          circuitState: this.circuitBreaker.state,
        }),
        "Starting GitHub API validation",
      );

      if (!personalAccessToken) {
        const result: ValidationResult = {
          isValid: false,
          message: "GitHub personal access token not configured",
          errorCode: "MISSING_TOKEN",
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

      if (!repoOwner || !repoName) {
        const result: ValidationResult = {
          isValid: false,
          message: "GitHub repository owner and name must be configured",
          errorCode: "MISSING_REPOSITORY_INFO",
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

      // Create GitHub client with timeout
      const octokit = new Octokit({
        auth: personalAccessToken,
        request: {
          timeout: GitHubService.TIMEOUT_MS,
        },
      });

      // Test API connectivity by fetching authenticated user
      const userResponse = await Promise.race([
        octokit.rest.users.getAuthenticated(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("API request timeout")),
            GitHubService.TIMEOUT_MS,
          ),
        ),
      ]);

      // Test repository access
      const repoResponse = await Promise.race([
        octokit.rest.repos.get({
          owner: repoOwner,
          repo: repoName,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Repository access timeout")),
            GitHubService.TIMEOUT_MS,
          ),
        ),
      ]);

      const responseTime = Date.now() - startTime;

      // Extract metadata
      const metadata: Record<string, unknown> = {
        username: userResponse.data.login,
        userId: userResponse.data.id,
        userType: userResponse.data.type,
        repositoryFullName: repoResponse.data.full_name,
        repositoryPrivate: repoResponse.data.private,
        repositoryPermissions: repoResponse.data.permissions,
      };

      // Record success for circuit breaker
      this.circuitBreaker.recordSuccess();

      const result: ValidationResult = {
        isValid: true,
        message: `GitHub API connection successful (${userResponse.data.login} → ${repoResponse.data.full_name})`,
        responseTimeMs: responseTime,
        metadata,
      };

      // Record successful connectivity
      await this.recordConnectivityStatus(
        "connected",
        responseTime,
        result.message,
      );

      servicesLogger().info(
        this.circuitBreaker.redact({
          responseTime,
          username: userResponse.data.login,
          repository: repoResponse.data.full_name,
        }),
        "GitHub API validation successful",
      );

      return result;
    } catch (error) {
      const { errorCode, connectivityStatus, isRetriable } =
        this.circuitBreaker.parseError(error);

      const responseTime = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Record failure for circuit breaker
      this.circuitBreaker.recordFailure(errorCode);

      const result: ValidationResult = {
        isValid: false,
        message: `GitHub API validation failed: ${errorMessage}`,
        errorCode,
        responseTimeMs: responseTime,
      };

      // Record connectivity failure
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
        "GitHub API validation failed",
      );

      return result;
    }
  }

  /**
   * Create a GitHub issue
   * @param request Issue creation request
   * @returns Created issue details
   */
  async createIssue(request: CreateGitHubIssueRequest): Promise<GitHubIssue> {
    const startTime = Date.now();

    try {
      // Get stored settings
      const personalAccessToken = await this.get(
        GitHubService.PERSONAL_ACCESS_TOKEN_KEY,
      );
      const repoOwner = await this.get(GitHubService.REPO_OWNER_KEY);
      const repoName = await this.get(GitHubService.REPO_NAME_KEY);

      servicesLogger().debug(
        this.circuitBreaker.redact({
          hasToken: !!personalAccessToken,
          repoOwner,
          repoName,
          title: request.title,
          labels: request.labels,
        }),
        "Creating GitHub issue",
      );

      if (!personalAccessToken || !repoOwner || !repoName) {
        throw new Error("GitHub not configured. Please configure settings first.");
      }

      // Create GitHub client
      const octokit = new Octokit({
        auth: personalAccessToken,
        request: {
          timeout: GitHubService.TIMEOUT_MS,
        },
      });

      // Create the issue
      const response = await Promise.race([
        octokit.rest.issues.create({
          owner: repoOwner,
          repo: repoName,
          title: request.title,
          body: request.body,
          labels: request.labels,
          assignees: request.assignees,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Issue creation timeout")),
            GitHubService.TIMEOUT_MS,
          ),
        ),
      ]);

      const responseTime = Date.now() - startTime;

      servicesLogger().info(
        {
          issueNumber: response.data.number,
          issueUrl: response.data.html_url,
          responseTime,
        },
        "GitHub issue created successfully",
      );

      return {
        id: response.data.id,
        number: response.data.number,
        title: response.data.title,
        body: response.data.body || undefined,
        state: response.data.state as "open" | "closed",
        html_url: response.data.html_url,
        created_at: response.data.created_at,
        updated_at: response.data.updated_at,
        labels: response.data.labels.map((label) => ({
          name: typeof label === "string" ? label : (label.name ?? ""),
          color: typeof label === "string" ? "" : (label.color ?? ""),
        })),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const responseTime = Date.now() - startTime;

      servicesLogger().error(
        this.circuitBreaker.redact({
          error: errorMessage,
          responseTime,
          title: request.title,
        }),
        "Failed to create GitHub issue",
      );

      throw toServiceError(error, "github");
    }
  }

  /**
   * Set the personal access token
   * @param token The GitHub personal access token
   * @param userId The user making the change
   */
  async setPersonalAccessToken(
    token: string,
    userId: string,
  ): Promise<void> {
    // TODO: Encryption should be handled at the database/route level
    await this.set(
      GitHubService.PERSONAL_ACCESS_TOKEN_KEY,
      token,
      userId,
    );
  }

  /**
   * Set the repository owner
   * @param owner The repository owner
   * @param userId The user making the change
   */
  async setRepoOwner(owner: string, userId: string): Promise<void> {
    await this.set(GitHubService.REPO_OWNER_KEY, owner, userId);
  }

  /**
   * Set the repository name
   * @param name The repository name
   * @param userId The user making the change
   */
  async setRepoName(name: string, userId: string): Promise<void> {
    await this.set(GitHubService.REPO_NAME_KEY, name, userId);
  }

  /**
   * Get current configuration status
   * @returns Configuration status information
   */
  async getConfigStatus(): Promise<{
    isConfigured: boolean;
    hasPersonalAccessToken: boolean;
    repoOwner?: string;
    repoName?: string;
  }> {
    const personalAccessToken = await this.get(
      GitHubService.PERSONAL_ACCESS_TOKEN_KEY,
    );
    const repoOwner = await this.get(GitHubService.REPO_OWNER_KEY);
    const repoName = await this.get(GitHubService.REPO_NAME_KEY);

    return {
      isConfigured:
        !!personalAccessToken && !!repoOwner && !!repoName,
      hasPersonalAccessToken: !!personalAccessToken,
      repoOwner: repoOwner || undefined,
      repoName: repoName || undefined,
    };
  }

  /**
   * Get health status of GitHub integration
   * @returns ServiceHealthStatus with current connectivity information
   */
  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const latestStatus = await this.getLatestConnectivityStatus();

    if (!latestStatus) {
      // No previous status, perform validation
      const validationResult = await this.validate();

      return {
        service: "github",
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
      service: "github",
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
}

// Export singleton instance
export const githubService = new GitHubService(prisma);
