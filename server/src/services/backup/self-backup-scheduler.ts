import { PrismaClient } from "../../lib/prisma";
import * as cron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { selfBackupLogger } from "../../lib/logger-factory";
import { SelfBackupExecutor } from "./self-backup-executor";

/**
 * Scheduled job information
 */
export interface ScheduledJob {
  schedule: string;
  timezone: string;
  containerName: string;
  task: cron.ScheduledTask;
  isEnabled: boolean;
  nextScheduledAt: Date | null;
}

/**
 * Schedule information response
 */
export interface ScheduleInfo {
  isEnabled: boolean;
  schedule: string;
  timezone: string;
  containerName: string;
  nextScheduledAt: Date | null;
  isRegistered: boolean;
}

/**
 * SelfBackupScheduler manages cron-based self-backup scheduling
 */
export class SelfBackupScheduler {
  private static instance: SelfBackupScheduler | null = null;
  private prisma: PrismaClient;
  private backupExecutor: SelfBackupExecutor;
  private scheduledJob: ScheduledJob | null = null;
  private isInitialized = false;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.backupExecutor = new SelfBackupExecutor(prisma);
  }

  /**
   * Get the singleton instance of SelfBackupScheduler
   */
  public static getInstance(prisma?: PrismaClient): SelfBackupScheduler | null {
    if (!SelfBackupScheduler.instance && prisma) {
      SelfBackupScheduler.instance = new SelfBackupScheduler(prisma);
    }
    return SelfBackupScheduler.instance;
  }

  /**
   * Set the singleton instance (used by server initialization)
   */
  public static setInstance(instance: SelfBackupScheduler): void {
    SelfBackupScheduler.instance = instance;
  }

  /**
   * Initialize scheduler from database settings
   * Loads configuration and registers schedule if enabled
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Load configuration from database
      const config = await this.loadConfigFromDatabase();

      if (config && config.enabled) {
        // Register schedule
        await this.registerSchedule(
          config.cronSchedule,
          config.timezone,
          config.azureContainerName
        );

        // Enable if configured to be enabled
        await this.enableSchedule();

        selfBackupLogger().info({
          schedule: config.cronSchedule,
          timezone: config.timezone,
          containerName: config.azureContainerName,
          nextScheduledAt: this.scheduledJob?.nextScheduledAt?.toISOString(),
        }, "Self-backup scheduler initialized and enabled");
      } else {
        selfBackupLogger().info("Self-backup scheduler initialized but not enabled");
      }

      this.isInitialized = true;
    } catch (error) {
      selfBackupLogger().error({
        error: error instanceof Error ? error.message : "Unknown error",
      }, "Failed to initialize SelfBackupScheduler");
      // Don't throw - allow server to continue even if scheduler fails
      this.isInitialized = true;
    }
  }

  /**
   * Load configuration from SystemSettings database
   */
  private async loadConfigFromDatabase(): Promise<{
    cronSchedule: string;
    azureContainerName: string;
    timezone: string;
    enabled: boolean;
  } | null> {
    try {
      const settings = await this.prisma.systemSettings.findMany({
        where: {
          category: "self-backup",
          isActive: true,
        },
      });

      if (settings.length === 0) {
        return null;
      }

      const settingsMap = new Map(settings.map(s => [s.key, s.value]));

      const cronSchedule = settingsMap.get("cron_schedule");
      const azureContainerName = settingsMap.get("azure_container_name");
      const timezone = settingsMap.get("timezone") || "UTC";
      const enabled = settingsMap.get("enabled") === "true";

      if (!cronSchedule || !azureContainerName) {
        return null;
      }

      return {
        cronSchedule,
        azureContainerName,
        timezone,
        enabled,
      };
    } catch (error) {
      selfBackupLogger().error({
        error: error instanceof Error ? error.message : "Unknown error",
      }, "Failed to load self-backup configuration from database");
      return null;
    }
  }

  /**
   * Register a new backup schedule
   * @param schedule - Cron expression
   * @param timezone - Timezone for schedule
   * @param containerName - Azure container
   */
  public async registerSchedule(
    schedule: string,
    timezone: string,
    containerName: string
  ): Promise<void> {
    try {
      // Validate cron expression
      if (!cron.validate(schedule)) {
        throw new Error(`Invalid cron expression: ${schedule}`);
      }

      // Remove existing schedule if it exists
      await this.unregisterSchedule();

      // Create scheduled task (initially stopped)
      const task = cron.schedule(
        schedule,
        async () => {
          await this.executeScheduledBackup(containerName);
        },
        {
          timezone: timezone,
        }
      );

      // Stop the task initially - it will be started when enabled
      task.stop();

      // Calculate next scheduled time
      const nextScheduledAt = this.calculateNextRunTime(schedule, timezone);

      // Store job information
      this.scheduledJob = {
        schedule,
        timezone,
        containerName,
        task,
        isEnabled: false,
        nextScheduledAt,
      };

      selfBackupLogger().info({
        schedule,
        timezone,
        containerName,
        nextScheduledAt: nextScheduledAt?.toISOString(),
      }, "Self-backup schedule registered");

    } catch (error) {
      selfBackupLogger().error({
        error: error instanceof Error ? error.message : "Unknown error",
        schedule,
        timezone,
        containerName,
      }, "Failed to register self-backup schedule");
      throw error;
    }
  }

  /**
   * Enable the registered schedule (starts cron job)
   */
  public async enableSchedule(): Promise<void> {
    try {
      if (!this.scheduledJob) {
        throw new Error("No schedule registered");
      }

      if (this.scheduledJob.isEnabled) {
        selfBackupLogger().debug("Self-backup schedule already enabled");
        return;
      }

      this.scheduledJob.task.start();
      this.scheduledJob.isEnabled = true;

      selfBackupLogger().info({
        schedule: this.scheduledJob.schedule,
        nextScheduledAt: this.scheduledJob.nextScheduledAt?.toISOString(),
      }, "Self-backup schedule enabled");

    } catch (error) {
      selfBackupLogger().error({
        error: error instanceof Error ? error.message : "Unknown error",
      }, "Failed to enable self-backup schedule");
      throw error;
    }
  }

  /**
   * Disable the schedule (stops cron job)
   */
  public async disableSchedule(): Promise<void> {
    try {
      if (!this.scheduledJob) {
        selfBackupLogger().debug("No schedule to disable");
        return;
      }

      if (!this.scheduledJob.isEnabled) {
        selfBackupLogger().debug("Self-backup schedule already disabled");
        return;
      }

      this.scheduledJob.task.stop();
      this.scheduledJob.isEnabled = false;

      selfBackupLogger().info("Self-backup schedule disabled");

    } catch (error) {
      selfBackupLogger().error({
        error: error instanceof Error ? error.message : "Unknown error",
      }, "Failed to disable self-backup schedule");
      throw error;
    }
  }

  /**
   * Update schedule parameters
   * @param schedule - New cron expression
   * @param timezone - New timezone
   * @param containerName - New container name
   */
  public async updateSchedule(
    schedule: string,
    timezone: string,
    containerName: string
  ): Promise<void> {
    const wasEnabled = this.scheduledJob?.isEnabled || false;

    // Unregister old schedule
    await this.unregisterSchedule();

    // Register new schedule
    await this.registerSchedule(schedule, timezone, containerName);

    // Re-enable if it was enabled before
    if (wasEnabled) {
      await this.enableSchedule();
    }

    selfBackupLogger().info({
      schedule,
      timezone,
      containerName,
      wasEnabled,
    }, "Self-backup schedule updated");
  }

  /**
   * Unregister schedule and clean up
   */
  public async unregisterSchedule(): Promise<void> {
    try {
      if (this.scheduledJob) {
        // Stop and destroy the cron task
        this.scheduledJob.task.stop();
        this.scheduledJob.task.destroy();

        selfBackupLogger().info("Self-backup schedule unregistered");
        this.scheduledJob = null;
      }
    } catch (error) {
      selfBackupLogger().error({
        error: error instanceof Error ? error.message : "Unknown error",
      }, "Failed to unregister self-backup schedule");
      throw error;
    }
  }

  /**
   * Get current schedule information
   */
  public getScheduleInfo(): ScheduleInfo | null {
    if (!this.scheduledJob) {
      return {
        isEnabled: false,
        schedule: "",
        timezone: "",
        containerName: "",
        nextScheduledAt: null,
        isRegistered: false,
      };
    }

    return {
      isEnabled: this.scheduledJob.isEnabled,
      schedule: this.scheduledJob.schedule,
      timezone: this.scheduledJob.timezone,
      containerName: this.scheduledJob.containerName,
      nextScheduledAt: this.scheduledJob.nextScheduledAt,
      isRegistered: true,
    };
  }

  /**
   * Execute scheduled backup
   */
  private async executeScheduledBackup(containerName: string): Promise<void> {
    selfBackupLogger().info({
      containerName,
    }, "Executing scheduled self-backup");

    try {
      await this.backupExecutor.executeBackup(
        containerName,
        'scheduled'
      );

      // Update next scheduled time
      if (this.scheduledJob) {
        this.scheduledJob.nextScheduledAt = this.calculateNextRunTime(
          this.scheduledJob.schedule,
          this.scheduledJob.timezone
        );
      }

    } catch (error) {
      selfBackupLogger().error({
        error: error instanceof Error ? error.message : "Unknown error",
        containerName,
      }, "Scheduled self-backup failed");
    }
  }

  /**
   * Calculate next scheduled run time
   * @param schedule - Cron expression
   * @param timezone - Timezone
   */
  private calculateNextRunTime(schedule: string, timezone: string): Date | null {
    try {
      const interval = CronExpressionParser.parse(schedule, {
        tz: timezone,
        currentDate: new Date(),
      });
      const next = interval.next();
      return next.toDate();
    } catch (error) {
      selfBackupLogger().error({
        error: error instanceof Error ? error.message : "Unknown error",
        schedule,
        timezone,
      }, "Failed to calculate next run time");
      return null;
    }
  }

  /**
   * Graceful shutdown - stop cron job
   */
  public async shutdown(): Promise<void> {
    try {
      if (this.scheduledJob) {
        this.scheduledJob.task.stop();
        this.scheduledJob.task.destroy();
        selfBackupLogger().info("Self-backup scheduler shutdown complete");
      }
    } catch (error) {
      selfBackupLogger().error({
        error: error instanceof Error ? error.message : "Unknown error",
      }, "Error during self-backup scheduler shutdown");
    }
  }
}
