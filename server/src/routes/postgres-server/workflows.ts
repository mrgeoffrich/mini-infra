import express, { RequestHandler } from "express";
import { z } from "zod";
import { ErrorCode } from "@mini-infra/types";
import { getLogger } from "../../lib/logger-factory";
import { asyncHandler } from "../../lib/async-handler";
import { UnauthorizedError } from "../../lib/errors";
import { requirePermission, getCurrentUserId } from "../../middleware/auth";
import databaseManagementService from "../../services/postgres-server/database-manager";
import userManagementService from "../../services/postgres-server/user-manager";
import grantManagementService from "../../services/postgres-server/grant-manager";
import postgresServerService from "../../services/postgres-server/server-manager";
import { Permission } from "@mini-infra/types";

const logger = getLogger("db", "workflows");
const router = express.Router();

// Helper to extract userId or throw
function getUserId(req: express.Request): string {
  const userId = getCurrentUserId(req);
  if (!userId) {
    throw new UnauthorizedError(ErrorCode.USER_NOT_AUTHENTICATED, "User not authenticated");
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
router.post(
  "/create-app-database",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
    let createdDatabase: Awaited<ReturnType<typeof databaseManagementService.createDatabase>> | null = null;
    let createdUser: Awaited<ReturnType<typeof userManagementService.createUser>> | null = null;
    let createdGrant: Awaited<ReturnType<typeof grantManagementService.createGrant>> | null = null;

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
    } catch (workflowError) {
      // Rollback any created resources
      logger.error(
        { error: (workflowError instanceof Error ? workflowError.message : String(workflowError)), database: createdDatabase?.id, user: createdUser?.id, grant: createdGrant?.id },
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
      } catch (rollbackError) {
        logger.error(
          { error: (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)) },
          "Failed to rollback workflow - manual cleanup may be required"
        );
      }

      // Re-throw the original error so the central error middleware maps it
      // (a taxonomy error from one of the steps above, or an InternalError).
      throw workflowError;
    }
  }),
);

export default router;
