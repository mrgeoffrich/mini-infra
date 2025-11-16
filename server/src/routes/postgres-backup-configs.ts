import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";

const logger = appLogger();
import { requireSessionOrApiKey, getAuthenticatedUser } from "../middleware/auth";
import prisma from "../lib/prisma";
import { BackupConfigService } from "../services/backup-config";
import { PostgresServerService } from "../services/postgres-server/server-manager";
import { DatabaseConfigService } from "../services/postgres-config";
import { UserPreferencesService } from "../services/user-preferences";
import {
  CreateBackupConfigurationRequest,
  UpdateBackupConfigurationRequest,
  BackupConfigurationResponse,
  BackupConfigurationDeleteResponse,
  BackupFormat,
  QuickBackupSetupRequest,
} from "@mini-infra/types";

const router = express.Router();

// Create service instances
const backupConfigService = new BackupConfigService(prisma);
const postgresServerService = new PostgresServerService();
const databaseConfigService = new DatabaseConfigService(prisma);

// Zod validation schemas

// Create backup configuration request validation schema
const createBackupConfigSchema = z.object({
  databaseId: z.string().min(1, "Database ID is required"),
  schedule: z.string().optional(),
  timezone: z.string().optional(),
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
  timezone: z.string().optional(),
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

// Quick backup setup request validation schema
const quickBackupSetupSchema = z.object({
  serverId: z.string().min(1, "Server ID is required"),
  databaseName: z.string().min(1, "Database name is required"),
});


router.get("/:databaseId", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const databaseId = req.params.databaseId;

  logger.debug(
    {
      requestId,
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
    );

    if (!backupConfig) {
      logger.warn(
        {
          requestId,
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

    logger.debug(
      {
        requestId,
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
        databaseId,
      },
      "Failed to fetch backup configuration",
    );

    next(error);
  }
}) as RequestHandler);


router.post("/", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;

  logger.debug(
    {
      requestId,
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
    );

    logger.debug(
      {
        requestId,
        configId: createdConfig.id,
        databaseId: createRequest.databaseId,
        azureContainer: createRequest.azureContainerName,
        schedule: createRequest.schedule,
        isEnabled: createRequest.isEnabled,
      },
      "Backup configuration created successfully",
    );

    // Log business event
    logger.debug(
      {
        event: "postgres_backup_config_created",
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
 * PUT /api/postgres/backup-configs/:id - Update backup configuration
 */
router.put("/:id", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const configId = req.params.id;

  logger.debug(
    {
      requestId,
      configId,
      body: req.body,
    },
    "Backup configuration update requested",
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

    // Validate request body
    const bodyValidation = updateBackupConfigSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn(
        {
          requestId,
          configId,
          validationErrors: bodyValidation.error.issues,
        },
        "Invalid request body for backup configuration update",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid request data",
        details: bodyValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const updateRequest: UpdateBackupConfigurationRequest = bodyValidation.data;

    // Update backup configuration
    const updatedConfig = await backupConfigService.updateBackupConfig(
      configId,
      updateRequest,
    );

    logger.debug(
      {
        requestId,
        configId,
        updates: Object.keys(updateRequest),
        isEnabled: updatedConfig.isEnabled,
        schedule: updatedConfig.schedule,
      },
      "Backup configuration updated successfully",
    );

    // Log business event
    logger.debug(
      {
        event: "postgres_backup_config_updated",
        requestId,
        configId,
        databaseId: updatedConfig.databaseId,
        updates: Object.keys(updateRequest),
        isEnabled: updatedConfig.isEnabled,
        hasSchedule: !!updatedConfig.schedule,
      },
      "Business event: Backup configuration updated",
    );

    const response: BackupConfigurationResponse = {
      success: true,
      data: updatedConfig,
      message: "Backup configuration updated successfully",
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        requestId,
        configId,
      },
      "Failed to update backup configuration",
    );

    if (error instanceof Error) {
      if (
        error.message.includes("not found") ||
        error.message.includes("Access denied")
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
router.delete("/:id", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const configId = req.params.id;

  logger.debug(
    {
      requestId,
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
    await backupConfigService.deleteBackupConfig(configId,);

    logger.debug(
      {
        requestId,
        configId,
      },
      "Backup configuration deleted successfully",
    );

    // Log business event
    logger.debug(
      {
        event: "postgres_backup_config_deleted",
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

/**
 * POST /api/postgres/backup-configs/quick-setup - Quick setup backup for a database on a server
 */
router.post("/quick-setup", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;

  logger.debug(
    {
      requestId,
      body: req.body,
    },
    "Quick backup setup requested",
  );

  try {
    // Get authenticated user
    const user = getAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "User not authenticated",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Validate request body
    const bodyValidation = quickBackupSetupSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn(
        {
          requestId,
          validationErrors: bodyValidation.error.issues,
        },
        "Invalid request body for quick backup setup",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid request data",
        details: bodyValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const setupRequest: QuickBackupSetupRequest = bodyValidation.data;

    // Get the PostgreSQL server
    const server = await postgresServerService.getServer(
      setupRequest.serverId,
      user.id,
    );

    if (!server) {
      return res.status(404).json({
        error: "Not Found",
        message: `PostgreSQL server with ID '${setupRequest.serverId}' not found`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Get user preferences for timezone
    const userPreferences = await UserPreferencesService.getUserPreferences(user.id);
    const timezone = userPreferences.timezone || "UTC";

    // Get the server's admin password
    const adminPassword = await postgresServerService.getServerAdminPassword(
      setupRequest.serverId,
      user.id,
    );

    // Create PostgresDatabase entry with server's admin credentials
    const databaseEntry = await databaseConfigService.createDatabase({
      name: `${server.name} - ${setupRequest.databaseName}`,
      host: server.host,
      port: server.port,
      database: setupRequest.databaseName,
      username: server.adminUsername,
      password: adminPassword,
      sslMode: server.sslMode as "prefer" | "require" | "disable",
      tags: [`server:${server.name}`, "backup"],
    });

    // Create backup configuration with smart defaults
    const backupConfig = await backupConfigService.createBackupConfig(
      databaseEntry.id,
      {
        schedule: "0 2 * * *", // 2am every day
        timezone: timezone,
        azureContainerName: "postgres-backups",
        azurePathPrefix: setupRequest.databaseName,
        retentionDays: 30,
        backupFormat: "custom" as BackupFormat,
        compressionLevel: 6,
        isEnabled: true,
      },
    );

    logger.info(
      {
        requestId,
        serverId: server.id,
        databaseName: setupRequest.databaseName,
        databaseId: databaseEntry.id,
        configId: backupConfig.id,
        timezone,
      },
      "Quick backup setup completed successfully",
    );

    // Log business event
    logger.debug(
      {
        event: "postgres_backup_quick_setup",
        requestId,
        serverId: server.id,
        databaseName: setupRequest.databaseName,
        databaseId: databaseEntry.id,
        configId: backupConfig.id,
        timezone,
      },
      "Business event: Quick backup setup completed",
    );

    const response: BackupConfigurationResponse = {
      success: true,
      data: backupConfig,
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
        serverId: req.body?.serverId,
        databaseName: req.body?.databaseName,
      },
      "Failed to create quick backup setup",
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
        error.message.includes("Server not found")
      ) {
        return res.status(404).json({
          error: "Not Found",
          message: error.message,
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      if (error.message.includes("Invalid")) {
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

export default router;
