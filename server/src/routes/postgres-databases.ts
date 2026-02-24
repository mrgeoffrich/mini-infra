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
import { PostgresDatabaseManager } from "../services/postgres-database-manager";
import {
  CreatePostgresDatabaseRequest,
  UpdatePostgresDatabaseRequest,
  TestDatabaseConnectionRequest,
  DiscoverDatabasesRequest,
  PostgresDatabaseResponse,
  PostgresDatabaseListResponse,
  PostgresDatabaseDeleteResponse,
  DatabaseConnectionTestResponse,
  DatabaseDiscoveryResponse,
  PostgresDatabaseInfo,
  PostgresDatabaseFilter,
  PostgresDatabaseSortOptions,
  PostgreSSLMode,
  DatabaseHealthStatus,
} from "@mini-infra/types";

const router = express.Router();

// Create database configuration service
const databaseConfigService = new PostgresDatabaseManager(prisma);

// Helper function to serialize database for API responses
function serializeDatabaseInfo(
  database: PostgresDatabaseInfo,
): PostgresDatabaseInfo {
  return {
    ...database,
    connectionString: "[ENCRYPTED]", // Never expose encrypted connection string in API
  };
}

// Zod validation schemas

// Query parameter validation schema for listing databases
const databaseQuerySchema = z.object({
  name: z.string().optional(),
  host: z.string().optional(),
  healthStatus: z.enum(["healthy", "unhealthy", "unknown"]).optional(),
  tags: z
    .string()
    .optional()
    .transform((val) => (val ? val.split(",") : undefined)),
  sortBy: z.string().optional().default("name"),
  sortOrder: z.enum(["asc", "desc"]).optional().default("asc"),
  page: z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (!val) return 1;
      const parsed = parseInt(val);
      if (isNaN(parsed) || parsed < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Page must be a positive integer",
        });
        return z.NEVER;
      }
      return parsed;
    }),
  limit: z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (!val) return 20;
      const parsed = parseInt(val);
      if (isNaN(parsed) || parsed < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Limit must be a positive integer",
        });
        return z.NEVER;
      }
      return Math.min(parsed, 100); // Maximum 100 databases per page
    }),
});

// Create database request validation schema
const createDatabaseSchema = z.object({
  name: z
    .string()
    .min(1, "Configuration name is required")
    .max(255, "Configuration name must be 255 characters or less"),
  host: z.string().min(1, "Host is required"),
  port: z
    .number()
    .int()
    .min(1, "Port must be between 1 and 65535")
    .max(65535, "Port must be between 1 and 65535"),
  database: z.string().min(1, "Database name is required"),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  sslMode: z.enum(["require", "disable", "prefer"]),
  tags: z.array(z.string()).optional().default([]),
});

// Update database request validation schema
const updateDatabaseSchema = z.object({
  name: z
    .string()
    .min(1, "Configuration name is required")
    .max(255, "Configuration name must be 255 characters or less")
    .optional(),
  host: z.string().min(1, "Host is required").optional(),
  port: z
    .number()
    .int()
    .min(1, "Port must be between 1 and 65535")
    .max(65535, "Port must be between 1 and 65535")
    .optional(),
  database: z.string().min(1, "Database name is required").optional(),
  username: z.string().min(1, "Username is required").optional(),
  password: z.string().min(1, "Password is required").optional(),
  sslMode: z.enum(["require", "disable", "prefer"]).optional(),
  tags: z.array(z.string()).optional(),
});

// Test connection request validation schema
const testConnectionSchema = z.object({
  host: z.string().min(1, "Host is required"),
  port: z
    .number()
    .int()
    .min(1, "Port must be between 1 and 65535")
    .max(65535, "Port must be between 1 and 65535"),
  database: z.string().min(1, "Database name is required"),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  sslMode: z.enum(["require", "disable", "prefer"]),
});

// Database discovery request validation schema
const discoverDatabasesSchema = z.object({
  host: z.string().min(1, "Host is required"),
  port: z
    .number()
    .int()
    .min(1, "Port must be between 1 and 65535")
    .max(65535, "Port must be between 1 and 65535"),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  sslMode: z.enum(["require", "disable", "prefer"]),
});

/**
 * GET /api/postgres/databases - List database configurations with filtering and pagination
 */
