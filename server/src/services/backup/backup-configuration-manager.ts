import { PrismaClient } from "../../lib/prisma";
import { Prisma } from "../../generated/prisma/client";
import * as cron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { getLogger } from "../../lib/logger-factory";
import { StorageService } from "../storage/storage-service";
import { UserPreferencesService } from "../user-preferences";
import { BackupConfigurationInfo, BackupFormat, ErrorCode } from "@mini-infra/types";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { refreshAllPgBackupTriggers } from "./backup-job-pool-materialiser";

export class BackupConfigurationManager {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Create a backup configuration for a database
   */
  async createBackupConfig(
    databaseId: string,
    config: {
      schedule?: string;
      timezone?: string;
      storageLocationId: string;
      storagePathPrefix: string;
      retentionDays?: number;
      backupFormat?: BackupFormat;
      compressionLevel?: number;
      isEnabled?: boolean;
    },
  ): Promise<BackupConfigurationInfo> {
    try {
      // Verify database exists
      const database = await this.prisma.postgresDatabase.findFirst({
        where: {
          id: databaseId,
        },
      });

      if (!database) {
        throw new NotFoundError(
          ErrorCode.BACKUP_DATABASE_NOT_FOUND,
          `Database ${databaseId} not found`,
          { resource: { type: "postgresDatabase", id: databaseId } },
        );
      }

      // Validate cron expression if provided
      if (config.schedule && !this.isValidCronExpression(config.schedule)) {
        throw new ValidationError(ErrorCode.BACKUP_CONFIG_INVALID, "Invalid cron expression");
      }

      // Determine timezone - use provided timezone or default to UTC
      const timezone = config.timezone || "UTC";

      // Validate timezone
      if (!UserPreferencesService.validateTimezone(timezone)) {
        throw new ValidationError(ErrorCode.BACKUP_CONFIG_INVALID, `Invalid timezone: ${timezone}`);
      }

      // Validate storage location through the active backend
      await this.validateStorageLocation(config.storageLocationId);

      // Validate configuration values
      this.validateBackupConfig(config);

      // Check if backup configuration already exists
      const existingConfig = await this.prisma.backupConfiguration.findUnique({
        where: { databaseId: databaseId },
      });

      if (existingConfig) {
        throw new ConflictError(
          ErrorCode.POSTGRES_BACKUP_CONFIG_EXISTS,
          "Backup configuration already exists for this database",
          {
            resource: { type: "backupConfiguration", id: existingConfig.id },
            action: "Edit the existing backup configuration instead of creating a new one.",
          },
        );
      }

      // Calculate next scheduled time if schedule is provided and enabled
      const nextScheduledAt =
        config.schedule && (config.isEnabled ?? true)
          ? this.calculateNextScheduledTime(config.schedule, timezone)
          : null;

      // Create backup configuration
      const createdConfig = await this.prisma.backupConfiguration.create({
        data: {
          databaseId: databaseId,
          schedule: config.schedule || null,
          timezone: timezone,
          storageLocationId: config.storageLocationId,
          storagePathPrefix: config.storagePathPrefix,
          retentionDays: config.retentionDays || 30,
          backupFormat: config.backupFormat || "custom",
          compressionLevel: config.compressionLevel || 6,
          isEnabled: config.isEnabled ?? true,
          nextScheduledAt: nextScheduledAt,
        },
      });

      // Phase 4 (MINI-53): the cron schedule is no longer registered with a
      // bespoke scheduler — it flows into the pg-az-backup JobPool template's
      // `triggers[]` via the materialiser. Refresh every applied stack so
      // the new BackupConfiguration row's cron entry takes effect.
      try {
        await refreshAllPgBackupTriggers(this.prisma);
      } catch (materialiseError) {
        getLogger("backup", "backup-configuration-manager").warn(
          {
            configId: createdConfig.id,
            databaseId,
            err:
              materialiseError instanceof Error
                ? materialiseError.message
                : String(materialiseError),
          },
          "Failed to materialise pg-az-backup triggers after configuration create (configuration saved)",
        );
      }

      getLogger("backup", "backup-configuration-manager").info(
        {
          configId: createdConfig.id,
          databaseId: databaseId,
          schedule: config.schedule,
          timezone: timezone,
          storageLocationId: config.storageLocationId,
        },
        "Backup configuration created",
      );

      return this.toBackupConfigInfo(createdConfig);
    } catch (error) {
      getLogger("backup", "backup-configuration-manager").error(
        {
          databaseId: databaseId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to create backup configuration",
      );
      throw error;
    }
  }

  /**
   * Update an existing backup configuration
   */
  async updateBackupConfig(
    configId: string,
    updates: {
      schedule?: string | null;
      timezone?: string;
      storageLocationId?: string;
      storagePathPrefix?: string;
      retentionDays?: number;
      backupFormat?: BackupFormat;
      compressionLevel?: number;
      isEnabled?: boolean;
    },
  ): Promise<BackupConfigurationInfo> {
    try {
      // Get existing configuration
      const existingConfig = await this.prisma.backupConfiguration.findUnique({
        where: { id: configId },
        include: { database: true },
      });

      if (!existingConfig) {
        throw new NotFoundError(
          ErrorCode.BACKUP_CONFIG_NOT_FOUND,
          `Backup configuration '${configId}' not found`,
          { resource: { type: "backupConfiguration", id: configId } },
        );
      }

      // Validate cron expression if provided
      if (
        updates.schedule !== undefined &&
        updates.schedule !== null &&
        !this.isValidCronExpression(updates.schedule)
      ) {
        throw new ValidationError(ErrorCode.BACKUP_CONFIG_INVALID, "Invalid cron expression");
      }

      // Validate timezone if provided
      if (
        updates.timezone &&
        !UserPreferencesService.validateTimezone(updates.timezone)
      ) {
        throw new ValidationError(
          ErrorCode.BACKUP_CONFIG_INVALID,
          `Invalid timezone: ${updates.timezone}`,
        );
      }

      // Validate storage location through the active backend if changed
      if (updates.storageLocationId) {
        await this.validateStorageLocation(updates.storageLocationId);
      }

      // Validate other updates
      if (updates.retentionDays !== undefined && updates.retentionDays < 1) {
        throw new ValidationError(
          ErrorCode.BACKUP_CONFIG_INVALID,
          "Retention days must be at least 1",
        );
      }

      if (
        updates.compressionLevel !== undefined &&
        (updates.compressionLevel < 0 || updates.compressionLevel > 9)
      ) {
        throw new ValidationError(
          ErrorCode.BACKUP_CONFIG_INVALID,
          "Compression level must be between 0 and 9",
        );
      }

      // Prepare update data
      const updateData: Prisma.BackupConfigurationUpdateInput = {
        updatedAt: new Date(),
      };

      // Update fields if provided
      if (updates.schedule !== undefined) {
        updateData.schedule = updates.schedule;
      }
      if (updates.timezone) {
        updateData.timezone = updates.timezone;
      }
      if (updates.storageLocationId) {
        updateData.storageLocationId = updates.storageLocationId;
      }
      if (updates.storagePathPrefix) {
        updateData.storagePathPrefix = updates.storagePathPrefix;
      }
      if (updates.retentionDays !== undefined) {
        updateData.retentionDays = updates.retentionDays;
      }
      if (updates.backupFormat) {
        updateData.backupFormat = updates.backupFormat;
      }
      if (updates.compressionLevel !== undefined) {
        updateData.compressionLevel = updates.compressionLevel;
      }
      if (updates.isEnabled !== undefined) {
        updateData.isEnabled = updates.isEnabled;
      }

      // Recalculate next scheduled time if schedule, timezone, or enabled status changed
      if (
        updates.schedule !== undefined ||
        updates.timezone !== undefined ||
        updates.isEnabled !== undefined
      ) {
        const finalSchedule = updates.schedule ?? existingConfig.schedule;
        const finalTimezone = updates.timezone ?? existingConfig.timezone;
        const finalEnabled = updates.isEnabled ?? existingConfig.isEnabled;

        updateData.nextScheduledAt =
          finalSchedule && finalEnabled
            ? this.calculateNextScheduledTime(finalSchedule, finalTimezone)
            : null;
      }

      // Update configuration
      const updatedConfig = await this.prisma.backupConfiguration.update({
        where: { id: configId },
        data: updateData,
      });

      // Phase 4 (MINI-53): cron handling moved to JobPoolCronRegistry via the
      // pg-az-backup template's `triggers[]`. Re-materialise on schedule /
      // timezone / enabled changes so cron registrations update immediately.
      if (
        updates.schedule !== undefined ||
        updates.timezone !== undefined ||
        updates.isEnabled !== undefined
      ) {
        try {
          await refreshAllPgBackupTriggers(this.prisma);
        } catch (materialiseError) {
          getLogger("backup", "backup-configuration-manager").warn(
            {
              configId,
              databaseId: existingConfig.databaseId,
              err:
                materialiseError instanceof Error
                  ? materialiseError.message
                  : String(materialiseError),
            },
            "Failed to materialise pg-az-backup triggers after configuration update (configuration saved)",
          );
        }
      }

      getLogger("backup", "backup-configuration-manager").info(
        {
          configId: configId,
          databaseId: existingConfig.databaseId,
        },
        "Backup configuration updated",
      );

      return this.toBackupConfigInfo(updatedConfig);
    } catch (error) {
      getLogger("backup", "backup-configuration-manager").error(
        {
          configId: configId,
                    error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to update backup configuration",
      );
      throw error;
    }
  }

  /**
   * Get backup configuration by database ID
   */
  async getBackupConfigByDatabaseId(
    databaseId: string,
  ): Promise<BackupConfigurationInfo | null> {
    try {
      const config = await this.prisma.backupConfiguration.findUnique({
        where: { databaseId: databaseId },
        include: { database: true },
      });

      if (!config) {
        return null;
      }


      return this.toBackupConfigInfo(config);
    } catch (error) {
      getLogger("backup", "backup-configuration-manager").error(
        {
          databaseId: databaseId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get backup configuration",
      );
      throw error;
    }
  }

  /**
   * Delete a backup configuration
   */
  async deleteBackupConfig(configId: string): Promise<void> {
    try {
      // Get configuration
      const config = await this.prisma.backupConfiguration.findUnique({
        where: { id: configId },
        include: { database: true },
      });

      if (!config) {
        throw new NotFoundError(
          ErrorCode.BACKUP_CONFIG_NOT_FOUND,
          `Backup configuration '${configId}' not found`,
          { resource: { type: "backupConfiguration", id: configId } },
        );
      }

      // Delete configuration first; the JobPool trigger refresh below picks
      // up the now-absent row and removes the corresponding cron trigger.
      await this.prisma.backupConfiguration.delete({
        where: { id: configId },
      });

      // Phase 4 (MINI-53): cron handling moved to JobPoolCronRegistry via the
      // pg-az-backup template's `triggers[]`. Re-materialise so the
      // now-deleted config's cron trigger is removed from the registry.
      try {
        await refreshAllPgBackupTriggers(this.prisma);
      } catch (materialiseError) {
        getLogger("backup", "backup-configuration-manager").warn(
          {
            configId,
            databaseId: config.databaseId,
            err:
              materialiseError instanceof Error
                ? materialiseError.message
                : String(materialiseError),
          },
          "Failed to materialise pg-az-backup triggers after configuration delete (configuration deleted)",
        );
      }

      getLogger("backup", "backup-configuration-manager").info(
        {
          configId: configId,
          databaseId: config.databaseId,
                  },
        "Backup configuration deleted",
      );
    } catch (error) {
      getLogger("backup", "backup-configuration-manager").error(
        {
          configId: configId,
                    error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to delete backup configuration",
      );
      throw error;
    }
  }

  /**
   * Validate cron expression
   */
  isValidCronExpression(cronExpression: string): boolean {
    try {
      return cron.validate(cronExpression);
    } catch {
      return false;
    }
  }

  /**
   * Calculate next scheduled backup time
   */
  calculateNextScheduledTime(
    cronExpression: string,
    timezone: string = "UTC",
  ): Date | null {
    try {
      if (!this.isValidCronExpression(cronExpression)) {
        return null;
      }

      // Use cron-parser for accurate next execution time calculation with timezone support
      const interval = CronExpressionParser.parse(cronExpression, {
        tz: timezone,
        currentDate: new Date(),
      });

      return interval.next().toDate();
    } catch (error) {
      getLogger("backup", "backup-configuration-manager").error(
        {
          cronExpression,
          timezone,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to calculate next scheduled time",
      );
      return null;
    }
  }

  /**
   * Validate that the specified storage location is accessible via the active backend.
   */
  private async validateStorageLocation(storageLocationId: string): Promise<void> {
    try {
      const backend = await StorageService.getInstance(this.prisma).getActiveBackend();
      const access = await backend.testLocationAccess({ id: storageLocationId });
      if (!access.accessible) {
        const errMeta = (access.metadata ?? {}) as {
          error?: string;
          errorCode?: string;
        };
        // `testLocationAccess()` folds several distinct causes (missing
        // container, bad credentials, network/timeout) into one boolean —
        // all are the user pointing the config at a location we currently
        // can't use, so one validation code covers the family.
        throw new ValidationError(
          ErrorCode.BACKUP_CONFIG_INVALID,
          `Storage location '${storageLocationId}' is not accessible: ${errMeta.error || "Unknown error"}`,
          { resource: { type: "storageLocation", id: storageLocationId } },
        );
      }
      getLogger("backup", "backup-configuration-manager").debug(
        {
          storageLocationId,
          providerId: backend.providerId,
        },
        "Storage location validation successful",
      );
    } catch (error) {
      getLogger("backup", "backup-configuration-manager").error(
        {
          storageLocationId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Storage location validation failed",
      );
      throw error;
    }
  }

  /**
   * Update last backup time for a configuration
   */
  async updateLastBackupTime(configId: string): Promise<void> {
    try {
      const now = new Date();

      await this.prisma.backupConfiguration.update({
        where: { id: configId },
        data: {
          lastBackupAt: now,
          updatedAt: now,
        },
      });

      getLogger("backup", "backup-configuration-manager").debug(
        {
          configId,
          lastBackupAt: now.toISOString(),
        },
        "Updated last backup time for configuration",
      );
    } catch (error) {
      getLogger("backup", "backup-configuration-manager").error(
        {
          configId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to update last backup time",
      );
      throw error;
    }
  }

  /**
   * Calculate cutoff date for retention policy
   */
  calculateRetentionCutoffDate(retentionDays: number): Date {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    return cutoffDate;
  }

  /**
   * Validate backup configuration values
   */
  private validateBackupConfig(config: {
    storageLocationId: string;
    storagePathPrefix: string;
    retentionDays?: number;
    backupFormat?: BackupFormat;
    compressionLevel?: number;
  }): void {
    if (!config.storageLocationId || config.storageLocationId.trim() === "") {
      throw new ValidationError(ErrorCode.BACKUP_CONFIG_INVALID, "Storage location id is required");
    }

    // Storage path prefix can be empty (root of location).

    // Length sanity check (max applies to both Azure container names and Drive
    // folder ids comfortably).
    if (config.storageLocationId.length < 1 || config.storageLocationId.length > 256) {
      throw new ValidationError(
        ErrorCode.BACKUP_CONFIG_INVALID,
        "Storage location id must be 1-256 characters",
      );
    }

    if (config.retentionDays !== undefined && config.retentionDays < 1) {
      throw new ValidationError(
        ErrorCode.BACKUP_CONFIG_INVALID,
        "Retention days must be at least 1",
      );
    }

    if (
      config.compressionLevel !== undefined &&
      (config.compressionLevel < 0 || config.compressionLevel > 9)
    ) {
      throw new ValidationError(
        ErrorCode.BACKUP_CONFIG_INVALID,
        "Compression level must be between 0 and 9",
      );
    }

    if (
      config.backupFormat &&
      !["custom", "plain", "tar"].includes(config.backupFormat)
    ) {
      throw new ValidationError(
        ErrorCode.BACKUP_CONFIG_INVALID,
        "Backup format must be 'custom', 'plain', or 'tar'",
      );
    }
  }

  /**
   * Convert database record to info object for API responses
   */
  private toBackupConfigInfo(config: Prisma.BackupConfigurationGetPayload<true>): BackupConfigurationInfo {
    return {
      id: config.id,
      databaseId: config.databaseId,
      schedule: config.schedule,
      timezone: config.timezone,
      storageLocationId: config.storageLocationId,
      storagePathPrefix: config.storagePathPrefix,
      retentionDays: config.retentionDays,
      backupFormat: config.backupFormat as BackupFormat,
      compressionLevel: config.compressionLevel,
      isEnabled: config.isEnabled,
      lastBackupAt: config.lastBackupAt?.toISOString() || null,
      nextScheduledAt: config.nextScheduledAt?.toISOString() || null,
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    };
  }
}
