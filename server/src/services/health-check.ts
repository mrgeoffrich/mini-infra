import { HttpClient, HttpError, isHttpError } from "../lib/http-client";
import { ValidationResult } from "@mini-infra/types";
import { servicesLogger } from "../lib/logger-factory";

/**
 * Health check configuration interface
 */
export interface HealthCheckConfig {
  endpoint: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  expectedStatuses?: number[];
  responseBodyPattern?: string; // regex pattern
  responseTimeThreshold?: number; // milliseconds
}

/**
 * Health check result interface
 */
export interface HealthCheckResult {
  success: boolean;
  statusCode?: number;
  responseTime: number;
  responseBody?: any;
  errorMessage?: string;
  validationDetails?: {
    statusCode: boolean;
    bodyPattern: boolean;
    responseTime: boolean;
  };
}

/**
 * Circuit breaker state for health checks
 */
interface CircuitBreakerState {
  state: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  lastFailureTime?: Date;
  nextRetryTime?: Date;
}

/**
 * HealthCheckService provides HTTP-based health checking with advanced features:
 * - Configurable retry logic with exponential backoff
 * - Response validation (status codes, body patterns, custom expressions)
 * - Circuit breaker pattern to prevent cascading failures
 * - Progressive health checking (basic to comprehensive)
 * - Response time monitoring and thresholds
 */
export class HealthCheckService {
  private static readonly DEFAULT_TIMEOUT = 10000; // 10 seconds
  private static readonly DEFAULT_RETRIES = 3;
  private static readonly DEFAULT_RETRY_DELAY = 1000; // 1 second
  private static readonly DEFAULT_EXPECTED_STATUSES = [200, 201, 202, 204];
  private static readonly CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
  private static readonly CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly RESPONSE_TIME_THRESHOLD = 30000; // 30 seconds

  private circuitBreakers = new Map<string, CircuitBreakerState>();
  private httpClient: HttpClient;

  constructor() {
    this.httpClient = new HttpClient({
      timeout: HealthCheckService.DEFAULT_TIMEOUT,
    });
  }

  /**
   * Get circuit breaker key for endpoint
   */
  private getCircuitBreakerKey(endpoint: string): string {
    try {
      const url = new URL(endpoint);
      return `${url.protocol}//${url.host}`;
    } catch {
      return endpoint;
    }
  }

  /**
   * Check if circuit breaker allows requests
   */
  private isCircuitBreakerOpen(endpoint: string): boolean {
    const key = this.getCircuitBreakerKey(endpoint);
    const breaker = this.circuitBreakers.get(key);

    if (!breaker || breaker.state === "closed") {
      return false;
    }

    if (breaker.state === "open") {
      // Check if cooldown period has passed
      if (breaker.nextRetryTime && new Date() >= breaker.nextRetryTime) {
        // Transition to half-open
        breaker.state = "half-open";
        servicesLogger().info(
          {
            endpoint: key,
            previousFailures: breaker.consecutiveFailures,
            lastFailureTime: breaker.lastFailureTime,
          },
          "Health check circuit breaker transitioning to half-open state",
        );
        return false;
      }
      return true;
    }

    return false; // half-open allows requests
  }

  /**
   * Record circuit breaker success
   */
  private recordCircuitBreakerSuccess(endpoint: string): void {
    const key = this.getCircuitBreakerKey(endpoint);
    const breaker = this.circuitBreakers.get(key);

    if (
      breaker &&
      (breaker.state === "half-open" || breaker.consecutiveFailures > 0)
    ) {
      servicesLogger().info(
        {
          endpoint: key,
          previousState: breaker.state,
          previousFailures: breaker.consecutiveFailures,
        },
        "Health check circuit breaker reset after successful request",
      );
    }

    this.circuitBreakers.set(key, {
      state: "closed",
      consecutiveFailures: 0,
    });
  }

