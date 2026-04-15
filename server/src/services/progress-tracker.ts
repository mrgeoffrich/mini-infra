import { PrismaClient } from "../lib/prisma";
import { getLogger } from "../lib/logger-factory";
import {
  BackupProgressUpdate,
  RestoreProgressUpdate,
  BackupOperationProgress,
  RestoreOperationProgress,
  BackupOperationStatus,
  RestoreOperationStatus,
} from "@mini-infra/types";
import type { BackupOperation, RestoreOperation } from "../generated/prisma/client";
import { EventEmitter } from "events";

/**
 * Progress tracking event types
 */
export interface ProgressEvents {
  "backup-progress": (data: BackupProgressUpdate) => void;
  "restore-progress": (data: RestoreProgressUpdate) => void;
  "operation-completed": (data: {
    type: "backup" | "restore";
    operationId: string;
  }) => void;
  "operation-failed": (data: {
    type: "backup" | "restore";
    operationId: string;
    error: string;
  }) => void;
}

/**
 * Operation history filter options
 */
export interface OperationHistoryFilter {
  databaseId?: string;
  operationType?: "backup" | "restore" | "all";
  status?: BackupOperationStatus | RestoreOperationStatus | "all";
  startedAfter?: Date;
  startedBefore?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Combined operation info for history
 */
export interface OperationHistoryItem {
  id: string;
  type: "backup" | "restore";
  databaseId: string;
  databaseName?: string;
  status: BackupOperationStatus | RestoreOperationStatus;
  progress: number;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  operationType?: string; // For backup operations: "manual" | "scheduled"
  backupUrl?: string; // For restore operations
  sizeBytes?: number | null; // For backup operations
}

/**
 * ProgressTrackerService provides centralized progress tracking for backup and restore operations
 */
export class ProgressTrackerService extends EventEmitter {
  private prisma: PrismaClient;
  private cleanupIntervalId: NodeJS.Timeout | null = null;
  private isInitialized = false;

  // Cleanup configuration
  private static readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private static readonly COMPLETED_OPERATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  private static readonly FAILED_OPERATION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  private static readonly STALE_RUNNING_OPERATION_TTL_MS = 60 * 60 * 1000; // 1 hour — running ops older than this are stale

  constructor(prisma: PrismaClient) {
    super();
    this.prisma = prisma;
  }

