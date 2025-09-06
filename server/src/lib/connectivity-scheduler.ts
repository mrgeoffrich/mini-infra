import prisma from "./prisma";
import { ConfigurationServiceFactory } from "../services/configuration-factory";
import { SettingsCategory, ConnectivityStatusType } from "@mini-infra/types";
import { appLogger } from "./logger-factory";

// Use app logger for connectivity scheduler
const logger = appLogger();

/**
 * CircuitBreakerState represents the possible states of a circuit breaker
 */
type CircuitBreakerState = "closed" | "open" | "half-open";

/**
 * CircuitBreaker implements the circuit breaker pattern for handling failures
 */
class CircuitBreaker {
  private state: CircuitBreakerState = "closed";
  private failures = 0;
  private readonly failureThreshold: number;
  private readonly timeout: number;
  private nextAttempt = Date.now();

  constructor(failureThreshold = 5, timeout = 60000) {
    this.failureThreshold = failureThreshold;
    this.timeout = timeout;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.state === "open") {
      if (Date.now() < this.nextAttempt) {
        logger.warn("Circuit breaker is open, skipping execution");
        return null;
      }
      this.state = "half-open";
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.failures++;
    if (this.failures >= this.failureThreshold) {
      this.state = "open";
      this.nextAttempt = Date.now() + this.timeout;
      logger.warn(
        {
          failures: this.failures,
          nextAttempt: new Date(this.nextAttempt).toISOString(),
        },
        "Circuit breaker opened due to failures",
      );
    }
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  getFailures(): number {
    return this.failures;
  }
}

/**
 * ExponentialBackoff implements exponential backoff for retrying failed operations
 */
class ExponentialBackoff {
  private attempts = 0;
  private readonly maxAttempts: number;
  private readonly baseDelay: number;
  private readonly maxDelay: number;
  private readonly delayFn: (ms: number) => Promise<void>;

  constructor(
    maxAttempts = 5,
    baseDelay = 1000,
    maxDelay = 30000,
    delayFn: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.maxAttempts = maxAttempts;
    this.baseDelay = baseDelay;
    this.maxDelay = maxDelay;
    this.delayFn = delayFn;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    while (this.attempts < this.maxAttempts) {
      try {
        const result = await fn();
        this.reset();
        return result;
      } catch (error) {
        this.attempts++;
        const isLastAttempt = this.attempts >= this.maxAttempts;

        if (isLastAttempt) {
          logger.error(
            {
              attempts: this.attempts,
              error: error instanceof Error ? error.message : "Unknown error",
            },
            "Exponential backoff failed after maximum attempts",
          );
          throw error;
        }

        const delay = Math.min(
          this.baseDelay * Math.pow(2, this.attempts - 1),
          this.maxDelay,
        );

        logger.warn(
          {
            attempt: this.attempts,
            nextDelay: delay,
            error: error instanceof Error ? error.message : "Unknown error",
          },
          "Operation failed, retrying with exponential backoff",
        );

        await this.delayFn(delay);
      }
    }

    throw new Error("Maximum retry attempts exceeded");
  }

  private reset(): void {
    this.attempts = 0;
  }
}

/**
 * ServiceMonitor handles monitoring of a single service
 */
class ServiceMonitor {
  private readonly service: SettingsCategory;
  private readonly factory: ConfigurationServiceFactory;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly backoff: ExponentialBackoff;
  private lastStatus: ConnectivityStatusType = "unreachable";

  constructor(
    service: SettingsCategory,
    factory: ConfigurationServiceFactory,
    delayFn?: (ms: number) => Promise<void>,
  ) {
    this.service = service;
    this.factory = factory;
    this.circuitBreaker = new CircuitBreaker(3, 300000); // 3 failures, 5min timeout
    this.backoff = new ExponentialBackoff(3, 2000, 60000, delayFn); // 3 attempts, 2s-60s delay
  }

