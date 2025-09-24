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

/**
 * @swagger
 * /api/keys:
 *   get:
 *     summary: Get all API keys for the current user
 *     description: Retrieve a list of all API keys owned by the authenticated user, excluding the actual key values for security
 *     tags:
 *       - API Keys
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     responses:
 *       200:
 *         description: API keys retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ApiKeyInfo'
 *               required:
 *                 - success
 *                 - data
 *             example:
 *               success: true
 *               data:
 *                 - id: 'key123'
 *                   name: 'Production API'
 *                   active: true
 *                   lastUsedAt: '2025-09-24T10:30:00.000Z'
 *                   createdAt: '2025-09-20T15:00:00.000Z'
 *                   updatedAt: '2025-09-24T10:30:00.000Z'
 *                 - id: 'key456'
 *                   name: 'Development API'
 *                   active: false
 *                   lastUsedAt: null
 *                   createdAt: '2025-09-22T12:00:00.000Z'
 *                   updatedAt: '2025-09-23T14:00:00.000Z'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @swagger
 * /api/keys:
 *   post:
 *     summary: Create a new API key
 *     description: Create a new API key for the authenticated user. The actual key value is only returned once and cannot be retrieved again.
 *     tags:
 *       - API Keys
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateApiKeyRequest'
 *           example:
 *             name: 'Production API Key'
 *     responses:
 *       201:
 *         description: API key created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/CreateApiKeyResponse'
 *                 message:
 *                   type: string
 *                   example: "API key created successfully. Save this key securely - it won't be shown again."
 *               required:
 *                 - success
 *                 - data
 *                 - message
 *             example:
 *               success: true
 *               data:
 *                 id: 'key789'
 *                 name: 'Production API Key'
 *                 active: true
 *                 lastUsedAt: null
 *                 createdAt: '2025-09-24T12:00:00.000Z'
 *                 updatedAt: '2025-09-24T12:00:00.000Z'
 *                 key: 'mk_1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t1u2v3w4x5y6z'
 *               message: "API key created successfully. Save this key securely - it won't be shown again."
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationError'
 *             example:
 *               error: 'Validation error'
 *               message: 'Invalid request data'
 *               details:
 *                 - code: 'too_small'
 *                   minimum: 1
 *                   type: 'string'
 *                   inclusive: true
 *                   exact: false
 *                   message: 'API key name is required'
 *                   path: ['name']
 *               timestamp: '2025-09-24T12:00:00.000Z'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @swagger
 * /api/keys/{keyId}/revoke:
 *   patch:
 *     summary: Revoke an API key
 *     description: Deactivate an API key, making it unusable while preserving it in the system for audit purposes. The key can still be rotated later.
 *     tags:
 *       - API Keys
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: keyId
 *         in: path
 *         description: API key unique identifier
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^[a-zA-Z0-9_-]+$'
 *         example: 'key123'
 *     responses:
 *       200:
 *         description: API key revoked successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: 'API key revoked successfully'
 *               required:
 *                 - success
 *                 - message
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: API key not found or not owned by user
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: 'Not found'
 *               message: 'API key not found or not owned by user'
 *               timestamp: '2025-09-24T12:00:00.000Z'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @swagger
 * /api/keys/{keyId}/rotate:
 *   post:
 *     summary: Rotate an API key
 *     description: Generate a new API key with the same name, deactivate the old one, and return the new key. The old key is preserved for audit purposes but becomes unusable.
 *     tags:
 *       - API Keys
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: keyId
 *         in: path
 *         description: API key unique identifier to rotate
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^[a-zA-Z0-9_-]+$'
 *         example: 'key123'
 *     responses:
 *       200:
 *         description: API key rotated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/CreateApiKeyResponse'
 *                 message:
 *                   type: string
 *                   example: "API key rotated successfully. Save the new key securely - it won't be shown again."
 *               required:
 *                 - success
 *                 - data
 *                 - message
 *             example:
 *               success: true
 *               data:
 *                 id: 'key999'
 *                 name: 'Production API Key'
 *                 active: true
 *                 lastUsedAt: null
 *                 createdAt: '2025-09-24T12:00:00.000Z'
 *                 updatedAt: '2025-09-24T12:00:00.000Z'
 *                 key: 'mk_9z8y7x6w5v4u3t2s1r0q9p8o7n6m5l4k3j2h1g0f9e8d7c6b5a'
 *               message: "API key rotated successfully. Save the new key securely - it won't be shown again."
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: API key not found or not owned by user
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: 'Not found'
 *               message: 'API key not found or not owned by user'
 *               timestamp: '2025-09-24T12:00:00.000Z'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @swagger
 * /api/keys/{keyId}:
 *   delete:
 *     summary: Permanently delete an API key
 *     description: Completely remove an API key from the system. This action is irreversible and the key cannot be recovered. Use revoke instead if you want to preserve audit history.
 *     tags:
 *       - API Keys
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: keyId
 *         in: path
 *         description: API key unique identifier to delete
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^[a-zA-Z0-9_-]+$'
 *         example: 'key123'
 *     responses:
 *       200:
 *         description: API key deleted permanently
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: 'API key deleted permanently'
 *               required:
 *                 - success
 *                 - message
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: API key not found or not owned by user
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: 'Not found'
 *               message: 'API key not found or not owned by user'
 *               timestamp: '2025-09-24T12:00:00.000Z'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @swagger
 * /api/keys/stats:
 *   get:
 *     summary: Get API key statistics
 *     description: Retrieve usage statistics and summary information about API keys for the authenticated user
 *     tags:
 *       - API Keys
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     responses:
 *       200:
 *         description: API key statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     totalKeys:
 *                       type: integer
 *                       description: Total number of API keys owned by user
 *                       example: 5
 *                     activeKeys:
 *                       type: integer
 *                       description: Number of active API keys
 *                       example: 3
 *                     revokedKeys:
 *                       type: integer
 *                       description: Number of revoked API keys
 *                       example: 2
 *                     lastCreatedAt:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 *                       description: When the most recent API key was created
 *                       example: '2025-09-24T10:00:00.000Z'
 *                     lastUsedAt:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 *                       description: When any API key was last used
 *                       example: '2025-09-24T11:30:00.000Z'
 *                   required:
 *                     - totalKeys
 *                     - activeKeys
 *                     - revokedKeys
 *               required:
 *                 - success
 *                 - data
 *             example:
 *               success: true
 *               data:
 *                 totalKeys: 5
 *                 activeKeys: 3
 *                 revokedKeys: 2
 *                 lastCreatedAt: '2025-09-24T10:00:00.000Z'
 *                 lastUsedAt: '2025-09-24T11:30:00.000Z'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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
