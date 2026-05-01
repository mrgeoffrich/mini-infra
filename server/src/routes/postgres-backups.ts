import { Router } from "express";
import prisma from "../lib/prisma";
import { Prisma } from "../generated/prisma/client";
import { z } from "zod";
import { getLogger } from "../lib/logger-factory";

const logger = getLogger("backup", "postgres-backups");
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import { BackupExecutorService } from "../services/backup";
import {
  BackupOperationListResponse,
  BackupOperationStatusResponse,
  BackupOperationDeleteResponse,
  ManualBackupResponse,
  BackupOperationFilter,
  BackupOperationProgress,
  BackupOperationType,
  BackupOperationStatus,
  BACKUP_OPERATION_TYPES,
  BACKUP_OPERATION_STATUSES,
  SORT_ORDERS,
} from "@mini-infra/types";

const router = Router();

// Initialize backup executor service
const backupExecutorService = new BackupExecutorService(prisma);

// ====================
// Validation Schemas
// ====================

const BackupOperationFilterSchema = z.object({
  status: z.enum(BACKUP_OPERATION_STATUSES).optional(),
  operationType: z.enum(BACKUP_OPERATION_TYPES).optional(),
  startedAfter: z.string().datetime().optional(),
  startedBefore: z.string().datetime().optional(),
});

const BackupOperationSortSchema = z.object({
  field: z.enum([
    "id",
    "startedAt",
    "completedAt",
    "status",
    "operationType",
    "progress",
    "sizeBytes",
  ]),
  order: z.enum(SORT_ORDERS),
});

const PaginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

// ====================
// Helper Functions
// ====================

/**
 * Parse query parameters for filtering and pagination
 */
function parseBackupOperationQuery(query: Record<string, unknown>) {
  const pagination = PaginationSchema.parse(query);
  const filter = BackupOperationFilterSchema.parse(query);
  const sort = query.sortBy
    ? BackupOperationSortSchema.parse({
        field: query.sortBy,
        order: query.sortOrder || "desc",
      })
    : { field: "startedAt" as const, order: "desc" as const };

  return { pagination, filter, sort };
}

/**
 * Build Prisma where clause from filter
 */
function buildWhereClause(filter: BackupOperationFilter, databaseId?: string) {
  const where: Prisma.BackupOperationWhereInput = {};

  if (databaseId) {
    where.databaseId = databaseId;
  }

  if (filter.status) {
    where.status = filter.status;
  }

  if (filter.operationType) {
    where.operationType = filter.operationType;
  }

  if (filter.startedAfter || filter.startedBefore) {
    where.startedAt = {};
    if (filter.startedAfter) {
      where.startedAt.gte = new Date(filter.startedAfter);
    }
    if (filter.startedBefore) {
      where.startedAt.lte = new Date(filter.startedBefore);
    }
  }

  return where;
}

/**
 * Map Prisma BackupOperation to BackupOperationInfo
 */
function mapBackupOperationToInfo(operation: Prisma.BackupOperationGetPayload<true>) {
  return {
    id: operation.id,
    databaseId: operation.databaseId,
    operationType: operation.operationType as BackupOperationType,
    status: operation.status as BackupOperationStatus,
    startedAt: operation.startedAt.toISOString(),
    completedAt: operation.completedAt?.toISOString() || null,
    sizeBytes: operation.sizeBytes ? Number(operation.sizeBytes) : null,
    storageObjectUrl: operation.storageObjectUrl,
    storageProviderAtCreation: operation.storageProviderAtCreation,
    errorMessage: operation.errorMessage,
    progress: operation.progress,
    metadata: operation.metadata ? JSON.parse(operation.metadata) : null,
  };
}

// ====================
// Route Handlers
// ====================


