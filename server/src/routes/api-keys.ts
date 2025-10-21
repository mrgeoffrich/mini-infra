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
import { appLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey, getCurrentUserId } from "../middleware/auth";

const logger = appLogger();
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

// Apply authentication to all routes (allows both session and API key auth)
router.use(requireSessionOrApiKey as RequestHandler);


router.get("/", (async (req: Request, res: Response) => {
  const userId = getCurrentUserId(req)!;
  const requestId = req.headers["x-request-id"] as string;

  try {
    logger.debug({ userId, requestId }, "Fetching user API keys");

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


router.post("/", (async (req: Request, res: Response) => {
  const userId = getCurrentUserId(req)!;
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
  } catch (error) {
    logger.error({ error, userId, requestId }, "Failed to create API key");

    res.status(500).json({
      error: "Internal server error",
      message: "Failed to create API key",
    });
  }
}) as RequestHandler);


router.patch("/:keyId/revoke", (async (req: Request, res: Response) => {
  const userId = getCurrentUserId(req)!;
  const { keyId } = req.params;
  const requestId = req.headers["x-request-id"] as string;

  try {
    logger.debug({ userId, requestId, keyId }, "Revoking API key");

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


router.post("/:keyId/rotate", (async (req: Request, res: Response) => {
  const userId = getCurrentUserId(req)!;
  const { keyId } = req.params;
  const requestId = req.headers["x-request-id"] as string;

  try {
    logger.debug({ userId, requestId, keyId }, "Rotating API key");

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


router.delete("/:keyId", (async (req: Request, res: Response) => {
  const userId = getCurrentUserId(req)!;
  const { keyId } = req.params;
  const requestId = req.headers["x-request-id"] as string;

  try {
    logger.debug({ userId, requestId, keyId }, "Deleting API key permanently");

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


router.get("/stats", (async (req: Request, res: Response) => {
  const userId = getCurrentUserId(req)!;
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
