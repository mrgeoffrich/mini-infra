import prisma, { PrismaClient } from "../lib/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  ConnectivityStatusType,
  CreateGitHubIssueRequest,
  GitHubIssue,
} from "@mini-infra/types";
import { ConfigurationService } from "./configuration-base";
import { servicesLogger } from "../lib/logger-factory";
import { Octokit } from "@octokit/rest";

/**
 * Circuit breaker state for managing API failures
 */
interface CircuitBreakerState {
  state: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  lastFailureTime?: Date;
  lastSuccessTime?: Date;
  nextRetryTime?: Date;
}

/**
 * Request deduplication tracking
 */
interface PendingRequest {
  promise: Promise<ValidationResult>;
  timestamp: number;
}

/**
 * GitHubConfigService handles GitHub API configuration management
 * Extends the base ConfigurationService to provide GitHub-specific functionality
 * Implements circuit breaker pattern for resilient API communication
 */
export class GitHubConfigService extends ConfigurationService {
  private static readonly TIMEOUT_MS = 10000; // 10 second timeout
  private static readonly PERSONAL_ACCESS_TOKEN_KEY = "personal_access_token";
  private static readonly REPO_OWNER_KEY = "repo_owner";
  private static readonly REPO_NAME_KEY = "repo_name";

  // Circuit breaker configuration
  private static readonly FAILURE_THRESHOLD = 5; // Open circuit after 5 consecutive failures
  private static readonly COOLDOWN_PERIOD_MS = 5 * 60 * 1000; // 5 minutes cooldown
  private static readonly DEDUP_WINDOW_MS = 1000; // 1 second deduplication window

  // Circuit breaker state
  private circuitBreaker: CircuitBreakerState = {
    state: "closed",
    consecutiveFailures: 0,
  };

  // Request deduplication
  private pendingValidation: PendingRequest | null = null;

  constructor(prisma: PrismaClient) {
    super(prisma, "github");
  }

