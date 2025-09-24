import { Router } from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";

const logger = appLogger();
import { requireSessionOrApiKey, getAuthenticatedUser } from "../middleware/auth";
import prisma from "../lib/prisma";
import { getRestoreExecutorService } from "../services/restore-executor-instance";
import { AzureConfigService } from "../services/azure-config";
import { BlobServiceClient } from "@azure/storage-blob";
import {
  RestoreOperationResponse,
  RestoreOperationStatusResponse,
  CreateRestoreOperationResponse,
  BackupBrowserResponse,
  RestoreOperationFilter,
  RestoreOperationSortOptions,
  BackupBrowserFilter,
  BackupBrowserSortOptions,
  BackupBrowserItem,
  RestoreOperationProgress,
} from "@mini-infra/types";

const router = Router();

// Initialize services
const azureConfigService = new AzureConfigService(prisma);

// ====================
// Validation Schemas
// ====================

const CreateRestoreOperationSchema = z
  .object({
    databaseId: z.string().min(1, "Database ID is required"),
    backupUrl: z
      .string()
      .url("Must be a valid URL")
      .refine(
        (url) => validateAzureStorageUrl(url),
        "Backup URL must be a valid Azure Storage blob URL ending with .dump or .sql",
      ),
    confirmRestore: z.boolean().optional(),
    restoreToNewDatabase: z.boolean().optional(),
    newDatabaseName: z
      .string()
      .min(1, "New database name is required")
      .optional(),
  })
  .refine(
    (data) => {
      // If restoreToNewDatabase is true, newDatabaseName is required
      if (data.restoreToNewDatabase && !data.newDatabaseName) {
        return false;
      }
      return true;
    },
    {
      message: "New database name is required when restoring to new database",
      path: ["newDatabaseName"],
    },
  );

const RestoreOperationFilterSchema = z.object({
  status: z.enum(["pending", "running", "completed", "failed"]).optional(),
  startedAfter: z.string().datetime().optional(),
  startedBefore: z.string().datetime().optional(),
});

const RestoreOperationSortSchema = z.object({
  field: z.enum([
    "id",
    "startedAt",
    "completedAt",
    "status",
    "progress",
    "backupUrl",
  ]),
  order: z.enum(["asc", "desc"]),
});

const BackupBrowserFilterSchema = z.object({
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
  sizeMin: z.coerce.number().min(0).optional(),
  sizeMax: z.coerce.number().min(0).optional(),
});

const BackupBrowserSortSchema = z.object({
  field: z.enum(["createdAt", "sizeBytes", "name"]),
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
 * Validate if the URL is a proper Azure Storage blob URL
 */
function validateAzureStorageUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);

    // Check if it's an Azure Storage blob URL
    const isAzureStorageUrl = parsedUrl.hostname.includes(
      ".blob.core.windows.net",
    );

    // Check if the path has at least container/blob structure
    const pathParts = parsedUrl.pathname.substring(1).split("/"); // Remove leading slash
    const hasValidPath = pathParts.length >= 2 && !!pathParts[0] && !!pathParts[1];

    // Check if it ends with .dump or .sql (expected backup file extensions)
    const isBackupFile = parsedUrl.pathname.endsWith(".dump") || parsedUrl.pathname.endsWith(".sql");

    return isAzureStorageUrl && hasValidPath && isBackupFile;
  } catch {
    return false;
  }
}

/**
 * Parse query parameters for filtering and pagination
 */
function parseRestoreOperationQuery(query: any) {
  const pagination = PaginationSchema.parse(query);
  const filter = RestoreOperationFilterSchema.parse(query);
  const sort = query.sortBy
    ? RestoreOperationSortSchema.parse({
        field: query.sortBy,
        order: query.sortOrder || "desc",
      })
    : { field: "startedAt" as const, order: "desc" as const };

  return { pagination, filter, sort };
}

/**
 * Parse backup browser query parameters
 */
function parseBackupBrowserQuery(query: any) {
  const pagination = PaginationSchema.parse(query);
  const filter = BackupBrowserFilterSchema.parse(query);
  const sort = query.sortBy
    ? BackupBrowserSortSchema.parse({
        field: query.sortBy,
        order: query.sortOrder || "desc",
      })
    : { field: "createdAt" as const, order: "desc" as const };

  return { pagination, filter, sort };
}

/**
 * Build Prisma where clause from filter
 */
