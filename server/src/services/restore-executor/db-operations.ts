import { getLogger } from "../../lib/logger-factory";
import { PostgresDatabaseManager, getPgBackupImage } from "../postgres";
import type { RestoreProgressData } from "./types";
import type { RestoreOperation } from "../../generated/prisma/client";
import type { DatabaseConnectionConfig } from "@mini-infra/types";
import type { PrismaClient } from "../../generated/prisma/client";
import {
  RestoreOperationInfo,
  RestoreOperationStatus,
  Channel,
  ServerEvent,
} from "@mini-infra/types";
import { emitToChannel } from "../../lib/socket";

/**
 * DbOperations handles database-related operations for the restore executor:
 * progress updates, operation mapping, Docker image retrieval, and verification.
 */
export class DbOperations {
  private prisma: PrismaClient;
  private databaseConfigService: PostgresDatabaseManager;

  constructor(
    prisma: PrismaClient,
    databaseConfigService: PostgresDatabaseManager,
  ) {
    this.prisma = prisma;
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

      getLogger("backup", "db-operations").debug(
        {
          operationId,
          status: progressData.status,
          progress: progressData.progress,
          message: progressData.message,
        },
        "Restore progress updated",
      );

      // Emit progress via Socket.IO
      try {
        if (progressData.status === "completed" || progressData.status === "failed") {
          emitToChannel(Channel.POSTGRES, ServerEvent.POSTGRES_OPERATION_COMPLETED, {
            operationId,
            type: "restore",
            success: progressData.status === "completed",
            error: progressData.errorMessage,
          });
        } else {
          emitToChannel(Channel.POSTGRES, ServerEvent.POSTGRES_OPERATION, {
            operationId,
            type: "restore",
            status: progressData.status,
            progress: progressData.progress,
            message: progressData.message,
          });
        }
      } catch (emitError) {
        getLogger("backup", "db-operations").error(
          { operationId, error: emitError instanceof Error ? emitError.message : emitError },
          "Failed to emit restore progress via socket",
        );
      }
    } catch (error) {
      getLogger("backup", "db-operations").error(
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
   * Get restore Docker image (resolved from PG_BACKUP_IMAGE_TAG env var)
   */
  getRestoreDockerImage(): string {
    const dockerImage = getPgBackupImage();
    getLogger("backup", "db-operations").info({ dockerImage }, "Resolved restore Docker image");
    return dockerImage;
  }

  /**
   * Verify restored database integrity
   */
  async verifyRestoredDatabase(connectionConfig: DatabaseConnectionConfig): Promise<{
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

      getLogger("backup", "db-operations").info(
        { database: connectionConfig.database },
        "Restored database verified successfully",
      );

      return { isValid: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      getLogger("backup", "db-operations").error(
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
