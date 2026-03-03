import prisma, { PrismaClient } from '../../lib/prisma';
import * as cron from 'node-cron';
import { servicesLogger } from '../../lib/logger-factory';
import { UserEventService } from './user-event-service';

/**
 * UserEventCleanupScheduler manages automated cleanup of old user events
 */
export class UserEventCleanupScheduler {
  private static instance: UserEventCleanupScheduler | null = null;
  private prisma: PrismaClient;
  private userEventService: UserEventService;
  private cleanupTask: cron.ScheduledTask | null = null;
  private isInitialized = false;
  private logger = servicesLogger();

  // Default schedule: Daily at 2 AM
  private static readonly DEFAULT_SCHEDULE = '0 2 * * *';
  private static readonly DEFAULT_TIMEZONE = 'UTC';
  private static readonly DEFAULT_RETENTION_DAYS = 30;
  private static readonly SYSTEM_SETTING_CATEGORY = 'system';
  private static readonly RETENTION_DAYS_KEY = 'user_events_retention_days';
  private static readonly CLEANUP_SCHEDULE_KEY = 'user_events_cleanup_schedule';

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || prisma;
    this.userEventService = new UserEventService(this.prisma);
  }

  /**
   * Get the singleton instance of UserEventCleanupScheduler
   */
  public static getInstance(
    prisma?: PrismaClient,
  ): UserEventCleanupScheduler | null {
    if (!UserEventCleanupScheduler.instance && prisma) {
      UserEventCleanupScheduler.instance = new UserEventCleanupScheduler(
        prisma,
      );
    }
    return UserEventCleanupScheduler.instance;
  }

  /**
   * Set the singleton instance (used by server initialization)
   */
  public static setInstance(instance: UserEventCleanupScheduler): void {
    UserEventCleanupScheduler.instance = instance;
  }

  /**
   * Initialize the cleanup scheduler
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      this.logger.debug(
        'UserEventCleanupScheduler already initialized, skipping',
      );
      return;
    }

    try {
      this.logger.info('Initializing UserEventCleanupScheduler...');

      // Get cleanup schedule from system settings or use default
      const schedule = await this.getCleanupSchedule();

      // Start the cleanup scheduler
      await this.startScheduler(schedule);

      this.logger.info(
        {
          schedule,
          timezone: UserEventCleanupScheduler.DEFAULT_TIMEZONE,
        },
        'UserEventCleanupScheduler initialized successfully',
      );

      this.isInitialized = true;
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to initialize UserEventCleanupScheduler',
      );
      throw error;
    }
  }

  /**
   * Start the cleanup scheduler
   */
  private async startScheduler(schedule: string): Promise<void> {
    try {
      // Validate cron expression
      if (!cron.validate(schedule)) {
        this.logger.warn(
          {
            schedule,
          },
          'Invalid cron expression, using default schedule',
        );
        schedule = UserEventCleanupScheduler.DEFAULT_SCHEDULE;
      }

      // Stop existing task if running
      if (this.cleanupTask) {
        this.cleanupTask.stop();
        this.cleanupTask.destroy();
      }

      // Create new scheduled task
      this.cleanupTask = cron.schedule(
        schedule,
        async () => {
          await this.executeCleanup();
        },
        {
          timezone: UserEventCleanupScheduler.DEFAULT_TIMEZONE,
        },
      );

      this.logger.info(
        {
          schedule,
          timezone: UserEventCleanupScheduler.DEFAULT_TIMEZONE,
        },
        'User event cleanup scheduler started',
      );
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          schedule,
        },
        'Failed to start cleanup scheduler',
      );
      throw error;
    }
  }

  /**
   * Execute the cleanup job
   */
  private async executeCleanup(): Promise<void> {
    try {
      this.logger.info('Starting scheduled user event cleanup...');

      const retentionDays = await this.getRetentionDays();

      const deletedCount =
        await this.userEventService.cleanupExpiredEvents(retentionDays);

      this.logger.info(
        {
          deletedCount,
          retentionDays,
        },
        'Scheduled user event cleanup completed',
      );
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to execute scheduled user event cleanup',
      );
    }
  }

  /**
   * Get retention days from system settings
   */
  private async getRetentionDays(): Promise<number> {
    try {
      const setting = await this.prisma.systemSettings.findUnique({
        where: {
          category_key: {
            category: UserEventCleanupScheduler.SYSTEM_SETTING_CATEGORY,
            key: UserEventCleanupScheduler.RETENTION_DAYS_KEY,
          },
        },
      });

      if (setting && setting.value) {
        const retentionDays = parseInt(setting.value, 10);
        if (!isNaN(retentionDays) && retentionDays > 0) {
          return retentionDays;
        }
      }

      // Return default if not found or invalid
      return UserEventCleanupScheduler.DEFAULT_RETENTION_DAYS;
    } catch (error) {
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to get retention days from settings, using default',
      );
      return UserEventCleanupScheduler.DEFAULT_RETENTION_DAYS;
    }
  }

  /**
   * Get cleanup schedule from system settings
   */
  private async getCleanupSchedule(): Promise<string> {
    try {
      const setting = await this.prisma.systemSettings.findUnique({
        where: {
          category_key: {
            category: UserEventCleanupScheduler.SYSTEM_SETTING_CATEGORY,
            key: UserEventCleanupScheduler.CLEANUP_SCHEDULE_KEY,
          },
        },
      });

      if (setting && setting.value && cron.validate(setting.value)) {
        return setting.value;
      }

      // Return default if not found or invalid
      return UserEventCleanupScheduler.DEFAULT_SCHEDULE;
    } catch (error) {
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to get cleanup schedule from settings, using default',
      );
      return UserEventCleanupScheduler.DEFAULT_SCHEDULE;
    }
  }

  /**
   * Update the cleanup schedule (useful for dynamic schedule updates)
   */
  public async updateSchedule(newSchedule: string): Promise<void> {
    try {
      if (!cron.validate(newSchedule)) {
        throw new Error(`Invalid cron expression: ${newSchedule}`);
      }

      this.logger.info(
        {
          newSchedule,
        },
        'Updating user event cleanup schedule',
      );

      // Update the scheduler
      await this.startScheduler(newSchedule);

      this.logger.info('User event cleanup schedule updated successfully');
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          newSchedule,
        },
        'Failed to update cleanup schedule',
      );
      throw error;
    }
  }

  /**
   * Manually trigger cleanup (useful for testing or manual execution)
   */
  public async triggerCleanup(): Promise<number> {
    try {
      this.logger.info('Manually triggering user event cleanup...');

      const retentionDays = await this.getRetentionDays();
      const deletedCount =
        await this.userEventService.cleanupExpiredEvents(retentionDays);

      this.logger.info(
        {
          deletedCount,
          retentionDays,
        },
        'Manual user event cleanup completed',
      );

      return deletedCount;
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to manually trigger user event cleanup',
      );
      throw error;
    }
  }

  /**
   * Stop the cleanup scheduler
   */
  public async shutdown(): Promise<void> {
    try {
      if (this.cleanupTask) {
        this.cleanupTask.stop();
        this.cleanupTask.destroy();
        this.cleanupTask = null;
      }

      this.logger.info('UserEventCleanupScheduler shut down successfully');
      this.isInitialized = false;
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to shutdown UserEventCleanupScheduler',
      );
      throw error;
    }
  }

  /**
   * Get scheduler status
   */
  public getStatus(): {
    isRunning: boolean;
    schedule: string;
    nextRun: string | null;
  } {
    const isRunning = this.cleanupTask !== null && this.isInitialized;
    return {
      isRunning,
      schedule: UserEventCleanupScheduler.DEFAULT_SCHEDULE,
      nextRun: null, // Would need additional logic to calculate next run
    };
  }
}