  /**
   * Record circuit breaker failure
   */
  private recordCircuitBreakerFailure(endpoint: string): void {
    const key = this.getCircuitBreakerKey(endpoint);
    const breaker = this.circuitBreakers.get(key) || {
      state: "closed" as const,
      consecutiveFailures: 0,
    };

    breaker.consecutiveFailures++;
    breaker.lastFailureTime = new Date();

    if (
      breaker.consecutiveFailures >=
      HealthCheckService.CIRCUIT_BREAKER_FAILURE_THRESHOLD
    ) {
      breaker.state = "open";
      breaker.nextRetryTime = new Date(
        Date.now() + HealthCheckService.CIRCUIT_BREAKER_COOLDOWN_MS,
      );

      servicesLogger().warn(
        {
          endpoint: key,
          consecutiveFailures: breaker.consecutiveFailures,
          nextRetryTime: breaker.nextRetryTime,
        },
        "Health check circuit breaker opened due to consecutive failures",
      );
    } else {
      servicesLogger().debug(
        {
          endpoint: key,
          consecutiveFailures: breaker.consecutiveFailures,
          threshold: HealthCheckService.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
        },
        "Health check failure recorded, circuit breaker still closed",
      );
    }

    this.circuitBreakers.set(key, breaker);
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Validate response body against pattern
   */
  private validateResponseBody(body: any, pattern?: string): boolean {
    if (!pattern) return true;

    try {
      const regex = new RegExp(pattern);
      const bodyString = typeof body === "string" ? body : JSON.stringify(body);
      return regex.test(bodyString);
    } catch (error) {
      servicesLogger().warn(
        {
          pattern,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Invalid regex pattern for response body validation",
      );
      return false;
    }
  }

  /**
   * Perform single health check request
   */
  private async performSingleCheck(
    config: HealthCheckConfig,
  ): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const requestConfig = {
        headers: config.headers,
        timeout: config.timeout || HealthCheckService.DEFAULT_TIMEOUT,
        validateStatus: () => true, // Accept all status codes
      };

      const method = config.method || "GET";
      let response;
      if (method === "POST") {
        response = await this.httpClient.post(config.endpoint, undefined, requestConfig);
      } else {
        response = await this.httpClient.get(config.endpoint, requestConfig);
      }

      const responseTime = Date.now() - startTime;
      const expectedStatuses =
        config.expectedStatuses || HealthCheckService.DEFAULT_EXPECTED_STATUSES;

      // Validation checks
      const validationDetails = {
        statusCode: expectedStatuses.includes(response.status),
        bodyPattern: this.validateResponseBody(
          response.data,
          config.responseBodyPattern,
        ),
        responseTime:
          !config.responseTimeThreshold ||
          responseTime <= config.responseTimeThreshold,
      };

      const success = Object.values(validationDetails).every(Boolean);

      const result: HealthCheckResult = {
        success,
        statusCode: response.status,
        responseTime,
        responseBody: response.data,
        validationDetails,
      };

      if (!success) {
        const failedChecks = Object.entries(validationDetails)
          .filter(([_, passed]) => !passed)
          .map(([check]) => check);

        result.errorMessage = `Health check failed validation: ${failedChecks.join(", ")}`;
      }


      servicesLogger().debug(
        {
          endpoint: config.endpoint,
          method: config.method || "GET",
          statusCode: response.status,
          responseTime,
          success,
          validationDetails,
        },
        "Health check request completed",
      );

      return result;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      let errorMessage = "Unknown error";
      let statusCode: number | undefined = undefined;


      if (isHttpError(error)) {
        // Handle HTTP errors with response (e.g., 4xx, 5xx status codes)
        if (error.response) {
          statusCode = error.response.status;
          errorMessage = `Health check failed validation: statusCode`;
        } else {
          // Handle network/connection errors
          if (error.code === "ECONNREFUSED") {
            errorMessage = "Connection refused - service may be down";
          } else if (
            error.code === "ETIMEDOUT" ||
            error.message.includes("timeout")
          ) {
            errorMessage = `Request timeout after ${config.timeout || HealthCheckService.DEFAULT_TIMEOUT}ms`;
          } else if (error.code === "ENOTFOUND") {
            errorMessage = "DNS resolution failed - hostname not found";
          } else if (error.code === "ECONNRESET") {
            errorMessage = "Connection reset by server";
          } else {
            errorMessage = error.message || "Network error";
          }
        }
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      servicesLogger().debug(
        {
          endpoint: config.endpoint,
          method: config.method || "GET",
          error: errorMessage,
          errorCode: (error as any)?.code,
          responseTime,
          statusCode,
        },
        "Health check request failed",
      );

      return {
        success: false,
        statusCode,
        responseTime,
        errorMessage,
      };
    }
  }

  /**
   * Perform health check with retry logic
   */
  async performHealthCheck(
    config: HealthCheckConfig,
  ): Promise<HealthCheckResult> {
    const endpoint = config.endpoint;

    // Check circuit breaker
    if (this.isCircuitBreakerOpen(endpoint)) {
      const key = this.getCircuitBreakerKey(endpoint);
      const breaker = this.circuitBreakers.get(key)!;
      const timeUntilRetry = breaker.nextRetryTime
        ? breaker.nextRetryTime.getTime() - Date.now()
        : 0;

      servicesLogger().info(
        {
          endpoint,
          circuitState: "open",
          consecutiveFailures: breaker.consecutiveFailures,
          timeUntilRetry,
        },
        "Health check skipped due to circuit breaker",
      );

      return {
        success: false,
        responseTime: 0,
        errorMessage: `Circuit breaker open after ${breaker.consecutiveFailures} consecutive failures. Retry in ${Math.ceil(timeUntilRetry / 1000)} seconds.`,
      };
    }

    const retries = config.retries ?? HealthCheckService.DEFAULT_RETRIES;
    const baseDelay =
      config.retryDelay ?? HealthCheckService.DEFAULT_RETRY_DELAY;
    let lastResult: HealthCheckResult | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: baseDelay * 2^(attempt-1)
        const delay = baseDelay * Math.pow(2, attempt - 1);
        servicesLogger().debug(
          {
            endpoint,
            attempt,
            totalAttempts: retries + 1,
            retryDelay: delay,
          },
          "Retrying health check after delay",
        );
        await this.sleep(delay);
      }

      const result = await this.performSingleCheck(config);
      lastResult = result;


      if (result.success) {
        this.recordCircuitBreakerSuccess(endpoint);
        servicesLogger().info(
          {
            endpoint,
            attempt: attempt + 1,
            totalAttempts: retries + 1,
            responseTime: result.responseTime,
            statusCode: result.statusCode,
          },
          "Health check succeeded",
        );
        return result;
      }

      // If we got a statusCode, it means we received a valid HTTP response
      // Don't retry for validation failures, only retry for network errors
      if (result.statusCode !== undefined) {
        this.recordCircuitBreakerFailure(endpoint);
        servicesLogger().info(
          {
            endpoint,
            attempt: attempt + 1,
            statusCode: result.statusCode,
            error: result.errorMessage,
          },
          "Health check failed validation, not retrying",
        );
        return result;
      }

      servicesLogger().debug(
        {
          endpoint,
          attempt: attempt + 1,
          totalAttempts: retries + 1,
          error: result.errorMessage,
          willRetry: attempt < retries,
        },
        "Health check attempt failed",
      );
    }

