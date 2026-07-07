import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { getLogger } from "../lib/logger-factory";

const logger = getLogger("backup", "postgres-backup-configs");
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import prisma from "../lib/prisma";
import { BackupConfigurationManager } from "../services/backup";
import { PostgresServerService } from "../services/postgres-server/server-manager";
import { PostgresDatabaseManager } from "../services/postgres";
import { UserPreferencesService } from "../services/user-preferences";
import { ConflictError } from "../lib/errors";
import { CreateBackupConfigurationRequest, UpdateBackupConfigurationRequest, BackupConfigurationResponse, BackupConfigurationDeleteResponse, BackupFormat, QuickBackupSetupRequest, BACKUP_FORMATS, Permission, ErrorCode } from "@mini-infra/types";

const router = express.Router();

// Create service instances
const backupConfigService = new BackupConfigurationManager(prisma);
const postgresServerService = new PostgresServerService();
const databaseConfigService = new PostgresDatabaseManager(prisma);

// IMPORTANT: Define specific routes BEFORE parameterized routes
// to prevent Express from matching specific paths as parameters

// Zod validation schemas

// Create backup configuration request validation schema. The
// `storageLocationId` is interpreted by the active StorageBackend — Azure
// container name today, Google Drive folder id in Phase 3.
const createBackupConfigSchema = z.object({
  databaseId: z.string().min(1, "Database ID is required"),
  schedule: z.string().optional(),
  timezone: z.string().optional(),
  storageLocationId: z
    .string()
    .min(1, "Storage location id is required")
    .max(256, "Storage location id must be at most 256 characters"),
  storagePathPrefix: z.string().optional().default(""),
  retentionDays: z
    .number()
    .int()
    .min(1, "Retention days must be at least 1")
    .optional()
    .default(30),
  backupFormat: z.enum(BACKUP_FORMATS).optional().default("custom"),
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
  storageLocationId: z
    .string()
    .min(1, "Storage location id is required")
    .max(256, "Storage location id must be at most 256 characters")
    .optional(),
  storagePathPrefix: z.string().optional(),
  retentionDays: z
    .number()
    .int()
    .min(1, "Retention days must be at least 1")
    .optional(),
  backupFormat: z.enum(BACKUP_FORMATS).optional(),
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
  environmentId: z.string().min(1, "Environment is required"),
});

/**
 * POST /api/postgres/backup-configs/quick-setup - Quick setup backup for a database on a server
 * IMPORTANT: This route must come BEFORE /:databaseId to prevent "quick-setup" from being matched as a databaseId
 */
router.post("/quick-setup", requirePermission(Permission.PostgresWrite) as RequestHandler, (async (
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

    // Get default container from system settings
    const defaultContainerSetting = await prisma.systemSettings.findFirst({
      where: {
        category: "system",
        key: "default_postgres_backup_container",
        isActive: true,
      },
    });
    const storageLocationId = defaultContainerSetting?.value || "postgres-backups";

    // Get the server's admin password
    const adminPassword = await postgresServerService.getServerAdminPassword(
      setupRequest.serverId,
      user.id,
    );

    // Create PostgresDatabase entry with server's admin credentials
    // Note: name field can only contain alphanumeric, hyphens, and underscores
    const safeName = `${server.name}_${setupRequest.databaseName}`.replace(/[^a-zA-Z0-9_-]/g, '_');

    // Pre-check for an existing backup config BEFORE creating anything.
    // Quick setup deterministically maps server+databaseName -> safeName, so
    // a re-run of the exact same quick-setup hits the same PostgresDatabase
    // row. From the user's POV they ran a *backup* action, so if that row
    // already has a backup config attached, the conflict is a backup-config
    // conflict — not the "database configuration already exists" error
    // createDatabase() would otherwise throw (the incident's misattribution;
    // see docs/planning/not-shipped/error-handling-overhaul-plan.md §1).
    const existingDatabase = await prisma.postgresDatabase.findUnique({
      where: { name: safeName },
    });
    if (existingDatabase) {
      const existingBackupConfig =
        await backupConfigService.getBackupConfigByDatabaseId(existingDatabase.id);
      if (existingBackupConfig) {
        throw new ConflictError(
          ErrorCode.POSTGRES_BACKUP_CONFIG_EXISTS,
          `${setupRequest.databaseName} already has a backup configuration.`,
          {
            resource: { type: "postgresBackupConfig", name: setupRequest.databaseName },
            action: "Edit the existing backup config instead of creating a new one.",
          },
        );
      }
      // Else: the database row exists but has no backup config — a leftover
      // from a prior quick-setup attempt that failed between the two
      // creates below. Fall through; createDatabase() will correctly report
      // a POSTGRES_DB_CONFIG_EXISTS conflict for this genuinely DB-level case.
    }

    const databaseEntry = await databaseConfigService.createDatabase({
      name: safeName,
      host: server.host,
      port: server.port,
      database: setupRequest.databaseName,
      username: server.adminUsername,
      password: adminPassword,
      sslMode: server.sslMode as "prefer" | "require" | "disable",
      environmentId: setupRequest.environmentId,
      tags: [`server:${server.name}`, "backup"],
    });

    // Create backup configuration with smart defaults
    const backupConfig = await backupConfigService.createBackupConfig(
      databaseEntry.id,
      {
        schedule: "0 2 * * *", // 2am every day
        timezone: timezone,
        storageLocationId: storageLocationId,
        storagePathPrefix: setupRequest.databaseName,
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

    // Taxonomy errors (e.g. the ConflictError thrown above, or the
    // ConflictError createDatabase()/createBackupConfig() throw for their
    // own conflict cases) carry their own status/code and are handled by
    // the central error middleware — just forward them. Only the remaining
    // ad-hoc string-matches below are legacy, un-migrated failure modes.
    if (error instanceof Error) {
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

router.get("/:databaseId", requirePermission(Permission.PostgresRead) as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const databaseId = String(req.params.databaseId);

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


router.post("/", requirePermission(Permission.PostgresWrite) as RequestHandler, (async (
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
        storageLocationId: createRequest.storageLocationId,
        storagePathPrefix: createRequest.storagePathPrefix || "",
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
        storageLocationId: createRequest.storageLocationId,
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
        storageLocationId: createRequest.storageLocationId,
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
router.put("/:id", requirePermission(Permission.PostgresWrite) as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const configId = String(req.params.id);

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
router.delete("/:id", requirePermission(Permission.PostgresWrite) as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const configId = String(req.params.id);

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

export default router;
