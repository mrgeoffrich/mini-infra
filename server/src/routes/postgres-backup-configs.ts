import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import logger from "../lib/logger";
import { requireAuth, getAuthenticatedUser } from "../lib/auth-middleware";
import prisma from "../lib/prisma";
import { BackupConfigService } from "../services/backup-config";
import {
  CreateBackupConfigurationRequest,
  UpdateBackupConfigurationRequest,
  BackupConfigurationResponse,
  BackupConfigurationDeleteResponse,
  BackupFormat,
} from "@mini-infra/types";

const router = express.Router();

// Create backup configuration service
const backupConfigService = new BackupConfigService(prisma);

// Zod validation schemas

// Create backup configuration request validation schema
const createBackupConfigSchema = z.object({
  databaseId: z.string().min(1, "Database ID is required"),
  schedule: z.string().optional(),
  azureContainerName: z
    .string()
    .min(3, "Azure container name must be at least 3 characters")
    .max(63, "Azure container name must be at most 63 characters")
    .regex(
      /^[a-z0-9]([a-z0-9\-])*[a-z0-9]$/,
      "Azure container name must contain only lowercase letters, numbers, and hyphens, and start/end with alphanumeric characters",
    ),
  azurePathPrefix: z.string().optional().default(""),
  retentionDays: z
    .number()
    .int()
    .min(1, "Retention days must be at least 1")
    .optional()
    .default(30),
  backupFormat: z.enum(["custom", "plain", "tar"]).optional().default("custom"),
  compressionLevel: z
    .number()
    .int()
    .min(0, "Compression level must be between 0 and 9")
    .max(9, "Compression level must be between 0 and 9")
    .optional()
    .default(6),
  isEnabled: z.boolean().optional().default(true),
});

// Update backup configuration request validation schema
const updateBackupConfigSchema = z.object({
  schedule: z.string().nullable().optional(),
  azureContainerName: z
    .string()
    .min(3, "Azure container name must be at least 3 characters")
    .max(63, "Azure container name must be at most 63 characters")
    .regex(
      /^[a-z0-9]([a-z0-9\-])*[a-z0-9]$/,
      "Azure container name must contain only lowercase letters, numbers, and hyphens, and start/end with alphanumeric characters",
    )
    .optional(),
  azurePathPrefix: z.string().optional(),
  retentionDays: z
    .number()
    .int()
    .min(1, "Retention days must be at least 1")
    .optional(),
  backupFormat: z.enum(["custom", "plain", "tar"]).optional(),
  compressionLevel: z
    .number()
    .int()
    .min(0, "Compression level must be between 0 and 9")
    .max(9, "Compression level must be between 0 and 9")
    .optional(),
  isEnabled: z.boolean().optional(),
});

/**
 * GET /api/postgres/backup-configs/:databaseId - Get backup configuration for a database
 */
