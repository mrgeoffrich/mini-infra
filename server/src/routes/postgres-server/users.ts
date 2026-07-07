import express, { RequestHandler } from "express";
import { z } from "zod";
import { ErrorCode } from "@mini-infra/types";
import { asyncHandler } from "../../lib/async-handler";
import { UnauthorizedError } from "../../lib/errors";
import { requirePermission, getCurrentUserId } from "../../middleware/auth";
import userManagementService from "../../services/postgres-server/user-manager";
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
const createUserSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  canLogin: z.boolean().default(true),
  isSuperuser: z.boolean().default(false),
  connectionLimit: z.number().int().default(-1),
});

const updateUserSchema = z.object({
  canLogin: z.boolean().optional(),
  isSuperuser: z.boolean().optional(),
  connectionLimit: z.number().int().optional(),
});

const changePasswordSchema = z.object({
  password: z.string().min(1, "Password is required"),
});

/**
 * GET /api/postgres-server/servers/:serverId/users
 * List all users on the server
 */
router.get(
  "/",
  requirePermission(Permission.PostgresRead) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const serverId = String(req.params.serverId);

    const users = await userManagementService.listManagedUsers(serverId, userId);

    // Remove password hashes from response
    const sanitizedUsers = users.map((user) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { passwordHash, ...rest } = user;
      return rest;
    });

    res.json({
      success: true,
      data: sanitizedUsers,
    });
  }),
);

/**
 * POST /api/postgres-server/servers/:serverId/users
 * Create a new user on the server
 */
router.post(
  "/",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const serverId = String(req.params.serverId);
    const validatedData = createUserSchema.parse(req.body);

    const user = await userManagementService.createUser(serverId, userId, validatedData);

    // Remove password hash from response
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash, ...sanitizedUser } = user;

    res.status(201).json({
      success: true,
      data: sanitizedUser,
    });
  }),
);

/**
 * GET /api/postgres-server/servers/:serverId/users/:userId
 * Get user details
 */
router.get(
  "/:userId",
  requirePermission(Permission.PostgresRead) as RequestHandler,
  asyncHandler(async (req, res) => {
    const authUserId = getUserId(req);
    const serverId = String(req.params.serverId);
    const managedUserId = String(req.params.userId);

    const user = await userManagementService.getUserDetails(serverId, authUserId, managedUserId);

    // Remove password hash from response
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash, ...sanitizedUser } = user;

    res.json({
      success: true,
      data: sanitizedUser,
    });
  }),
);

/**
 * PUT /api/postgres-server/servers/:serverId/users/:userId
 * Update user attributes
 */
router.put(
  "/:userId",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
    const authUserId = getUserId(req);
    const serverId = String(req.params.serverId);
    const managedUserId = String(req.params.userId);
    const validatedData = updateUserSchema.parse(req.body);

    const user = await userManagementService.updateUser(serverId, authUserId, managedUserId, validatedData);

    // Remove password hash from response
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash, ...sanitizedUser } = user;

    res.json({
      success: true,
      data: sanitizedUser,
    });
  }),
);

/**
 * DELETE /api/postgres-server/servers/:serverId/users/:userId
 * Drop a user from the server
 */
router.delete(
  "/:userId",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
    const authUserId = getUserId(req);
    const serverId = String(req.params.serverId);
    const managedUserId = String(req.params.userId);

    await userManagementService.dropUser(serverId, authUserId, managedUserId);

    res.json({
      success: true,
      message: "User dropped successfully",
    });
  }),
);

/**
 * POST /api/postgres-server/servers/:serverId/users/:userId/password
 * Change user password
 */
router.post(
  "/:userId/password",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
    const authUserId = getUserId(req);
    const serverId = String(req.params.serverId);
    const managedUserId = String(req.params.userId);
    const validatedData = changePasswordSchema.parse(req.body);

    await userManagementService.changePassword(serverId, authUserId, managedUserId, validatedData.password);

    res.json({
      success: true,
      message: "Password changed successfully",
    });
  }),
);

/**
 * POST /api/postgres-server/servers/:serverId/users/sync
 * Sync users from the server
 */
router.post(
  "/sync",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const serverId = String(req.params.serverId);

    const result = await userManagementService.syncUsers(serverId, userId);

    res.json({
      success: true,
      message: "Users synced successfully",
      data: result,
    });
  }),
);

/**
 * GET /api/postgres-server/servers/:serverId/users/:userId/grants
 * List grants for a specific user
 */
router.get(
  "/:userId/grants",
  requirePermission(Permission.PostgresRead) as RequestHandler,
  asyncHandler(async (req, res) => {
    const authUserId = getUserId(req);
    const serverId = String(req.params.serverId);
    const managedUserId = String(req.params.userId);

    const grants = await grantManagementService.listGrantsForUser(serverId, authUserId, managedUserId);

    res.json({
      success: true,
      data: grants,
    });
  }),
);

export default router;
