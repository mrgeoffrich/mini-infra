import express from "express";
import { z } from "zod";
import { getLogger } from "../../lib/logger-factory";
import { requirePermission, getCurrentUserId } from "../../middleware/auth";
import databaseManagementService from "../../services/postgres-server/database-manager";
import grantManagementService from "../../services/postgres-server/grant-manager";

const logger = getLogger("db", "databases");
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

const changeDatabaseOwnerSchema = z.object({
  newOwner: z.string().min(1, "New owner is required"),
});

/**
 * GET /api/postgres-server/servers/:serverId/databases
 * List all databases on the server
 */
router.get("/", requirePermission('postgres:read'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = String(req.params.serverId);

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
  } catch (error) {
    if ((error instanceof Error ? error.message : String(error)) === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    logger.error({ error: (error instanceof Error ? error.message : String(error)) }, "Failed to list databases");
    res.status(500).json({
      success: false,
      error: "Failed to list databases",
      message: (error instanceof Error ? error.message : String(error)),
    });
  }
});

/**
 * POST /api/postgres-server/servers/:serverId/databases
 * Create a new database on the server
 */
router.post("/", requirePermission('postgres:write'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = String(req.params.serverId);
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
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.issues,
      });
    }

    if ((error instanceof Error ? error.message : String(error)) === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    logger.error({ error: (error instanceof Error ? error.message : String(error)) }, "Failed to create database");
    res.status(500).json({
      success: false,
      error: "Failed to create database",
      message: (error instanceof Error ? error.message : String(error)),
    });
  }
});

/**
 * GET /api/postgres-server/servers/:serverId/databases/:dbId
 * Get database details
 */
router.get("/:dbId", requirePermission('postgres:read'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = String(req.params.serverId);
    const databaseId = String(req.params.dbId);

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
  } catch (error) {
    if ((error instanceof Error ? error.message : String(error)) === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    if ((error instanceof Error ? error.message : String(error)) === "Database not found") {
      return res.status(404).json({
        success: false,
        error: "Database not found",
      });
    }

    logger.error({ error: (error instanceof Error ? error.message : String(error)) }, "Failed to get database details");
    res.status(500).json({
      success: false,
      error: "Failed to get database details",
      message: (error instanceof Error ? error.message : String(error)),
    });
  }
});

/**
 * DELETE /api/postgres-server/servers/:serverId/databases/:dbId
 * Drop a database from the server
 */
router.delete("/:dbId", requirePermission('postgres:write'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = String(req.params.serverId);
    const databaseId = String(req.params.dbId);

    await databaseManagementService.dropDatabase(serverId, userId, databaseId);

    res.json({
      success: true,
      message: "Database dropped successfully",
    });
  } catch (error) {
    if ((error instanceof Error ? error.message : String(error)) === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    if ((error instanceof Error ? error.message : String(error)) === "Database not found") {
      return res.status(404).json({
        success: false,
        error: "Database not found",
      });
    }

    logger.error({ error: (error instanceof Error ? error.message : String(error)) }, "Failed to drop database");
    res.status(500).json({
      success: false,
      error: "Failed to drop database",
      message: (error instanceof Error ? error.message : String(error)),
    });
  }
});

/**
 * PUT /api/postgres-server/servers/:serverId/databases/:dbId/owner
 * Change the owner of a database
 */
router.put("/:dbId/owner", requirePermission('postgres:write'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = String(req.params.serverId);
    const databaseId = String(req.params.dbId);
    const validatedData = changeDatabaseOwnerSchema.parse(req.body);

    const updatedDatabase = await databaseManagementService.changeOwner(
      serverId,
      userId,
      databaseId,
      validatedData.newOwner
    );

    // Convert BigInt to string for JSON serialization
    const sanitizedDatabase = {
      ...updatedDatabase,
      sizeBytes: updatedDatabase.sizeBytes ? updatedDatabase.sizeBytes.toString() : null,
    };

    res.json({
      success: true,
      data: sanitizedDatabase,
      message: "Database owner changed successfully",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.issues,
      });
    }

    if ((error instanceof Error ? error.message : String(error)) === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    if ((error instanceof Error ? error.message : String(error)) === "Database not found") {
      return res.status(404).json({
        success: false,
        error: "Database not found",
      });
    }

    logger.error({ error: (error instanceof Error ? error.message : String(error)) }, "Failed to change database owner");
    res.status(500).json({
      success: false,
      error: "Failed to change database owner",
      message: (error instanceof Error ? error.message : String(error)),
    });
  }
});

/**
 * POST /api/postgres-server/servers/:serverId/databases/sync
 * Sync databases from the server
 */
router.post("/sync", requirePermission('postgres:write'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = String(req.params.serverId);

    const result = await databaseManagementService.syncDatabases(serverId, userId);

    res.json({
      success: true,
      message: "Databases synced successfully",
      data: result,
    });
  } catch (error) {
    if ((error instanceof Error ? error.message : String(error)) === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    logger.error({ error: (error instanceof Error ? error.message : String(error)) }, "Failed to sync databases");
    res.status(500).json({
      success: false,
      error: "Failed to sync databases",
      message: (error instanceof Error ? error.message : String(error)),
    });
  }
});

/**
 * GET /api/postgres-server/servers/:serverId/databases/:dbId/grants
 * List grants for a specific database
 */
router.get("/:dbId/grants", requirePermission('postgres:read'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = String(req.params.serverId);
    const databaseId = String(req.params.dbId);

    const grants = await grantManagementService.listGrantsForDatabase(serverId, userId, databaseId);

    res.json({
      success: true,
      data: grants,
    });
  } catch (error) {
    if ((error instanceof Error ? error.message : String(error)) === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    if ((error instanceof Error ? error.message : String(error)) === "Database not found") {
      return res.status(404).json({
        success: false,
        error: "Database not found",
      });
    }

    logger.error({ error: (error instanceof Error ? error.message : String(error)) }, "Failed to list grants for database");
    res.status(500).json({
      success: false,
      error: "Failed to list grants for database",
      message: (error instanceof Error ? error.message : String(error)),
    });
  }
});

// Import and mount sub-router for table data
import tableDataRoutes from './table-data';

// Mount sub-router for table data operations
router.use('/:dbId/tables', tableDataRoutes);

export default router;