router.get("/:databaseId", requireAuth, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const userId = req.user?.id;
  const databaseId = req.params.databaseId;

  logger.info(
    {
      requestId,
      userId,
      databaseId,
    },
    "Backup configuration requested for database",
  );

  try {
    // Validate database ID format
    if (!databaseId || databaseId.trim().length === 0) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid database ID format",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const backupConfig = await backupConfigService.getBackupConfigByDatabaseId(
      databaseId,
      userId!,
    );

    if (!backupConfig) {
      logger.warn(
        {
          requestId,
          userId,
          databaseId,
        },
        "Backup configuration not found for database",
      );

      return res.status(404).json({
        error: "Not Found",
        message: `Backup configuration for database with ID '${databaseId}' not found`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    logger.info(
      {
        requestId,
        userId,
        databaseId,
        configId: backupConfig.id,
        isEnabled: backupConfig.isEnabled,
        schedule: backupConfig.schedule,
      },
      "Backup configuration returned successfully",
    );

    const response: BackupConfigurationResponse = {
      success: true,
      data: backupConfig,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        requestId,
        userId,
        databaseId,
      },
      "Failed to fetch backup configuration",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/postgres/backup-configs - Create backup configuration
 */
router.post("/", requireAuth, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const userId = req.user?.id;

  logger.info(
    {
      requestId,
      userId,
      body: req.body,
    },
    "Backup configuration creation requested",
  );

  try {
    // Validate request body
    const bodyValidation = createBackupConfigSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          validationErrors: bodyValidation.error.issues,
        },
        "Invalid request body for backup configuration creation",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid request data",
        details: bodyValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const createRequest: CreateBackupConfigurationRequest = bodyValidation.data;

    // Create backup configuration
    const createdConfig = await backupConfigService.createBackupConfig(
      createRequest.databaseId,
      {
        schedule: createRequest.schedule,
        azureContainerName: createRequest.azureContainerName,
        azurePathPrefix: createRequest.azurePathPrefix || "",
        retentionDays: createRequest.retentionDays,
        backupFormat: createRequest.backupFormat,
        compressionLevel: createRequest.compressionLevel,
        isEnabled: createRequest.isEnabled,
      },
      userId!,
    );

    logger.info(
      {
        requestId,
        userId,
        configId: createdConfig.id,
        databaseId: createRequest.databaseId,
        azureContainer: createRequest.azureContainerName,
        schedule: createRequest.schedule,
        isEnabled: createRequest.isEnabled,
      },
      "Backup configuration created successfully",
    );

    // Log business event
    logger.info(
      {
        event: "postgres_backup_config_created",
        userId,
        requestId,
        configId: createdConfig.id,
        databaseId: createRequest.databaseId,
        azureContainerName: createRequest.azureContainerName,
        retentionDays: createRequest.retentionDays,
        backupFormat: createRequest.backupFormat,
        hasSchedule: !!createRequest.schedule,
        isEnabled: createRequest.isEnabled,
      },
      "Business event: Backup configuration created",
    );

    const response: BackupConfigurationResponse = {
      success: true,
      data: createdConfig,
      message: "Backup configuration created successfully",
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        requestId,
        userId,
        databaseId: req.body?.databaseId,
      },
      "Failed to create backup configuration",
    );

    if (error instanceof Error) {
      if (error.message.includes("already exists")) {
        return res.status(409).json({
          error: "Conflict",
          message: error.message,
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      if (
        error.message.includes("not found") ||
        error.message.includes("access denied")
      ) {
        return res.status(404).json({
          error: "Not Found",
          message: error.message,
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      if (
        error.message.includes("Invalid") ||
        error.message.includes("not accessible") ||
        error.message.includes("cron")
      ) {
        return res.status(400).json({
          error: "Bad Request",
          message: error.message,
          timestamp: new Date().toISOString(),
          requestId,
        });
      }
    }

    next(error);
  }
}) as RequestHandler);

/**
 * DELETE /api/postgres/backup-configs/:id - Delete backup configuration
 */
router.delete("/:id", requireAuth, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const userId = req.user?.id;
  const configId = req.params.id;

  logger.info(
    {
      requestId,
      userId,
      configId,
    },
    "Backup configuration deletion requested",
  );

  try {
    // Validate config ID
    if (!configId || configId.trim().length === 0) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid backup configuration ID format",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Delete backup configuration
    await backupConfigService.deleteBackupConfig(configId, userId!);

    logger.info(
      {
        requestId,
        userId,
        configId,
      },
      "Backup configuration deleted successfully",
    );

    // Log business event
    logger.info(
      {
        event: "postgres_backup_config_deleted",
        userId,
        requestId,
        configId,
      },
      "Business event: Backup configuration deleted",
    );

    const response: BackupConfigurationDeleteResponse = {
      success: true,
      message: "Backup configuration deleted successfully",
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        requestId,
        userId,
        configId,
      },
      "Failed to delete backup configuration",
    );

    if (
      error instanceof Error &&
      (error.message.includes("not found") ||
        error.message.includes("Access denied"))
    ) {
      return res.status(404).json({
        error: "Not Found",
        message: error.message,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    next(error);
  }
}) as RequestHandler);

export default router;