    // All attempts failed
    this.recordCircuitBreakerFailure(endpoint);


    servicesLogger().warn(
      {
        endpoint,
        totalAttempts: retries + 1,
        finalError: lastResult?.errorMessage,
      },
      "Health check failed after all retry attempts",
    );

    return lastResult!;
  }

  /**
   * Perform basic health check (GET request, 200 status only)
   */
  async performBasicHealthCheck(endpoint: string): Promise<HealthCheckResult> {
    return this.performHealthCheck({
      endpoint,
      method: "GET",
      expectedStatuses: [200],
      timeout: 5000, // Shorter timeout for basic checks
      retries: 0, // No retries for basic checks to get immediate feedback
    });
  }

  /**
   * Perform comprehensive health check with all validations
   */
  async performComprehensiveHealthCheck(
    config: HealthCheckConfig,
  ): Promise<HealthCheckResult> {
    const fullConfig: HealthCheckConfig = {
      timeout: HealthCheckService.DEFAULT_TIMEOUT,
      retries: HealthCheckService.DEFAULT_RETRIES,
      retryDelay: HealthCheckService.DEFAULT_RETRY_DELAY,
      expectedStatuses: HealthCheckService.DEFAULT_EXPECTED_STATUSES,
      responseTimeThreshold: HealthCheckService.RESPONSE_TIME_THRESHOLD,
      ...config,
    };

    return this.performHealthCheck(fullConfig);
  }

  /**
   * Perform progressive health check (basic first, then comprehensive if basic passes)
   */
  async performProgressiveHealthCheck(
    config: HealthCheckConfig,
  ): Promise<HealthCheckResult> {
    servicesLogger().info(
      { endpoint: config.endpoint },
      "Starting progressive health check",
    );

    // First, try basic check
    const basicResult = await this.performBasicHealthCheck(config.endpoint);

    if (!basicResult.success) {
      servicesLogger().info(
        {
          endpoint: config.endpoint,
          basicCheckError: basicResult.errorMessage,
        },
        "Progressive health check failed at basic level",
      );
      return basicResult;
    }

    servicesLogger().debug(
      {
        endpoint: config.endpoint,
        basicResponseTime: basicResult.responseTime,
      },
      "Basic health check passed, proceeding to comprehensive check",
    );

    // Basic check passed, now try comprehensive
    const comprehensiveResult =
      await this.performComprehensiveHealthCheck(config);

    servicesLogger().info(
      {
        endpoint: config.endpoint,
        basicResponseTime: basicResult.responseTime,
        comprehensiveResponseTime: comprehensiveResult.responseTime,
        finalResult: comprehensiveResult.success,
      },
      "Progressive health check completed",
    );

    return comprehensiveResult;
  }

  /**
   * Convert health check result to validation result format
   */
  convertToValidationResult(
    result: HealthCheckResult,
    endpoint: string,
  ): ValidationResult {
    return {
      isValid: result.success,
      message: result.success
        ? `Health check passed for ${endpoint}`
        : result.errorMessage || `Health check failed for ${endpoint}`,
      errorCode: result.success ? undefined : "HEALTH_CHECK_FAILED",
      responseTimeMs: result.responseTime,
      metadata: {
        endpoint,
        statusCode: result.statusCode,
        validationDetails: result.validationDetails,
      },
    };
  }

  /**
   * Get circuit breaker status for an endpoint
   */
  getCircuitBreakerStatus(endpoint: string): {
    state: "closed" | "open" | "half-open";
    consecutiveFailures: number;
    lastFailureTime?: Date;
    nextRetryTime?: Date;
  } {
    const key = this.getCircuitBreakerKey(endpoint);
    const breaker = this.circuitBreakers.get(key);

    if (!breaker) {
      return {
        state: "closed",
        consecutiveFailures: 0,
      };
    }

    return { ...breaker };
  }

  /**
   * Reset circuit breaker for an endpoint
   */
  resetCircuitBreaker(endpoint: string): void {
    const key = this.getCircuitBreakerKey(endpoint);
    this.circuitBreakers.delete(key);

    servicesLogger().info({ endpoint: key }, "Circuit breaker manually reset");
  }

  /**
   * Get all circuit breaker statuses
   */
  getAllCircuitBreakerStatuses(): Record<
    string,
    {
      state: "closed" | "open" | "half-open";
      consecutiveFailures: number;
      lastFailureTime?: Date;
      nextRetryTime?: Date;
    }
  > {
    const statuses: Record<string, any> = {};

    for (const [key, breaker] of this.circuitBreakers) {
      statuses[key] = { ...breaker };
    }

    return statuses;
  }
}
