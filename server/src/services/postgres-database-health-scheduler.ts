import prisma from "../lib/prisma";
import { PostgresDatabaseManager } from "./postgres-database-manager";
import { servicesLogger } from "../lib/logger-factory";

/**
 * PostgresDatabaseHealthScheduler manages periodic health checks for PostgreSQL database configurations
 * It periodically checks the health of all configured databases and updates their status
 */
export class PostgresDatabaseHealthScheduler {
  private readonly checkInterval: number;
  private readonly databaseConfigService: PostgresDatabaseManager;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private readonly logger = servicesLogger();

  constructor(checkInterval: number = 10 * 60 * 1000) { // 10 minutes default
    this.checkInterval = checkInterval;
    this.databaseConfigService = new PostgresDatabaseManager(prisma);
  }

  /**
   * Start the periodic health check scheduler
   */
  start(): void {
    if (this.isRunning) {
      this.logger.warn("PostgreSQL database health scheduler is already running");
      return;
    }

    this.logger.info("Starting PostgreSQL database health scheduler");

    // Perform initial health checks
    this.performAllHealthChecks();

    // Schedule periodic health checks
    this.intervalId = setInterval(() => {
      this.performAllHealthChecks();
    }, this.checkInterval);

    this.isRunning = true;

    this.logger.info(
      {
        checkIntervalMs: this.checkInterval,
        nextCheckAt: new Date(Date.now() + this.checkInterval).toISOString(),
      },
      "PostgreSQL database health scheduler started successfully",
    );
  }

  /**
   * Stop the periodic health check scheduler
   */
  stop(): void {
    if (!this.isRunning) {
      this.logger.warn("PostgreSQL database health scheduler is not running");
      return;
    }

    this.logger.info("Stopping PostgreSQL database health scheduler");

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isRunning = false;

    this.logger.info("PostgreSQL database health scheduler stopped successfully");
  }

  /**
   * Perform health checks for all PostgreSQL databases
   */
  private async performAllHealthChecks(): Promise<void> {
    const startTime = Date.now();

    try {
      this.logger.debug("Starting health checks for all PostgreSQL databases");

      // Get all PostgreSQL database configurations
      const databases = await this.databaseConfigService.listDatabases();

      if (databases.length === 0) {
        this.logger.debug("No PostgreSQL databases found to check");
        return;
      }

      this.logger.info(
        { databaseCount: databases.length },
        "Performing health checks for PostgreSQL databases",
      );

      // Execute all health checks in parallel with error handling
      const healthCheckPromises = databases.map(async (database) => {
        try {
          const result = await this.databaseConfigService.performHealthCheck(database.id);

          this.logger.debug(
            {
              databaseId: database.id,
              databaseName: database.name,
              healthStatus: result.healthStatus,
              responseTime: result.responseTime,
            },
            "Database health check completed",
          );

          return {
            databaseId: database.id,
            databaseName: database.name,
            success: true,
            healthStatus: result.healthStatus,
            responseTime: result.responseTime,
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";

          this.logger.error(
            {
              databaseId: database.id,
              databaseName: database.name,
              error: errorMessage,
            },
            "Database health check failed",
          );

          // Update database status to unhealthy when health check fails
          try {
            await prisma.postgresDatabase.update({
              where: { id: database.id },
              data: {
                healthStatus: "unhealthy",
                lastHealthCheck: new Date(),
              },
            });
          } catch (updateError) {
            this.logger.error(
              {
                databaseId: database.id,
                error: updateError instanceof Error ? updateError.message : "Unknown error",
              },
              "Failed to update database health status after health check failure",
            );
          }

          return {
            databaseId: database.id,
            databaseName: database.name,
            success: false,
            error: errorMessage,
          };
        }
      });

      // Wait for all health checks to complete
      const results = await Promise.all(healthCheckPromises);

      const totalTime = Date.now() - startTime;
      const successCount = results.filter(r => r.success).length;
      const failureCount = results.length - successCount;

      // Log summary
      this.logger.info(
        {
          totalTimeMs: totalTime,
          totalDatabases: results.length,
          successCount,
          failureCount,
          nextCheckAt: new Date(Date.now() + this.checkInterval).toISOString(),
        },
        "PostgreSQL database health check cycle completed",
      );

      // Log details for any failures
      if (failureCount > 0) {
        const failures = results.filter(r => !r.success);
        this.logger.warn(
          {
            failures: failures.map(f => ({
              databaseId: f.databaseId,
              databaseName: f.databaseName,
              error: f.error,
            })),
          },
          "Some database health checks failed",
        );
      }

    } catch (error) {
      const totalTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      this.logger.error(
        {
          totalTimeMs: totalTime,
          error: errorMessage,
        },
        "Failed to perform PostgreSQL database health checks",
      );
    }
  }

  /**
   * Perform health check for a specific database
   * @param databaseId - The database ID to check
   */
  async performHealthCheck(databaseId: string): Promise<void> {
    this.logger.info({ databaseId }, "Performing on-demand health check for database");

    try {
      await this.databaseConfigService.performHealthCheck(databaseId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      this.logger.error(
        {
          databaseId,
          error: errorMessage,
        },
        "On-demand database health check failed",
      );
      throw error;
    }
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

  /**
   * Get health status summary for all databases
   */
  async getHealthStatusSummary(): Promise<{
    total: number;
    healthy: number;
    unhealthy: number;
    unknown: number;
  }> {
    try {
      const databases = await this.databaseConfigService.listDatabases();

      const summary = {
        total: databases.length,
        healthy: 0,
        unhealthy: 0,
        unknown: 0,
      };

      for (const database of databases) {
        switch (database.healthStatus) {
          case "healthy":
            summary.healthy++;
            break;
          case "unhealthy":
            summary.unhealthy++;
            break;
          default:
            summary.unknown++;
            break;
        }
      }

      return summary;
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get health status summary",
      );
      throw error;
    }
  }
}