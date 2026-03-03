import express from "express";
import { z } from "zod";
import { appLogger } from "../../lib/logger-factory";
import { requirePermission, getCurrentUserId } from "../../middleware/auth";
import userManagementService from "../../services/postgres-server/user-manager";
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
router.get("/", requirePermission('postgres:read'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = req.params.serverId;

    const users = await userManagementService.listManagedUsers(serverId, userId);

    // Remove password hashes from response
    const sanitizedUsers = users.map((user) => {
      const { passwordHash, ...rest } = user;
      return rest;
    });

    res.json({
      success: true,
      data: sanitizedUsers,
    });
  } catch (error: any) {
    if (error.message === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    logger.error({ error: error.message }, "Failed to list users");
    res.status(500).json({
      success: false,
      error: "Failed to list users",
      message: error.message,
    });
  }
});

/**
 * POST /api/postgres-server/servers/:serverId/users
 * Create a new user on the server
 */
router.post("/", requirePermission('postgres:write'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = req.params.serverId;
    const validatedData = createUserSchema.parse(req.body);

    const user = await userManagementService.createUser(serverId, userId, validatedData);

    // Remove password hash from response
    const { passwordHash, ...sanitizedUser } = user;

    res.status(201).json({
      success: true,
      data: sanitizedUser,
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

    logger.error({ error: error.message }, "Failed to create user");
    res.status(500).json({
      success: false,
      error: "Failed to create user",
      message: error.message,
    });
  }
});

/**
 * GET /api/postgres-server/servers/:serverId/users/:userId
 * Get user details
 */
router.get("/:userId", requirePermission('postgres:read'), async (req, res) => {
  try {
    const authUserId = getUserId(req);
    const serverId = req.params.serverId;
    const managedUserId = req.params.userId;

    const user = await userManagementService.getUserDetails(serverId, authUserId, managedUserId);

    // Remove password hash from response
    const { passwordHash, ...sanitizedUser } = user;

    res.json({
      success: true,
      data: sanitizedUser,
    });
  } catch (error: any) {
    if (error.message === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    if (error.message === "User not found") {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    logger.error({ error: error.message }, "Failed to get user details");
    res.status(500).json({
      success: false,
      error: "Failed to get user details",
      message: error.message,
    });
  }
});

/**
 * PUT /api/postgres-server/servers/:serverId/users/:userId
 * Update user attributes
 */
router.put("/:userId", requirePermission('postgres:write'), async (req, res) => {
  try {
    const authUserId = getUserId(req);
    const serverId = req.params.serverId;
    const managedUserId = req.params.userId;
    const validatedData = updateUserSchema.parse(req.body);

    const user = await userManagementService.updateUser(serverId, authUserId, managedUserId, validatedData);

    // Remove password hash from response
    const { passwordHash, ...sanitizedUser } = user;

    res.json({
      success: true,
      data: sanitizedUser,
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

    if (error.message === "User not found") {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    logger.error({ error: error.message }, "Failed to update user");
    res.status(500).json({
      success: false,
      error: "Failed to update user",
      message: error.message,
    });
  }
});

/**
 * DELETE /api/postgres-server/servers/:serverId/users/:userId
 * Drop a user from the server
 */
router.delete("/:userId", requirePermission('postgres:write'), async (req, res) => {
  try {
    const authUserId = getUserId(req);
    const serverId = req.params.serverId;
    const managedUserId = req.params.userId;

    await userManagementService.dropUser(serverId, authUserId, managedUserId);

    res.json({
      success: true,
      message: "User dropped successfully",
    });
  } catch (error: any) {
    if (error.message === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    if (error.message === "User not found") {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    logger.error({ error: error.message }, "Failed to drop user");
    res.status(500).json({
      success: false,
      error: "Failed to drop user",
      message: error.message,
    });
  }
});

/**
 * POST /api/postgres-server/servers/:serverId/users/:userId/password
 * Change user password
 */
router.post("/:userId/password", requirePermission('postgres:write'), async (req, res) => {
  try {
    const authUserId = getUserId(req);
    const serverId = req.params.serverId;
    const managedUserId = req.params.userId;
    const validatedData = changePasswordSchema.parse(req.body);

    await userManagementService.changePassword(serverId, authUserId, managedUserId, validatedData.password);

    res.json({
      success: true,
      message: "Password changed successfully",
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

    if (error.message === "User not found") {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    logger.error({ error: error.message }, "Failed to change password");
    res.status(500).json({
      success: false,
      error: "Failed to change password",
      message: error.message,
    });
  }
});

/**
 * POST /api/postgres-server/servers/:serverId/users/sync
 * Sync users from the server
 */
router.post("/sync", requirePermission('postgres:write'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = req.params.serverId;

    const result = await userManagementService.syncUsers(serverId, userId);

    res.json({
      success: true,
      message: "Users synced successfully",
      data: result,
    });
  } catch (error: any) {
    if (error.message === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    logger.error({ error: error.message }, "Failed to sync users");
    res.status(500).json({
      success: false,
      error: "Failed to sync users",
      message: error.message,
    });
  }
});

/**
 * GET /api/postgres-server/servers/:serverId/users/:userId/grants
 * List grants for a specific user
 */
router.get("/:userId/grants", requirePermission('postgres:read'), async (req, res) => {
  try {
    const authUserId = getUserId(req);
    const serverId = req.params.serverId;
    const managedUserId = req.params.userId;

    const grants = await grantManagementService.listGrantsForUser(serverId, authUserId, managedUserId);

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

    if (error.message === "User not found") {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    logger.error({ error: error.message }, "Failed to list grants for user");
    res.status(500).json({
      success: false,
      error: "Failed to list grants for user",
      message: error.message,
    });
  }
});

export default router;
