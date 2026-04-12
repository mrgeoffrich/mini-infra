import express from "express";
import { z } from "zod";
import { appLogger } from "../../lib/logger-factory";
import { requirePermission, getCurrentUserId } from "../../middleware/auth";
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
router.post("/create-app-database", requirePermission('postgres:write'), async (req, res) => {
  let createdDatabase: any = null;
  let createdUser: any = null;
  let createdGrant: any = null;

  try {
    const userId = getUserId(req);
    const validatedData = createAppDatabaseSchema.parse(req.body);

    logger.info(
      { serverId: validatedData.serverId, databaseName: validatedData.databaseName, username: validatedData.username },
      "Starting quick setup workflow"
    );

    try {
      // Step 1: Create the database
      logger.debug("Creating database");
      createdDatabase = await databaseManagementService.createDatabase(validatedData.serverId, userId, {
        databaseName: validatedData.databaseName,
        owner: "postgres", // Default owner, the new user will get full access via grants
      });

      // Step 2: Create the user
      logger.debug("Creating user");
      createdUser = await userManagementService.createUser(validatedData.serverId, userId, {
        username: validatedData.username,
        password: validatedData.password,
        canLogin: true,
        isSuperuser: false,
      });

      // Step 3: Grant all permissions to the user on the database
      logger.debug("Granting permissions");
      createdGrant = await grantManagementService.createGrant(validatedData.serverId, userId, {
        databaseId: createdDatabase.id,
        managedUserId: createdUser.id,
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
        { serverId: validatedData.serverId, databaseId: createdDatabase.id, userId: createdUser.id, grantId: createdGrant.id },
        "Quick setup workflow completed successfully"
      );

      // Sanitize response
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { passwordHash, ...sanitizedUser } = createdUser;
      const sanitizedDatabase = {
        ...createdDatabase,
        sizeBytes: createdDatabase.sizeBytes ? createdDatabase.sizeBytes.toString() : null,
      };

      res.status(201).json({
        success: true,
        message: "Application database created successfully",
        data: {
          database: sanitizedDatabase,
          user: sanitizedUser,
          grant: createdGrant,
          connectionString,
        },
      });
    } catch (workflowError: any) {
      // Rollback any created resources
      logger.error(
        { error: workflowError.message, database: createdDatabase?.id, user: createdUser?.id, grant: createdGrant?.id },
        "Quick setup workflow failed, rolling back"
      );

      try {
        // Rollback in reverse order: grant -> user -> database
        if (createdGrant) {
          logger.debug({ grantId: createdGrant.id }, "Rolling back grant");
          await grantManagementService.deleteGrant(userId, createdGrant.id);
        }

        if (createdUser) {
          logger.debug({ userId: createdUser.id }, "Rolling back user");
          await userManagementService.dropUser(validatedData.serverId, userId, createdUser.id);
        }

        if (createdDatabase) {
          logger.debug({ databaseId: createdDatabase.id }, "Rolling back database");
          await databaseManagementService.dropDatabase(validatedData.serverId, userId, createdDatabase.id);
        }

        logger.info("Rollback completed successfully");
      } catch (rollbackError: any) {
        logger.error(
          { error: rollbackError.message },
          "Failed to rollback workflow - manual cleanup may be required"
        );
      }

      // Re-throw the original error
      throw workflowError;
    }
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

    logger.error({ error: (error instanceof Error ? error.message : String(error)) }, "Failed to create application database");
    res.status(500).json({
      success: false,
      error: "Failed to create application database",
      message: (error instanceof Error ? error.message : String(error)),
    });
  }
});

export default router;