function buildRestoreWhereClause(
  filter: RestoreOperationFilter,
  databaseId?: string,
) {
  const where: any = {};

  if (databaseId) {
    where.databaseId = databaseId;
  }

  if (filter.status) {
    where.status = filter.status;
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
 * Map Prisma RestoreOperation to RestoreOperationInfo
 */
function mapRestoreOperationToInfo(operation: any) {
  return {
    id: operation.id,
    databaseId: operation.databaseId,
    backupUrl: operation.backupUrl,
    status: operation.status as any,
    startedAt: operation.startedAt.toISOString(),
    completedAt: operation.completedAt?.toISOString() || null,
    errorMessage: operation.errorMessage,
    progress: operation.progress,
  };
}

/**
 * Extract backup ID from blob name
 * Expected format: databaseId/backupId_timestamp.dump
 */
function extractBackupIdFromBlobName(blobName: string): string {
  try {
    // Extract filename from path
    const pathParts = blobName.split("/");
    const filename = pathParts[pathParts.length - 1];

    // Extract backup ID (everything before the first underscore, excluding .dump extension)
    const match = filename.match(/^([^_]+)_/);
    if (match) {
      return match[1];
    }

    // Fallback - remove extension
    return filename.replace(/\.dump$/, "");
  } catch {
    return "unknown";
  }
}

/**
 * List available backups from Azure Storage for all databases in a container
 */
async function listAvailableBackupsInContainer(
  containerName: string,
  filter: BackupBrowserFilter,
  sort: BackupBrowserSortOptions,
  pagination: { page: number; limit: number },
): Promise<{ items: BackupBrowserItem[]; totalCount: number }> {
  try {
    const azureConnectionString =
      await azureConfigService.get("connection_string");
    if (!azureConnectionString) {
      throw new Error("Azure connection string not configured");
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(
      azureConnectionString,
    );
    const containerClient = blobServiceClient.getContainerClient(containerName);

    const blobs: BackupBrowserItem[] = [];

    // List all blobs in container
    for await (const blob of containerClient.listBlobsFlat({
      includeMetadata: true,
    })) {
      // Skip if not a backup file (should be .dump or .sql files based on our naming convention)
      if (!blob.name.endsWith(".dump") && !blob.name.endsWith(".sql")) {
        continue;
      }

      const blobClient = containerClient.getBlobClient(blob.name);
      const blobUrl = blobClient.url;

      // Extract database ID from blob path
      const pathParts = blob.name.split("/");
      const databaseId = pathParts.length > 1 ? pathParts[0] : "unknown";

      const item: BackupBrowserItem = {
        name: blob.name,
        url: blobUrl,
        sizeBytes: blob.properties.contentLength || 0,
        createdAt:
          blob.properties.createdOn?.toISOString() || new Date().toISOString(),
        lastModified:
          blob.properties.lastModified?.toISOString() ||
          new Date().toISOString(),
        metadata: {
          databaseName: databaseId,
          contentType: blob.properties.contentType,
          etag: blob.properties.etag,
          ...blob.metadata,
        },
      };

      // Apply filters
      if (
        filter.createdAfter &&
        new Date(item.createdAt) < new Date(filter.createdAfter)
      ) {
        continue;
      }
      if (
        filter.createdBefore &&
        new Date(item.createdAt) > new Date(filter.createdBefore)
      ) {
        continue;
      }
      if (filter.sizeMin && item.sizeBytes < filter.sizeMin) {
        continue;
      }
      if (filter.sizeMax && item.sizeBytes > filter.sizeMax) {
        continue;
      }

      blobs.push(item);
    }

    // Sort results
    blobs.sort((a, b) => {
      let aVal: any;
      let bVal: any;

      switch (sort.field) {
        case "createdAt":
          aVal = new Date(a.createdAt).getTime();
          bVal = new Date(b.createdAt).getTime();
          break;
        case "sizeBytes":
          aVal = a.sizeBytes;
          bVal = b.sizeBytes;
          break;
        case "name":
          aVal = a.name.toLowerCase();
          bVal = b.name.toLowerCase();
          break;
        default:
          aVal = new Date(a.createdAt).getTime();
          bVal = new Date(b.createdAt).getTime();
      }

      if (sort.order === "asc") {
        return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      } else {
        return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
      }
    });

    // Apply pagination
    const totalCount = blobs.length;
    const startIndex = (pagination.page - 1) * pagination.limit;
    const endIndex = startIndex + pagination.limit;
    const paginatedItems = blobs.slice(startIndex, endIndex);

    return { items: paginatedItems, totalCount };
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        containerName,
      },
      "Failed to list available backups",
    );
    throw error;
  }
}

/**
 * List available backups from Azure Storage for a specific database
 */
async function listAvailableBackups(
  containerName: string,
  databaseId: string,
  filter: BackupBrowserFilter,
  sort: BackupBrowserSortOptions,
  pagination: { page: number; limit: number },
): Promise<{ items: BackupBrowserItem[]; totalCount: number }> {
  try {
    const azureConnectionString =
      await azureConfigService.get("connection_string");
    if (!azureConnectionString) {
      throw new Error("Azure connection string not configured");
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(
      azureConnectionString,
    );
    const containerClient = blobServiceClient.getContainerClient(containerName);

    const blobs: BackupBrowserItem[] = [];

    // List blobs in container filtered by database ID prefix
    for await (const blob of containerClient.listBlobsFlat({
      prefix: `${databaseId}/`,
      includeMetadata: true,
    })) {
      // Skip if not a backup file (should be .dump files based on our naming convention)
      if (!blob.name.endsWith(".dump")) {
        continue;
      }

      const blobClient = containerClient.getBlobClient(blob.name);
      const blobUrl = blobClient.url;

      const item: BackupBrowserItem = {
        name: blob.name,
        url: blobUrl,
        sizeBytes: blob.properties.contentLength || 0,
        createdAt:
          blob.properties.createdOn?.toISOString() || new Date().toISOString(),
        lastModified:
          blob.properties.lastModified?.toISOString() ||
          new Date().toISOString(),
        metadata: {
          databaseId: databaseId,
          backupId: extractBackupIdFromBlobName(blob.name),
          contentType: blob.properties.contentType,
          etag: blob.properties.etag,
          ...blob.metadata,
        },
      };

      // Apply filters
      if (
        filter.createdAfter &&
        new Date(item.createdAt) < new Date(filter.createdAfter)
      ) {
        continue;
      }
      if (
        filter.createdBefore &&
        new Date(item.createdAt) > new Date(filter.createdBefore)
      ) {
        continue;
      }
      if (filter.sizeMin && item.sizeBytes < filter.sizeMin) {
        continue;
      }
      if (filter.sizeMax && item.sizeBytes > filter.sizeMax) {
        continue;
      }

      blobs.push(item);
    }

    // Sort results
    blobs.sort((a, b) => {
      let aVal: any;
      let bVal: any;

      switch (sort.field) {
        case "createdAt":
          aVal = new Date(a.createdAt).getTime();
          bVal = new Date(b.createdAt).getTime();
          break;
        case "sizeBytes":
          aVal = a.sizeBytes;
          bVal = b.sizeBytes;
          break;
        case "name":
          aVal = a.name.toLowerCase();
          bVal = b.name.toLowerCase();
          break;
        default:
          aVal = new Date(a.createdAt).getTime();
          bVal = new Date(b.createdAt).getTime();
      }

      if (sort.order === "asc") {
        return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      } else {
        return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
      }
    });

    // Apply pagination
    const totalCount = blobs.length;
    const startIndex = (pagination.page - 1) * pagination.limit;
    const endIndex = startIndex + pagination.limit;
    const paginatedItems = blobs.slice(startIndex, endIndex);

    return { items: paginatedItems, totalCount };
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        containerName,
        databaseId,
      },
      "Failed to list available backups",
    );
    throw error;
  }
}

