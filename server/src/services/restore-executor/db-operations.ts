import { servicesLogger } from "../../lib/logger-factory";
import { PostgresDatabaseManager } from "../postgres";
import { PostgresSettingsConfigService } from "../postgres";
import type { RestoreProgressData } from "./types";
import type { RestoreOperation } from "@prisma/client";
import {
  RestoreOperationInfo,
  RestoreOperationStatus,
} from "@mini-infra/types";

/**
 * DbOperations handles database-related operations for the restore executor:
 * progress updates, operation mapping, Docker image retrieval, and verification.
 */
export class DbOperations {
  private prisma: any;
  private postgresSettingsConfigService: PostgresSettingsConfigService;
  private databaseConfigService: PostgresDatabaseManager;

  constructor(
    prisma: any,
    postgresSettingsConfigService: PostgresSettingsConfigService,
    databaseConfigService: PostgresDatabaseManager,
  ) {
    this.prisma = prisma;
    this.postgresSettingsConfigService = postgresSettingsConfigService;
    this.databaseConfigService = databaseConfigService;
  }

  /**
   * Update restore operation progress
   */
  async updateRestoreProgress(
    operationId: string,
    progressData: RestoreProgressData,
  ): Promise<void> {
    try {
      await this.prisma.restoreOperation.update({
        where: { id: operationId },
        data: {
          status: progressData.status,
          progress: progressData.progress,
          errorMessage: progressData.errorMessage,
          ...(progressData.status === "completed" && {
            completedAt: new Date(),
          }),
        },
      });

      servicesLogger().debug(
        {
          operationId,
          status: progressData.status,
          progress: progressData.progress,
          message: progressData.message,
        },
        "Restore progress updated",
      );
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          operationId,
          progressData,
        },
        "Failed to update restore progress",
      );
    }
  }

  /**
   * Map Prisma RestoreOperation to RestoreOperationInfo
   */
  mapRestoreOperationToInfo(operation: RestoreOperation): RestoreOperationInfo {
    return {
      id: operation.id,
      databaseId: operation.databaseId,
      backupUrl: operation.backupUrl,
      status: operation.status as RestoreOperationStatus,
      startedAt: operation.startedAt.toISOString(),
      completedAt: operation.completedAt?.toISOString() || null,
      errorMessage: operation.errorMessage,
      progress: operation.progress,
    };
  }

  /**
   * Get restore Docker image from system settings
   */
  async getRestoreDockerImage(): Promise<string> {
    try {
      const dockerImage =
        await this.postgresSettingsConfigService.getRestoreDockerImage();

      servicesLogger().info(
        {
          dockerImage,
        },
        "Retrieved restore Docker image from PostgreSQL settings",
      );

      return dockerImage;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      servicesLogger().error(
        {
          error: errorMessage,
        },
        "Failed to get restore Docker image from PostgreSQL settings",
      );
      throw new Error(
        `Restore Docker image not configured in system settings. Please configure PostgreSQL restore settings at /settings/system before running restore operations. Error: ${errorMessage}`,
      );
    }
  }

  /**
   * Verify restored database integrity
   */
  async verifyRestoredDatabase(connectionConfig: any): Promise<{
    isValid: boolean;
    error?: string;
  }> {
    try {
      // Basic connection and query test
      const validationResult =
        await this.databaseConfigService.testConnection(connectionConfig);

      if (!validationResult.isValid) {
        return {
          isValid: false,
          error: `Database connection failed: ${validationResult.message}`,
        };
      }

      servicesLogger().info(
        { database: connectionConfig.database },
        "Restored database verified successfully",
      );

      return { isValid: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      servicesLogger().error(
        {
          error: errorMessage,
          database: connectionConfig.database,
        },
        "Failed to verify restored database",
      );

      return {
        isValid: false,
        error: errorMessage,
      };
    }
  }
}
