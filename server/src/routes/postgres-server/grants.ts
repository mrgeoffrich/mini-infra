import express from "express";
import { z } from "zod";
import { getLogger } from "../../lib/logger-factory";
import { requirePermission, getCurrentUserId } from "../../middleware/auth";
import grantManagementService from "../../services/postgres-server/grant-manager";

const logger = getLogger("db", "grants");
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
router.post("/", requirePermission('postgres:write'), async (req, res) => {
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

    if ((error instanceof Error ? error.message : String(error)) === "User not found") {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    logger.error({ error: (error instanceof Error ? error.message : String(error)) }, "Failed to create grant");
    res.status(500).json({
      success: false,
      error: "Failed to create grant",
      message: (error instanceof Error ? error.message : String(error)),
    });
  }
});

/**
 * GET /api/postgres-server/grants/:grantId
 * Get grant details
 */
router.get("/:grantId", requirePermission('postgres:read'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const grantId = String(req.params.grantId);

    const grant = await grantManagementService.getGrantDetails(userId, grantId);

    res.json({
      success: true,
      data: grant,
    });
  } catch (error) {
    if ((error instanceof Error ? error.message : String(error)) === "Grant not found") {
      return res.status(404).json({
        success: false,
        error: "Grant not found",
      });
    }

    logger.error({ error: (error instanceof Error ? error.message : String(error)) }, "Failed to get grant details");
    res.status(500).json({
      success: false,
      error: "Failed to get grant details",
      message: (error instanceof Error ? error.message : String(error)),
    });
  }
});

/**
 * PUT /api/postgres-server/grants/:grantId
 * Update grant permissions
 */
router.put("/:grantId", requirePermission('postgres:write'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const grantId = String(req.params.grantId);
    const validatedData = updateGrantSchema.parse(req.body);

    const grant = await grantManagementService.updateGrant(userId, grantId, validatedData);

    res.json({
      success: true,
      data: grant,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.issues,
      });
    }

    if ((error instanceof Error ? error.message : String(error)) === "Grant not found") {
      return res.status(404).json({
        success: false,
        error: "Grant not found",
      });
    }

    logger.error({ error: (error instanceof Error ? error.message : String(error)) }, "Failed to update grant");
    res.status(500).json({
      success: false,
      error: "Failed to update grant",
      message: (error instanceof Error ? error.message : String(error)),
    });
  }
});

/**
 * DELETE /api/postgres-server/grants/:grantId
 * Revoke a grant
 */
router.delete("/:grantId", requirePermission('postgres:write'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const grantId = String(req.params.grantId);

    await grantManagementService.deleteGrant(userId, grantId);

    res.json({
      success: true,
      message: "Grant revoked successfully",
    });
  } catch (error) {
    if ((error instanceof Error ? error.message : String(error)) === "Grant not found") {
      return res.status(404).json({
        success: false,
        error: "Grant not found",
      });
    }

    logger.error({ error: (error instanceof Error ? error.message : String(error)) }, "Failed to delete grant");
    res.status(500).json({
      success: false,
      error: "Failed to delete grant",
      message: (error instanceof Error ? error.message : String(error)),
    });
  }
});

export default router;