router.get("/", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;

  logger.debug(
    {
      requestId,
      query: req.query,
    },
    "PostgreSQL database list requested",
  );

  try {
    // Validate query parameters
    const queryValidation = databaseQuerySchema.safeParse(req.query);
    if (!queryValidation.success) {
      logger.warn(
        {
          requestId,
          validationErrors: queryValidation.error.issues,
        },
        "Invalid query parameters for PostgreSQL database list",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid query parameters",
        details: queryValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const queryParams = queryValidation.data;

    // Build filter object
    const filter: PostgresDatabaseFilter = {};
    if (queryParams.name) filter.name = queryParams.name;
    if (queryParams.host) filter.host = queryParams.host;
    if (queryParams.healthStatus)
      filter.healthStatus = queryParams.healthStatus as DatabaseHealthStatus;
    if (queryParams.tags) filter.tags = queryParams.tags;

    // Build sort options
    const sortOptions: PostgresDatabaseSortOptions = {
      field: queryParams.sortBy as keyof PostgresDatabaseInfo,
      order: queryParams.sortOrder,
    };

    // Calculate pagination
    const page = queryParams.page;
    const limit = queryParams.limit;
    const offset = (page - 1) * limit;

    // Fetch databases
    const databases = await databaseConfigService.listDatabases(
      filter,
      sortOptions,
      limit,
      offset,
    );

    // Get total count for pagination
    const allDatabases = await databaseConfigService.listDatabases();
    const totalCount = allDatabases.length;
    const hasMore = offset + limit < totalCount;

    logger.debug(
      {
        requestId,
        totalDatabases: totalCount,
        returnedDatabases: databases.length,
        page,
        limit,
      },
      "PostgreSQL database list returned successfully",
    );

    const response: PostgresDatabaseListResponse = {
      success: true,
      data: databases.map(serializeDatabaseInfo),
      pagination: {
        page,
        limit,
        totalCount,
        hasMore,
      },
    };

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        requestId,
        query: req.query,
      },
      "Failed to fetch PostgreSQL database list",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * GET /api/postgres/databases/:id - Get specific database configuration
 */
router.get("/:id", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const databaseId = req.params.id;

  logger.debug(
    {
      requestId,
      databaseId,
    },
    "PostgreSQL database details requested",
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

    const database = await databaseConfigService.getDatabaseById(
      databaseId,
    );

    if (!database) {
      logger.warn(
        {
          requestId,
          databaseId,
        },
        "PostgreSQL database not found",
      );

      return res.status(404).json({
        error: "Not Found",
        message: `Database configuration with ID '${databaseId}' not found`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    logger.debug(
      {
        requestId,
        databaseId,
        databaseName: database.name,
        healthStatus: database.healthStatus,
      },
      "PostgreSQL database details returned successfully",
    );

    const response: PostgresDatabaseResponse = {
      success: true,
      data: serializeDatabaseInfo(database),
    };

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        requestId,
        databaseId,
      },
      "Failed to fetch PostgreSQL database details",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/postgres/databases - Create new database configuration
 */
router.post("/", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;

  logger.debug(
    {
      requestId,
      body: { ...req.body, password: "[REDACTED]" }, // Redact password from logs
    },
    "PostgreSQL database creation requested",
  );

  try {
    // Validate request body
    const bodyValidation = createDatabaseSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn(
        {
          requestId,
          validationErrors: bodyValidation.error.issues,
        },
        "Invalid request body for PostgreSQL database creation",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid request data",
        details: bodyValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const createRequest: CreatePostgresDatabaseRequest = bodyValidation.data;

    // Create database configuration
    const createdDatabase = await databaseConfigService.createDatabase(
      createRequest,
    );

    logger.debug(
      {
        requestId,
        databaseId: createdDatabase.id,
        databaseName: createdDatabase.name,
        host: createdDatabase.host,
      },
      "PostgreSQL database configuration created successfully",
    );

    // Log business event
    logger.debug(
      {
        event: "postgres_database_created",
        requestId,
        databaseId: createdDatabase.id,
        databaseName: createdDatabase.name,
        host: createdDatabase.host,
        port: createdDatabase.port,
        sslMode: createdDatabase.sslMode,
        tagsCount: createdDatabase.tags.length,
      },
      "Business event: PostgreSQL database configuration created",
    );

    const response: PostgresDatabaseResponse = {
      success: true,
      data: serializeDatabaseInfo(createdDatabase),
      message: "Database configuration created successfully",
    };

    res.status(201).json(response);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        requestId,
        databaseName: req.body?.name,
      },
      "Failed to create PostgreSQL database configuration",
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
        error.message.includes("Encryption failed") ||
        error.message.includes("Invalid")
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
 * PUT /api/postgres/databases/:id - Update database configuration
 */
router.put("/:id", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const databaseId = req.params.id;

  logger.debug(
    {
      requestId,
      databaseId,
      body: {
        ...req.body,
        password: req.body.password ? "[REDACTED]" : undefined,
      },
    },
    "PostgreSQL database update requested",
  );

  try {
    // Validate database ID
    if (!databaseId || databaseId.trim().length === 0) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid database ID format",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Validate request body
    const bodyValidation = updateDatabaseSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn(
        {
          requestId,
          databaseId,
          validationErrors: bodyValidation.error.issues,
        },
        "Invalid request body for PostgreSQL database update",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid request data",
        details: bodyValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const updateRequest: UpdatePostgresDatabaseRequest = bodyValidation.data;

    // Update database configuration
    const updatedDatabase = await databaseConfigService.updateDatabase(
      databaseId,
      updateRequest,
    );

    logger.debug(
      {
        requestId,
        databaseId,
        databaseName: updatedDatabase.name,
      },
      "PostgreSQL database configuration updated successfully",
    );

    // Log business event
    logger.debug(
      {
        event: "postgres_database_updated",
        requestId,
        databaseId,
        databaseName: updatedDatabase.name,
        updatedFields: Object.keys(updateRequest),
      },
      "Business event: PostgreSQL database configuration updated",
    );

    const response: PostgresDatabaseResponse = {
      success: true,
      data: serializeDatabaseInfo(updatedDatabase),
      message: "Database configuration updated successfully",
    };

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        requestId,
        databaseId,
      },
      "Failed to update PostgreSQL database configuration",
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

      if (error.message.includes("already exists")) {
        return res.status(409).json({
          error: "Conflict",
          message: error.message,
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      if (
        error.message.includes("Invalid") ||
        error.message.includes("Encryption failed")
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
 * DELETE /api/postgres/databases/:id - Delete database configuration
 */
router.delete("/:id", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const databaseId = req.params.id;

  logger.debug(
    {
      requestId,
      databaseId,
    },
    "PostgreSQL database deletion requested",
  );

  try {
    // Validate database ID
    if (!databaseId || databaseId.trim().length === 0) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid database ID format",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Get database info before deletion for logging
    const databaseInfo = await databaseConfigService.getDatabaseById(
      databaseId,
    );

    if (!databaseInfo) {
      return res.status(404).json({
        error: "Not Found",
        message: `Database configuration with ID '${databaseId}' not found`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Delete database configuration
    await databaseConfigService.deleteDatabase(databaseId);

    logger.debug(
      {
        requestId,
        databaseId,
        databaseName: databaseInfo.name,
      },
      "PostgreSQL database configuration deleted successfully",
    );

    // Log business event
    logger.debug(
      {
        event: "postgres_database_deleted",
        requestId,
        databaseId,
        databaseName: databaseInfo.name,
        host: databaseInfo.host,
      },
      "Business event: PostgreSQL database configuration deleted",
    );

    const response: PostgresDatabaseDeleteResponse = {
      success: true,
      message: "Database configuration deleted successfully",
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
      "Failed to delete PostgreSQL database configuration",
    );

    if (
      error instanceof Error &&
      (error.message.includes("not found") ||
        error.message.includes("access denied"))
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
 * POST /api/postgres/databases/:id/test - Test database connection
 */
router.post("/:id/test", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const databaseId = req.params.id;

  logger.debug(
    {
      requestId,
      databaseId,
    },
    "PostgreSQL database connection test requested",
  );

  try {
    // Validate database ID
    if (!databaseId || databaseId.trim().length === 0) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid database ID format",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Test database connection
    const testResult = await databaseConfigService.testDatabaseConnection(
      databaseId,
    );

    logger.debug(
      {
        requestId,
        databaseId,
        isConnected: testResult.isValid,
        responseTimeMs: testResult.responseTimeMs,
        errorCode: testResult.errorCode,
      },
      "PostgreSQL database connection test completed",
    );

    // Log business event
    logger.debug(
      {
        event: "postgres_database_tested",
        requestId,
        databaseId,
        isConnected: testResult.isValid,
        responseTimeMs: testResult.responseTimeMs,
        errorCode: testResult.errorCode,
      },
      "Business event: PostgreSQL database connection tested",
    );

    const response: DatabaseConnectionTestResponse = {
      success: true,
      data: {
        isConnected: testResult.isValid,
        responseTimeMs: testResult.responseTimeMs || 0,
        error: testResult.isValid ? undefined : testResult.message,
        errorCode: testResult.errorCode,
        serverVersion: testResult.serverVersion,
        databaseName: testResult.databaseName,
        testedAt: new Date().toISOString(),
      },
      message: testResult.isValid
        ? "Connection successful"
        : "Connection failed",
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
      "Failed to test PostgreSQL database connection",
    );

    if (
      error instanceof Error &&
      (error.message.includes("not found") ||
        error.message.includes("access denied"))
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
 * POST /api/postgres/test-connection - Test connection with provided credentials (without saving)
 */
router.post("/test-connection", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;

  logger.debug(
    {
      requestId,
      body: { ...req.body, password: "[REDACTED]" },
    },
    "PostgreSQL test connection requested with provided credentials",
  );

  try {
    // Validate request body
    const bodyValidation = testConnectionSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn(
        {
          requestId,
          validationErrors: bodyValidation.error.issues,
        },
        "Invalid request body for PostgreSQL test connection",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid request data",
        details: bodyValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const testRequest: TestDatabaseConnectionRequest = bodyValidation.data;

    // Test connection
    const testResult = await databaseConfigService.testConnection(testRequest);

    logger.debug(
      {
        requestId,
        host: testRequest.host,
        port: testRequest.port,
        database: testRequest.database,
        isConnected: testResult.isValid,
        responseTimeMs: testResult.responseTimeMs,
        errorCode: testResult.errorCode,
      },
      "PostgreSQL test connection completed",
    );

    // Log business event
    logger.debug(
      {
        event: "postgres_connection_tested",
        requestId,
        host: testRequest.host,
        port: testRequest.port,
        database: testRequest.database,
        isConnected: testResult.isValid,
        responseTimeMs: testResult.responseTimeMs,
        errorCode: testResult.errorCode,
      },
      "Business event: PostgreSQL connection tested with provided credentials",
    );

    const response: DatabaseConnectionTestResponse = {
      success: true,
      data: {
        isConnected: testResult.isValid,
        responseTimeMs: testResult.responseTimeMs || 0,
        error: testResult.isValid ? undefined : testResult.message,
        errorCode: testResult.errorCode,
        serverVersion: testResult.serverVersion,
        databaseName: testResult.databaseName,
        testedAt: new Date().toISOString(),
      },
      message: testResult.isValid
        ? "Connection successful"
        : "Connection failed",
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        requestId,
        host: req.body?.host,
      },
      "Failed to test PostgreSQL connection",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/postgres/discover-databases - Discover databases on a PostgreSQL server
 */
router.post("/discover-databases", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;

  logger.debug(
    {
      requestId,
      body: { ...req.body, password: "[REDACTED]" },
    },
    "PostgreSQL database discovery requested",
  );

  try {
    // Validate request body
    const bodyValidation = discoverDatabasesSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn(
        {
          requestId,
          validationErrors: bodyValidation.error.issues,
        },
        "Invalid request body for PostgreSQL database discovery",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid request data",
        details: bodyValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const discoveryRequest: DiscoverDatabasesRequest = bodyValidation.data;

    // Discover databases
    const result = await databaseConfigService.discoverDatabases(discoveryRequest);

    logger.debug(
      {
        requestId,
        host: discoveryRequest.host,
        port: discoveryRequest.port,
        databaseCount: result.databases.length,
        responseTimeMs: result.responseTimeMs,
      },
      "PostgreSQL database discovery completed",
    );

    // Log business event
    logger.debug(
      {
        event: "postgres_databases_discovered",
        requestId,
        host: discoveryRequest.host,
        port: discoveryRequest.port,
        databaseCount: result.databases.length,
        responseTimeMs: result.responseTimeMs,
      },
      "Business event: PostgreSQL databases discovered",
    );

    const response: DatabaseDiscoveryResponse = {
      success: true,
      data: {
        databases: result.databases,
        serverVersion: result.serverVersion,
        responseTimeMs: result.responseTimeMs,
        testedAt: new Date().toISOString(),
      },
      message: `Found ${result.databases.length} database(s)`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        requestId,
        host: req.body?.host,
      },
      "Failed to discover PostgreSQL databases",
    );

    next(error);
  }
}) as RequestHandler);

export default router;
