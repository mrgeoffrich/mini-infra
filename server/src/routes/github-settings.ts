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
import { githubService } from "../services/github-service";
import {
  CreateGitHubSettingRequest,
  UpdateGitHubSettingRequest,
  GitHubSettingResponse,
  GitHubValidationResponse,
} from "@mini-infra/types";

const router = express.Router();

// Request validation schemas
const createGitHubSettingSchema = z.object({
  personal_access_token: z
    .string()
    .min(1, "Personal access token is required")
    .regex(
      /^(gh[a-z]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]+)$/,
      "Invalid GitHub personal access token format",
    ),
  repo_owner: z
    .string()
    .min(1, "Repository owner is required")
    .regex(
      /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/,
      "Invalid repository owner format",
    ),
  repo_name: z
    .string()
    .min(1, "Repository name is required")
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      "Invalid repository name format",
    ),
  encrypt: z.boolean().optional().default(true),
});

const updateGitHubSettingSchema = z.object({
  personal_access_token: z
    .string()
    .min(1, "Personal access token cannot be empty")
    .regex(
      /^(gh[a-z]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]+)$/,
      "Invalid GitHub personal access token format",
    )
    .optional(),
  repo_owner: z
    .string()
    .min(1, "Repository owner cannot be empty")
    .regex(
      /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/,
      "Invalid repository owner format",
    )
    .optional(),
  repo_name: z
    .string()
    .min(1, "Repository name cannot be empty")
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      "Invalid repository name format",
    )
    .optional(),
  encrypt: z.boolean().optional().default(true),
});

const validateGitHubConnectionSchema = z.object({
  personal_access_token: z.string().optional(),
  repo_owner: z.string().optional(),
  repo_name: z.string().optional(),
});

/**
 * GET /api/settings/github - Get current GitHub configuration
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
    "GitHub settings requested",
  );

  try {
    const configStatus = await githubService.getConfigStatus();

    const response: GitHubSettingResponse = {
      success: true,
      data: {
        isConfigured: configStatus.isConfigured,
        hasPersonalAccessToken: configStatus.hasPersonalAccessToken,
        repoOwner: configStatus.repoOwner,
        repoName: configStatus.repoName,
      },
    };

    logger.debug(
      {
        requestId,
        userId,
        isConfigured: response.data.isConfigured,
      },
      "GitHub settings retrieved successfully",
    );

    res.json(response);
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to retrieve GitHub settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/github - Create or update GitHub configuration
 */
