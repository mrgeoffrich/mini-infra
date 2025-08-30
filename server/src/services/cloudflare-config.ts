import { PrismaClient } from "../generated/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  ConnectivityStatusType,
} from "@mini-infra/types";
import { ConfigurationService } from "./configuration-base";
import logger from "../lib/logger";
import Cloudflare from "cloudflare";

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
        logger.info(
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
    if (this.circuitBreaker.state === "half-open" || this.circuitBreaker.consecutiveFailures > 0) {
      logger.info(
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
    if (this.circuitBreaker.consecutiveFailures >= CloudflareConfigService.FAILURE_THRESHOLD) {
      this.circuitBreaker.state = "open";
      this.circuitBreaker.nextRetryTime = new Date(
        Date.now() + CloudflareConfigService.COOLDOWN_PERIOD_MS,
      );
      
      logger.warn(
        {
          consecutiveFailures: this.circuitBreaker.consecutiveFailures,
          errorCode,
          nextRetryTime: this.circuitBreaker.nextRetryTime,
        },
        "Circuit breaker opened due to consecutive failures",
      );
    } else {
      logger.debug(
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
      const sensitiveKeys = ["apiToken", "api_token", "token", "secret", "password", "key"];
      
      for (const key of Object.keys(redacted)) {
        if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
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
   * @returns ValidationResult with connectivity status and details
   */
  async validate(): Promise<ValidationResult> {
    const startTime = Date.now();
    
    // Check for request deduplication
    if (this.pendingValidation) {
      const timeSinceRequest = Date.now() - this.pendingValidation.timestamp;
      if (timeSinceRequest < CloudflareConfigService.DEDUP_WINDOW_MS) {
        logger.debug(
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
        
      logger.info(
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
    const validationPromise = this.performValidation(startTime);
    
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
   * @returns ValidationResult with connectivity status and details
   */
  private async performValidation(startTime: number): Promise<ValidationResult> {

    try {
      const apiToken = await this.get(CloudflareConfigService.API_TOKEN_KEY);
      
      logger.debug(
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
      const accountId = await this.get(CloudflareConfigService.ACCOUNT_ID_KEY);
      if (accountId) {
        try {
          accountInfo = await cf.accounts.get({ account_id: accountId });
          metadata.accountName = accountInfo.name;
          metadata.accountId = accountInfo.id;
        } catch (accountError) {
          logger.warn(
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
      
      logger.info(
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
      const { errorCode, connectivityStatus, isRetriable } = this.parseApiError(error);
      
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

      logger.error(
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
    
    logger.info(
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
   * Test tunnel connectivity and retrieve tunnel information
   * Respects circuit breaker state
   * @returns Array of tunnel information or empty array if no tunnels or connection fails
   */
  async getTunnelInfo(): Promise<any[]> {
    // Check circuit breaker before making API call
    if (this.isCircuitBreakerOpen()) {
      logger.warn(
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
        logger.warn("Cannot retrieve tunnel info: API token not configured");
        return [];
      }

      if (!accountId) {
        logger.warn("Cannot retrieve tunnel info: Account ID not configured");
        return [];
      }

      const cf = new Cloudflare({
        apiToken,
      });

      // Fetch tunnels for the account
      const tunnelsResponse = (await Promise.race([
        cf.zeroTrust.tunnels.list({ account_id: accountId }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Tunnel API request timeout")),
            CloudflareConfigService.TIMEOUT_MS,
          ),
        ),
      ])) as any;

      const tunnels = tunnelsResponse.result || [];

      // Record success for circuit breaker
      this.recordSuccess();
      
      logger.info(
        this.redactSensitiveData({
          accountId,
          tunnelCount: tunnels.length,
        }),
        "Successfully retrieved Cloudflare tunnel information",
      );

      return tunnels.map((tunnel: any) => ({
        id: tunnel.id,
        name: tunnel.name,
        status: tunnel.status,
        created_at: tunnel.created_at,
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

      logger.error(
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
