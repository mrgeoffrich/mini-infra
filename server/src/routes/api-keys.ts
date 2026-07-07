import { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  createApiKey,
  getUserApiKeys,
  revokeApiKey,
  rotateApiKey,
  deleteApiKey,
  getApiKeyStats,
} from "../lib/api-key-service";
import { getLogger } from "../lib/logger-factory";
import { asyncHandler } from "../lib/async-handler";
import { getCurrentUserId } from "../middleware/auth";
import { requirePermission } from "../middleware/auth";
import {
  PERMISSION_GROUPS,
  ALL_PERMISSION_SCOPES,
  Permission,
} from "@mini-infra/types";
import { getAllPresets } from "../services/permission-preset-service";

const logger = getLogger("auth", "api-keys");
import type { CreateApiKeyRequest } from "@mini-infra/types";

const router = Router();

// Validation schemas
const createApiKeySchema = z.object({
  name: z
    .string()
    .min(1, "API key name is required")
    .max(100, "API key name must be less than 100 characters")
    .regex(
      /^[a-zA-Z0-9\s\-_]+$/,
      "API key name can only contain letters, numbers, spaces, hyphens, and underscores",
    ),
  permissions: z
    .array(z.string())
    .nullable()
    .optional()
    .refine(
      (val) => {
        if (val === null || val === undefined) return true;
        // Validate each scope is either "*" or a known scope
        return val.every(
          (scope) => scope === "*" || ALL_PERMISSION_SCOPES.includes(scope),
        );
      },
      { message: "Invalid permission scope(s) provided" },
    ),
});

// GET /api/keys/permissions - return available permissions and presets
router.get(
  "/permissions",
  requirePermission(Permission.ApiKeysRead) as RequestHandler,
  asyncHandler(async (_req: Request, res: Response) => {
    const presets = await getAllPresets();
    res.json({
      success: true,
      data: {
        groups: PERMISSION_GROUPS,
        presets,
      },
    });
  }),
);

router.get(
  "/",
  requirePermission(Permission.ApiKeysRead) as RequestHandler,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = getCurrentUserId(req)!;
    const requestId = req.headers["x-request-id"] as string;

    logger.debug({ userId, requestId }, "Fetching user API keys");

    const apiKeys = await getUserApiKeys(userId);

    res.json({
      success: true,
      data: apiKeys,
    });
  }),
);

router.post(
  "/",
  requirePermission(Permission.ApiKeysWrite) as RequestHandler,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = getCurrentUserId(req)!;
    const requestId = req.headers["x-request-id"] as string;

    // Validate request body — a failed parse throws a ZodError, which the
    // central middleware maps to the standard VALIDATION_FAILED envelope.
    const validationResult = createApiKeySchema.safeParse(req.body);
    if (!validationResult.success) {
      logger.warn(
        { userId, requestId, errors: validationResult.error.issues },
        "Invalid API key creation request",
      );
      throw validationResult.error;
    }

    const createRequest: CreateApiKeyRequest = {
      name: validationResult.data.name,
      permissions: validationResult.data.permissions ?? null,
    };

    logger.debug(
      { userId, requestId, name: createRequest.name },
      "Creating new API key",
    );

    const apiKey = await createApiKey(userId, createRequest);

    res.status(201).json({
      success: true,
      data: apiKey,
      message:
        "API key created successfully. Save this key securely - it won't be shown again.",
    });
  }),
);

router.patch(
  "/:keyId/revoke",
  requirePermission(Permission.ApiKeysWrite) as RequestHandler,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = getCurrentUserId(req)!;
    const keyId = String(req.params.keyId);
    const requestId = req.headers["x-request-id"] as string;

    logger.debug({ userId, requestId, keyId }, "Revoking API key");

    await revokeApiKey(userId, keyId);

    res.json({
      success: true,
      message: "API key revoked successfully",
    });
  }),
);

router.post(
  "/:keyId/rotate",
  requirePermission(Permission.ApiKeysWrite) as RequestHandler,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = getCurrentUserId(req)!;
    const keyId = String(req.params.keyId);
    const requestId = req.headers["x-request-id"] as string;

    logger.debug({ userId, requestId, keyId }, "Rotating API key");

    const newApiKey = await rotateApiKey(userId, keyId);

    res.json({
      success: true,
      data: newApiKey,
      message:
        "API key rotated successfully. Save the new key securely - it won't be shown again.",
    });
  }),
);

router.delete(
  "/:keyId",
  requirePermission(Permission.ApiKeysWrite) as RequestHandler,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = getCurrentUserId(req)!;
    const keyId = String(req.params.keyId);
    const requestId = req.headers["x-request-id"] as string;

    logger.debug({ userId, requestId, keyId }, "Deleting API key permanently");

    await deleteApiKey(userId, keyId);

    res.json({
      success: true,
      message: "API key deleted permanently",
    });
  }),
);

router.get(
  "/stats",
  requirePermission(Permission.ApiKeysRead) as RequestHandler,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = getCurrentUserId(req)!;
    const requestId = req.headers["x-request-id"] as string;

    logger.debug({ userId, requestId }, "Fetching API key statistics");

    const stats = await getApiKeyStats(userId);

    res.json({
      success: true,
      data: stats,
    });
  }),
);

export default router;
