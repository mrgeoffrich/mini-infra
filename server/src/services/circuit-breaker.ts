import { ValidationResult, ConnectivityStatusType } from "@mini-infra/types";
import { servicesLogger } from "../lib/logger-factory";

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
 * Error mapper configuration for service-specific error parsing
 */
export interface ErrorMapper {
  /** Match by regex on the error message or by a predicate function */
  pattern: RegExp | ((error: unknown) => boolean);
  errorCode: string;
  connectivityStatus: ConnectivityStatusType;
  isRetriable: boolean;
}

/**
 * Parsed error result from the circuit breaker
 */
export interface ParsedError {
  errorCode: string;
  connectivityStatus: ConnectivityStatusType;
  isRetriable: boolean;
}

/**
 * Configuration options for the CircuitBreaker
 */
export interface CircuitBreakerOptions {
  /** Service name for log messages (e.g. "Cloudflare", "GitHub") */
  serviceName: string;
  /** Number of consecutive failures before opening circuit (default: 5) */
  failureThreshold?: number;
  /** Cooldown period in ms before retrying after circuit opens (default: 5 minutes) */
  cooldownPeriodMs?: number;
  /** Deduplication window in ms for validation requests (default: 1 second) */
  dedupWindowMs?: number;
  /** Ordered array of error matchers for service-specific error parsing */
  errorMappers?: ErrorMapper[];
  /** Fallback error code when no mapper matches (e.g. "CLOUDFLARE_API_ERROR") */
  defaultErrorCode?: string;
  /** Regex patterns for token redaction in string data */
  tokenRedactPatterns?: RegExp[];
  /** Key names to redact in object data */
  sensitiveKeys?: string[];
}

/**
 * CircuitBreaker provides resilient API communication with:
 * - Circuit breaker pattern (closed -> open -> half-open -> closed)
 * - Request deduplication for validation calls
 * - Service-specific error parsing via configurable error mappers
 * - Sensitive data redaction for logging
 */
export class CircuitBreaker {
  private readonly serviceName: string;
  private readonly failureThreshold: number;
  private readonly cooldownPeriodMs: number;
  private readonly dedupWindowMs: number;
  private readonly errorMappers: ErrorMapper[];
  private readonly defaultErrorCode: string;
  private readonly tokenRedactPatterns: RegExp[];
  private readonly sensitiveKeys: string[];

  private circuitState: CircuitBreakerState = {
    state: "closed",
    consecutiveFailures: 0,
  };

  private pendingValidation: PendingRequest | null = null;

  constructor(options: CircuitBreakerOptions) {
    this.serviceName = options.serviceName;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownPeriodMs = options.cooldownPeriodMs ?? 5 * 60 * 1000;
    this.dedupWindowMs = options.dedupWindowMs ?? 1000;
    this.errorMappers = options.errorMappers ?? [];
    this.defaultErrorCode = options.defaultErrorCode ?? "API_ERROR";
    this.tokenRedactPatterns = options.tokenRedactPatterns ?? [];
    this.sensitiveKeys = options.sensitiveKeys ?? [
      "token",
      "secret",
      "password",
      "key",
    ];
  }