// ====================
// Route Handlers
// ====================

/**
 * @swagger
 * /api/postgres/restore/{databaseId}:
 *   post:
 *     summary: Initiate database restore operation
 *     description: Start a restore operation for a PostgreSQL database from an Azure Storage backup
 *     tags:
 *       - PostgreSQL Restore
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
 *         description: The ID of the target database for restore
 *         example: "db123"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - backupUrl
 *             properties:
 *               backupUrl:
 *                 type: string
 *                 format: uri
 *                 description: Azure Storage blob URL of the backup file (.dump or .sql)
 *                 example: "https://storage.blob.core.windows.net/backups/backup_123.dump"
 *               confirmRestore:
 *                 type: boolean
 *                 description: Confirm that restore operation should proceed
 *                 default: false
 *                 example: true
 *               restoreToNewDatabase:
 *                 type: boolean
 *                 description: Whether to restore to a new database instead of overwriting
 *                 default: false
 *                 example: false
 *               newDatabaseName:
 *                 type: string
 *                 description: Name for new database (required if restoreToNewDatabase is true)
 *                 example: "my_restored_db"
 *           examples:
 *             restoreOverExisting:
 *               summary: Restore over existing database
 *               value:
 *                 backupUrl: "https://storage.blob.core.windows.net/backups/backup_123.dump"
 *                 confirmRestore: true
 *                 restoreToNewDatabase: false
 *             restoreToNewDatabase:
 *               summary: Restore to new database
 *               value:
 *                 backupUrl: "https://storage.blob.core.windows.net/backups/backup_123.dump"
 *                 confirmRestore: true
 *                 restoreToNewDatabase: true
 *                 newDatabaseName: "restored_db_copy"
 *     responses:
 *       201:
 *         description: Restore operation initiated successfully
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
 *                       example: "restore_789"
 *                     databaseId:
 *                       type: string
 *                       example: "db123"
 *                     backupUrl:
 *                       type: string
 *                       example: "https://storage.blob.core.windows.net/backups/backup_123.dump"
 *                     status:
 *                       type: string
 *                       enum: [pending, running, completed, failed]
 *                       example: "pending"
 *                     restoreToNewDatabase:
 *                       type: boolean
 *                       example: false
 *                     newDatabaseName:
 *                       type: string
 *                       nullable: true
 *                       example: null
 *                     startedAt:
 *                       type: string
 *                       format: date-time
 *                       example: "2024-01-15T10:30:00.000Z"
 *                     progress:
 *                       type: number
 *                       example: 0
 *                 message:
 *                   type: string
 *                   example: "Restore operation initiated successfully"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:30:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_123"
 *       400:
 *         description: Bad request - validation error or invalid backup URL
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
 *                   example: "Invalid backup URL"
 *                 message:
 *                   type: string
 *                   example: "Backup URL must be a valid Azure Storage blob URL ending with .dump or .sql"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:30:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_123"
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
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Database not found"
 *                 message:
 *                   type: string
 *                   example: "Database not found or you don't have access to it"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:30:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_123"
 *       409:
 *         description: Conflict - restore operation already running
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
 *                   example: "Restore operation already running"
 *                 message:
 *                   type: string
 *                   example: "A restore operation is already in progress for this database"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:30:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_123"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *
 * POST /api/postgres/restore/:databaseId
 * Initiate restore operation for a specific database
 */
