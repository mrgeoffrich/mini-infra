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
router.get("/", requirePermission('settings:read') as RequestHandler, (async (
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
router.post("/manifest", requirePermission('settings:write') as RequestHandler, (async (
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
router.post("/setup/complete", requirePermission('settings:write') as RequestHandler, (async (
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
 * POST /api/settings/github-app/refresh-installation - Re-check for app installations
 * Called after the user installs the app on their GitHub account/org.
 */
router.post("/refresh-installation", requirePermission('settings:write') as RequestHandler, (async (
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
    "GitHub App installation refresh requested",
  );

  try {
    const result = await githubAppService.refreshInstallation(userId);

    logger.debug(
      {
        requestId,
        userId,
        found: result.found,
        installationId: result.installationId,
      },
      "GitHub App installation refresh completed",
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
      "Failed to refresh GitHub App installation",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/github-app/test - Test GitHub App connectivity
 */
router.post("/test", requirePermission('settings:write') as RequestHandler, (async (
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
router.delete("/", requirePermission('settings:write') as RequestHandler, (async (
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
router.post("/registry-token", requirePermission('settings:write') as RequestHandler, (async (
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

/**
 * GET /api/settings/github-app/oauth/authorize - Start OAuth user authorization flow
 * Returns a URL to redirect the user to GitHub for authorization.
 */
router.get("/oauth/authorize", requirePermission('settings:read') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  try {
    const { authorizeUrl, state } = await githubAppService.generateOAuthAuthorizeUrl();

    logger.debug(
      { requestId, userId },
      "GitHub OAuth authorization URL generated",
    );

    res.json({
      success: true,
      data: { authorizeUrl, state },
    });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to generate OAuth authorization URL",
    );
    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/github-app/oauth/callback - Exchange OAuth code for user token
 * Called by the frontend after GitHub redirects back with a code.
 */
const oauthCallbackSchema = z.object({
  code: z.string().min(1, "Code is required"),
});

router.post("/oauth/callback", requirePermission('settings:write') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  try {
    const validationResult = oauthCallbackSchema.safeParse(req.body);
    if (!validationResult.success) {
      return res.status(400).json({
        success: false,
        error: "Invalid request parameters",
        details: validationResult.error.flatten(),
      });
    }

    const { code } = validationResult.data;
    await githubAppService.exchangeOAuthCode(code, userId);

    logger.info({ requestId, userId }, "GitHub OAuth authorization completed");

    res.json({
      success: true,
      data: { message: "GitHub user authorization successful" },
    });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to complete OAuth code exchange",
    );
    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/github-app/oauth/pat - Save a classic PAT for package access
 */
const patSchema = z.object({
  token: z.string().min(1, "Token is required"),
});

router.post("/oauth/pat", requirePermission('settings:write') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  try {
    const validationResult = patSchema.safeParse(req.body);
    if (!validationResult.success) {
      return res.status(400).json({
        success: false,
        error: "Invalid request parameters",
        details: validationResult.error.flatten(),
      });
    }

    const { token } = validationResult.data;

    // Verify the token works by calling the GitHub API
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "mini-infra",
      },
    });

    if (!response.ok) {
      return res.status(400).json({
        success: false,
        error: "Token verification failed — please check the token is valid",
      });
    }

    // Store the PAT using the OAuth token fields (reusing the same storage)
    await Promise.all([
      githubAppService.set("oauth_access_token", token, userId),
      // Classic PATs don't expire, so set far-future expiry and no refresh token
      githubAppService.set("oauth_expires_at", "2099-12-31T23:59:59Z", userId),
    ]);

    // Remove any old refresh token (PATs don't use refresh)
    try {
      await githubAppService.delete("oauth_refresh_token", userId);
    } catch {
      // ignore if not exists
    }

    logger.info({ requestId, userId }, "GitHub PAT saved for package access");

    res.json({
      success: true,
      data: { message: "Personal access token saved successfully" },
    });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to save PAT",
    );
    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/github-app/oauth/revoke - Revoke OAuth user token
 */
router.post("/oauth/revoke", requirePermission('settings:write') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  try {
    // Clear the stored OAuth tokens
    await Promise.all([
      githubAppService.delete("oauth_access_token", userId),
      githubAppService.delete("oauth_refresh_token", userId),
      githubAppService.delete("oauth_expires_at", userId),
    ]);

    logger.info({ requestId, userId }, "GitHub OAuth tokens revoked");

    res.json({
      success: true,
      data: { message: "OAuth authorization revoked" },
    });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to revoke OAuth tokens",
    );
    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/github-app/agent/token - Save a PAT for AI assistant GitHub access
 */
const agentTokenSchema = z.object({
  token: z.string().min(1, "Token is required"),
  accessLevel: z.enum(["read_only", "full_access"]),
});

router.post("/agent/token", requirePermission('settings:write') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  try {
    const validationResult = agentTokenSchema.safeParse(req.body);
    if (!validationResult.success) {
      return res.status(400).json({
        success: false,
        error: "Invalid request parameters",
        details: validationResult.error.flatten(),
      });
    }

    const { token, accessLevel } = validationResult.data;

    // Verify the token works by calling the GitHub API
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "mini-infra",
      },
    });

    if (!response.ok) {
      return res.status(400).json({
        success: false,
        error: "Token verification failed — please check the token is valid",
      });
    }

    await Promise.all([
      githubAppService.set("agent_github_token", token, userId),
      githubAppService.set("agent_github_access_level", accessLevel, userId),
    ]);

    logger.info({ requestId, userId, accessLevel }, "Agent GitHub token saved");

    res.json({
      success: true,
      data: { message: "Assistant GitHub token saved successfully" },
    });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to save agent GitHub token",
    );
    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/github-app/agent/revoke - Revoke AI assistant GitHub token
 */
router.post("/agent/revoke", requirePermission('settings:write') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  try {
    await Promise.all([
      githubAppService.delete("agent_github_token", userId),
      githubAppService.delete("agent_github_access_level", userId),
    ]);

    logger.info({ requestId, userId }, "Agent GitHub token revoked");

    res.json({
      success: true,
      data: { message: "Assistant GitHub token revoked" },
    });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to revoke agent GitHub token",
    );
    next(error);
  }
}) as RequestHandler);

export default router;
