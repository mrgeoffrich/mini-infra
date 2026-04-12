import * as cron from "node-cron";
import prisma from "../../lib/prisma";
import { appLogger } from "../../lib/logger-factory";
import postgresServerService from "./server-manager";
import databaseManagementService from "./database-manager";
import userManagementService from "./user-manager";

const logger = appLogger();

/**
 * ServerHealthScheduler - Manages periodic health checks for PostgreSQL servers
 * Runs health checks, syncs databases and users, and updates server status
 */
export class ServerHealthScheduler {
  private healthCheckTask: cron.ScheduledTask | null = null;
  private syncTask: cron.ScheduledTask | null = null;

  /**
   * Start the health check scheduler
   * Runs every 5 minutes
   */
  startHealthCheckScheduler() {
    if (this.healthCheckTask) {
      logger.warn("Health check scheduler already running");
      return;
    }

    logger.info("Starting PostgreSQL server health check scheduler");

    // Run every 5 minutes
    this.healthCheckTask = cron.schedule("*/5 * * * *", async () => {
      await this.performAllHealthChecks();
    });

    logger.info("PostgreSQL server health check scheduler started");
  }

  /**
   * Stop the health check scheduler
   */
  stopHealthCheckScheduler() {
    if (this.healthCheckTask) {
      this.healthCheckTask.stop();
      this.healthCheckTask = null;
      logger.info("PostgreSQL server health check scheduler stopped");
    }
  }

  /**
   * Start the sync scheduler
   * Runs every 30 minutes to sync databases and users
   */
  startSyncScheduler() {
    if (this.syncTask) {
      logger.warn("Sync scheduler already running");
      return;
    }

    logger.info("Starting PostgreSQL server sync scheduler");

    // Run every 30 minutes
    this.syncTask = cron.schedule("*/30 * * * *", async () => {
      await this.performAllSyncs();
    });

    logger.info("PostgreSQL server sync scheduler started");
  }

  /**
   * Stop the sync scheduler
   */
  stopSyncScheduler() {
    if (this.syncTask) {
      this.syncTask.stop();
      this.syncTask = null;
      logger.info("PostgreSQL server sync scheduler stopped");
    }
  }

  /**
   * Perform health checks on all servers
   */
  async performAllHealthChecks() {
    logger.info("Starting health checks for all PostgreSQL servers");

    try {
      // Get all servers
      const servers = await prisma.postgresServer.findMany({
        select: {
          id: true,
          name: true,
          userId: true,
        },
      });

      logger.info({ count: servers.length }, "Found servers to check");

      let successCount = 0;
      let failureCount = 0;

      // Check each server
      for (const server of servers) {
        try {
          const result = await postgresServerService.performHealthCheck(server.id, server.userId);
          if (result.success) {
            successCount++;
            logger.debug({ serverId: server.id, name: server.name }, "Health check passed");
          } else {
            failureCount++;
            logger.warn({ serverId: server.id, name: server.name, error: result.error }, "Health check failed");
          }
        } catch (error) {
          failureCount++;
          logger.error({ error: (error instanceof Error ? error.message : String(error)), serverId: server.id, name: server.name }, "Health check error");
        }
      }

      logger.info({ successCount, failureCount }, "Completed health checks for all PostgreSQL servers");
    } catch (error) {
      logger.error({ error: (error instanceof Error ? error.message : String(error)) }, "Failed to perform health checks");
    }
  }

  /**
   * Perform sync operations on all servers
   */
  async performAllSyncs() {
    logger.info("Starting sync for all PostgreSQL servers");

    try {
      // Get all healthy servers
      const servers = await prisma.postgresServer.findMany({
        where: {
          healthStatus: "healthy",
        },
        select: {
          id: true,
          name: true,
          userId: true,
        },
      });

      logger.info({ count: servers.length }, "Found healthy servers to sync");

      let successCount = 0;
      let failureCount = 0;

      // Sync each server
      for (const server of servers) {
        try {
          // Sync databases
          await databaseManagementService.syncDatabases(server.id, server.userId);

          // Sync users
          await userManagementService.syncUsers(server.id, server.userId);

          successCount++;
          logger.debug({ serverId: server.id, name: server.name }, "Sync completed");
        } catch (error) {
          failureCount++;
          logger.error({ error: (error instanceof Error ? error.message : String(error)), serverId: server.id, name: server.name }, "Sync error");
        }
      }

      logger.info({ successCount, failureCount }, "Completed sync for all PostgreSQL servers");
    } catch (error) {
      logger.error({ error: (error instanceof Error ? error.message : String(error)) }, "Failed to perform syncs");
    }
  }

  /**
   * Perform health check for a specific server
   */
  async performHealthCheckForServer(serverId: string, userId: string) {
    logger.info({ serverId }, "Performing health check for server");

    try {
      const result = await postgresServerService.performHealthCheck(serverId, userId);
      logger.info({ serverId, success: result.success }, "Health check completed");
      return result;
    } catch (error) {
      logger.error({ error: (error instanceof Error ? error.message : String(error)), serverId }, "Health check failed");
      throw error;
    }
  }

  /**
   * Perform sync for a specific server
   */
  async performSyncForServer(serverId: string, userId: string) {
    logger.info({ serverId }, "Performing sync for server");

    try {
      // Sync databases
      const dbResult = await databaseManagementService.syncDatabases(serverId, userId);

      // Sync users
      const userResult = await userManagementService.syncUsers(serverId, userId);

      logger.info({ serverId, databases: dbResult.synced, users: userResult.synced }, "Sync completed");
      return {
        databases: dbResult.synced,
        users: userResult.synced,
      };
    } catch (error) {
      logger.error({ error: (error instanceof Error ? error.message : String(error)), serverId }, "Sync failed");
      throw error;
    }
  }

  /**
   * Start all schedulers
   */
  startAll() {
    this.startHealthCheckScheduler();
    this.startSyncScheduler();
  }

  /**
   * Stop all schedulers
   */
  stopAll() {
    this.stopHealthCheckScheduler();
    this.stopSyncScheduler();
  }
}

export default new ServerHealthScheduler();