router.post(
  "/restore/:databaseId",
  requireSessionOrApiKey,
  async (req, res) => {
    const requestId = res.locals.requestId;
    const user = getAuthenticatedUser(req);
    const { databaseId } = req.params;

    if (!user?.id) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
        message: "Valid authentication required",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    try {
      logger.debug(
        { requestId, userId: user?.id, databaseId },
        "Creating restore operation",
      );

      // Validate request body
      const validatedData = CreateRestoreOperationSchema.parse({
        databaseId,
        ...req.body,
      });

      logger.debug(
        {
          requestId,
            databaseId,
          backupUrl: validatedData.backupUrl,
          restoreToNewDatabase: validatedData.restoreToNewDatabase,
          newDatabaseName: validatedData.newDatabaseName,
        },
        "Backup file selected for restore operation",
      );

      // Verify database exists and user has access
      const database = await prisma.postgresDatabase.findFirst({
        where: {
          id: databaseId,
          },
      });

      if (!database) {
        logger.warn(
          { requestId, userId: user?.id, databaseId },
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

      // Check for confirmation if not explicitly provided
      if (validatedData.confirmRestore !== true) {
        logger.debug(
          { requestId, userId: user?.id, databaseId },
          "Restore operation requires confirmation",
        );
        return res.status(400).json({
          success: false,
          error: "Confirmation required",
          message:
            "Restore operations require explicit confirmation. Set confirmRestore to true.",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      // Check if there's already a running restore for this database
      const runningRestore = await prisma.restoreOperation.findFirst({
        where: {
          databaseId,
          status: { in: ["pending", "running"] },
        },
      });

      if (runningRestore) {
        logger.warn(
          {
            requestId,
                databaseId,
            runningRestoreId: runningRestore.id,
          },
          "Restore already in progress",
        );
        return res.status(409).json({
          success: false,
          error: "Restore in progress",
          message: "A restore is already in progress for this database",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      // For now, the restore service handles basic restore operations
      // The new database creation logic is handled on the frontend by prompting user to create database first
      if (validatedData.restoreToNewDatabase) {
        logger.debug(
          {
            requestId,
                databaseId,
            newDbName: validatedData.newDatabaseName,
          },
          "Restore to new database requested - user should create database first",
        );
        // Note: In a future version, this could automatically create the new database
        // For now, we assume the user has already created the target database
      }

      // Queue the restore operation
      const restoreExecutorService = getRestoreExecutorService();
      const restoreOperation = await restoreExecutorService.queueRestore(
        databaseId,
        validatedData.backupUrl,
        user.id,
        validatedData.restoreToNewDatabase
          ? validatedData.newDatabaseName
          : undefined,
      );

      logger.debug(
        {
          requestId,
            databaseId,
          operationId: restoreOperation.id,
        },
        "Restore operation queued successfully",
      );

      const response: CreateRestoreOperationResponse = {
        success: true,
        data: {
          operationId: restoreOperation.id,
          status: restoreOperation.status,
          message: "Restore operation queued successfully",
          backupUrl: restoreOperation.backupUrl,
          databaseName: database.database,
        },
        timestamp: new Date().toISOString(),
        requestId,
      };

      res.status(201).json(response);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessage = error.issues
          .map((e: any) => `${e.path.join(".")}: ${e.message}`)
          .join(", ");

        logger.warn(
          {
            requestId,
                databaseId,
            validationErrors: error.issues,
          },
          "Invalid restore operation request",
        );

        return res.status(400).json({
          success: false,
          error: "Validation error",
          message: errorMessage,
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logger.error(
        { requestId, userId: user?.id, databaseId, error: errorMessage },
        "Failed to create restore operation",
      );

      res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "Failed to create restore operation",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  },
);

/**
 * @swagger
 * /api/postgres/restore/{operationId}/status:
 *   get:
 *     summary: Get restore operation status
 *     description: Retrieve the current status and details of a specific restore operation
 *     tags:
 *       - PostgreSQL Restore
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - in: path
 *         name: operationId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the restore operation
 *         example: "restore_456"
 *     responses:
 *       200:
 *         description: Restore operation status retrieved successfully
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
 *                       example: "restore_456"
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
 *                     backupUrl:
 *                       type: string
 *                       example: "https://storage.blob.core.windows.net/backups/backup_123.dump"
 *                     databaseName:
 *                       type: string
 *                       example: "my_database"
 *                 message:
 *                   type: string
 *                   example: "Restore operation is running"
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
 *         description: Restore operation not found
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
 * GET /api/postgres/restore/:operationId/status
 * Get status of a specific restore operation
 */
router.get(
  "/restore/:operationId/status",
  requireSessionOrApiKey,
  async (req, res) => {
    const requestId = res.locals.requestId;
    const user = getAuthenticatedUser(req);
    const { operationId } = req.params;

    if (!user?.id) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
        message: "Valid authentication required",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    try {
      logger.debug(
        { requestId, userId: user?.id, operationId },
        "Fetching restore operation status",
      );

      // Get restore operation with database check for access control
      const operation = await prisma.restoreOperation.findFirst({
        where: {
          id: operationId,
        },
        include: {
          database: true,
        },
      });

      if (!operation) {
        logger.warn(
          { requestId, userId: user?.id, operationId },
          "Restore operation not found or access denied",
        );
        return res.status(404).json({
          success: false,
          error: "Restore operation not found",
          message: "Restore operation not found or you don't have access to it",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      const response: RestoreOperationStatusResponse = {
        success: true,
        data: {
          id: operation.id,
          status: operation.status as any,
          progress: operation.progress,
          startedAt: operation.startedAt.toISOString(),
          completedAt: operation.completedAt?.toISOString() || null,
          errorMessage: operation.errorMessage,
          backupUrl: operation.backupUrl,
          databaseName: operation.database.name,
        },
        message: `Restore operation is ${operation.status}`,
        timestamp: new Date().toISOString(),
        requestId,
      };

      logger.debug(
        { requestId, userId: user?.id, operationId, status: operation.status },
        "Successfully fetched restore operation status",
      );

      res.json(response);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logger.error(
        { requestId, userId: user?.id, operationId, error: errorMessage },
        "Failed to fetch restore operation status",
      );

      res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "Failed to fetch restore operation status",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  },
);

/**
 * @swagger
 * /api/postgres/restore/backups/{containerName}:
 *   get:
 *     summary: Browse available backups in Azure container
 *     description: List all available backup files in an Azure Storage container with filtering and pagination
 *     tags:
 *       - PostgreSQL Restore
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - in: path
 *         name: containerName
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the Azure Storage container
 *         example: "postgres-backups"
 *       - in: query
 *         name: createdAfter
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter backups created after this date (ISO 8601)
 *         example: "2024-01-01T00:00:00.000Z"
 *       - in: query
 *         name: createdBefore
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter backups created before this date (ISO 8601)
 *         example: "2024-12-31T23:59:59.999Z"
 *       - in: query
 *         name: sizeMin
 *         schema:
 *           type: integer
 *           minimum: 0
 *         description: Filter backups with minimum size in bytes
 *         example: 1048576
 *       - in: query
 *         name: sizeMax
 *         schema:
 *           type: integer
 *           minimum: 0
 *         description: Filter backups with maximum size in bytes
 *         example: 104857600
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
 *           enum: [createdAt, sizeBytes, name]
 *           default: createdAt
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
 *         description: Available backups retrieved successfully
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
 *                       name:
 *                         type: string
 *                         example: "db123/backup_456_20240115103000.dump"
 *                       url:
 *                         type: string
 *                         example: "https://storage.blob.core.windows.net/backups/db123/backup_456_20240115103000.dump"
 *                       sizeBytes:
 *                         type: number
 *                         example: 1048576
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                         example: "2024-01-15T10:30:00.000Z"
 *                       lastModified:
 *                         type: string
 *                         format: date-time
 *                         example: "2024-01-15T10:30:00.000Z"
 *                       metadata:
 *                         type: object
 *                         properties:
 *                           databaseName:
 *                             type: string
 *                             example: "db123"
 *                           contentType:
 *                             type: string
 *                             example: "application/octet-stream"
 *                           etag:
 *                             type: string
 *                             example: '"0x8DC1E2F3A4B5C6D"'
 *                 message:
 *                   type: string
 *                   example: "Found 5 available backups"
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
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *
 * GET /api/postgres/restore/backups/:containerName
 * Browse available backups in Azure container
 */
router.get(
  "/restore/backups/:containerName",
  requireSessionOrApiKey,
  async (req, res) => {
    const requestId = res.locals.requestId;
    const user = getAuthenticatedUser(req);
    const { containerName } = req.params;

    if (!user?.id) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
        message: "Valid authentication required",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    try {
      logger.debug(
        { requestId, userId: user?.id, containerName },
        "Browsing available backups in container",
      );

      // Parse query parameters
      const { pagination, filter, sort } = parseBackupBrowserQuery(req.query);

      // List available backups from Azure Storage for all databases
      const { items, totalCount } = await listAvailableBackupsInContainer(
        containerName,
        filter,
        sort,
        pagination,
      );

      const response: BackupBrowserResponse = {
        success: true,
        data: items,
        message: `Found ${items.length} available backups`,
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
        { requestId, userId: user?.id, containerName, count: items.length },
        "Successfully fetched available backups",
      );

      res.json(response);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logger.error(
        {
          requestId,
            containerName,
          error: errorMessage,
        },
        "Failed to browse available backups",
      );

      res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "Failed to browse available backups",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  },
);

/**
 * @swagger
 * /api/postgres/restore/{databaseId}/operations:
 *   get:
 *     summary: List restore operations for a database
 *     description: Retrieve all restore operations for a specific PostgreSQL database with filtering, sorting, and pagination
 *     tags:
 *       - PostgreSQL Restore
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
 *         description: Filter by restore operation status
 *         example: "completed"
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
 *           enum: [id, startedAt, completedAt, status, progress, backupUrl]
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
 *         description: Restore operations retrieved successfully
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
 *                         example: "restore_123"
 *                       databaseId:
 *                         type: string
 *                         example: "db123"
 *                       backupUrl:
 *                         type: string
 *                         example: "https://storage.blob.core.windows.net/backups/backup_456.dump"
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
 *                         example: "2024-01-15T10:35:45.000Z"
 *                       errorMessage:
 *                         type: string
 *                         nullable: true
 *                       progress:
 *                         type: number
 *                         minimum: 0
 *                         maximum: 100
 *                         example: 100
 *                 message:
 *                   type: string
 *                   example: "Found 3 restore operations"
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
 *                       example: 3
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
 * GET /api/postgres/restore/:databaseId/operations
 * List restore operations for a specific database
 */
router.get(
  "/restore/:databaseId/operations",
  requireSessionOrApiKey,
  async (req, res) => {
    const requestId = res.locals.requestId;
    const user = getAuthenticatedUser(req);
    const { databaseId } = req.params;

    if (!user?.id) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
        message: "Valid authentication required",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    try {
      logger.debug(
        { requestId, userId: user?.id, databaseId },
        "Fetching restore operations for database",
      );

      // Verify database exists and user has access
      const database = await prisma.postgresDatabase.findFirst({
        where: {
          id: databaseId,
          },
      });

      if (!database) {
        logger.warn(
          { requestId, userId: user?.id, databaseId },
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
      const { pagination, filter, sort } = parseRestoreOperationQuery(
        req.query,
      );
      const where = buildRestoreWhereClause(filter, databaseId);

      // Get total count for pagination
      const totalCount = await prisma.restoreOperation.count({ where });

      // Fetch restore operations
      const operations = await prisma.restoreOperation.findMany({
        where,
        orderBy: { [sort.field]: sort.order },
        skip: (pagination.page - 1) * pagination.limit,
        take: pagination.limit,
      });

      const restoreOperations = operations.map(mapRestoreOperationToInfo);

      const response = {
        success: true,
        data: restoreOperations,
        message: `Found ${restoreOperations.length} restore operations`,
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
        {
          requestId,
            databaseId,
          count: restoreOperations.length,
        },
        "Successfully fetched restore operations",
      );

      res.json(response);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logger.error(
        { requestId, userId: user?.id, databaseId, error: errorMessage },
        "Failed to fetch restore operations",
      );

      res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "Failed to fetch restore operations",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  },
);

/**
 * @swagger
 * /api/postgres/restore/{operationId}/progress:
 *   get:
 *     summary: Get restore operation progress
 *     description: Retrieve detailed progress information for a restore operation including estimated completion time
 *     tags:
 *       - PostgreSQL Restore
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - in: path
 *         name: operationId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the restore operation
 *         example: "restore_456"
 *     responses:
 *       200:
 *         description: Restore operation progress retrieved successfully
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
 *                       example: "restore_456"
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
 *                     errorMessage:
 *                       type: string
 *                       nullable: true
 *                       description: Error message if the operation failed
 *                       example: null
 *                     backupUrl:
 *                       type: string
 *                       description: The backup URL being restored from
 *                       example: "https://storage.blob.core.windows.net/backups/backup_123.dump"
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
 *         description: Restore operation not found
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
 * GET /api/postgres/restore/:operationId/progress
 * Get detailed progress information for a restore operation
 */
router.get(
  "/restore/:operationId/progress",
  requireSessionOrApiKey,
  async (req, res) => {
    const requestId = res.locals.requestId;
    const user = getAuthenticatedUser(req);
    const { operationId } = req.params;

    if (!user?.id) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
        message: "Valid authentication required",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    try {
      logger.debug(
        { requestId, userId: user?.id, operationId },
        "Fetching restore operation progress",
      );

      // Get restore operation with database check for access control
      const operation = await prisma.restoreOperation.findFirst({
        where: {
          id: operationId,
        },
        include: {
          database: true,
        },
      });

      if (!operation) {
        logger.warn(
          { requestId, userId: user?.id, operationId },
          "Restore operation not found or access denied",
        );
        return res.status(404).json({
          success: false,
          error: "Restore operation not found",
          message: "Restore operation not found or you don't have access to it",
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

      const progressData: RestoreOperationProgress = {
        id: operation.id,
        databaseId: operation.databaseId,
        status: operation.status as any,
        progress: operation.progress,
        startedAt: operation.startedAt.toISOString(),
        estimatedCompletion,
        errorMessage: operation.errorMessage || undefined,
        backupUrl: operation.backupUrl,
      };

      logger.debug(
        {
          requestId,
            operationId,
          progress: operation.progress,
        },
        "Successfully fetched restore operation progress",
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
        { requestId, userId: user?.id, operationId, error: errorMessage },
        "Failed to fetch restore operation progress",
      );

      res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "Failed to fetch restore operation progress",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  },
);

export default router;
