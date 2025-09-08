import { Router } from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";

const logger = appLogger();
import { requireSessionOrApiKey } from "../lib/api-key-middleware";
import { getAuthenticatedUser } from "../lib/auth-middleware";
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
        "Backup URL must be a valid Azure Storage blob URL ending with .dump",
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

    // Check if it ends with .dump (expected backup file extension)
    const isDumpFile = parsedUrl.pathname.endsWith(".dump");

    return isAzureStorageUrl && hasValidPath && isDumpFile;
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
      logger.info(
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
          userId: user?.id,
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
          userId: user?.id,
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
        logger.info(
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
            userId: user?.id,
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
        logger.info(
          {
            requestId,
            userId: user?.id,
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

      logger.info(
        {
          requestId,
          userId: user?.id,
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
            userId: user?.id,
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
      logger.info(
        { requestId, userId: user?.id, operationId },
        "Fetching restore operation status",
      );

      // Get restore operation with database check for access control
      const operation = await prisma.restoreOperation.findFirst({
        where: {
          id: operationId,
          database: { userId: user?.id },
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
          databaseName: operation.database.database,
        },
        message: `Restore operation is ${operation.status}`,
        timestamp: new Date().toISOString(),
        requestId,
      };

      logger.info(
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
 * GET /api/postgres/restore/backups/:containerName/:databaseId
 * Browse available backups in Azure container for a specific database
 */
router.get(
  "/restore/backups/:containerName/:databaseId",
  requireSessionOrApiKey,
  async (req, res) => {
    const requestId = res.locals.requestId;
    const user = getAuthenticatedUser(req);
    const { containerName, databaseId } = req.params;

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
      logger.info(
        { requestId, userId: user?.id, containerName, databaseId },
        "Browsing available backups for database",
      );

      // Verify database exists and user has access
      const database = await prisma.postgresDatabase.findFirst({
        where: {
          id: databaseId,
          userId: user?.id,
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
      const { pagination, filter, sort } = parseBackupBrowserQuery(req.query);

      // List available backups from Azure Storage for this database
      const { items, totalCount } = await listAvailableBackups(
        containerName,
        databaseId,
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

      logger.info(
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
          userId: user?.id,
          containerName,
          databaseId,
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
      logger.info(
        { requestId, userId: user?.id, databaseId },
        "Fetching restore operations for database",
      );

      // Verify database exists and user has access
      const database = await prisma.postgresDatabase.findFirst({
        where: {
          id: databaseId,
          userId: user?.id,
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

      logger.info(
        {
          requestId,
          userId: user?.id,
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
      logger.info(
        { requestId, userId: user?.id, operationId },
        "Fetching restore operation progress",
      );

      // Get restore operation with database check for access control
      const operation = await prisma.restoreOperation.findFirst({
        where: {
          id: operationId,
          database: { userId: user?.id },
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

      logger.info(
        {
          requestId,
          userId: user?.id,
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
