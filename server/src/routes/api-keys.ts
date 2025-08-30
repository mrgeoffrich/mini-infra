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
import logger from "../lib/logger";
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
});

/**
 * Middleware to ensure user is authenticated (session required for API key management)
 */
function requireAuth(req: Request, res: Response, next: () => void) {
  if (!req.user) {
    logger.warn(
      { path: req.path },
      "API key management attempted without authentication",
    );
    return res.status(401).json({
      error: "Authentication required",
      message: "You must be logged in to manage API keys",
    });
  }
  next();
}

// Apply authentication to all routes
router.use(requireAuth as RequestHandler);

/**
 * GET /api/keys - Get all API keys for the current user
 */
router.get("/", (async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const requestId = req.headers["x-request-id"] as string;

  try {
    logger.info({ userId, requestId }, "Fetching user API keys");

    const apiKeys = await getUserApiKeys(userId);

    res.json({
      success: true,
      data: apiKeys,
    });
  } catch (error) {
    logger.error({ error, userId, requestId }, "Failed to fetch API keys");

    res.status(500).json({
      error: "Internal server error",
      message: "Failed to retrieve API keys",
    });
  }
}) as RequestHandler);

/**
 * POST /api/keys - Create a new API key
 */
router.post("/", (async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const requestId = req.headers["x-request-id"] as string;

  try {
    // Validate request body
    const validationResult = createApiKeySchema.safeParse(req.body);
    if (!validationResult.success) {
      logger.warn(
        { userId, requestId, errors: validationResult.error.issues },
        "Invalid API key creation request",
      );
      return res.status(400).json({
        error: "Validation error",
        message: "Invalid request data",
        details: validationResult.error.issues,
      });
    }

    const createRequest: CreateApiKeyRequest = validationResult.data;

    logger.info(
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
  } catch (error) {
    logger.error({ error, userId, requestId }, "Failed to create API key");

    res.status(500).json({
      error: "Internal server error",
      message: "Failed to create API key",
    });
  }
}) as RequestHandler);

/**
 * PATCH /api/keys/:keyId/revoke - Revoke (deactivate) an API key
 */
router.patch("/:keyId/revoke", (async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { keyId } = req.params;
  const requestId = req.headers["x-request-id"] as string;

  try {
    logger.info({ userId, requestId, keyId }, "Revoking API key");

    await revokeApiKey(userId, keyId);

    res.json({
      success: true,
      message: "API key revoked successfully",
    });
  } catch (error) {
    logger.error(
      { error, userId, requestId, keyId },
      "Failed to revoke API key",
    );

    if (error instanceof Error && error.message.includes("not found")) {
      return res.status(404).json({
        error: "Not found",
        message: "API key not found or not owned by user",
      });
    }

    res.status(500).json({
      error: "Internal server error",
      message: "Failed to revoke API key",
    });
  }
}) as RequestHandler);

/**
 * POST /api/keys/:keyId/rotate - Rotate an API key (create new, deactivate old)
 */
router.post("/:keyId/rotate", (async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { keyId } = req.params;
  const requestId = req.headers["x-request-id"] as string;

  try {
    logger.info({ userId, requestId, keyId }, "Rotating API key");

    const newApiKey = await rotateApiKey(userId, keyId);

    res.json({
      success: true,
      data: newApiKey,
      message:
        "API key rotated successfully. Save the new key securely - it won't be shown again.",
    });
  } catch (error) {
    logger.error(
      { error, userId, requestId, keyId },
      "Failed to rotate API key",
    );

    if (error instanceof Error && error.message.includes("not found")) {
      return res.status(404).json({
        error: "Not found",
        message: "API key not found or not owned by user",
      });
    }

    res.status(500).json({
      error: "Internal server error",
      message: "Failed to rotate API key",
    });
  }
}) as RequestHandler);

/**
 * DELETE /api/keys/:keyId - Permanently delete an API key
 */
router.delete("/:keyId", (async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { keyId } = req.params;
  const requestId = req.headers["x-request-id"] as string;

  try {
    logger.info({ userId, requestId, keyId }, "Deleting API key permanently");

    await deleteApiKey(userId, keyId);

    res.json({
      success: true,
      message: "API key deleted permanently",
    });
  } catch (error) {
    logger.error(
      { error, userId, requestId, keyId },
      "Failed to delete API key",
    );

    if (error instanceof Error && error.message.includes("not found")) {
      return res.status(404).json({
        error: "Not found",
        message: "API key not found or not owned by user",
      });
    }

    res.status(500).json({
      error: "Internal server error",
      message: "Failed to delete API key",
    });
  }
}) as RequestHandler);

/**
 * GET /api/keys/stats - Get API key statistics for the current user
 */
router.get("/stats", (async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const requestId = req.headers["x-request-id"] as string;

  try {
    logger.debug({ userId, requestId }, "Fetching API key statistics");

    const stats = await getApiKeyStats(userId);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error(
      { error, userId, requestId },
      "Failed to fetch API key statistics",
    );

    res.status(500).json({
      error: "Internal server error",
      message: "Failed to retrieve API key statistics",
    });
  }
}) as RequestHandler);

export default router;
