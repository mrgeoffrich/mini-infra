import express, { RequestHandler } from "express";
import { z } from "zod";
import { ErrorCode } from "@mini-infra/types";
import { asyncHandler } from "../../lib/async-handler";
import { UnauthorizedError } from "../../lib/errors";
import { requirePermission, getCurrentUserId } from "../../middleware/auth";
import grantManagementService from "../../services/postgres-server/grant-manager";
import { Permission } from "@mini-infra/types";

const router = express.Router();

// Helper to extract userId or throw
function getUserId(req: express.Request): string {
  const userId = getCurrentUserId(req);
  if (!userId) {
    throw new UnauthorizedError(ErrorCode.USER_NOT_AUTHENTICATED, "User not authenticated");
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
router.post(
  "/",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
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
  }),
);

/**
 * GET /api/postgres-server/grants/:grantId
 * Get grant details
 */
router.get(
  "/:grantId",
  requirePermission(Permission.PostgresRead) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const grantId = String(req.params.grantId);

    const grant = await grantManagementService.getGrantDetails(userId, grantId);

    res.json({
      success: true,
      data: grant,
    });
  }),
);

/**
 * PUT /api/postgres-server/grants/:grantId
 * Update grant permissions
 */
router.put(
  "/:grantId",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const grantId = String(req.params.grantId);
    const validatedData = updateGrantSchema.parse(req.body);

    const grant = await grantManagementService.updateGrant(userId, grantId, validatedData);

    res.json({
      success: true,
      data: grant,
    });
  }),
);

/**
 * DELETE /api/postgres-server/grants/:grantId
 * Revoke a grant
 */
router.delete(
  "/:grantId",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const grantId = String(req.params.grantId);

    await grantManagementService.deleteGrant(userId, grantId);

    res.json({
      success: true,
      message: "Grant revoked successfully",
    });
  }),
);

export default router;
