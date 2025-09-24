import { Router } from "express";
import prisma from "../lib/prisma";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";

const logger = appLogger();
import { requireSessionOrApiKey, getAuthenticatedUser } from "../middleware/auth";
import { BackupExecutorService } from "../services/backup-executor";
import {
  BackupOperationListResponse,
  BackupOperationStatusResponse,
  BackupOperationDeleteResponse,
  ManualBackupResponse,
  BackupOperationFilter,
  BackupOperationSortOptions,
  BackupOperationProgress,
} from "@mini-infra/types";

const router = Router();

// Initialize backup executor service
const backupExecutorService = new BackupExecutorService(prisma);

// ====================
// Validation Schemas
// ====================

const BackupOperationFilterSchema = z.object({
  status: z.enum(["pending", "running", "completed", "failed"]).optional(),
  operationType: z.enum(["manual", "scheduled"]).optional(),
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
  order: z.enum(["asc", "desc"]),
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
function parseBackupOperationQuery(query: any) {
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
  const where: any = {};

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
function mapBackupOperationToInfo(operation: any) {
  return {
    id: operation.id,
    databaseId: operation.databaseId,
    operationType: operation.operationType as any,
    status: operation.status as any,
    startedAt: operation.startedAt.toISOString(),
    completedAt: operation.completedAt?.toISOString() || null,
    sizeBytes: operation.sizeBytes ? Number(operation.sizeBytes) : null,
    azureBlobUrl: operation.azureBlobUrl,
    errorMessage: operation.errorMessage,
    progress: operation.progress,
    metadata: operation.metadata ? JSON.parse(operation.metadata) : null,
  };
}

// ====================
// Route Handlers
// ====================

/**
 * @swagger
 * /api/postgres/backups/{databaseId}:
 *   get:
 *     summary: List backup operations for a database
 *     description: Retrieve all backup operations for a specific PostgreSQL database with filtering, sorting, and pagination
 *     tags:
 *       - PostgreSQL Backups
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - in: path
 *         name: databaseId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the PostgreSQL database
 *         example: "db123"
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, running, completed, failed]
 *         description: Filter by backup operation status
 *         example: "completed"
 *       - in: query
 *         name: operationType
 *         schema:
 *           type: string
 *           enum: [manual, scheduled]
 *         description: Filter by operation type
 *         example: "manual"
 *       - in: query
 *         name: startedAfter
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter operations started after this date (ISO 8601)
 *         example: "2024-01-01T00:00:00.000Z"
 *       - in: query
 *         name: startedBefore
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter operations started before this date (ISO 8601)
 *         example: "2024-12-31T23:59:59.999Z"
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of items per page
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [id, startedAt, completedAt, status, operationType, progress, sizeBytes]
 *           default: startedAt
 *         description: Field to sort by
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order
 *     responses:
 *       200:
 *         description: Backup operations retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         example: "backup_123"
 *                       databaseId:
 *                         type: string
 *                         example: "db123"
 *                       operationType:
 *                         type: string
 *                         enum: [manual, scheduled]
 *                         example: "manual"
 *                       status:
 *                         type: string
 *                         enum: [pending, running, completed, failed]
 *                         example: "completed"
 *                       startedAt:
 *                         type: string
 *                         format: date-time
 *                         example: "2024-01-15T10:30:00.000Z"
 *                       completedAt:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                         example: "2024-01-15T10:32:45.000Z"
 *                       sizeBytes:
 *                         type: number
 *                         nullable: true
 *                         example: 1048576
 *                       azureBlobUrl:
 *                         type: string
 *                         nullable: true
 *                         example: "https://storage.blob.core.windows.net/backups/backup_123.sql"
 *                       errorMessage:
 *                         type: string
 *                         nullable: true
 *                       progress:
 *                         type: number
 *                         minimum: 0
 *                         maximum: 100
 *                         example: 100
 *                       metadata:
 *                         type: object
 *                         nullable: true
 *                 message:
 *                   type: string
 *                   example: "Found 5 backup operations"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:33:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_123"
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page:
 *                       type: integer
 *                       example: 1
 *                     limit:
 *                       type: integer
 *                       example: 20
 *                     totalCount:
 *                       type: integer
 *                       example: 5
 *                     hasMore:
 *                       type: boolean
 *                       example: false
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Database not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *
 * GET /api/postgres/backups/:databaseId
 * List all backup operations for a specific database
 */
router.get("/backups/:databaseId", requireSessionOrApiKey, async (req, res) => {
  const requestId = res.locals.requestId;
  const userId = res.locals.user.id;
  const { databaseId } = req.params;

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

/**
 * @swagger
 * /api/postgres/backups/{databaseId}/manual:
 *   post:
 *     summary: Trigger manual backup
 *     description: Start a manual backup operation for a specific PostgreSQL database
 *     tags:
 *       - PostgreSQL Backups
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - in: path
 *         name: databaseId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the PostgreSQL database to backup
 *         example: "db123"
 *     responses:
 *       201:
 *         description: Manual backup operation queued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     operationId:
 *                       type: string
 *                       example: "backup_456"
 *                     status:
 *                       type: string
 *                       enum: [pending, running]
 *                       example: "pending"
 *                     message:
 *                       type: string
 *                       example: "Backup operation queued successfully"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:30:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_456"
 *       400:
 *         description: Bad request - backup configuration required or validation error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Backup configuration required"
 *                 message:
 *                   type: string
 *                   example: "Please configure backup settings before creating a backup"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:30:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_456"
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Database not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Conflict - backup already in progress
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Backup in progress"
 *                 message:
 *                   type: string
 *                   example: "A backup is already in progress for this database"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:30:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_456"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *
 * POST /api/postgres/backups/:databaseId/manual
 * Trigger a manual backup for a specific database
 */
router.post(
  "/backups/:databaseId/manual",
  requireSessionOrApiKey,
  async (req, res) => {
    const requestId = req.headers["x-request-id"] as string;
    const user = getAuthenticatedUser(req);
    const { databaseId } = req.params;

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

/**
 * @swagger
 * /api/postgres/backups/{backupId}/status:
 *   get:
 *     summary: Get backup operation status
 *     description: Retrieve the current status and details of a specific backup operation
 *     tags:
 *       - PostgreSQL Backups
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - in: path
 *         name: backupId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the backup operation
 *         example: "backup_456"
 *     responses:
 *       200:
 *         description: Backup operation status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       example: "backup_456"
 *                     status:
 *                       type: string
 *                       enum: [pending, running, completed, failed]
 *                       example: "running"
 *                     progress:
 *                       type: number
 *                       minimum: 0
 *                       maximum: 100
 *                       example: 45
 *                     startedAt:
 *                       type: string
 *                       format: date-time
 *                       example: "2024-01-15T10:30:00.000Z"
 *                     completedAt:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 *                       example: null
 *                     errorMessage:
 *                       type: string
 *                       nullable: true
 *                       example: null
 *                     sizeBytes:
 *                       type: number
 *                       nullable: true
 *                       example: null
 *                     azureBlobUrl:
 *                       type: string
 *                       nullable: true
 *                       example: null
 *                     metadata:
 *                       type: object
 *                       nullable: true
 *                       example: {"currentStep": "dumping", "totalSteps": 3}
 *                 message:
 *                   type: string
 *                   example: "Backup operation is running"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:32:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_789"
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Backup operation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *
 * GET /api/postgres/backups/:backupId/status
 * Get status of a specific backup operation
 */
router.get(
  "/backups/:backupId/status",
  requireSessionOrApiKey,
  async (req, res) => {
    const requestId = req.headers["x-request-id"] as string;
    const user = getAuthenticatedUser(req);
    const { backupId } = req.params;

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
          status: operation.status as any,
          progress: operation.progress,
          startedAt: operation.startedAt.toISOString(),
          completedAt: operation.completedAt?.toISOString() || null,
          errorMessage: operation.errorMessage,
          sizeBytes: operation.sizeBytes ? Number(operation.sizeBytes) : null,
          azureBlobUrl: operation.azureBlobUrl,
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

/**
 * @swagger
 * /api/postgres/backups/{backupId}:
 *   delete:
 *     summary: Delete backup operation
 *     description: Delete a backup operation record and its associated Azure blob storage
 *     tags:
 *       - PostgreSQL Backups
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - in: path
 *         name: backupId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the backup operation to delete
 *         example: "backup_456"
 *     responses:
 *       200:
 *         description: Backup operation deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Backup operation deleted successfully"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:35:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_101112"
 *       400:
 *         description: Bad request - cannot delete running backup
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Backup in progress"
 *                 message:
 *                   type: string
 *                   example: "Cannot delete a backup operation that is currently running"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:35:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_101112"
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Backup operation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *
 * DELETE /api/postgres/backups/:backupId
 * Delete a backup operation and its associated Azure blob
 */
router.delete(
  "/backups/:backupId",
  requireSessionOrApiKey,
  async (req, res) => {
    const requestId = res.locals.requestId;
    const userId = res.locals.user.id;
    const { backupId } = req.params;

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

      // TODO: Delete Azure blob if it exists
      // This would require Azure Storage integration
      if (operation.azureBlobUrl) {
        logger.debug(
          { requestId, backupId, blobUrl: operation.azureBlobUrl },
          "TODO: Delete Azure blob (not implemented yet)",
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

/**
 * @swagger
 * /api/postgres/backups/{backupId}/progress:
 *   get:
 *     summary: Get backup operation progress
 *     description: Retrieve detailed progress information for a backup operation including estimated completion time and current steps
 *     tags:
 *       - PostgreSQL Backups
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - in: path
 *         name: backupId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the backup operation
 *         example: "backup_456"
 *     responses:
 *       200:
 *         description: Backup operation progress retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       example: "backup_456"
 *                     databaseId:
 *                       type: string
 *                       example: "db123"
 *                     status:
 *                       type: string
 *                       enum: [pending, running, completed, failed]
 *                       example: "running"
 *                     progress:
 *                       type: number
 *                       minimum: 0
 *                       maximum: 100
 *                       example: 67
 *                     startedAt:
 *                       type: string
 *                       format: date-time
 *                       example: "2024-01-15T10:30:00.000Z"
 *                     estimatedCompletion:
 *                       type: string
 *                       format: date-time
 *                       description: Estimated completion time (only for running operations with progress > 0)
 *                       example: "2024-01-15T10:35:30.000Z"
 *                     currentStep:
 *                       type: string
 *                       description: Current backup step being executed
 *                       example: "uploading"
 *                     totalSteps:
 *                       type: integer
 *                       description: Total number of steps in the backup process
 *                       example: 3
 *                     completedSteps:
 *                       type: integer
 *                       description: Number of completed steps
 *                       example: 2
 *                     errorMessage:
 *                       type: string
 *                       nullable: true
 *                       description: Error message if the operation failed
 *                       example: null
 *                     metadata:
 *                       type: object
 *                       nullable: true
 *                       description: Additional metadata about the backup operation
 *                       example: {"currentStep": "uploading", "totalSteps": 3, "completedSteps": 2}
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:33:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_131415"
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Backup operation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *
 * GET /api/postgres/backups/:backupId/progress
 * Get detailed progress information for a backup operation
 */
router.get(
  "/backups/:backupId/progress",
  requireSessionOrApiKey,
  async (req, res) => {
    const requestId = res.locals.requestId;
    const userId = res.locals.user.id;
    const { backupId } = req.params;

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
        status: operation.status as any,
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