  /**
   * Initialize the progress tracker service
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Start periodic cleanup
      this.startPeriodicCleanup();

      getLogger("backup", "progress-tracker").info("ProgressTrackerService initialized successfully");
      this.isInitialized = true;
    } catch (error) {
      getLogger("backup", "progress-tracker").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to initialize ProgressTrackerService",
      );
      throw error;
    }
  }

  /**
   * Get progress for a specific backup operation
   */
  public async getBackupProgress(
    operationId: string,
  ): Promise<BackupOperationProgress | null> {
    try {
      const operation = await this.prisma.backupOperation.findFirst({
        where: {
          id: operationId,
        },
        include: {
          database: {
            select: {
              name: true,
            },
          },
        },
      });

      if (!operation) {
        return null;
      }

      return this.mapBackupOperationToProgress(operation);
    } catch (error) {
      getLogger("backup", "progress-tracker").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          operationId,
        },
        "Failed to get backup progress",
      );
      throw error;
    }
  }

  /**
   * Get progress for a specific restore operation
   */
  public async getRestoreProgress(
    operationId: string,
  ): Promise<RestoreOperationProgress | null> {
    try {
      const operation = await this.prisma.restoreOperation.findFirst({
        where: {
          id: operationId,
        },
        include: {
          database: {
            select: {
              name: true,
            },
          },
        },
      });

      if (!operation) {
        return null;
      }

      return this.mapRestoreOperationToProgress(operation);
    } catch (error) {
      getLogger("backup", "progress-tracker").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          operationId,
        },
        "Failed to get restore progress",
      );
      throw error;
    }
  }

  /**
   * Get all active operations (pending or running) for all databases
   */
  public async getActiveOperations(): Promise<{
    backupOperations: BackupOperationProgress[];
    restoreOperations: RestoreOperationProgress[];
  }> {
    try {
      const [backupOperations, restoreOperations] = await Promise.all([
        this.prisma.backupOperation.findMany({
          where: {
            status: {
              in: ["pending", "running"],
            },
          },
          include: {
            database: {
              select: {
                name: true,
              },
            },
          },
          orderBy: {
            startedAt: "desc",
          },
        }),
        this.prisma.restoreOperation.findMany({
          where: {
            status: {
              in: ["pending", "running"],
            },
          },
          include: {
            database: {
              select: {
                name: true,
              },
            },
          },
          orderBy: {
            startedAt: "desc",
          },
        }),
      ]);

      return {
        backupOperations: backupOperations.map((op: BackupOperation) =>
          this.mapBackupOperationToProgress(op),
        ),
        restoreOperations: restoreOperations.map((op: RestoreOperation) =>
          this.mapRestoreOperationToProgress(op),
        ),
      };
    } catch (error) {
      getLogger("backup", "progress-tracker").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get active operations",
      );
      throw error;
    }
  }

  /**
   * Get operation history with filtering and pagination
   */
  public async getOperationHistory(
    filter: OperationHistoryFilter = {},
  ): Promise<{
    operations: OperationHistoryItem[];
    totalCount: number;
    hasMore: boolean;
  }> {
    try {
      const {
        databaseId,
        operationType = "all",
        status = "all",
        startedAfter,
        startedBefore,
        limit = 50,
        offset = 0,
      } = filter;

      // Build where clauses for backup and restore operations
      const baseWhere: Record<string, unknown> = {};
      if (databaseId) {
        baseWhere.databaseId = databaseId;
      }

      const dateFilter: { gte?: Date; lte?: Date } = {};
      if (startedAfter) {
        dateFilter.gte = startedAfter;
      }
      if (startedBefore) {
        dateFilter.lte = startedBefore;
      }
      if (Object.keys(dateFilter).length > 0) {
        baseWhere.startedAt = dateFilter;
      }

      const statusFilter = status !== "all" ? { status } : {};

      const backupWhere = { ...baseWhere, ...statusFilter };
      const restoreWhere = { ...baseWhere, ...statusFilter };

      // Fetch operations based on type filter
      const operations: OperationHistoryItem[] = [];

      if (operationType === "all" || operationType === "backup") {
        const backupOperations = await this.prisma.backupOperation.findMany({
          where: backupWhere,
          include: {
            database: {
              select: {
                name: true,
              },
            },
          },
          orderBy: {
            startedAt: "desc",
          },
          take: limit * 2, // Get more than needed for sorting
        });

        operations.push(
          ...backupOperations.map((op: BackupOperation) =>
            this.mapBackupOperationToHistoryItem(op),
          ),
        );
      }

      if (operationType === "all" || operationType === "restore") {
        const restoreOperations = await this.prisma.restoreOperation.findMany({
          where: restoreWhere,
          include: {
            database: {
              select: {
                name: true,
              },
            },
          },
          orderBy: {
            startedAt: "desc",
          },
          take: limit * 2, // Get more than needed for sorting
        });

        operations.push(
          ...restoreOperations.map((op: RestoreOperation) =>
            this.mapRestoreOperationToHistoryItem(op),
          ),
        );
      }

      // Sort all operations by startedAt descending
      operations.sort(
        (a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      );

      // Apply pagination
      const paginatedOperations = operations.slice(offset, offset + limit);
      const hasMore = operations.length > offset + limit;

      // Get total count (approximate for performance)
      let totalCount = operations.length;
      if (hasMore || offset > 0) {
        // If we have more or we're not on the first page, get a proper count
        const [backupCount, restoreCount] = await Promise.all([
          operationType === "all" || operationType === "backup"
            ? this.prisma.backupOperation.count({ where: backupWhere })
            : 0,
          operationType === "all" || operationType === "restore"
            ? this.prisma.restoreOperation.count({ where: restoreWhere })
            : 0,
        ]);
        totalCount = backupCount + restoreCount;
      }

      getLogger("backup", "progress-tracker").debug(
        {
          filter,
          operationCount: paginatedOperations.length,
          totalCount,
          hasMore,
        },
        "Retrieved operation history",
      );

      return {
        operations: paginatedOperations,
        totalCount,
        hasMore,
      };
    } catch (error) {
      getLogger("backup", "progress-tracker").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          filter,
        },
        "Failed to get operation history",
      );
      throw error;
    }
  }

  /**
   * Broadcast progress update event
   */
  public broadcastProgressUpdate(
    type: "backup" | "restore",
    update: BackupProgressUpdate | RestoreProgressUpdate,
  ): void {
    try {
      if (type === "backup") {
        this.emit("backup-progress", update as BackupProgressUpdate);
      } else {
        this.emit("restore-progress", update as RestoreProgressUpdate);
      }

      // Emit operation completion/failure events
      if (update.status === "completed") {
        this.emit("operation-completed", {
          type,
          operationId: update.operationId,
        });
      } else if (update.status === "failed") {
        this.emit("operation-failed", {
          type,
          operationId: update.operationId,
          error: update.message || "Operation failed",
        });
      }

      getLogger("backup", "progress-tracker").debug(
        {
          type,
          operationId: update.operationId,
          status: update.status,
          progress: update.progress,
        },
        "Progress update broadcasted",
      );
    } catch (error) {
      getLogger("backup", "progress-tracker").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          type,
          update,
        },
        "Failed to broadcast progress update",
      );
    }
  }

  /**
   * Clean up old completed operations
   */
  public async cleanupOldOperations(): Promise<{
    deletedBackupOperations: number;
    deletedRestoreOperations: number;
    repairedStaleBackupOperations: number;
    repairedStaleRestoreOperations: number;
  }> {
    try {
      const now = new Date();
      const completedCutoff = new Date(
        now.getTime() - ProgressTrackerService.COMPLETED_OPERATION_TTL_MS,
      );
      const failedCutoff = new Date(
        now.getTime() - ProgressTrackerService.FAILED_OPERATION_TTL_MS,
      );
      const staleCutoff = new Date(
        now.getTime() - ProgressTrackerService.STALE_RUNNING_OPERATION_TTL_MS,
      );

      // Repair stale "running" backup operations that actually completed
      // (have completedAt and sizeBytes set but status stuck at "running"
      // due to a race condition in the progress callback)
      const staleCompletedBackups =
        await this.prisma.backupOperation.updateMany({
          where: {
            status: "running",
            completedAt: { not: null },
            sizeBytes: { not: null },
            startedAt: { lt: staleCutoff },
          },
          data: {
            status: "completed",
            progress: 100,
          },
        });

      // Repair stale "running" backup operations that never finished
      // (no completedAt/sizeBytes, stuck for over an hour — mark as failed)
      const staleFailedBackups = await this.prisma.backupOperation.updateMany({
        where: {
          status: "running",
          completedAt: null,
          startedAt: { lt: staleCutoff },
        },
        data: {
          status: "failed",
          progress: 0,
          errorMessage: "Operation timed out — marked as failed during cleanup",
        },
      });

      // Repair stale "running" restore operations
      const staleCompletedRestores =
        await this.prisma.restoreOperation.updateMany({
          where: {
            status: "running",
            completedAt: { not: null },
            startedAt: { lt: staleCutoff },
          },
          data: {
            status: "completed",
            progress: 100,
          },
        });

      const staleFailedRestores =
        await this.prisma.restoreOperation.updateMany({
          where: {
            status: "running",
            completedAt: null,
            startedAt: { lt: staleCutoff },
          },
          data: {
            status: "failed",
            progress: 0,
            errorMessage:
              "Operation timed out — marked as failed during cleanup",
          },
        });

      const repairedStaleBackupOperations =
        staleCompletedBackups.count + staleFailedBackups.count;
      const repairedStaleRestoreOperations =
        staleCompletedRestores.count + staleFailedRestores.count;

      if (
        repairedStaleBackupOperations > 0 ||
        repairedStaleRestoreOperations > 0
      ) {
        getLogger("backup", "progress-tracker").info(
          {
            repairedStaleBackupOperations,
            repairedStaleRestoreOperations,
            staleCompletedBackups: staleCompletedBackups.count,
            staleFailedBackups: staleFailedBackups.count,
            staleCompletedRestores: staleCompletedRestores.count,
            staleFailedRestores: staleFailedRestores.count,
            staleCutoff: staleCutoff.toISOString(),
          },
          "Repaired stale running operations",
        );
      }

      // Delete old completed backup operations
      const deletedBackupCompleted =
        await this.prisma.backupOperation.deleteMany({
          where: {
            status: "completed",
            completedAt: {
              lt: completedCutoff,
            },
          },
        });

      // Delete old failed backup operations
      const deletedBackupFailed = await this.prisma.backupOperation.deleteMany({
        where: {
          status: "failed",
          startedAt: {
            lt: failedCutoff,
          },
        },
      });

      // Delete old completed restore operations
      const deletedRestoreCompleted =
        await this.prisma.restoreOperation.deleteMany({
          where: {
            status: "completed",
            completedAt: {
              lt: completedCutoff,
            },
          },
        });

      // Delete old failed restore operations
      const deletedRestoreFailed =
        await this.prisma.restoreOperation.deleteMany({
          where: {
            status: "failed",
            startedAt: {
              lt: failedCutoff,
            },
          },
        });

      const result = {
        deletedBackupOperations:
          deletedBackupCompleted.count + deletedBackupFailed.count,
        deletedRestoreOperations:
          deletedRestoreCompleted.count + deletedRestoreFailed.count,
        repairedStaleBackupOperations,
        repairedStaleRestoreOperations,
      };

      if (
        result.deletedBackupOperations > 0 ||
        result.deletedRestoreOperations > 0 ||
        result.repairedStaleBackupOperations > 0 ||
        result.repairedStaleRestoreOperations > 0
      ) {
        getLogger("backup", "progress-tracker").info(
          {
            ...result,
            completedCutoff: completedCutoff.toISOString(),
            failedCutoff: failedCutoff.toISOString(),
            staleCutoff: staleCutoff.toISOString(),
          },
          "Cleaned up old operations",
        );
      }

      return result;
    } catch (error) {
      getLogger("backup", "progress-tracker").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to clean up old operations",
      );
      throw error;
    }
  }

  /**
   * Start periodic cleanup of old operations
   */
  private startPeriodicCleanup(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
    }

    this.cleanupIntervalId = setInterval(async () => {
      try {
        await this.cleanupOldOperations();
      } catch (error) {
        getLogger("backup", "progress-tracker").error(
          {
            error: error instanceof Error ? error.message : "Unknown error",
          },
          "Periodic cleanup failed",
        );
      }
    }, ProgressTrackerService.CLEANUP_INTERVAL_MS);

    getLogger("backup", "progress-tracker").debug(
      {
        cleanupIntervalMs: ProgressTrackerService.CLEANUP_INTERVAL_MS,
      },
      "Periodic cleanup started",
    );
  }

  /**
   * Map backup operation to progress format
   */
  private mapBackupOperationToProgress(
    operation: BackupOperation & { database?: { name: string } },
  ): BackupOperationProgress {
    const progress: BackupOperationProgress = {
      id: operation.id,
      databaseId: operation.databaseId,
      status: operation.status as BackupOperationStatus,
      progress: operation.progress,
      startedAt: operation.startedAt.toISOString(),
      errorMessage: operation.errorMessage || undefined,
    };

    // Add optional fields
    if (operation.completedAt) {
      progress.estimatedCompletion = operation.completedAt.toISOString();
    }

    // Parse metadata if available
    if (operation.metadata) {
      try {
        const metadata = JSON.parse(operation.metadata);
        progress.metadata = metadata;

        // Extract step information from metadata
        if (metadata.currentStep) {
          progress.currentStep = metadata.currentStep;
        }
        if (metadata.totalSteps) {
          progress.totalSteps = metadata.totalSteps;
        }
        if (metadata.completedSteps) {
          progress.completedSteps = metadata.completedSteps;
        }
      } catch {
        getLogger("backup", "progress-tracker").debug(
          { operationId: operation.id },
          "Failed to parse backup operation metadata",
        );
      }
    }

    return progress;
  }

  /**
   * Map restore operation to progress format
   */
  private mapRestoreOperationToProgress(
    operation: RestoreOperation & { database?: { name: string } },
  ): RestoreOperationProgress {
    const progress: RestoreOperationProgress = {
      id: operation.id,
      databaseId: operation.databaseId,
      status: operation.status as RestoreOperationStatus,
      progress: operation.progress,
      startedAt: operation.startedAt.toISOString(),
      backupUrl: operation.backupUrl,
      errorMessage: operation.errorMessage || undefined,
    };

    // Add estimated completion if we can calculate it
    if (operation.completedAt) {
      progress.estimatedCompletion = operation.completedAt.toISOString();
    }

    return progress;
  }

  /**
   * Map backup operation to history item format
   */
  private mapBackupOperationToHistoryItem(
    operation: BackupOperation & { database?: { name: string } },
  ): OperationHistoryItem {
    return {
      id: operation.id,
      type: "backup",
      databaseId: operation.databaseId,
      databaseName: operation.database?.name,
      status: operation.status as BackupOperationStatus,
      progress: operation.progress,
      startedAt: operation.startedAt.toISOString(),
      completedAt: operation.completedAt?.toISOString() || null,
      errorMessage: operation.errorMessage,
      operationType: operation.operationType,
      sizeBytes: operation.sizeBytes ? Number(operation.sizeBytes) : null,
    };
  }

  /**
   * Map restore operation to history item format
   */
  private mapRestoreOperationToHistoryItem(
    operation: RestoreOperation & { database?: { name: string } },
  ): OperationHistoryItem {
    return {
      id: operation.id,
      type: "restore",
      databaseId: operation.databaseId,
      databaseName: operation.database?.name,
      status: operation.status as RestoreOperationStatus,
      progress: operation.progress,
      startedAt: operation.startedAt.toISOString(),
      completedAt: operation.completedAt?.toISOString() || null,
      errorMessage: operation.errorMessage,
      backupUrl: operation.backupUrl,
    };
  }

  /**
   * Clean up resources
   */
  public async shutdown(): Promise<void> {
    try {
      if (this.cleanupIntervalId) {
        clearInterval(this.cleanupIntervalId);
        this.cleanupIntervalId = null;
      }

      // Remove all listeners
      this.removeAllListeners();

      getLogger("backup", "progress-tracker").info("ProgressTrackerService shut down successfully");
    } catch (error) {
      getLogger("backup", "progress-tracker").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Error during ProgressTrackerService shutdown",
      );
    }
  }
}
