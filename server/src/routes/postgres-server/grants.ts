import express from "express";
import { z } from "zod";
import { appLogger } from "../../lib/logger-factory";
import { requireSessionOrApiKey, getCurrentUserId } from "../../middleware/auth";
import grantManagementService from "../../services/postgres-server/grant-manager";

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

// Validation schemas
const createGrantSchema = z.object({
  serverId: z.string().min(1, "Server ID is required"),
  databaseId: z.string().min(1, "Database ID is required"),
  managedUserId: z.string().min(1, "User ID is required"),
  canConnect: z.boolean().default(true),
  canCreate: z.boolean().default(false),
  canTemp: z.boolean().default(false),
  canCreateSchema: z.boolean().default(false),
  canUsageSchema: z.boolean().default(true),
  canSelect: z.boolean().default(true),
  canInsert: z.boolean().default(true),
  canUpdate: z.boolean().default(true),
  canDelete: z.boolean().default(true),
});

const updateGrantSchema = z.object({
  canConnect: z.boolean().optional(),
  canCreate: z.boolean().optional(),
  canTemp: z.boolean().optional(),
  canCreateSchema: z.boolean().optional(),
  canUsageSchema: z.boolean().optional(),
  canSelect: z.boolean().optional(),
  canInsert: z.boolean().optional(),
  canUpdate: z.boolean().optional(),
  canDelete: z.boolean().optional(),
});

/**
 * POST /api/postgres-server/grants
 * Create a new grant
 */
router.post("/", requireSessionOrApiKey, async (req, res) => {
  try {
    const userId = getUserId(req);
    const validatedData = createGrantSchema.parse(req.body);

    const grant = await grantManagementService.createGrant(
      validatedData.serverId,
      userId,
      validatedData
    );

    res.status(201).json({
      success: true,
      data: grant,
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

    if (error.message === "Database not found") {
      return res.status(404).json({
        success: false,
        error: "Database not found",
      });
    }

    if (error.message === "User not found") {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    logger.error({ error: error.message }, "Failed to create grant");
    res.status(500).json({
      success: false,
      error: "Failed to create grant",
      message: error.message,
    });
  }
});

/**
 * GET /api/postgres-server/grants/:grantId
 * Get grant details
 */
router.get("/:grantId", requireSessionOrApiKey, async (req, res) => {
  try {
    const userId = getUserId(req);
    const grantId = req.params.grantId;

    // We need to get the grant first to determine the serverId
    const grant = await grantManagementService.getGrantDetails("", userId, grantId);

    res.json({
      success: true,
      data: grant,
    });
  } catch (error: any) {
    if (error.message === "Grant not found") {
      return res.status(404).json({
        success: false,
        error: "Grant not found",
      });
    }

    logger.error({ error: error.message }, "Failed to get grant details");
    res.status(500).json({
      success: false,
      error: "Failed to get grant details",
      message: error.message,
    });
  }
});

/**
 * PUT /api/postgres-server/grants/:grantId
 * Update grant permissions
 */
router.put("/:grantId", requireSessionOrApiKey, async (req, res) => {
  try {
    const userId = getUserId(req);
    const grantId = req.params.grantId;
    const validatedData = updateGrantSchema.parse(req.body);

    // Get serverId from query param or from the grant itself
    const serverId = req.query.serverId as string;
    if (!serverId) {
      return res.status(400).json({
        success: false,
        error: "Server ID is required as query parameter",
      });
    }

    const grant = await grantManagementService.updateGrant(serverId, userId, grantId, validatedData);

    res.json({
      success: true,
      data: grant,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.issues,
      });
    }

    if (error.message === "Grant not found") {
      return res.status(404).json({
        success: false,
        error: "Grant not found",
      });
    }

    logger.error({ error: error.message }, "Failed to update grant");
    res.status(500).json({
      success: false,
      error: "Failed to update grant",
      message: error.message,
    });
  }
});

/**
 * DELETE /api/postgres-server/grants/:grantId
 * Revoke a grant
 */
router.delete("/:grantId", requireSessionOrApiKey, async (req, res) => {
  try {
    const userId = getUserId(req);
    const grantId = req.params.grantId;

    // Get serverId from query param
    const serverId = req.query.serverId as string;
    if (!serverId) {
      return res.status(400).json({
        success: false,
        error: "Server ID is required as query parameter",
      });
    }

    await grantManagementService.deleteGrant(serverId, userId, grantId);

    res.json({
      success: true,
      message: "Grant revoked successfully",
    });
  } catch (error: any) {
    if (error.message === "Grant not found") {
      return res.status(404).json({
        success: false,
        error: "Grant not found",
      });
    }

    logger.error({ error: error.message }, "Failed to delete grant");
    res.status(500).json({
      success: false,
      error: "Failed to delete grant",
      message: error.message,
    });
  }
});

/**
 * GET /api/postgres-server/servers/:serverId/databases/:dbId/grants
 * List grants for a specific database
 */
router.get("/servers/:serverId/databases/:dbId/grants", requireSessionOrApiKey, async (req, res) => {
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

    logger.error({ error: error.message }, "Failed to list grants for database");
    res.status(500).json({
      success: false,
      error: "Failed to list grants for database",
      message: error.message,
    });
  }
});

/**
 * GET /api/postgres-server/users/:userId/grants
 * List grants for a specific user
 */
router.get("/users/:userId/grants", requireSessionOrApiKey, async (req, res) => {
  try {
    const authUserId = getUserId(req);
    const managedUserId = req.params.userId;

    // Get serverId from query param
    const serverId = req.query.serverId as string;
    if (!serverId) {
      return res.status(400).json({
        success: false,
        error: "Server ID is required as query parameter",
      });
    }

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

    logger.error({ error: error.message }, "Failed to list grants for user");
    res.status(500).json({
      success: false,
      error: "Failed to list grants for user",
      message: error.message,
    });
  }
});

export default router;
