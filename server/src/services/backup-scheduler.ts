import prisma, { PrismaClient } from "../lib/prisma";
import * as cron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { servicesLogger } from "../lib/logger-factory";
import { BackupConfigService } from "./backup-config";
import { BackupExecutorService } from "./backup-executor";
import { BackupOperationType } from "@mini-infra/types";

/**
 * Scheduled job information
 */
export interface ScheduledJob {
  id: string;
  databaseId: string;
  schedule: string;
  timezone: string;
  task: cron.ScheduledTask;
  isEnabled: boolean;
  nextScheduledAt: Date | null;
}

/**
 * BackupSchedulerService manages cron-based backup scheduling
 */
export class BackupSchedulerService {
  private static instance: BackupSchedulerService | null = null;
  private prisma: PrismaClient;
  private backupConfigService: BackupConfigService;
  private backupExecutorService: BackupExecutorService;
  private scheduledJobs: Map<string, ScheduledJob> = new Map();
  private isInitialized = false;

  constructor(prisma: typeof prisma) {
    this.prisma = prisma;
    this.backupConfigService = new BackupConfigService(prisma);
    this.backupExecutorService = new BackupExecutorService(prisma);
  }

  /**
   * Get the singleton instance of BackupSchedulerService
   */
  public static getInstance(prisma?: typeof prisma): BackupSchedulerService | null {
    if (!BackupSchedulerService.instance && prisma) {
      BackupSchedulerService.instance = new BackupSchedulerService(prisma);
    }
    return BackupSchedulerService.instance;
  }

  /**
   * Set the singleton instance (used by server initialization)
   */
  public static setInstance(instance: BackupSchedulerService): void {
    BackupSchedulerService.instance = instance;
  }