  /**
   * Check if the circuit breaker is open (blocking requests)
   * If the cooldown period has passed, transitions to half-open state
   */
  isOpen(): boolean {
    if (this.circuitState.state === "open") {
      // Check if cooldown period has passed
      if (
        this.circuitState.nextRetryTime &&
        new Date() >= this.circuitState.nextRetryTime
      ) {
        // Transition to half-open state to allow retry
        this.circuitState.state = "half-open";
        servicesLogger().info(
          {
            previousFailures: this.circuitState.consecutiveFailures,
            lastFailureTime: this.circuitState.lastFailureTime,
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
  recordSuccess(): void {
    if (
      this.circuitState.state === "half-open" ||
      this.circuitState.consecutiveFailures > 0
    ) {
      servicesLogger().info(
        {
          previousState: this.circuitState.state,
          previousFailures: this.circuitState.consecutiveFailures,
        },
        "Circuit breaker reset after successful API call",
      );
    }

    this.circuitState = {
      state: "closed",
      consecutiveFailures: 0,
      lastSuccessTime: new Date(),
    };
  }

  /**
   * Record a failed API call and update circuit breaker state
   * @param errorCode The error code from the API failure
   */
  recordFailure(errorCode: string): void {
    this.circuitState.consecutiveFailures++;
    this.circuitState.lastFailureTime = new Date();

    // Check if we should open the circuit
    if (this.circuitState.consecutiveFailures >= this.failureThreshold) {
      this.circuitState.state = "open";
      this.circuitState.nextRetryTime = new Date(
        Date.now() + this.cooldownPeriodMs,
      );

      servicesLogger().warn(
        {
          consecutiveFailures: this.circuitState.consecutiveFailures,
          errorCode,
          nextRetryTime: this.circuitState.nextRetryTime,
        },
        "Circuit breaker opened due to consecutive failures",
      );
    } else {
      servicesLogger().debug(
        {
          consecutiveFailures: this.circuitState.consecutiveFailures,
          threshold: this.failureThreshold,
          errorCode,
        },
        "API failure recorded, circuit breaker still closed",
      );
    }
  }

  /**
   * Parse and categorize an error using the configured error mappers
   * @param error The error to parse
   * @returns Categorized error information
   */
  parseError(error: unknown): ParsedError {
    const errorMessage = error instanceof Error ? error.message : String(error);

    for (const mapper of this.errorMappers) {
      let matches: boolean;

      if (typeof mapper.pattern === "function") {
        matches = mapper.pattern(error);
      } else {
        matches = mapper.pattern.test(errorMessage);
      }

      if (matches) {
        return {
          errorCode: mapper.errorCode,
          connectivityStatus: mapper.connectivityStatus,
          isRetriable: mapper.isRetriable,
        };
      }
    }

    return {
      errorCode: this.defaultErrorCode,
      connectivityStatus: "failed",
      isRetriable: true,
    };
  }

  /**
   * Redact sensitive information from data for safe logging
   * @param data The data to redact
   * @returns Redacted copy of the data
   */
  redact(data: unknown): unknown {
    if (typeof data === "string") {
      let result = data;
      for (const pattern of this.tokenRedactPatterns) {
        // Create a new RegExp from the pattern to avoid shared lastIndex state
        const freshPattern = new RegExp(pattern.source, pattern.flags);
        result = result.replace(freshPattern, "[REDACTED_TOKEN]");
      }
      return result;
    }

    if (typeof data === "object" && data !== null) {
      const redacted: Record<string, unknown> = { ...(data as Record<string, unknown>) };

      for (const key of Object.keys(redacted)) {
        if (
          this.sensitiveKeys.some((sensitive) =>
            key.toLowerCase().includes(sensitive),
          )
        ) {
          redacted[key] = "[REDACTED]";
        } else if (typeof redacted[key] === "object") {
          redacted[key] = this.redact(redacted[key]);
        }
      }

      return redacted;
    }

    return data;
  }

  /**
   * Validate with deduplication and circuit breaker protection.
   * Wraps the actual validation function with dedup window checks and
   * circuit breaker state management.
   *
   * @param fn The actual validation function to execute
   * @param settings Optional settings to pass through to the validation function
   * @returns ValidationResult
   */
  async validateWithDedup(
    fn: (startTime: number, settings?: Record<string, string>) => Promise<ValidationResult>,
    settings?: Record<string, string>,
  ): Promise<ValidationResult> {
    const startTime = Date.now();

    // Check for request deduplication
    if (this.pendingValidation) {
      const timeSinceRequest = Date.now() - this.pendingValidation.timestamp;
      if (timeSinceRequest < this.dedupWindowMs) {
        servicesLogger().debug(
          {
            timeSinceRequest,
            dedupWindow: this.dedupWindowMs,
          },
          "Deduplicating validation request within time window",
        );
        return this.pendingValidation.promise;
      }
    }

    // Check circuit breaker state
    if (this.isOpen()) {
      const timeSinceFailure = this.circuitState.lastFailureTime
        ? Date.now() - this.circuitState.lastFailureTime.getTime()
        : 0;
      const timeUntilRetry = this.circuitState.nextRetryTime
        ? this.circuitState.nextRetryTime.getTime() - Date.now()
        : 0;

      servicesLogger().info(
        {
          circuitState: "open",
          consecutiveFailures: this.circuitState.consecutiveFailures,
          timeSinceFailure,
          timeUntilRetry,
        },
        "Circuit breaker is open, skipping validation",
      );

      const result: ValidationResult = {
        isValid: false,
        message: `Circuit breaker open after ${this.circuitState.consecutiveFailures} consecutive failures. Retry in ${Math.ceil(timeUntilRetry / 1000)} seconds.`,
        errorCode: "CIRCUIT_BREAKER_OPEN",
        responseTimeMs: Date.now() - startTime,
      };

      return result;
    }

    // Create the validation promise
    const validationPromise = fn(startTime, settings);

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
   * Explicitly reset the circuit breaker to closed state.
   * Used when new credentials are set.
   */
  reset(): void {
    this.circuitState = {
      state: "closed",
      consecutiveFailures: 0,
    };
  }

  /**
   * Get the current number of consecutive failures (for logging)
   */
  get consecutiveFailures(): number {
    return this.circuitState.consecutiveFailures;
  }

  /**
   * Get the current circuit breaker state name (for logging)
   */
  get state(): string {
    return this.circuitState.state;
  }
}