  async performHealthCheck(): Promise<void> {
    const serviceInstance = this.factory.create({ category: this.service });

    try {
      const result = await this.circuitBreaker.execute(async () => {
        return await this.backoff.execute(async () => {
          return await serviceInstance.validate();
        });
      });

      if (result) {
        const newStatus: ConnectivityStatusType = result.isValid
          ? "connected"
          : "failed";

        if (this.lastStatus !== newStatus) {
          logger.info(
            {
              service: this.service,
              previousStatus: this.lastStatus,
              newStatus: newStatus,
              responseTime: result.responseTimeMs,
            },
            "Service connectivity status changed",
          );
        }

        this.lastStatus = newStatus;
      } else {
        logger.warn(
          {
            service: this.service,
            circuitBreakerState: this.circuitBreaker.getState(),
          },
          "Health check skipped due to circuit breaker",
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      if (this.lastStatus !== "failed") {
        logger.error(
          {
            service: this.service,
            error: errorMessage,
            circuitBreakerFailures: this.circuitBreaker.getFailures(),
          },
          "Service health check failed",
        );
      }

      this.lastStatus = "failed";
    }
  }

  getService(): SettingsCategory {
    return this.service;
  }

  getLastStatus(): ConnectivityStatusType {
    return this.lastStatus;
  }

  getCircuitBreakerState(): CircuitBreakerState {
    return this.circuitBreaker.getState();
  }

  getCircuitBreakerFailures(): number {
    return this.circuitBreaker.getFailures();
  }
}

/**
 * ConnectivityScheduler manages periodic health checks for all configuration services
 */
export class ConnectivityScheduler {
  private readonly prisma: typeof prisma;
  private readonly factory: ConfigurationServiceFactory;
  private readonly monitors: Map<SettingsCategory, ServiceMonitor>;
  private readonly checkInterval: number;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    prismaClient: typeof prisma,
    checkInterval: number = 5 * 60 * 1000, // 5 minutes default
    delayFn?: (ms: number) => Promise<void>,
  ) {
    this.prisma = prismaClient;
    this.factory = new ConfigurationServiceFactory(prisma);
    this.monitors = new Map();
    this.checkInterval = checkInterval;

    // Initialize monitors for all supported services
    const supportedCategories = this.factory.getSupportedCategories();
    for (const category of supportedCategories) {
      this.monitors.set(
        category,
        new ServiceMonitor(category, this.factory, delayFn),
      );
    }

    logger.info(
      {
        services: supportedCategories,
        checkIntervalMs: checkInterval,
      },
      "ConnectivityScheduler initialized",
    );
  }

  /**
   * Start the periodic health check scheduler
   */
  start(): void {
    if (this.isRunning) {
      logger.warn("ConnectivityScheduler is already running");
      return;
    }

    logger.info("Starting ConnectivityScheduler");

    // Perform initial health checks
    this.performAllHealthChecks();

    // Schedule periodic health checks
    this.intervalId = setInterval(() => {
      this.performAllHealthChecks();
    }, this.checkInterval);

    this.isRunning = true;

    logger.info(
      {
        checkIntervalMs: this.checkInterval,
        nextCheckAt: new Date(Date.now() + this.checkInterval).toISOString(),
      },
      "ConnectivityScheduler started successfully",
    );
  }

  /**
   * Stop the periodic health check scheduler
   */
  stop(): void {
    if (!this.isRunning) {
      logger.warn("ConnectivityScheduler is not running");
      return;
    }

    logger.info("Stopping ConnectivityScheduler");

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isRunning = false;

    logger.info("ConnectivityScheduler stopped successfully");
  }

  /**
   * Perform health checks for all services
   */
  private async performAllHealthChecks(): Promise<void> {
    const startTime = Date.now();
    const promises: Promise<void>[] = [];

    logger.debug(
      {
        serviceCount: this.monitors.size,
      },
      "Starting health checks for all services",
    );

    // Execute all health checks in parallel
    for (const [service, monitor] of this.monitors) {
      promises.push(
        (async () => {
          try {
            await monitor.performHealthCheck();
          } catch (error) {
            logger.error(
              {
                service: service,
                error: error instanceof Error ? error.message : "Unknown error",
              },
              "Health check failed for service",
            );
          }
        })(),
      );
    }

    // Wait for all health checks to complete
    await Promise.all(promises);

    const totalTime = Date.now() - startTime;

    // Log summary
    const statusSummary = Array.from(this.monitors.entries()).map(
      ([service, monitor]) => ({
        service,
        status: monitor.getLastStatus(),
        circuitBreakerState: monitor.getCircuitBreakerState(),
        circuitBreakerFailures: monitor.getCircuitBreakerFailures(),
      }),
    );

    logger.info(
      {
        totalTimeMs: totalTime,
        services: statusSummary,
        nextCheckAt: new Date(Date.now() + this.checkInterval).toISOString(),
      },
      "Health check cycle completed",
    );
  }

  /**
   * Perform health check for a specific service
   * @param service - The service to check
   */
  async performHealthCheck(service: SettingsCategory): Promise<void> {
    const monitor = this.monitors.get(service);
    if (!monitor) {
      throw new Error(`Unsupported service: ${service}`);
    }

    logger.info({ service }, "Performing on-demand health check");
    await monitor.performHealthCheck();
  }

  /**
   * Get the current status of all services
   * @returns Map of service statuses
   */
  getServiceStatuses(): Map<SettingsCategory, ConnectivityStatusType> {
    const statuses = new Map<SettingsCategory, ConnectivityStatusType>();
    for (const [service, monitor] of this.monitors) {
      statuses.set(service, monitor.getLastStatus());
    }
    return statuses;
  }

  /**
   * Get detailed monitoring information for all services
   */
  getMonitoringInfo(): Array<{
    service: SettingsCategory;
    status: ConnectivityStatusType;
    circuitBreakerState: CircuitBreakerState;
    circuitBreakerFailures: number;
  }> {
    return Array.from(this.monitors.entries()).map(([service, monitor]) => ({
      service,
      status: monitor.getLastStatus(),
      circuitBreakerState: monitor.getCircuitBreakerState(),
      circuitBreakerFailures: monitor.getCircuitBreakerFailures(),
    }));
  }

  /**
   * Check if the scheduler is currently running
   */
  isSchedulerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get the configured check interval
   */
  getCheckInterval(): number {
    return this.checkInterval;
  }
}
