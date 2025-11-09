import express from "express";
import { z } from "zod";
import { appLogger } from "../../lib/logger-factory";
import { requireSessionOrApiKey, getCurrentUserId } from "../../middleware/auth";
import databaseManagementService from "../../services/postgres-server/database-manager";
import userManagementService from "../../services/postgres-server/user-manager";
import grantManagementService from "../../services/postgres-server/grant-manager";
import postgresServerService from "../../services/postgres-server/server-manager";

const logger = appLogger();
const router = express.Router();

// Helper to extract userId or throw
function getUserId(req: express.Request): string {
  const userId = getCurrentUserId(req);
  if (!userId) {
    throw new Error("Unauthorized");
  }
  return userId;
}

// Validation schema
const createAppDatabaseSchema = z.object({
  serverId: z.string().min(1, "Server ID is required"),
  databaseName: z.string().min(1, "Database name is required"),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

/**
 * POST /api/postgres-server/workflows/create-app-database
 * Quick workflow: Create database + user + grant all permissions
 * Returns connection string for application use
 */
router.post("/create-app-database", requireSessionOrApiKey, async (req, res) => {
  try {
    const userId = getUserId(req);
    const validatedData = createAppDatabaseSchema.parse(req.body);

    logger.info(
      { serverId: validatedData.serverId, databaseName: validatedData.databaseName, username: validatedData.username },
      "Starting quick setup workflow"
    );

    // Step 1: Create the database
    logger.debug("Creating database");
    const database = await databaseManagementService.createDatabase(validatedData.serverId, userId, {
      databaseName: validatedData.databaseName,
      owner: "postgres", // Default owner, the new user will get full access via grants
    });

    // Step 2: Create the user
    logger.debug("Creating user");
    const user = await userManagementService.createUser(validatedData.serverId, userId, {
      username: validatedData.username,
      password: validatedData.password,
      canLogin: true,
      isSuperuser: false,
    });

    // Step 3: Grant all permissions to the user on the database
    logger.debug("Granting permissions");
    const grant = await grantManagementService.createGrant(validatedData.serverId, userId, {
      databaseId: database.id,
      managedUserId: user.id,
      canConnect: true,
      canCreate: true,
      canTemp: true,
      canCreateSchema: true,
      canUsageSchema: true,
      canSelect: true,
      canInsert: true,
      canUpdate: true,
      canDelete: true,
    });

    // Step 4: Build connection string
    const server = await postgresServerService.getServer(validatedData.serverId, userId);
    const connectionString = `postgresql://${validatedData.username}:${validatedData.password}@${server.host}:${server.port}/${validatedData.databaseName}?sslmode=${server.sslMode}`;

    logger.info(
      { serverId: validatedData.serverId, databaseId: database.id, userId: user.id, grantId: grant.id },
      "Quick setup workflow completed successfully"
    );

    // Sanitize response
    const { passwordHash, ...sanitizedUser } = user;
    const sanitizedDatabase = {
      ...database,
      sizeBytes: database.sizeBytes ? database.sizeBytes.toString() : null,
    };

    res.status(201).json({
      success: true,
      message: "Application database created successfully",
      data: {
        database: sanitizedDatabase,
        user: sanitizedUser,
        grant,
        connectionString,
      },
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

    logger.error({ error: error.message }, "Failed to create application database");
    res.status(500).json({
      success: false,
      error: "Failed to create application database",
      message: error.message,
    });
  }
});

export default router;
