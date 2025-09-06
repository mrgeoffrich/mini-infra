import prisma from "../lib/prisma";
import * as cron from "node-cron";
import { servicesLogger } from "../lib/logger-factory";
import { AzureConfigService } from "./azure-config";
import {
  BackupConfiguration,
  BackupConfigurationInfo,
  BackupFormat,
} from "@mini-infra/types";

export class BackupConfigService {
  private prisma: PrismaClient;
  private azureConfigService: AzureConfigService;

  constructor(prisma: typeof prisma) {
    this.prisma = prisma;
    this.azureConfigService = new AzureConfigService(prisma);
  }

  /**
   * Create a backup configuration for a database
   */
  async createBackupConfig(
    databaseId: string,
    config: {
      schedule?: string;
      azureContainerName: string;
      azurePathPrefix: string;
      retentionDays?: number;
      backupFormat?: BackupFormat;
      compressionLevel?: number;
      isEnabled?: boolean;
    },
    userId: string,
  ): Promise<BackupConfigurationInfo> {
    try {
      // Verify database exists and user owns it
      const database = await this.prisma.postgresDatabase.findFirst({
        where: {
          id: databaseId,
          userId: userId,
        },
      });

      if (!database) {
        throw new Error("Database not found or access denied");
      }

      // Validate cron expression if provided
      if (config.schedule && !this.isValidCronExpression(config.schedule)) {
        throw new Error("Invalid cron expression");
      }

      // Validate Azure container if Azure is configured
      await this.validateAzureContainer(config.azureContainerName);

      // Validate configuration values
      this.validateBackupConfig(config);

      // Check if backup configuration already exists
      const existingConfig = await this.prisma.backupConfiguration.findUnique({
        where: { databaseId: databaseId },
      });

      if (existingConfig) {
        throw new Error(
          "Backup configuration already exists for this database",
        );
      }

      // Calculate next scheduled time if schedule is provided and enabled
      const nextScheduledAt =
        config.schedule && (config.isEnabled ?? true)
          ? this.calculateNextScheduledTime(config.schedule)
          : null;

      // Create backup configuration
      const createdConfig = await this.prisma.backupConfiguration.create({
        data: {
          databaseId: databaseId,
          schedule: config.schedule || null,
          azureContainerName: config.azureContainerName,
          azurePathPrefix: config.azurePathPrefix,
          retentionDays: config.retentionDays || 30,
          backupFormat: config.backupFormat || "custom",
          compressionLevel: config.compressionLevel || 6,
          isEnabled: config.isEnabled ?? true,
          nextScheduledAt: nextScheduledAt,
        },
      });

      servicesLogger().info(
        {
          configId: createdConfig.id,
          databaseId: databaseId,
          schedule: config.schedule,
          azureContainer: config.azureContainerName,
          userId: userId,
        },
        "Backup configuration created",
      );

      return this.toBackupConfigInfo(createdConfig);
    } catch (error) {
      servicesLogger().error(
        {
          databaseId: databaseId,
          userId: userId,
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
      azureContainerName?: string;
      azurePathPrefix?: string;
      retentionDays?: number;
      backupFormat?: BackupFormat;
      compressionLevel?: number;
      isEnabled?: boolean;
    },
    userId: string,
  ): Promise<BackupConfigurationInfo> {
    try {
      // Get existing configuration and verify ownership
      const existingConfig = await this.prisma.backupConfiguration.findUnique({
        where: { id: configId },
        include: { database: true },
      });

      if (!existingConfig) {
        throw new Error("Backup configuration not found");
      }

      if (existingConfig.database.userId !== userId) {
        throw new Error(
          "Access denied: You can only update backup configurations for your own databases",
        );
      }

      // Validate cron expression if provided
      if (
        updates.schedule !== undefined &&
        updates.schedule !== null &&
        !this.isValidCronExpression(updates.schedule)
      ) {
        throw new Error("Invalid cron expression");
      }

      // Validate Azure container if changed
      if (updates.azureContainerName) {
        await this.validateAzureContainer(updates.azureContainerName);
      }

      // Validate other updates
      if (updates.retentionDays !== undefined && updates.retentionDays < 1) {
        throw new Error("Retention days must be at least 1");
      }

      if (
        updates.compressionLevel !== undefined &&
        (updates.compressionLevel < 0 || updates.compressionLevel > 9)
      ) {
        throw new Error("Compression level must be between 0 and 9");
      }

      // Prepare update data
      const updateData: any = {
        updatedAt: new Date(),
      };

      // Update fields if provided
      if (updates.schedule !== undefined) {
        updateData.schedule = updates.schedule;
      }
      if (updates.azureContainerName) {
        updateData.azureContainerName = updates.azureContainerName;
      }
      if (updates.azurePathPrefix) {
        updateData.azurePathPrefix = updates.azurePathPrefix;
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

      // Recalculate next scheduled time if schedule or enabled status changed
      if (updates.schedule !== undefined || updates.isEnabled !== undefined) {
        const finalSchedule = updates.schedule ?? existingConfig.schedule;
        const finalEnabled = updates.isEnabled ?? existingConfig.isEnabled;

        updateData.nextScheduledAt =
          finalSchedule && finalEnabled
            ? this.calculateNextScheduledTime(finalSchedule)
            : null;
      }

      // Update configuration
      const updatedConfig = await this.prisma.backupConfiguration.update({
        where: { id: configId },
        data: updateData,
      });

      servicesLogger().info(
        {
          configId: configId,
          databaseId: existingConfig.databaseId,
          userId: userId,
        },
        "Backup configuration updated",
      );

      return this.toBackupConfigInfo(updatedConfig);
    } catch (error) {
      servicesLogger().error(
        {
          configId: configId,
          userId: userId,
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
    userId: string,
  ): Promise<BackupConfigurationInfo | null> {
    try {
      const config = await this.prisma.backupConfiguration.findUnique({
        where: { databaseId: databaseId },
        include: { database: true },
      });

      if (!config) {
        return null;
      }

      // Verify ownership
      if (config.database.userId !== userId) {
        return null;
      }

      return this.toBackupConfigInfo(config);
    } catch (error) {
      servicesLogger().error(
        {
          databaseId: databaseId,
          userId: userId,
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
  async deleteBackupConfig(configId: string, userId: string): Promise<void> {
    try {
      // Verify ownership
      const config = await this.prisma.backupConfiguration.findUnique({
        where: { id: configId },
        include: { database: true },
      });

      if (!config) {
        throw new Error("Backup configuration not found");
      }

      if (config.database.userId !== userId) {
        throw new Error("Access denied");
      }

      // Delete configuration
      await this.prisma.backupConfiguration.delete({
        where: { id: configId },
      });

      servicesLogger().info(
        {
          configId: configId,
          databaseId: config.databaseId,
          userId: userId,
        },
        "Backup configuration deleted",
      );
    } catch (error) {
      servicesLogger().error(
        {
          configId: configId,
          userId: userId,
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
    } catch (error) {
      return false;
    }
  }

  /**
   * Calculate next scheduled backup time
   */
  calculateNextScheduledTime(cronExpression: string): Date | null {
    try {
      if (!this.isValidCronExpression(cronExpression)) {
        return null;
      }

      // Simple implementation - next hour
      const nextTime = new Date();
      nextTime.setHours(nextTime.getHours() + 1);
      nextTime.setMinutes(0);
      nextTime.setSeconds(0);
      nextTime.setMilliseconds(0);

      return nextTime;
    } catch (error) {
      servicesLogger().error(
        {
          cronExpression,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to calculate next scheduled time",
      );
      return null;
    }
  }

  /**
   * Validate that the specified Azure container exists and is accessible
   */
  private async validateAzureContainer(containerName: string): Promise<void> {
    try {
      const accessResult =
        await this.azureConfigService.testContainerAccess(containerName);

      if (!accessResult.accessible) {
        throw new Error(
          `Azure container '${containerName}' is not accessible: ${accessResult.error || "Unknown error"}`,
        );
      }

      servicesLogger().debug(
        {
          containerName,
          responseTime: accessResult.responseTimeMs,
          cached: accessResult.cached,
        },
        "Azure container validation successful",
      );
    } catch (error) {
      servicesLogger().error(
        {
          containerName,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Azure container validation failed",
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

      servicesLogger().debug(
        {
          configId,
          lastBackupAt: now.toISOString(),
        },
        "Updated last backup time for configuration",
      );
    } catch (error) {
      servicesLogger().error(
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
    azureContainerName: string;
    azurePathPrefix: string;
    retentionDays?: number;
    backupFormat?: BackupFormat;
    compressionLevel?: number;
  }): void {
    if (!config.azureContainerName || config.azureContainerName.trim() === "") {
      throw new Error("Azure container name is required");
    }

    // Azure path prefix can be empty (root of container)

    // Validate container name format
    const containerNamePattern = /^[a-z0-9]([a-z0-9\-])*[a-z0-9]$/;
    if (
      config.azureContainerName.length < 3 ||
      config.azureContainerName.length > 63 ||
      !containerNamePattern.test(config.azureContainerName)
    ) {
      throw new Error(
        "Azure container name must be 3-63 characters, contain only lowercase letters, numbers, and hyphens, and start/end with alphanumeric characters",
      );
    }

    if (config.retentionDays !== undefined && config.retentionDays < 1) {
      throw new Error("Retention days must be at least 1");
    }

    if (
      config.compressionLevel !== undefined &&
      (config.compressionLevel < 0 || config.compressionLevel > 9)
    ) {
      throw new Error("Compression level must be between 0 and 9");
    }

    if (
      config.backupFormat &&
      !["custom", "plain", "tar"].includes(config.backupFormat)
    ) {
      throw new Error("Backup format must be 'custom', 'plain', or 'tar'");
    }
  }

  /**
   * Convert database record to info object for API responses
   */
  private toBackupConfigInfo(config: any): BackupConfigurationInfo {
    return {
      id: config.id,
      databaseId: config.databaseId,
      schedule: config.schedule,
      azureContainerName: config.azureContainerName,
      azurePathPrefix: config.azurePathPrefix,
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
