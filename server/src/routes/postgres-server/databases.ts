import express, { RequestHandler } from "express";
import { z } from "zod";
import { ErrorCode } from "@mini-infra/types";
import { asyncHandler } from "../../lib/async-handler";
import { UnauthorizedError } from "../../lib/errors";
import { requirePermission, getCurrentUserId } from "../../middleware/auth";
import databaseManagementService from "../../services/postgres-server/database-manager";
import grantManagementService from "../../services/postgres-server/grant-manager";
import { Permission } from "@mini-infra/types";

const router = express.Router({ mergeParams: true }); // mergeParams to access :serverId

// Helper to extract userId or throw
function getUserId(req: express.Request): string {
  const userId = getCurrentUserId(req);
  if (!userId) {
    throw new UnauthorizedError(ErrorCode.USER_NOT_AUTHENTICATED, "User not authenticated");
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
router.get(
  "/",
  requirePermission(Permission.PostgresRead) as RequestHandler,
  asyncHandler(async (req, res) => {
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
  }),
);

/**
 * POST /api/postgres-server/servers/:serverId/databases
 * Create a new database on the server
 */
router.post(
  "/",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
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
  }),
);

/**
 * GET /api/postgres-server/servers/:serverId/databases/:dbId
 * Get database details
 */
router.get(
  "/:dbId",
  requirePermission(Permission.PostgresRead) as RequestHandler,
  asyncHandler(async (req, res) => {
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
  }),
);

/**
 * DELETE /api/postgres-server/servers/:serverId/databases/:dbId
 * Drop a database from the server
 */
router.delete(
  "/:dbId",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const serverId = String(req.params.serverId);
    const databaseId = String(req.params.dbId);

    await databaseManagementService.dropDatabase(serverId, userId, databaseId);

    res.json({
      success: true,
      message: "Database dropped successfully",
    });
  }),
);

/**
 * PUT /api/postgres-server/servers/:serverId/databases/:dbId/owner
 * Change the owner of a database
 */
router.put(
  "/:dbId/owner",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
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
  }),
);

/**
 * POST /api/postgres-server/servers/:serverId/databases/sync
 * Sync databases from the server
 */
router.post(
  "/sync",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const serverId = String(req.params.serverId);

    const result = await databaseManagementService.syncDatabases(serverId, userId);

    res.json({
      success: true,
      message: "Databases synced successfully",
      data: result,
    });
  }),
);

/**
 * GET /api/postgres-server/servers/:serverId/databases/:dbId/grants
 * List grants for a specific database
 */
router.get(
  "/:dbId/grants",
  requirePermission(Permission.PostgresRead) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const serverId = String(req.params.serverId);
    const databaseId = String(req.params.dbId);

    const grants = await grantManagementService.listGrantsForDatabase(serverId, userId, databaseId);

    res.json({
      success: true,
      data: grants,
    });
  }),
);

// Import and mount sub-router for table data
import tableDataRoutes from './table-data';

// Mount sub-router for table data operations
router.use('/:dbId/tables', tableDataRoutes);

export default router;