  /**
   * Initialize the scheduler service and load existing schedules
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Initialize dependencies
      await this.backupExecutorService.initialize();

      // Load existing backup configurations with schedules
      await this.loadExistingSchedules();

      servicesLogger().info("BackupSchedulerService initialized successfully");
      this.isInitialized = true;
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to initialize BackupSchedulerService",
      );
      throw error;
    }
  }

  /**
   * Register a scheduled backup job
   */
  public async registerSchedule(
    databaseId: string,
    schedule: string,
    timezone: string,
    userId: string,
  ): Promise<void> {
    // Note: Don't auto-initialize here to avoid recursive loops during initialization

    try {
      // Validate cron expression
      if (!cron.validate(schedule)) {
        throw new Error(`Invalid cron expression: ${schedule}`);
      }

      // Remove existing schedule if it exists
      await this.unregisterSchedule(databaseId);

      // Create scheduled task (initially stopped)
      const task = cron.schedule(
        schedule,
        async () => {
          await this.executeScheduledBackup(databaseId, userId);
        },
        {
          timezone: timezone,
        },
      );

      // Stop the task initially - it will be started when enabled
      task.stop();

      // Calculate next scheduled time
      const nextScheduledAt = this.calculateNextRunTime(schedule, timezone);

      // Store job information
      const scheduledJob: ScheduledJob = {
        id: `${databaseId}-${Date.now()}`,
        databaseId,
        schedule,
        timezone,
        task,
        isEnabled: false,
        nextScheduledAt,
      };

      this.scheduledJobs.set(databaseId, scheduledJob);

      // Update database with next scheduled time
      await this.updateNextScheduledTime(databaseId, nextScheduledAt);

      servicesLogger().info(
        {
          databaseId,
          schedule,
          nextScheduledAt: nextScheduledAt?.toISOString(),
        },
        "Backup schedule registered",
      );
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          databaseId,
          schedule,
          userId,
        },
        "Failed to register backup schedule",
      );
      throw error;
    }
  }

  /**
   * Unregister a scheduled backup job
   */
  public async unregisterSchedule(databaseId: string): Promise<void> {
    try {
      const existingJob = this.scheduledJobs.get(databaseId);
      if (existingJob) {
        // Stop and destroy the cron task
        existingJob.task.stop();
        existingJob.task.destroy();

        // Remove from map
        this.scheduledJobs.delete(databaseId);

        // Clear next scheduled time in database
        await this.updateNextScheduledTime(databaseId, null);

        servicesLogger().info({ databaseId }, "Backup schedule unregistered");
      }
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          databaseId,
        },
        "Failed to unregister backup schedule",
      );
      throw error;
    }
  }

  /**
   * Enable a scheduled backup job
   */
  public async enableSchedule(databaseId: string): Promise<void> {
    try {
      const job = this.scheduledJobs.get(databaseId);
      if (!job) {
        throw new Error("Schedule not found for database");
      }

      if (!job.isEnabled) {
        job.task.start();
        job.isEnabled = true;

        // Update next scheduled time
        job.nextScheduledAt = this.calculateNextRunTime(job.schedule, job.timezone);
        await this.updateNextScheduledTime(databaseId, job.nextScheduledAt);

        servicesLogger().info(
          {
            databaseId,
            nextScheduledAt: job.nextScheduledAt?.toISOString(),
          },
          "Backup schedule enabled",
        );
      }
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          databaseId,
        },
        "Failed to enable backup schedule",
      );
      throw error;
    }
  }

  /**
   * Disable a scheduled backup job
   */
  public async disableSchedule(databaseId: string): Promise<void> {
    try {
      const job = this.scheduledJobs.get(databaseId);
      if (!job) {
        throw new Error("Schedule not found for database");
      }

      if (job.isEnabled) {
        job.task.stop();
        job.isEnabled = false;

        // Clear next scheduled time
        job.nextScheduledAt = null;
        await this.updateNextScheduledTime(databaseId, null);

        servicesLogger().info({ databaseId }, "Backup schedule disabled");
      }
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          databaseId,
        },
        "Failed to disable backup schedule",
      );
      throw error;
    }
  }

  /**
   * Get status of all scheduled jobs
   */
  public getScheduleStatus(): Array<{
    databaseId: string;
    schedule: string;
    timezone: string;
    isEnabled: boolean;
    nextScheduledAt: string | null;
  }> {
    return Array.from(this.scheduledJobs.values()).map((job) => ({
      databaseId: job.databaseId,
      schedule: job.schedule,
      timezone: job.timezone,
      isEnabled: job.isEnabled,
      nextScheduledAt: job.nextScheduledAt?.toISOString() || null,
    }));
  }

  /**
   * Get status of a specific scheduled job
   */
  public getScheduleStatusForDatabase(databaseId: string): {
    databaseId: string;
    schedule: string;
    timezone: string;
    isEnabled: boolean;
    nextScheduledAt: string | null;
  } | null {
    const job = this.scheduledJobs.get(databaseId);
    if (!job) {
      return null;
    }

    return {
      databaseId: job.databaseId,
      schedule: job.schedule,
      timezone: job.timezone,
      isEnabled: job.isEnabled,
      nextScheduledAt: job.nextScheduledAt?.toISOString() || null,
    };
  }

  /**
   * Calculate next run time for a cron expression
   */
  private calculateNextRunTime(schedule: string, timezone: string = "UTC"): Date | null {
    try {
      if (!cron.validate(schedule)) {
        return null;
      }

      // Use cron-parser for accurate next execution time calculation with timezone support
      const interval = CronExpressionParser.parse(schedule, {
        tz: timezone,
        currentDate: new Date()
      });
      
      return interval.next().toDate();
    } catch (error) {
      servicesLogger().warn(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          schedule,
          timezone,
        },
        "Failed to calculate next run time",
      );
      return null;
    }
  }

  /**
   * Execute a scheduled backup
   */
  private async executeScheduledBackup(
    databaseId: string,
    userId: string,
  ): Promise<void> {
    try {
      servicesLogger().info({ databaseId }, "Executing scheduled backup");

      // Queue the backup operation
      const backupOperation = await this.backupExecutorService.queueBackup(
        databaseId,
        "scheduled" as BackupOperationType,
        userId,
      );

      // Update next scheduled time for this job
      const job = this.scheduledJobs.get(databaseId);
      if (job) {
        job.nextScheduledAt = this.calculateNextRunTime(job.schedule, job.timezone);
        await this.updateNextScheduledTime(databaseId, job.nextScheduledAt);
      }

      servicesLogger().info(
        {
          databaseId,
          operationId: backupOperation.id,
          nextScheduledAt: job?.nextScheduledAt?.toISOString(),
        },
        "Scheduled backup queued successfully",
      );
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          databaseId,
          userId,
        },
        "Failed to execute scheduled backup",
      );
    }
  }

  /**
   * Load existing backup configurations with schedules
   */
  private async loadExistingSchedules(): Promise<void> {
    try {
      const backupConfigs = await this.prisma.backupConfiguration.findMany({
        where: {
          schedule: { not: null },
          isEnabled: true,
        },
        include: {
          database: true,
        },
      });

      servicesLogger().info(
        { count: backupConfigs.length },
        "Loading existing backup schedules",
      );

      for (const config of backupConfigs) {
        if (config.schedule && config.database) {
          try {
            await this.registerSchedule(
              config.databaseId,
              config.schedule,
              config.timezone || "UTC",
              config.database.userId,
            );

            // Enable the schedule if it was previously enabled
            if (config.isEnabled) {
              await this.enableSchedule(config.databaseId);
            }
          } catch (error) {
            servicesLogger().warn(
              {
                error: error instanceof Error ? error.message : "Unknown error",
                databaseId: config.databaseId,
                schedule: config.schedule,
              },
              "Failed to load backup schedule, skipping",
            );
          }
        }
      }

      servicesLogger().info(
        {
          loaded: this.scheduledJobs.size,
          total: backupConfigs.length,
        },
        "Finished loading backup schedules",
      );
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to load existing backup schedules",
      );
      throw error;
    }
  }

  /**
   * Update next scheduled time in database
   */
  private async updateNextScheduledTime(
    databaseId: string,
    nextScheduledAt: Date | null,
  ): Promise<void> {
    try {
      await this.prisma.backupConfiguration.updateMany({
        where: { databaseId },
        data: { nextScheduledAt },
      });
    } catch (error) {
      servicesLogger().warn(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          databaseId,
          nextScheduledAt: nextScheduledAt?.toISOString(),
        },
        "Failed to update next scheduled time in database",
      );
    }
  }

  /**
   * Refresh schedules when backup configurations change
   */
  public async refreshSchedules(): Promise<void> {
    try {
      servicesLogger().info("Refreshing backup schedules");

      // Stop all existing jobs
      for (const [databaseId] of this.scheduledJobs) {
        await this.unregisterSchedule(databaseId);
      }

      // Reload from database
      await this.loadExistingSchedules();

      servicesLogger().info("Backup schedules refreshed successfully");
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to refresh backup schedules",
      );
      throw error;
    }
  }

  /**
   * Clean up resources
   */
  public async shutdown(): Promise<void> {
    try {
      // Stop all scheduled jobs
      for (const [databaseId] of this.scheduledJobs) {
        await this.unregisterSchedule(databaseId);
      }

      // Shutdown backup executor
      await this.backupExecutorService.shutdown();

      servicesLogger().info("BackupSchedulerService shut down successfully");
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Error during BackupSchedulerService shutdown",
      );
    }
  }
}
