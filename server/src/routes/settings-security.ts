import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";

const logger = appLogger();
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import prisma from "../lib/prisma";

const router = express.Router();

/**
 * GET /api/settings/security
 * Get security secrets (masked for display)
 *
 * Response: { session_secret: string, api_key_secret: string }
 */
router.get("/", requirePermission('settings:read') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const userId = user.id;

  try {
    logger.info({ requestId, userId }, "Fetching security secrets (masked)");

    // Fetch secrets from database
    const sessionSecret = await prisma.systemSettings.findFirst({
      where: {
        category: "system",
        key: "session_secret",
        isActive: true,
      },
    });

    const apiKeySecret = await prisma.systemSettings.findFirst({
      where: {
        category: "system",
        key: "api_key_secret",
        isActive: true,
      },
    });

    // Mask secrets (show first 4 and last 4 characters)
    const maskSecret = (secret: string | null): string => {
      if (!secret || secret.length < 8) {
        return "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
      }
      return `${secret.slice(0, 4)}\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022${secret.slice(-4)}`;
    };

    res.status(200).json({
      session_secret: maskSecret(sessionSecret?.value || null),
      api_key_secret: maskSecret(apiKeySecret?.value || null),
      session_secret_id: sessionSecret?.id || null,
      api_key_secret_id: apiKeySecret?.id || null,
    });
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
      },
      "Failed to fetch security secrets",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/security/regenerate
 * Regenerate a security secret (session_secret or api_key_secret)
 *
 * Body: { secret: "session" | "apiKey" }
 * Response: { message: string, warning: string }
 */
router.post("/regenerate", requirePermission('settings:write') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const userId = user.id;

  try {
    // Validate request body
    const requestSchema = z.object({
      secret: z.enum(["session", "apiKey"]),
    });

    const validationResult = requestSchema.safeParse(req.body);
    if (!validationResult.success) {
      logger.warn(
        { requestId, userId, errors: validationResult.error.issues },
        "Invalid regenerate secret request",
      );
      return res.status(400).json({
        error: "Invalid request",
        message: 'Secret type must be either "session" or "apiKey"',
      });
    }

    const { secret: secretType } = validationResult.data;

    logger.info(
      { requestId, userId, secretType },
      "Regenerating security secret",
    );

    // Import security config and crypto here to avoid circular dependencies
    const { securityConfig } = await import("../lib/security-config");
    const { randomBytes } = await import("crypto");

    // Generate new secret
    const newSecret = randomBytes(32).toString("hex");

    // Determine which secret to update
    const settingKey =
      secretType === "session" ? "session_secret" : "api_key_secret";
    const setterMethod =
      secretType === "session" ? "setSessionSecret" : "setApiKeySecret";
    const warningMessage =
      secretType === "session"
        ? "All active user sessions have been invalidated. Users will need to log in again."
        : "All existing API keys will no longer work. API key hashes are based on this secret.";

    // Update in database
    await prisma.systemSettings.upsert({
      where: {
        category_key: {
          category: "system",
          key: settingKey,
        },
      },
      create: {
        category: "system",
        key: settingKey,
        value: newSecret,
        isEncrypted: false,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      },
      update: {
        value: newSecret,
        updatedBy: userId,
        updatedAt: new Date(),
      },
    });

    // Update in-memory config
    (securityConfig as any)[setterMethod](newSecret);

    logger.info(
      { requestId, userId, secretType },
      "Security secret regenerated successfully",
    );

    res.status(200).json({
      message: `${secretType === "session" ? "Session" : "API key"} secret regenerated successfully`,
      warning: warningMessage,
    });
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
      },
      "Failed to regenerate security secret",
    );

    next(error);
  }
}) as RequestHandler);

export default router;
