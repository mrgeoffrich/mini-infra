import { Router, Request, Response } from "express";
import { z } from "zod";
import { getLogger } from "../lib/logger-factory";

const logger = getLogger("backup", "postgres-progress");
import { ProgressTrackerService } from "../services/progress-tracker";
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import prisma from "../lib/prisma";

const router = Router();

// Initialize progress tracker service
const progressTracker = new ProgressTrackerService(prisma);

// Initialize the service on first use
const initializeProgressTracker = async () => {
  await progressTracker.initialize();
};

// Validation schemas
const GetProgressParamsSchema = z.object({
  operationId: z.string().min(1, "Operation ID is required"),
});

const GetHistoryQuerySchema = z.object({
  databaseId: z.string().optional(),
  operationType: z.enum(["backup", "restore", "all"]).default("all"),
  status: z
    .enum(["pending", "running", "completed", "failed", "all"])
    .default("all"),
  startedAfter: z.string().datetime().optional(),
  startedBefore: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
});

/**
 * GET /api/postgres/progress/backup/:operationId
 * Get progress for a specific backup operation
 */
router.get(
  "/backup/:operationId",
  requirePermission('postgres:read'),
  async (req: Request, res: Response) => {
    const requestId = req.headers["x-request-id"] as string;
    const user = getAuthenticatedUser(req);
    const userId = user?.id;

    try {
      if (!userId) {
        return res.status(401).json({
          success: false,
          error: "Authentication required",
          message: "You must be logged in to access this endpoint",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      // Validate request parameters
      const parseResult = GetProgressParamsSchema.safeParse(req.params);
      if (!parseResult.success) {
        logger.warn(
          {
            requestId,
            userId,
            errors: parseResult.error.issues,
            params: req.params,
          },
          "Invalid request parameters for backup progress",
        );

        return res.status(400).json({
          success: false,
          error: "Validation failed",
          message: "Invalid operation ID",
          details: parseResult.error.issues,
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      const { operationId } = parseResult.data;

      await initializeProgressTracker();

      // Get backup progress
      const progress = await progressTracker.getBackupProgress(operationId);

      if (!progress) {
        return res.status(404).json({
          success: false,
          error: "Not found",
          message: "Backup operation not found",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      logger.debug(
        {
          requestId,
          userId,
          operationId,
          status: progress.status,
          progress: progress.progress,
        },
        "Retrieved backup progress",
      );

      return res.json({
        success: true,
        data: progress,
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      logger.error(
        {
          requestId,
          userId,
          operationId: req.params.operationId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get backup progress",
      );

      return res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "Failed to retrieve backup progress",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  },
);

/**
 * GET /api/postgres/progress/restore/:operationId
 * Get progress for a specific restore operation
 */
router.get(
  "/restore/:operationId",
  requirePermission('postgres:read'),
  async (req: Request, res: Response) => {
    const requestId = req.headers["x-request-id"] as string;
    const user = getAuthenticatedUser(req);
    const userId = user?.id;

    try {
      if (!userId) {
        return res.status(401).json({
          success: false,
          error: "Authentication required",
          message: "You must be logged in to access this endpoint",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      // Validate request parameters
      const parseResult = GetProgressParamsSchema.safeParse(req.params);
      if (!parseResult.success) {
        logger.warn(
          {
            requestId,
            userId,
            errors: parseResult.error.issues,
            params: req.params,
          },
          "Invalid request parameters for restore progress",
        );

        return res.status(400).json({
          success: false,
          error: "Validation failed",
          message: "Invalid operation ID",
          details: parseResult.error.issues,
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      const { operationId } = parseResult.data;

      await initializeProgressTracker();

      // Get restore progress
      const progress = await progressTracker.getRestoreProgress(operationId);

      if (!progress) {
        return res.status(404).json({
          success: false,
          error: "Not found",
          message: "Restore operation not found",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      logger.debug(
        {
          requestId,
          userId,
          operationId,
          status: progress.status,
          progress: progress.progress,
        },
        "Retrieved restore progress",
      );

      return res.json({
        success: true,
        data: progress,
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      logger.error(
        {
          requestId,
          userId,
          operationId: req.params.operationId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get restore progress",
      );

      return res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "Failed to retrieve restore progress",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  },
);

/**
 * GET /api/postgres/progress/active
 * Get all active operations (pending or running) for the current user
 */
router.get(
  "/active",
  requirePermission('postgres:read'),
  async (req: Request, res: Response) => {
    const requestId = req.headers["x-request-id"] as string;
    const user = getAuthenticatedUser(req);
    const userId = user?.id;

    try {
      if (!userId) {
        return res.status(401).json({
          success: false,
          error: "Authentication required",
          message: "You must be logged in to access this endpoint",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      await initializeProgressTracker();

      // Get active operations
      const activeOperations = await progressTracker.getActiveOperations();

      logger.debug(
        {
          requestId,
          userId,
          backupCount: activeOperations.backupOperations.length,
          restoreCount: activeOperations.restoreOperations.length,
        },
        "Retrieved active operations",
      );

      return res.json({
        success: true,
        data: activeOperations,
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      logger.error(
        {
          requestId,
          userId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get active operations",
      );

      return res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "Failed to retrieve active operations",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  },
);

/**
 * GET /api/postgres/progress/history
 * Get operation history with filtering and pagination
 */
router.get(
  "/history",
  requirePermission('postgres:read'),
  async (req: Request, res: Response) => {
    const requestId = req.headers["x-request-id"] as string;
    const user = getAuthenticatedUser(req);
    const userId = user?.id;

    try {
      if (!userId) {
        return res.status(401).json({
          success: false,
          error: "Authentication required",
          message: "You must be logged in to access this endpoint",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      // Validate query parameters
      const parseResult = GetHistoryQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        logger.warn(
          {
            requestId,
            userId,
            errors: parseResult.error.issues,
            query: req.query,
          },
          "Invalid query parameters for operation history",
        );

        return res.status(400).json({
          success: false,
          error: "Validation failed",
          message: "Invalid query parameters",
          details: parseResult.error.issues,
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      const {
        databaseId,
        operationType,
        status,
        startedAfter,
        startedBefore,
        limit,
        offset,
      } = parseResult.data;

      await initializeProgressTracker();

      // Build filter
      const filter: Record<string, unknown> = {
        databaseId,
        operationType,
        status: status === "all" ? undefined : status,
        startedAfter: startedAfter ? new Date(startedAfter) : undefined,
        startedBefore: startedBefore ? new Date(startedBefore) : undefined,
        limit,
        offset,
      };

      // Remove undefined values
      Object.keys(filter).forEach((key) => {
        if (filter[key] === undefined) {
          delete filter[key];
        }
      });

      // Get operation history
      const history = await progressTracker.getOperationHistory(filter);

      logger.debug(
        {
          requestId,
          userId,
          filter,
          operationCount: history.operations.length,
          totalCount: history.totalCount,
          hasMore: history.hasMore,
        },
        "Retrieved operation history",
      );

      return res.json({
        success: true,
        data: history.operations,
        pagination: {
          offset,
          limit,
          totalCount: history.totalCount,
          hasMore: history.hasMore,
        },
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      logger.error(
        {
          requestId,
          userId,
          query: req.query,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get operation history",
      );

      return res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "Failed to retrieve operation history",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  },
);

/**
 * POST /api/postgres/progress/cleanup
 * Manually trigger cleanup of old operations (admin only)
 */
router.post(
  "/cleanup",
  requirePermission('postgres:write'),
  async (req: Request, res: Response) => {
    const requestId = req.headers["x-request-id"] as string;
    const user = getAuthenticatedUser(req);
    const userId = user?.id;

    try {
      if (!userId) {
        return res.status(401).json({
          success: false,
          error: "Authentication required",
          message: "You must be logged in to access this endpoint",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      await initializeProgressTracker();

      // Perform cleanup
      const result = await progressTracker.cleanupOldOperations();

      logger.debug(
        {
          requestId,
          userId,
          deletedBackupOperations: result.deletedBackupOperations,
          deletedRestoreOperations: result.deletedRestoreOperations,
          repairedStaleBackupOperations: result.repairedStaleBackupOperations,
          repairedStaleRestoreOperations: result.repairedStaleRestoreOperations,
        },
        "Manual cleanup of old operations completed",
      );

      return res.json({
        success: true,
        data: {
          deletedBackupOperations: result.deletedBackupOperations,
          deletedRestoreOperations: result.deletedRestoreOperations,
          repairedStaleBackupOperations: result.repairedStaleBackupOperations,
          repairedStaleRestoreOperations: result.repairedStaleRestoreOperations,
          message: "Cleanup completed successfully",
        },
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      logger.error(
        {
          requestId,
          userId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to perform cleanup",
      );

      return res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "Failed to perform cleanup",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  },
);

export default router;