router.get("/backups/:databaseId", requirePermission('postgres:read'), async (req, res) => {
  const requestId = res.locals.requestId;
  const userId = res.locals.user.id;
  const databaseId = String(req.params.databaseId);

  try {
    logger.debug(
      { requestId, userId, databaseId },
      "Fetching backup operations for database",
    );

    // Verify database exists
    const database = await prisma.postgresDatabase.findFirst({
      where: {
        id: databaseId,
      },
    });

    if (!database) {
      logger.warn(
        { requestId, userId, databaseId },
        "Database not found or access denied",
      );
      return res.status(404).json({
        success: false,
        error: "Database not found",
        message: "Database not found or you don't have access to it",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Parse query parameters
    const { pagination, filter, sort } = parseBackupOperationQuery(req.query);
    const where = buildWhereClause(filter, databaseId);

    // Get total count for pagination
    const totalCount = await prisma.backupOperation.count({ where });

    // Fetch backup operations
    const operations = await prisma.backupOperation.findMany({
      where,
      orderBy: { [sort.field]: sort.order },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
    });

    const backupOperations = operations.map(mapBackupOperationToInfo);

    const response: BackupOperationListResponse = {
      success: true,
      data: backupOperations,
      message: `Found ${backupOperations.length} backup operations`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        totalCount,
        hasMore: pagination.page * pagination.limit < totalCount,
      },
    };

    logger.debug(
      { requestId, userId, databaseId, count: backupOperations.length },
      "Successfully fetched backup operations",
    );

    res.json(response);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    logger.error(
      { requestId, userId, databaseId, error: errorMessage },
      "Failed to fetch backup operations",
    );

    res.status(500).json({
      success: false,
      error: "Internal server error",
      message: "Failed to fetch backup operations",
      timestamp: new Date().toISOString(),
      requestId,
    });
  }
});


router.post(
  "/backups/:databaseId/manual",
  requirePermission('postgres:write'),
  async (req, res) => {
    const requestId = req.headers["x-request-id"] as string;
    const user = getAuthenticatedUser(req);
    const databaseId = String(req.params.databaseId);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "User not authenticated",
      });
    }

    const userId = user.id;

    try {
      logger.debug(
        { requestId, userId, databaseId },
        "Triggering manual backup",
      );

      // Verify database exists
      const database = await prisma.postgresDatabase.findFirst({
        where: {
          id: databaseId,
        },
      });

      if (!database) {
        logger.warn(
          { requestId, userId, databaseId },
          "Database not found or access denied",
        );
        return res.status(404).json({
          success: false,
          error: "Database not found",
          message: "Database not found or you don't have access to it",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      // Check if backup configuration exists
      const backupConfig = await prisma.backupConfiguration.findFirst({
        where: { databaseId },
      });

      if (!backupConfig) {
        logger.warn(
          { requestId, userId, databaseId },
          "Backup configuration not found",
        );
        return res.status(400).json({
          success: false,
          error: "Backup configuration required",
          message: "Please configure backup settings before creating a backup",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      // Check if there's already a running backup for this database
      const runningBackup = await prisma.backupOperation.findFirst({
        where: {
          databaseId,
          status: { in: ["pending", "running"] },
        },
      });

      if (runningBackup) {
        logger.warn(
          { requestId, userId, databaseId, runningBackupId: runningBackup.id },
          "Backup already in progress",
        );
        return res.status(409).json({
          success: false,
          error: "Backup in progress",
          message: "A backup is already in progress for this database",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      // Queue the backup operation
      const backupOperation = await backupExecutorService.queueBackup(
        databaseId,
        "manual",
        userId,
      );

      logger.debug(
        { requestId, userId, databaseId, operationId: backupOperation.id },
        "Manual backup queued successfully",
      );

      const response: ManualBackupResponse = {
        success: true,
        data: {
          operationId: backupOperation.id,
          status: backupOperation.status,
          message: "Backup operation queued successfully",
        },
        timestamp: new Date().toISOString(),
        requestId,
      };

      res.status(201).json(response);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logger.error(
        { requestId, userId, databaseId, error: errorMessage },
        "Failed to trigger manual backup",
      );

      res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "Failed to trigger backup operation",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  },
);


router.get(
  "/backups/:backupId/status",
  requirePermission('postgres:read'),
  async (req, res) => {
    const requestId = req.headers["x-request-id"] as string;
    const user = getAuthenticatedUser(req);
    const backupId = String(req.params.backupId);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized",
        message: "Authentication required",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const userId = user.id;

    try {
      logger.debug(
        { requestId, userId, backupId },
        "Fetching backup operation status",
      );

      // Get backup operation
      const operation = await prisma.backupOperation.findFirst({
        where: {
          id: backupId,
        },
        include: {
          database: true,
        },
      });

      if (!operation) {
        logger.warn(
          { requestId, userId, backupId },
          "Backup operation not found or access denied",
        );
        return res.status(404).json({
          success: false,
          error: "Backup operation not found",
          message: "Backup operation not found or you don't have access to it",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      const response: BackupOperationStatusResponse = {
        success: true,
        data: {
          id: operation.id,
          status: operation.status as BackupOperationStatus,
          progress: operation.progress,
          startedAt: operation.startedAt.toISOString(),
          completedAt: operation.completedAt?.toISOString() || null,
          errorMessage: operation.errorMessage,
          sizeBytes: operation.sizeBytes ? Number(operation.sizeBytes) : null,
          storageObjectUrl: operation.storageObjectUrl,
          storageProviderAtCreation: operation.storageProviderAtCreation,
          metadata: operation.metadata ? JSON.parse(operation.metadata) : null,
        },
        message: `Backup operation is ${operation.status}`,
        timestamp: new Date().toISOString(),
        requestId,
      };

      logger.debug(
        { requestId, userId, backupId, status: operation.status },
        "Successfully fetched backup operation status",
      );

      res.json(response);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logger.error(
        { requestId, userId, backupId, error: errorMessage },
        "Failed to fetch backup operation status",
      );

      res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "Failed to fetch backup operation status",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  },
);


router.delete(
  "/backups/:backupId",
  requirePermission('postgres:write'),
  async (req, res) => {
    const requestId = res.locals.requestId;
    const userId = res.locals.user.id;
    const backupId = String(req.params.backupId);

    try {
      logger.debug({ requestId, userId, backupId }, "Deleting backup operation");

      // Get backup operation
      const operation = await prisma.backupOperation.findFirst({
        where: {
          id: backupId,
        },
        include: {
          database: true,
        },
      });

      if (!operation) {
        logger.warn(
          { requestId, userId, backupId },
          "Backup operation not found or access denied",
        );
        return res.status(404).json({
          success: false,
          error: "Backup operation not found",
          message: "Backup operation not found or you don't have access to it",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      // Don't allow deletion of running backups
      if (operation.status === "running" || operation.status === "pending") {
        logger.warn(
          { requestId, userId, backupId, status: operation.status },
          "Cannot delete running backup operation",
        );
        return res.status(400).json({
          success: false,
          error: "Backup in progress",
          message: "Cannot delete a backup operation that is currently running",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      // TODO: Delete the storage object if it exists. Today we just drop
      // the row; the object stays in the backend until retention sweeps it.
      if (operation.storageObjectUrl) {
        logger.debug(
          { requestId, backupId, objectUrl: operation.storageObjectUrl },
          "TODO: Delete storage object (not implemented yet)",
        );
      }

      // Delete the backup operation record
      await prisma.backupOperation.delete({
        where: { id: backupId },
      });

      logger.debug(
        { requestId, userId, backupId },
        "Successfully deleted backup operation",
      );

      const response: BackupOperationDeleteResponse = {
        success: true,
        message: "Backup operation deleted successfully",
        timestamp: new Date().toISOString(),
        requestId,
      };

      res.json(response);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logger.error(
        { requestId, userId, backupId, error: errorMessage },
        "Failed to delete backup operation",
      );

      res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "Failed to delete backup operation",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  },
);


router.get(
  "/backups/:backupId/progress",
  requirePermission('postgres:read'),
  async (req, res) => {
    const requestId = res.locals.requestId;
    const userId = res.locals.user.id;
    const backupId = String(req.params.backupId);

    try {
      logger.debug(
        { requestId, userId, backupId },
        "Fetching backup operation progress",
      );

      // Get backup operation
      const operation = await prisma.backupOperation.findFirst({
        where: {
          id: backupId,
        },
        include: {
          database: true,
        },
      });

      if (!operation) {
        logger.warn(
          { requestId, userId, backupId },
          "Backup operation not found or access denied",
        );
        return res.status(404).json({
          success: false,
          error: "Backup operation not found",
          message: "Backup operation not found or you don't have access to it",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      // Calculate estimated completion time for running operations
      let estimatedCompletion: string | undefined;
      if (operation.status === "running" && operation.progress > 0) {
        const elapsed = Date.now() - operation.startedAt.getTime();
        const totalEstimated = (elapsed / operation.progress) * 100;
        const remaining = totalEstimated - elapsed;
        estimatedCompletion = new Date(Date.now() + remaining).toISOString();
      }

      // Parse metadata for additional progress details
      const metadata = operation.metadata
        ? JSON.parse(operation.metadata)
        : null;

      const progressData: BackupOperationProgress = {
        id: operation.id,
        databaseId: operation.databaseId,
        status: operation.status as BackupOperationStatus,
        progress: operation.progress,
        startedAt: operation.startedAt.toISOString(),
        estimatedCompletion,
        currentStep: metadata?.currentStep,
        totalSteps: metadata?.totalSteps,
        completedSteps: metadata?.completedSteps,
        errorMessage: operation.errorMessage || undefined,
        metadata,
      };

      logger.debug(
        { requestId, userId, backupId, progress: operation.progress },
        "Successfully fetched backup operation progress",
      );

      res.json({
        success: true,
        data: progressData,
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logger.error(
        { requestId, userId, backupId, error: errorMessage },
        "Failed to fetch backup operation progress",
      );

      res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "Failed to fetch backup operation progress",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  },
);

export default router;
