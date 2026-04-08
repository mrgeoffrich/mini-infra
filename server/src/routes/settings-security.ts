import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { appLogger } from "../lib/logger-factory";

const logger = appLogger();
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import prisma from "../lib/prisma";

const router = express.Router();

/**
 * GET /api/settings/security
 * Get security secret (masked for display)
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
    logger.info({ requestId, userId }, "Fetching security secret (masked)");

    const appSecret = await prisma.systemSettings.findFirst({
      where: {
        category: "system",
        key: "app_secret",
        isActive: true,
      },
    });

    const maskSecret = (secret: string | null): string => {
      if (!secret || secret.length < 8) {
        return "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
      }
      return `${secret.slice(0, 4)}\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022${secret.slice(-4)}`;
    };

    res.status(200).json({
      app_secret: maskSecret(appSecret?.value || null),
      app_secret_id: appSecret?.id || null,
    });
  } catch (error) {
    logger.error(
      { error, requestId, userId },
      "Failed to fetch security secret",
    );
    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/security/regenerate
 * Regenerate the application secret
 *
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
    logger.info({ requestId, userId }, "Regenerating app secret");

    const { securityConfig } = await import("../lib/security-config");
    const { randomBytes } = await import("crypto");

    const newSecret = randomBytes(32).toString("hex");

    await prisma.systemSettings.upsert({
      where: {
        category_key: {
          category: "system",
          key: "app_secret",
        },
      },
      create: {
        category: "system",
        key: "app_secret",
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

    securityConfig.setAppSecret(newSecret);

    logger.info({ requestId, userId }, "App secret regenerated successfully");

    res.status(200).json({
      message: "App secret regenerated successfully",
      warning:
        "All active sessions have been invalidated and all existing API keys will no longer work. Users will need to log in again and create new API keys.",
    });
  } catch (error) {
    logger.error(
      { error, requestId, userId },
      "Failed to regenerate app secret",
    );
    next(error);
  }
}) as RequestHandler);

export default router;
