import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";

const logger = appLogger();
import { requireSessionOrApiKey, getAuthenticatedUser } from "../middleware/auth";
import { githubAppService } from "../services/github-app-service";

const router = express.Router();

// Request validation schemas
const manifestSchema = z.object({
  callbackUrl: z.string().url("Invalid callback URL"),
});

const setupCompleteSchema = z.object({
  code: z.string().min(1, "Code is required"),
});

/**
 * GET /api/settings/github-app - Get current GitHub App configuration status
 */
router.get("/", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.debug(
    {
      requestId,
      userId,
    },
    "GitHub App settings requested",
  );

  try {
    const configStatus = await githubAppService.getConfigStatus();

    logger.debug(
      {
        requestId,
        userId,
        isConfigured: configStatus.isConfigured,
      },
      "GitHub App settings retrieved successfully",
    );

    res.json({
      success: true,
      data: configStatus,
    });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to retrieve GitHub App settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/github-app/manifest - Generate manifest for GitHub App setup flow
 */
router.post("/manifest", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.debug(
    {
      requestId,
      userId,
    },
    "GitHub App manifest generation requested",
  );

  try {
    const validationResult = manifestSchema.safeParse(req.body);
    if (!validationResult.success) {
      logger.warn(
        {
          requestId,
          userId,
          errors: validationResult.error.flatten(),
        },
        "Invalid manifest request",
      );

      return res.status(400).json({
        success: false,
        error: "Invalid request parameters",
        details: validationResult.error.flatten(),
      });
    }

    const { callbackUrl } = validationResult.data;
    const manifest = githubAppService.generateManifest(callbackUrl);

    logger.debug(
      {
        requestId,
        userId,
      },
      "GitHub App manifest generated successfully",
    );

    res.json({
      success: true,
      data: manifest,
    });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to generate GitHub App manifest",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/github-app/setup/complete - Complete setup after GitHub redirect
 */
router.post("/setup/complete", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.debug(
    {
      requestId,
      userId,
    },
    "GitHub App setup completion requested",
  );

  try {
    const validationResult = setupCompleteSchema.safeParse(req.body);
    if (!validationResult.success) {
      logger.warn(
        {
          requestId,
          userId,
          errors: validationResult.error.flatten(),
        },
        "Invalid setup completion request",
      );

      return res.status(400).json({
        success: false,
        error: "Invalid request parameters",
        details: validationResult.error.flatten(),
      });
    }

    const { code } = validationResult.data;
    const result = await githubAppService.completeSetup(code, userId);

    logger.debug(
      {
        requestId,
        userId,
        appSlug: result.appSlug,
      },
      "GitHub App setup completed successfully",
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to complete GitHub App setup",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/github-app/test - Test GitHub App connectivity
 */
router.post("/test", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.debug(
    {
      requestId,
      userId,
    },
    "GitHub App connection test requested",
  );

  try {
    const validationResponse = await githubAppService.validate();

    logger.debug(
      {
        requestId,
        userId,
        isValid: validationResponse.isValid,
        responseTimeMs: validationResponse.responseTimeMs,
      },
      "GitHub App connection test completed",
    );

    res.json({
      success: validationResponse.isValid,
      data: {
        isValid: validationResponse.isValid,
        message: validationResponse.message,
        errorCode: validationResponse.errorCode,
        metadata: validationResponse.metadata,
        responseTimeMs: validationResponse.responseTimeMs || 0,
      },
    });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to test GitHub App connection",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * DELETE /api/settings/github-app - Remove GitHub App configuration
 */
router.delete("/", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.debug(
    {
      requestId,
      userId,
    },
    "GitHub App configuration removal requested",
  );

  try {
    await githubAppService.removeConfiguration(userId);

    logger.debug(
      {
        requestId,
        userId,
      },
      "GitHub App configuration removed successfully",
    );

    res.json({
      success: true,
      data: {
        isConfigured: false,
      },
    });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to remove GitHub App configuration",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/github-app/registry-token - Create/update GHCR registry credential
 */
router.post("/registry-token", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.debug(
    {
      requestId,
      userId,
    },
    "GHCR registry token creation requested",
  );

  try {
    await githubAppService.createOrUpdateGhcrCredential(userId);

    logger.debug(
      {
        requestId,
        userId,
      },
      "GHCR registry token created/updated successfully",
    );

    res.json({
      success: true,
      data: {
        message: "GHCR registry credential created/updated successfully",
      },
    });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to create/update GHCR registry token",
    );

    next(error);
  }
}) as RequestHandler);

export default router;