  /**
   * Check if the circuit breaker allows requests
   * @returns Whether the circuit is closed or half-open (allowing requests)
   */
  private isCircuitBreakerOpen(): boolean {
    if (this.circuitBreaker.state === "open") {
      // Check if cooldown period has passed
      if (
        this.circuitBreaker.nextRetryTime &&
        new Date() >= this.circuitBreaker.nextRetryTime
      ) {
        // Transition to half-open state to allow retry
        this.circuitBreaker.state = "half-open";
        servicesLogger().info(
          {
            previousFailures: this.circuitBreaker.consecutiveFailures,
            lastFailureTime: this.circuitBreaker.lastFailureTime,
          },
          "Circuit breaker transitioning to half-open state",
        );
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Record a successful API call and reset circuit breaker if needed
   */
  private recordSuccess(): void {
    if (
      this.circuitBreaker.state === "half-open" ||
      this.circuitBreaker.consecutiveFailures > 0
    ) {
      servicesLogger().info(
        {
          previousState: this.circuitBreaker.state,
          previousFailures: this.circuitBreaker.consecutiveFailures,
        },
        "Circuit breaker reset after successful API call",
      );
    }

    this.circuitBreaker = {
      state: "closed",
      consecutiveFailures: 0,
      lastSuccessTime: new Date(),
    };
  }

  /**
   * Record a failed API call and update circuit breaker state
   * @param errorCode The error code from the API failure
   */
  private recordFailure(errorCode: string): void {
    this.circuitBreaker.consecutiveFailures++;
    this.circuitBreaker.lastFailureTime = new Date();

    // Check if we should open the circuit
    if (
      this.circuitBreaker.consecutiveFailures >=
      GitHubConfigService.FAILURE_THRESHOLD
    ) {
      this.circuitBreaker.state = "open";
      this.circuitBreaker.nextRetryTime = new Date(
        Date.now() + GitHubConfigService.COOLDOWN_PERIOD_MS,
      );

      servicesLogger().warn(
        {
          consecutiveFailures: this.circuitBreaker.consecutiveFailures,
          errorCode,
          nextRetryTime: this.circuitBreaker.nextRetryTime,
        },
        "Circuit breaker opened due to consecutive failures",
      );
    } else {
      servicesLogger().debug(
        {
          consecutiveFailures: this.circuitBreaker.consecutiveFailures,
          threshold: GitHubConfigService.FAILURE_THRESHOLD,
          errorCode,
        },
        "API failure recorded, circuit breaker still closed",
      );
    }
  }

  /**
   * Parse and categorize GitHub API errors
   * @param error The error to parse
   * @returns Error categorization with connectivity status
   */
  private parseApiError(error: unknown): {
    errorCode: string;
    connectivityStatus: ConnectivityStatusType;
    isRetriable: boolean;
  } {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    servicesLogger().debug(
      { errorMessage },
      "Parsing GitHub API error",
    );

    // Check for specific GitHub API error patterns
    if (errorMessage.includes("timeout") || errorMessage.includes("ETIMEDOUT")) {
      return {
        errorCode: "TIMEOUT",
        connectivityStatus: "unreachable",
        isRetriable: true,
      };
    } else if (
      errorMessage.includes("Bad credentials") ||
      errorMessage.includes("Unauthorized") ||
      errorMessage.includes("401")
    ) {
      return {
        errorCode: "INVALID_CREDENTIALS",
        connectivityStatus: "failed",
        isRetriable: false,
      };
    } else if (errorMessage.includes("Not Found") || errorMessage.includes("404")) {
      return {
        errorCode: "REPOSITORY_NOT_FOUND",
        connectivityStatus: "failed",
        isRetriable: false,
      };
    } else if (
      errorMessage.includes("ENOTFOUND") ||
      errorMessage.includes("ECONNREFUSED")
    ) {
      return {
        errorCode: "NETWORK_ERROR",
        connectivityStatus: "unreachable",
        isRetriable: true,
      };
    } else if (errorMessage.includes("rate limit")) {
      return {
        errorCode: "RATE_LIMITED",
        connectivityStatus: "failed",
        isRetriable: true,
      };
    }

    return {
      errorCode: "GITHUB_API_ERROR",
      connectivityStatus: "failed",
      isRetriable: true,
    };
  }

  /**
   * Redact sensitive information from log data
   * @param data The data to redact
   * @returns Redacted data safe for logging
   */
  private redactSensitiveData(data: any): any {
    if (typeof data === "string") {
      // Redact GitHub tokens (typically start with ghp_, gho_, etc.)
      return data.replace(/gh[a-z]_[a-zA-Z0-9]{36,}/g, "[REDACTED_TOKEN]");
    }

    if (typeof data === "object" && data !== null) {
      const redacted = { ...data };
      const sensitiveKeys = [
        "personalAccessToken",
        "personal_access_token",
        "token",
        "secret",
        "password",
        "key",
      ];

      for (const key of Object.keys(redacted)) {
        if (
          sensitiveKeys.some((sensitive) =>
            key.toLowerCase().includes(sensitive),
          )
        ) {
          redacted[key] = "[REDACTED]";
        } else if (typeof redacted[key] === "object") {
          redacted[key] = this.redactSensitiveData(redacted[key]);
        }
      }

      return redacted;
    }

    return data;
  }

  /**
   * Validate GitHub API configuration by testing API connectivity
   * Implements circuit breaker pattern and request deduplication
   * @param settings - Optional settings to validate with (overrides stored settings)
   * @returns ValidationResult with connectivity status and details
   */
  async validate(settings?: Record<string, string>): Promise<ValidationResult> {
    const startTime = Date.now();

    // Check for request deduplication
    if (this.pendingValidation) {
      const timeSinceRequest = Date.now() - this.pendingValidation.timestamp;
      if (timeSinceRequest < GitHubConfigService.DEDUP_WINDOW_MS) {
        servicesLogger().debug(
          {
            timeSinceRequest,
            dedupWindow: GitHubConfigService.DEDUP_WINDOW_MS,
          },
          "Deduplicating validation request within time window",
        );
        return this.pendingValidation.promise;
      }
    }

    // Check circuit breaker state
    if (this.isCircuitBreakerOpen()) {
      const timeSinceFailure = this.circuitBreaker.lastFailureTime
        ? Date.now() - this.circuitBreaker.lastFailureTime.getTime()
        : 0;
      const timeUntilRetry = this.circuitBreaker.nextRetryTime
        ? this.circuitBreaker.nextRetryTime.getTime() - Date.now()
        : 0;

      servicesLogger().info(
        {
          circuitState: "open",
          consecutiveFailures: this.circuitBreaker.consecutiveFailures,
          timeSinceFailure,
          timeUntilRetry,
        },
        "Circuit breaker is open, skipping validation",
      );

      const result: ValidationResult = {
        isValid: false,
        message: `Circuit breaker open after ${this.circuitBreaker.consecutiveFailures} consecutive failures. Retry in ${Math.ceil(timeUntilRetry / 1000)} seconds.`,
        errorCode: "CIRCUIT_BREAKER_OPEN",
        responseTimeMs: Date.now() - startTime,
      };

      return result;
    }

    // Create the validation promise
    const validationPromise = this.performValidation(startTime, settings);

    // Store for deduplication
    this.pendingValidation = {
      promise: validationPromise,
      timestamp: Date.now(),
    };

    // Clear pending validation after completion
    validationPromise.finally(() => {
      this.pendingValidation = null;
    });

    return validationPromise;
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
        (await this.get(GitHubConfigService.PERSONAL_ACCESS_TOKEN_KEY));
      const repoOwner = settings?.repoOwner ||
        (await this.get(GitHubConfigService.REPO_OWNER_KEY));
      const repoName = settings?.repoName ||
        (await this.get(GitHubConfigService.REPO_NAME_KEY));

      servicesLogger().debug(
        this.redactSensitiveData({
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
          timeout: GitHubConfigService.TIMEOUT_MS,
        },
      });

      // Test API connectivity by fetching authenticated user
      const userResponse = await Promise.race([
        octokit.rest.users.getAuthenticated(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("API request timeout")),
            GitHubConfigService.TIMEOUT_MS,
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
            GitHubConfigService.TIMEOUT_MS,
          ),
        ),
      ]);

      const responseTime = Date.now() - startTime;

      // Extract metadata
      const metadata: Record<string, any> = {
        username: userResponse.data.login,
        userId: userResponse.data.id,
        userType: userResponse.data.type,
        repositoryFullName: repoResponse.data.full_name,
        repositoryPrivate: repoResponse.data.private,
        repositoryPermissions: repoResponse.data.permissions,
      };

      // Record success for circuit breaker
      this.recordSuccess();

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
        this.redactSensitiveData({
          responseTime,
          username: userResponse.data.login,
          repository: repoResponse.data.full_name,
        }),
        "GitHub API validation successful",
      );

      return result;
    } catch (error) {
      const { errorCode, connectivityStatus, isRetriable } =
        this.parseApiError(error);

      const responseTime = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Record failure for circuit breaker
      this.recordFailure(errorCode);

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
        this.redactSensitiveData({
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
        GitHubConfigService.PERSONAL_ACCESS_TOKEN_KEY,
      );
      const repoOwner = await this.get(GitHubConfigService.REPO_OWNER_KEY);
      const repoName = await this.get(GitHubConfigService.REPO_NAME_KEY);

      servicesLogger().debug(
        this.redactSensitiveData({
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
          timeout: GitHubConfigService.TIMEOUT_MS,
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
            GitHubConfigService.TIMEOUT_MS,
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
        labels: response.data.labels.map((label: any) => ({
          name: typeof label === "string" ? label : label.name,
          color: typeof label === "string" ? "" : label.color,
        })),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const responseTime = Date.now() - startTime;

      servicesLogger().error(
        this.redactSensitiveData({
          error: errorMessage,
          responseTime,
          title: request.title,
        }),
        "Failed to create GitHub issue",
      );

      throw error;
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
      GitHubConfigService.PERSONAL_ACCESS_TOKEN_KEY,
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
    await this.set(GitHubConfigService.REPO_OWNER_KEY, owner, userId);
  }

  /**
   * Set the repository name
   * @param name The repository name
   * @param userId The user making the change
   */
  async setRepoName(name: string, userId: string): Promise<void> {
    await this.set(GitHubConfigService.REPO_NAME_KEY, name, userId);
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
      GitHubConfigService.PERSONAL_ACCESS_TOKEN_KEY,
    );
    const repoOwner = await this.get(GitHubConfigService.REPO_OWNER_KEY);
    const repoName = await this.get(GitHubConfigService.REPO_NAME_KEY);

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

    return {
      service: "github",
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
}

// Export singleton instance
export const githubConfigService = new GitHubConfigService(prisma);
