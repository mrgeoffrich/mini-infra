import prisma, { PrismaClient } from "../lib/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  ConnectivityStatusType,
} from "@mini-infra/types";
import { ConfigurationService } from "./configuration-base";
import { servicesLogger } from "../lib/logger-factory";
import Cloudflare from "cloudflare";
import { createCloudflareSpan } from "../lib/http-instrumentation";

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
 * CloudflareConfigService handles Cloudflare API configuration management
 * Extends the base ConfigurationService to provide Cloudflare-specific functionality
 * Implements circuit breaker pattern for resilient API communication
 */
export class CloudflareConfigService extends ConfigurationService {
  private static readonly TIMEOUT_MS = 10000; // 10 second timeout
  private static readonly API_TOKEN_KEY = "api_token";
  private static readonly ACCOUNT_ID_KEY = "account_id";

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
    super(prisma, "cloudflare");
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
      CloudflareConfigService.FAILURE_THRESHOLD
    ) {
      this.circuitBreaker.state = "open";
      this.circuitBreaker.nextRetryTime = new Date(
        Date.now() + CloudflareConfigService.COOLDOWN_PERIOD_MS,
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
          threshold: CloudflareConfigService.FAILURE_THRESHOLD,
          errorCode,
        },
        "API failure recorded, circuit breaker still closed",
      );
    }
  }

  /**
   * Parse and categorize Cloudflare API errors
   * @param error The error to parse
   * @returns Categorized error information
   */
  private parseApiError(error: any): {
    errorCode: string;
    connectivityStatus: ConnectivityStatusType;
    isRetriable: boolean;
  } {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const statusCode = error?.response?.status || error?.status;

    // Handle specific HTTP status codes
    if (statusCode) {
      switch (statusCode) {
        case 401:
          return {
            errorCode: "INVALID_API_TOKEN",
            connectivityStatus: "failed",
            isRetriable: false,
          };
        case 403:
          return {
            errorCode: "INSUFFICIENT_PERMISSIONS",
            connectivityStatus: "failed",
            isRetriable: false,
          };
        case 429:
          return {
            errorCode: "RATE_LIMITED",
            connectivityStatus: "failed",
            isRetriable: true,
          };
        case 500:
        case 502:
        case 503:
        case 504:
          return {
            errorCode: `SERVER_ERROR_${statusCode}`,
            connectivityStatus: "failed",
            isRetriable: true,
          };
      }
    }

    // Parse error messages
    if (errorMessage.includes("timeout")) {
      return {
        errorCode: "TIMEOUT",
        connectivityStatus: "timeout",
        isRetriable: true,
      };
    } else if (
      errorMessage.includes("Unauthorized") ||
      errorMessage.includes("Invalid API Token")
    ) {
      return {
        errorCode: "INVALID_API_TOKEN",
        connectivityStatus: "failed",
        isRetriable: false,
      };
    } else if (errorMessage.includes("Forbidden")) {
      return {
        errorCode: "INSUFFICIENT_PERMISSIONS",
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
    } else if (errorMessage.includes("Rate limit")) {
      return {
        errorCode: "RATE_LIMITED",
        connectivityStatus: "failed",
        isRetriable: true,
      };
    }

    return {
      errorCode: "CLOUDFLARE_API_ERROR",
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
      // Redact API tokens (typically 40+ characters starting with specific patterns)
      return data.replace(/[a-zA-Z0-9_-]{40,}/g, "[REDACTED_TOKEN]");
    }

    if (typeof data === "object" && data !== null) {
      const redacted = { ...data };
      const sensitiveKeys = [
        "apiToken",
        "api_token",
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
   * Validate Cloudflare API configuration by testing API connectivity
   * Implements circuit breaker pattern and request deduplication
   * @param settings - Optional settings to validate with (overrides stored settings)
   * @returns ValidationResult with connectivity status and details
   */
  async validate(settings?: Record<string, string>): Promise<ValidationResult> {
    const startTime = Date.now();

    // Check for request deduplication
    if (this.pendingValidation) {
      const timeSinceRequest = Date.now() - this.pendingValidation.timestamp;
      if (timeSinceRequest < CloudflareConfigService.DEDUP_WINDOW_MS) {
        servicesLogger().debug(
          {
            timeSinceRequest,
            dedupWindow: CloudflareConfigService.DEDUP_WINDOW_MS,
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
      const apiToken = settings?.apiToken || await this.get(CloudflareConfigService.API_TOKEN_KEY);
      const accountId = settings?.accountId || await this.get(CloudflareConfigService.ACCOUNT_ID_KEY);

      servicesLogger().debug(
        this.redactSensitiveData({
          hasToken: !!apiToken,
          tokenLength: apiToken?.length,
          circuitState: this.circuitBreaker.state,
        }),
        "Starting Cloudflare API validation",
      );

      if (!apiToken) {
        const result: ValidationResult = {
          isValid: false,
          message: "Cloudflare API token not configured",
          errorCode: "MISSING_API_TOKEN",
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

      // Create Cloudflare client with timeout
      const cf = new Cloudflare({
        apiToken,
      });

      // Test API connectivity by fetching user information
      const userResponse = (await Promise.race([
        cf.user.get(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("API request timeout")),
            CloudflareConfigService.TIMEOUT_MS,
          ),
        ),
      ])) as any;

      const responseTime = Date.now() - startTime;

      // Extract account information if available
      const metadata: Record<string, any> = {
        userEmail: userResponse.email,
        userId: userResponse.id,
        firstName: userResponse.first_name,
        lastName: userResponse.last_name,
        accountStatus: userResponse.suspended ? "suspended" : "active",
      };

      // Test account access if account ID is configured
      let accountInfo = null;
      if (accountId) {
        try {
          accountInfo = await cf.accounts.get({ account_id: accountId });
          metadata.accountName = accountInfo.name;
          metadata.accountId = accountInfo.id;
        } catch (accountError) {
          servicesLogger().warn(
            {
              accountId,
              error:
                accountError instanceof Error
                  ? accountError.message
                  : "Unknown error",
            },
            "Failed to fetch account information, but API token is valid",
          );
        }
      }

      // Record success for circuit breaker
      this.recordSuccess();

      const result: ValidationResult = {
        isValid: true,
        message: `Cloudflare API connection successful (${userResponse.email})`,
        responseTimeMs: responseTime,
        metadata,
      };

      await this.recordConnectivityStatus(
        "connected",
        result.responseTimeMs,
        undefined,
        undefined,
        metadata,
      );

      servicesLogger().info(
        this.redactSensitiveData({
          responseTime,
          userEmail: userResponse.email,
          accountStatus: metadata.accountStatus,
          circuitState: this.circuitBreaker.state,
        }),
        "Cloudflare API validation successful",
      );

      return result;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Parse and categorize the error
      const { errorCode, connectivityStatus, isRetriable } =
        this.parseApiError(error);

      // Record failure for circuit breaker (only for retriable errors)
      if (isRetriable) {
        this.recordFailure(errorCode);
      }

      const result: ValidationResult = {
        isValid: false,
        message: `Cloudflare API validation failed: ${errorMessage}`,
        errorCode,
        responseTimeMs: responseTime,
      };

      await this.recordConnectivityStatus(
        connectivityStatus,
        result.responseTimeMs,
        result.message,
        result.errorCode,
      );

      servicesLogger().error(
        this.redactSensitiveData({
          error: errorMessage,
          errorCode,
          responseTime,
          isRetriable,
          circuitState: this.circuitBreaker.state,
          consecutiveFailures: this.circuitBreaker.consecutiveFailures,
        }),
        "Cloudflare API validation failed",
      );

      return result;
    }
  }

  /**
   * Get current health status of the Cloudflare service
   * @returns ServiceHealthStatus with current connectivity information
   */
  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const latestStatus = await this.getLatestConnectivityStatus();

    if (!latestStatus) {
      // No previous status, perform validation
      const validationResult = await this.validate();

      return {
        service: "cloudflare",
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
      service: "cloudflare",
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

  /**
   * Set API token with validation
   * @param apiToken - Cloudflare API token
   * @param userId - User ID who is setting the token
   */
  async setApiToken(apiToken: string, userId: string): Promise<void> {
    if (!apiToken || apiToken.trim().length === 0) {
      throw new Error("API token cannot be empty");
    }

    // Validate token format (Cloudflare tokens are typically 40 characters)
    if (apiToken.length < 20) {
      throw new Error("Invalid API token format");
    }

    await this.set(CloudflareConfigService.API_TOKEN_KEY, apiToken, userId);

    // Reset circuit breaker when new credentials are set
    this.circuitBreaker = {
      state: "closed",
      consecutiveFailures: 0,
    };

    servicesLogger().info(
      this.redactSensitiveData({
        userId,
        tokenLength: apiToken.length,
      }),
      "API token updated, circuit breaker reset",
    );
  }

  /**
   * Set account ID
   * @param accountId - Cloudflare account ID
   * @param userId - User ID who is setting the account ID
   */
  async setAccountId(accountId: string, userId: string): Promise<void> {
    if (!accountId || accountId.trim().length === 0) {
      throw new Error("Account ID cannot be empty");
    }

    await this.set(CloudflareConfigService.ACCOUNT_ID_KEY, accountId, userId);
  }

  /**
   * Get API token
   * @returns API token or null if not set
   */
  async getApiToken(): Promise<string | null> {
    return await this.get(CloudflareConfigService.API_TOKEN_KEY);
  }

  /**
   * Get account ID
   * @returns Account ID or null if not set
   */
  async getAccountId(): Promise<string | null> {
    return await this.get(CloudflareConfigService.ACCOUNT_ID_KEY);
  }

  /**
   * Get tunnel configuration including ingress rules and hostname mappings
   * @param tunnelId The tunnel ID to get configuration for
   * @returns Tunnel configuration or null if not found or connection fails
   */
  async getTunnelConfig(tunnelId: string): Promise<any> {
    // Check circuit breaker before making API call
    if (this.isCircuitBreakerOpen()) {
      servicesLogger().warn(
        {
          circuitState: "open",
          consecutiveFailures: this.circuitBreaker.consecutiveFailures,
          tunnelId,
        },
        "Circuit breaker is open, skipping tunnel config retrieval",
      );
      return null;
    }

    try {
      const apiToken = await this.getApiToken();
      const accountId = await this.getAccountId();

      if (!apiToken) {
        servicesLogger().warn(
          "Cannot retrieve tunnel config: API token not configured",
        );
        return null;
      }

      if (!accountId) {
        servicesLogger().warn(
          "Cannot retrieve tunnel config: Account ID not configured",
        );
        return null;
      }

      const cf = new Cloudflare({
        apiToken,
      });

      // Try to fetch tunnel configuration using the proper API endpoint
      const configResponse = (await Promise.race([
        // Use the tunnel configurations endpoint
        fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
          {
            headers: {
              Authorization: `Bearer ${apiToken}`,
              "Content-Type": "application/json",
            },
          },
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Tunnel config API request timeout")),
            CloudflareConfigService.TIMEOUT_MS,
          ),
        ),
      ])) as Response;

      if (!configResponse.ok) {
        servicesLogger().warn(
          this.redactSensitiveData({
            accountId,
            tunnelId,
            status: configResponse.status,
            statusText: configResponse.statusText,
          }),
          "Failed to fetch tunnel configuration from Cloudflare API",
        );
        return null;
      }

      const configData = await configResponse.json();

      // Record success for circuit breaker
      this.recordSuccess();

      servicesLogger().info(
        this.redactSensitiveData({
          accountId,
          tunnelId,
          configVersion: configData.result?.version,
          ingressRuleCount: configData.result?.config?.ingress?.length || 0,
        }),
        "Successfully retrieved Cloudflare tunnel configuration",
      );

      return configData.result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Parse error and record failure if retriable
      const { errorCode, isRetriable } = this.parseApiError(error);
      if (isRetriable) {
        this.recordFailure(errorCode);
      }

      servicesLogger().error(
        this.redactSensitiveData({
          error: errorMessage,
          errorCode,
          isRetriable,
          tunnelId,
        }),
        "Failed to retrieve Cloudflare tunnel configuration",
      );

      return null;
    }
  }

  /**
   * Test tunnel connectivity and retrieve tunnel information
   * Respects circuit breaker state
   * @returns Array of tunnel information or empty array if no tunnels or connection fails
   */
  async getTunnelInfo(): Promise<any[]> {
    // Check circuit breaker before making API call
    if (this.isCircuitBreakerOpen()) {
      servicesLogger().warn(
        {
          circuitState: "open",
          consecutiveFailures: this.circuitBreaker.consecutiveFailures,
        },
        "Circuit breaker is open, skipping tunnel info retrieval",
      );
      return [];
    }
    try {
      const apiToken = await this.getApiToken();
      const accountId = await this.getAccountId();

      if (!apiToken) {
        servicesLogger().warn(
          "Cannot retrieve tunnel info: API token not configured",
        );
        return [];
      }

      if (!accountId) {
        servicesLogger().warn(
          "Cannot retrieve tunnel info: Account ID not configured",
        );
        return [];
      }

      const cf = new Cloudflare({
        apiToken,
      });

      // Fetch tunnels for the account with instrumentation
      const tunnelsResponse = await createCloudflareSpan(
        "list_tunnels",
        async () => {
          return (await Promise.race([
            cf.zeroTrust.tunnels.list({ account_id: accountId }),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("Tunnel API request timeout")),
                CloudflareConfigService.TIMEOUT_MS,
              ),
            ),
          ])) as any;
        },
        {
          "cloudflare.account.id": accountId,
          "cloudflare.operation.type": "list_tunnels",
        }
      );

      const tunnels = tunnelsResponse.result || [];

      // Record success for circuit breaker
      this.recordSuccess();

      servicesLogger().info(
        this.redactSensitiveData({
          accountId,
          tunnelCount: tunnels.length,
        }),
        "Successfully retrieved Cloudflare tunnel information",
      );

      return tunnels
        .filter((tunnel: any) => !tunnel.deleted_at) // Filter out deleted tunnels
        .map((tunnel: any) => ({
          id: tunnel.id,
          name: tunnel.name,
          status: tunnel.status,
          created_at: tunnel.created_at,
          deleted_at: tunnel.deleted_at,
          connections: tunnel.connections || [],
        }));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Parse error and record failure if retriable
      const { errorCode, isRetriable } = this.parseApiError(error);
      if (isRetriable) {
        this.recordFailure(errorCode);
      }

      servicesLogger().error(
        this.redactSensitiveData({
          error: errorMessage,
          errorCode,
          isRetriable,
        }),
        "Failed to retrieve Cloudflare tunnel information",
      );

      return [];
    }
  }

  /**
   * Update tunnel configuration with new ingress rules
   * @param tunnelId The tunnel ID to update
   * @param config The new tunnel configuration
   * @returns Updated configuration or null if update fails
   */
  async updateTunnelConfig(tunnelId: string, config: any): Promise<any> {
    // Check circuit breaker before making API call
    if (this.isCircuitBreakerOpen()) {
      servicesLogger().warn(
        {
          circuitState: "open",
          consecutiveFailures: this.circuitBreaker.consecutiveFailures,
          tunnelId,
        },
        "Circuit breaker is open, skipping tunnel config update",
      );
      return null;
    }

    try {
      const apiToken = await this.getApiToken();
      const accountId = await this.getAccountId();

      if (!apiToken) {
        servicesLogger().warn(
          "Cannot update tunnel config: API token not configured",
        );
        return null;
      }

      if (!accountId) {
        servicesLogger().warn(
          "Cannot update tunnel config: Account ID not configured",
        );
        return null;
      }

      // Update tunnel configuration using the proper API endpoint
      const updateResponse = (await Promise.race([
        fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${apiToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              config: config,
            }),
          },
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Tunnel config update API request timeout")),
            CloudflareConfigService.TIMEOUT_MS,
          ),
        ),
      ])) as Response;

      if (!updateResponse.ok) {
        const errorText = await updateResponse.text();
        servicesLogger().warn(
          this.redactSensitiveData({
            accountId,
            tunnelId,
            status: updateResponse.status,
            statusText: updateResponse.statusText,
            error: errorText,
          }),
          "Failed to update tunnel configuration via Cloudflare API",
        );
        throw new Error(`HTTP ${updateResponse.status}: ${errorText}`);
      }

      const updateData = await updateResponse.json();

      // Record success for circuit breaker
      this.recordSuccess();

      servicesLogger().info(
        this.redactSensitiveData({
          accountId,
          tunnelId,
          configVersion: updateData.result?.version,
          ingressRuleCount: config.ingress?.length || 0,
        }),
        "Successfully updated Cloudflare tunnel configuration",
      );

      return updateData.result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Parse error and record failure if retriable
      const { errorCode, isRetriable } = this.parseApiError(error);
      if (isRetriable) {
        this.recordFailure(errorCode);
      }

      servicesLogger().error(
        this.redactSensitiveData({
          error: errorMessage,
          errorCode,
          isRetriable,
          tunnelId,
        }),
        "Failed to update Cloudflare tunnel configuration",
      );

      throw error;
    }
  }

  /**
   * Add a public hostname to a tunnel's ingress rules
   * @param tunnelId The tunnel ID to update
   * @param hostname The public hostname to add
   * @param service The backend service URL
   * @param path Optional path pattern for the hostname
   * @returns Updated configuration or null if update fails
   */
  async addHostname(
    tunnelId: string,
    hostname: string,
    service: string,
    path?: string,
  ): Promise<any> {
    try {
      // First get the current configuration
      const currentConfig = await this.getTunnelConfig(tunnelId);

      if (!currentConfig || !currentConfig.config) {
        throw new Error("Unable to retrieve current tunnel configuration");
      }

      const ingress = [...(currentConfig.config.ingress || [])];

      // Check if hostname already exists
      const existingRuleIndex = ingress.findIndex(
        (rule) => rule.hostname === hostname && rule.path === path,
      );
      if (existingRuleIndex !== -1) {
        throw new Error(
          `Hostname ${hostname}${path ? ` with path ${path}` : ""} already exists`,
        );
      }

      // Find the catch-all rule (rule without hostname) and insert before it
      const catchAllIndex = ingress.findIndex((rule) => !rule.hostname);
      const newRule: any = {
        hostname,
        service,
      };

      if (path) {
        newRule.path = path;
      }

      if (catchAllIndex !== -1) {
        // Insert before catch-all rule
        ingress.splice(catchAllIndex, 0, newRule);
      } else {
        // No catch-all rule found, add at the end (though this shouldn't happen)
        ingress.push(newRule);
      }

      // Update the configuration
      const updatedConfig = {
        ...currentConfig.config,
        ingress,
      };

      servicesLogger().info(
        this.redactSensitiveData({
          tunnelId,
          hostname,
          service,
          path,
          ingressRuleCount: ingress.length,
        }),
        "Adding hostname to tunnel configuration",
      );

      return await this.updateTunnelConfig(tunnelId, updatedConfig);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      servicesLogger().error(
        this.redactSensitiveData({
          error: errorMessage,
          tunnelId,
          hostname,
          service,
        }),
        "Failed to add hostname to tunnel configuration",
      );

      throw error;
    }
  }

  /**
   * Remove a public hostname from a tunnel's ingress rules
   * @param tunnelId The tunnel ID to update
   * @param hostname The public hostname to remove
   * @param path Optional path pattern for the hostname
   * @returns Updated configuration or null if update fails
   */
  async removeHostname(
    tunnelId: string,
    hostname: string,
    path?: string,
  ): Promise<any> {
    try {
      // First get the current configuration
      const currentConfig = await this.getTunnelConfig(tunnelId);

      if (!currentConfig || !currentConfig.config) {
        throw new Error("Unable to retrieve current tunnel configuration");
      }

      const ingress = [...(currentConfig.config.ingress || [])];

      // Find the rule to remove
      const ruleIndex = ingress.findIndex(
        (rule) =>
          rule.hostname === hostname &&
          (path ? rule.path === path : !rule.path),
      );

      if (ruleIndex === -1) {
        throw new Error(
          `Hostname ${hostname}${path ? ` with path ${path}` : ""} not found`,
        );
      }

      // Remove the rule
      ingress.splice(ruleIndex, 1);

      // Update the configuration
      const updatedConfig = {
        ...currentConfig.config,
        ingress,
      };

      servicesLogger().info(
        this.redactSensitiveData({
          tunnelId,
          hostname,
          path,
          ingressRuleCount: ingress.length,
        }),
        "Removing hostname from tunnel configuration",
      );

      return await this.updateTunnelConfig(tunnelId, updatedConfig);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      servicesLogger().error(
        this.redactSensitiveData({
          error: errorMessage,
          tunnelId,
          hostname,
        }),
        "Failed to remove hostname from tunnel configuration",
      );

      throw error;
    }
  }

  /**
   * Get Cloudflare zone ID by domain name
   * @param domain - Domain name (e.g., "example.com")
   * @returns Zone ID
   */
  async getZoneId(domain: string): Promise<string> {
    // Check circuit breaker
    if (this.isCircuitBreakerOpen()) {
      throw new Error("Circuit breaker is open, cannot query Cloudflare API");
    }

    try {
      const apiToken = await this.getApiToken();

      if (!apiToken) {
        throw new Error("Cloudflare API token not configured");
      }

      const cf = new Cloudflare({
        apiToken,
      });

      // List zones and find matching domain
      const zonesResponse = (await Promise.race([
        cf.zones.list({ name: domain }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Get zone API request timeout")),
            CloudflareConfigService.TIMEOUT_MS,
          ),
        ),
      ])) as any;

      const zones = zonesResponse.result || [];

      if (zones.length === 0) {
        throw new Error(`No Cloudflare zone found for domain: ${domain}`);
      }

      // Record success for circuit breaker
      this.recordSuccess();

      servicesLogger().info(
        { domain, zoneId: zones[0].id },
        "Retrieved Cloudflare zone ID",
      );

      return zones[0].id;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Parse error and record failure if retriable
      const { errorCode, isRetriable } = this.parseApiError(error);
      if (isRetriable) {
        this.recordFailure(errorCode);
      }

      servicesLogger().error(
        this.redactSensitiveData({
          error: errorMessage,
          errorCode,
          domain,
        }),
        "Failed to get Cloudflare zone ID",
      );

      throw error;
    }
  }

  /**
   * Create DNS record in Cloudflare
   * @param params - DNS record parameters
   * @returns DNS record ID
   */
  async createDnsRecord(params: {
    zoneId: string;
    type: string;
    name: string;
    content: string;
    ttl: number;
  }): Promise<string> {
    // Check circuit breaker
    if (this.isCircuitBreakerOpen()) {
      throw new Error("Circuit breaker is open, cannot create DNS record");
    }

    try {
      const apiToken = await this.getApiToken();

      if (!apiToken) {
        throw new Error("Cloudflare API token not configured");
      }

      const cf = new Cloudflare({
        apiToken,
      });

      // Create DNS record
      const recordResponse = (await Promise.race([
        cf.dns.records.create({
          zone_id: params.zoneId,
          type: params.type as any,
          name: params.name,
          content: params.content,
          ttl: params.ttl,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Create DNS record API request timeout")),
            CloudflareConfigService.TIMEOUT_MS,
          ),
        ),
      ])) as any;

      // Record success for circuit breaker
      this.recordSuccess();

      servicesLogger().info(
        this.redactSensitiveData({
          zoneId: params.zoneId,
          recordId: recordResponse.id,
          type: params.type,
          name: params.name,
        }),
        "Created DNS record in Cloudflare",
      );

      return recordResponse.id;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Parse error and record failure if retriable
      const { errorCode, isRetriable } = this.parseApiError(error);
      if (isRetriable) {
        this.recordFailure(errorCode);
      }

      servicesLogger().error(
        this.redactSensitiveData({
          error: errorMessage,
          errorCode,
          zoneId: params.zoneId,
          type: params.type,
          name: params.name,
        }),
        "Failed to create DNS record in Cloudflare",
      );

      throw error;
    }
  }

  /**
   * Delete DNS record from Cloudflare
   * @param zoneId - Zone ID
   * @param recordId - DNS record ID to delete
   */
  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    // Check circuit breaker
    if (this.isCircuitBreakerOpen()) {
      throw new Error("Circuit breaker is open, cannot delete DNS record");
    }

    try {
      const apiToken = await this.getApiToken();

      if (!apiToken) {
        throw new Error("Cloudflare API token not configured");
      }

      const cf = new Cloudflare({
        apiToken,
      });

      // Delete DNS record
      await Promise.race([
        cf.dns.records.delete(recordId, { zone_id: zoneId }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Delete DNS record API request timeout")),
            CloudflareConfigService.TIMEOUT_MS,
          ),
        ),
      ]);

      // Record success for circuit breaker
      this.recordSuccess();

      servicesLogger().info(
        { zoneId, recordId },
        "Deleted DNS record from Cloudflare",
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Parse error and record failure if retriable
      const { errorCode, isRetriable } = this.parseApiError(error);
      if (isRetriable) {
        this.recordFailure(errorCode);
      }

      servicesLogger().error(
        this.redactSensitiveData({
          error: errorMessage,
          errorCode,
          zoneId,
          recordId,
        }),
        "Failed to delete DNS record from Cloudflare",
      );

      throw error;
    }
  }

  /**
   * Remove API token and account ID
   * @param userId - User ID who is removing the configuration
   */
  async removeConfiguration(userId: string): Promise<void> {
    try {
      await this.delete(CloudflareConfigService.API_TOKEN_KEY, userId);
    } catch (error) {
      // Token might not exist, continue
    }

    try {
      const oldAccountId = await this.get(
        CloudflareConfigService.ACCOUNT_ID_KEY,
      );
      await this.delete(CloudflareConfigService.ACCOUNT_ID_KEY, userId);
    } catch (error) {
      // Account ID might not exist, continue
    }

    // Record disconnection status
    await this.recordConnectivityStatus(
      "failed",
      undefined,
      "Configuration removed by user",
      "CONFIG_REMOVED",
      undefined,
      userId,
    );
  }
}