router.post("/", requireSessionOrApiKey, (async (
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
      hasToken: !!req.body.personal_access_token,
      hasRepoOwner: !!req.body.repo_owner,
      hasRepoName: !!req.body.repo_name,
    },
    "GitHub settings update requested",
  );

  try {
    // Validate request body
    const validationResult = createGitHubSettingSchema.safeParse(req.body);
    if (!validationResult.success) {
      logger.warn(
        {
          requestId,
          userId,
          errors: validationResult.error.flatten(),
        },
        "Invalid GitHub settings request",
      );

      return res.status(400).json({
        success: false,
        error: "Invalid request parameters",
        details: validationResult.error.flatten(),
      });
    }

    const { personal_access_token, repo_owner, repo_name } =
      validationResult.data;

    // Check if configuration already exists
    const existingConfig = await githubService.getConfigStatus();

    if (existingConfig.isConfigured) {
      // Update existing configuration
      await githubService.setPersonalAccessToken(
        personal_access_token,
        userId,
      );
      await githubService.setRepoOwner(repo_owner, userId);
      await githubService.setRepoName(repo_name, userId);

      logger.debug(
        {
          requestId,
          userId,
        },
        "GitHub settings updated successfully",
      );
    } else {
      // Create new configuration
      await githubService.setPersonalAccessToken(
        personal_access_token,
        userId,
      );
      await githubService.setRepoOwner(repo_owner, userId);
      await githubService.setRepoName(repo_name, userId);

      logger.debug(
        {
          requestId,
          userId,
        },
        "GitHub settings created successfully",
      );
    }

    // Validate the configuration
    const validationResponse = await githubService.validate();

    const response: GitHubSettingResponse = {
      success: true,
      data: {
        isConfigured: true,
        hasPersonalAccessToken: true,
        repoOwner: repo_owner,
        repoName: repo_name,
        isValid: validationResponse.isValid,
        validationMessage: validationResponse.message,
      },
    };

    res.json(response);
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to update GitHub settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * PATCH /api/settings/github - Partially update GitHub configuration
 */
router.patch("/", requireSessionOrApiKey, (async (
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
      hasToken: !!req.body.personal_access_token,
      hasRepoOwner: !!req.body.repo_owner,
      hasRepoName: !!req.body.repo_name,
    },
    "GitHub settings partial update requested",
  );

  try {
    // Validate request body
    const validationResult = updateGitHubSettingSchema.safeParse(req.body);
    if (!validationResult.success) {
      logger.warn(
        {
          requestId,
          userId,
          errors: validationResult.error.flatten(),
        },
        "Invalid GitHub settings update request",
      );

      return res.status(400).json({
        success: false,
        error: "Invalid request parameters",
        details: validationResult.error.flatten(),
      });
    }

    const { personal_access_token, repo_owner, repo_name } =
      validationResult.data;

    // Update only provided fields
    if (personal_access_token) {
      await githubService.setPersonalAccessToken(
        personal_access_token,
        userId,
      );
    }
    if (repo_owner) {
      await githubService.setRepoOwner(repo_owner, userId);
    }
    if (repo_name) {
      await githubService.setRepoName(repo_name, userId);
    }

    // Validate the configuration
    const validationResponse = await githubService.validate();

    const currentConfig = await githubService.getConfigStatus();

    const response: GitHubSettingResponse = {
      success: true,
      data: {
        isConfigured: currentConfig.isConfigured,
        hasPersonalAccessToken: currentConfig.hasPersonalAccessToken,
        repoOwner: currentConfig.repoOwner,
        repoName: currentConfig.repoName,
        isValid: validationResponse.isValid,
        validationMessage: validationResponse.message,
      },
    };

    logger.debug(
      {
        requestId,
        userId,
        isValid: validationResponse.isValid,
      },
      "GitHub settings updated successfully",
    );

    res.json(response);
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to update GitHub settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * DELETE /api/settings/github - Remove GitHub configuration
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
    "GitHub settings deletion requested",
  );

  try {
    // Delete all GitHub settings
    await githubService.delete("personal_access_token", userId);
    await githubService.delete("repo_owner", userId);
    await githubService.delete("repo_name", userId);

    logger.debug(
      {
        requestId,
        userId,
      },
      "GitHub settings deleted successfully",
    );

    const response: GitHubSettingResponse = {
      success: true,
      data: {
        isConfigured: false,
        hasPersonalAccessToken: false,
      },
    };

    res.json(response);
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to delete GitHub settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/github/test - Test GitHub API connectivity
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
    "GitHub connection test requested",
  );

  try {
    // Validate request body
    const validationResult = validateGitHubConnectionSchema.safeParse(
      req.body,
    );
    if (!validationResult.success) {
      logger.warn(
        {
          requestId,
          userId,
          errors: validationResult.error.flatten(),
        },
        "Invalid GitHub validation request",
      );

      return res.status(400).json({
        success: false,
        error: "Invalid request parameters",
        details: validationResult.error.flatten(),
      });
    }

    const { personal_access_token, repo_owner, repo_name } =
      validationResult.data;

    // Build settings object if any values are provided
    let settings: Record<string, string> | undefined = undefined;
    if (personal_access_token || repo_owner || repo_name) {
      settings = {};
      if (personal_access_token) {
        settings.personalAccessToken = personal_access_token;
      }
      if (repo_owner) {
        settings.repoOwner = repo_owner;
      }
      if (repo_name) {
        settings.repoName = repo_name;
      }
    }

    // Validate the configuration
    const validationResponse = await githubService.validate(settings);

    const response: GitHubValidationResponse = {
      success: validationResponse.isValid,
      data: {
        isValid: validationResponse.isValid,
        message: validationResponse.message,
        errorCode: validationResponse.errorCode,
        metadata: validationResponse.metadata,
        responseTimeMs: validationResponse.responseTimeMs || 0,
      },
    };

    logger.debug(
      {
        requestId,
        userId,
        isValid: validationResponse.isValid,
        responseTimeMs: validationResponse.responseTimeMs,
      },
      "GitHub connection test completed",
    );

    res.json(response);
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to test GitHub connection",
    );

    next(error);
  }
}) as RequestHandler);

export default router;
