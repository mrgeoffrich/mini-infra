import express from "express";
import { z } from "zod";
import { appLogger } from "../../lib/logger-factory";
import { requireSessionOrApiKey, getCurrentUserId } from "../../middleware/auth";
import databaseManagementService from "../../services/postgres-server/database-manager";
import grantManagementService from "../../services/postgres-server/grant-manager";

const logger = appLogger();
const router = express.Router({ mergeParams: true }); // mergeParams to access :serverId

// Helper to extract userId or throw
function getUserId(req: express.Request): string {
  const userId = getCurrentUserId(req);
  if (!userId) {
    throw new Error("Unauthorized");
  }
  return userId;
}

// Validation schemas
const createDatabaseSchema = z.object({
  databaseName: z.string().min(1, "Database name is required"),
  owner: z.string().optional(),
  encoding: z.string().default("UTF8"),
  collation: z.string().optional(),
  template: z.string().default("template0"),
  connectionLimit: z.number().int().default(-1),
});

/**
 * GET /api/postgres-server/servers/:serverId/databases
 * List all databases on the server
 */
router.get("/", requireSessionOrApiKey, async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = req.params.serverId;

    const databases = await databaseManagementService.listManagedDatabases(serverId, userId);

    // Convert BigInt to string for JSON serialization
    const sanitizedDatabases = databases.map((db) => ({
      ...db,
      sizeBytes: db.sizeBytes ? db.sizeBytes.toString() : null,
    }));

    res.json({
      success: true,
      data: sanitizedDatabases,
    });
  } catch (error: any) {
    if (error.message === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    logger.error({ error: error.message }, "Failed to list databases");
    res.status(500).json({
      success: false,
      error: "Failed to list databases",
      message: error.message,
    });
  }
});

/**
 * POST /api/postgres-server/servers/:serverId/databases
 * Create a new database on the server
 */
router.post("/", requireSessionOrApiKey, async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = req.params.serverId;
    const validatedData = createDatabaseSchema.parse(req.body);

    const database = await databaseManagementService.createDatabase(serverId, userId, validatedData);

    // Convert BigInt to string for JSON serialization
    const sanitizedDatabase = {
      ...database,
      sizeBytes: database.sizeBytes ? database.sizeBytes.toString() : null,
    };

    res.status(201).json({
      success: true,
      data: sanitizedDatabase,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.issues,
      });
    }

    if (error.message === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    logger.error({ error: error.message }, "Failed to create database");
    res.status(500).json({
      success: false,
      error: "Failed to create database",
      message: error.message,
    });
  }
});

/**
 * GET /api/postgres-server/servers/:serverId/databases/:dbId
 * Get database details
 */
router.get("/:dbId", requireSessionOrApiKey, async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = req.params.serverId;
    const databaseId = req.params.dbId;

    const database = await databaseManagementService.getDatabaseDetails(serverId, userId, databaseId);

    // Convert BigInt to string for JSON serialization
    const sanitizedDatabase = {
      ...database,
      sizeBytes: database.sizeBytes ? database.sizeBytes.toString() : null,
    };

    res.json({
      success: true,
      data: sanitizedDatabase,
    });
  } catch (error: any) {
    if (error.message === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    if (error.message === "Database not found") {
      return res.status(404).json({
        success: false,
        error: "Database not found",
      });
    }

    logger.error({ error: error.message }, "Failed to get database details");
    res.status(500).json({
      success: false,
      error: "Failed to get database details",
      message: error.message,
    });
  }
});

/**
 * DELETE /api/postgres-server/servers/:serverId/databases/:dbId
 * Drop a database from the server
 */
router.delete("/:dbId", requireSessionOrApiKey, async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = req.params.serverId;
    const databaseId = req.params.dbId;

    await databaseManagementService.dropDatabase(serverId, userId, databaseId);

    res.json({
      success: true,
      message: "Database dropped successfully",
    });
  } catch (error: any) {
    if (error.message === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    if (error.message === "Database not found") {
      return res.status(404).json({
        success: false,
        error: "Database not found",
      });
    }

    logger.error({ error: error.message }, "Failed to drop database");
    res.status(500).json({
      success: false,
      error: "Failed to drop database",
      message: error.message,
    });
  }
});

/**
 * POST /api/postgres-server/servers/:serverId/databases/sync
 * Sync databases from the server
 */
router.post("/sync", requireSessionOrApiKey, async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = req.params.serverId;

    const result = await databaseManagementService.syncDatabases(serverId, userId);

    res.json({
      success: true,
      message: "Databases synced successfully",
      data: result,
    });
  } catch (error: any) {
    if (error.message === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    logger.error({ error: error.message }, "Failed to sync databases");
    res.status(500).json({
      success: false,
      error: "Failed to sync databases",
      message: error.message,
    });
  }
});

/**
 * GET /api/postgres-server/servers/:serverId/databases/:dbId/grants
 * List grants for a specific database
 */
router.get("/:dbId/grants", requireSessionOrApiKey, async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = req.params.serverId;
    const databaseId = req.params.dbId;

    const grants = await grantManagementService.listGrantsForDatabase(serverId, userId, databaseId);

    res.json({
      success: true,
      data: grants,
    });
  } catch (error: any) {
    if (error.message === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    if (error.message === "Database not found") {
      return res.status(404).json({
        success: false,
        error: "Database not found",
      });
    }

    logger.error({ error: error.message }, "Failed to list grants for database");
    res.status(500).json({
      success: false,
      error: "Failed to list grants for database",
      message: error.message,
    });
  }
});

export default router;
