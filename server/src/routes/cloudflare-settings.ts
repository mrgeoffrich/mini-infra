import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import logger from "../lib/logger";
import { requireAuth, getAuthenticatedUser } from "../lib/auth-middleware";
import prisma from "../lib/prisma";
import { CloudflareConfigService } from "../services/cloudflare-config";
import {
  CreateCloudflareSettingRequest,
  UpdateCloudflareSettingRequest,
  CloudflareSettingResponse,
  CloudflareValidationResponse,
  CloudflareTunnelListResponse,
} from "@mini-infra/types";

const router = express.Router();

// Create Cloudflare configuration service instance
const cloudflareConfigService = new CloudflareConfigService(prisma);

// Request validation schemas
const createCloudflareSettingSchema = z.object({
  api_token: z
    .string()
    .min(40, "API token must be at least 40 characters"),
  account_id: z.string().optional(),
  encrypt: z.boolean().optional().default(true),
});

const updateCloudflareSettingSchema = z.object({
  api_token: z
    .string()
    .min(40, "API token must be at least 40 characters")
    .optional(),
  account_id: z.string().optional(),
  encrypt: z.boolean().optional().default(true),
});

const validateCloudflareConnectionSchema = z.object({
  api_token: z.string().optional(),
});

/**
 * GET /api/settings/cloudflare - Get current Cloudflare configuration
 */
router.get("/", requireAuth, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.info(
    {
      requestId,
      userId,
    },
    "Cloudflare settings requested",
  );

  try {
    const apiToken = await cloudflareConfigService.get("api_token");
    const accountId = await cloudflareConfigService.get("account_id");

    const response: CloudflareSettingResponse = {
      success: true,
      data: {
        isConfigured: !!apiToken,
        hasApiToken: !!apiToken,
        accountId: accountId || undefined,
      },
    };

    logger.info(
      {
        requestId,
        userId,
        isConfigured: response.data.isConfigured,
      },
      "Cloudflare settings retrieved successfully",
    );

    res.json(response);
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to retrieve Cloudflare settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/cloudflare - Create or update Cloudflare configuration
 */
router.post("/", requireAuth, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.info(
    {
      requestId,
      userId,
      hasApiToken: !!req.body.api_token,
      hasAccountId: !!req.body.account_id,
    },
    "Cloudflare settings update requested",
  );

  try {
    // Validate request body
    const validationResult = createCloudflareSettingSchema.safeParse(req.body);
    if (!validationResult.success) {
      logger.warn(
        {
          requestId,
          userId,
          errors: validationResult.error.flatten(),
        },
        "Invalid Cloudflare settings request",
      );

      return res.status(400).json({
        success: false,
        error: "Invalid request parameters",
        details: validationResult.error.flatten(),
      });
    }

    const { api_token, account_id } = validationResult.data;

    // Check if configuration already exists
    const existingApiToken = await cloudflareConfigService.get("api_token");
    const existingAccountId = await cloudflareConfigService.get("account_id");

    if (existingApiToken) {
      // Update existing configuration
      await cloudflareConfigService.setApiToken(api_token, userId);
      if (account_id) {
        await cloudflareConfigService.setAccountId(account_id, userId);
      }

      logger.info(
        {
          requestId,
          userId,
        },
        "Cloudflare settings updated successfully",
      );
    } else {
      // Create new configuration
      await cloudflareConfigService.setApiToken(api_token, userId);
      if (account_id) {
        await cloudflareConfigService.setAccountId(account_id, userId);
      }

      logger.info(
        {
          requestId,
          userId,
        },
        "Cloudflare settings created successfully",
      );
    }

    // Validate the configuration
    const validationResponse = await cloudflareConfigService.validate();

    const response: CloudflareSettingResponse = {
      success: true,
      data: {
        isConfigured: true,
        hasApiToken: true,
        accountId: account_id || existingAccountId || undefined,
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
      "Failed to update Cloudflare settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * PATCH /api/settings/cloudflare - Partially update Cloudflare configuration
 */
router.patch("/", requireAuth, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.info(
    {
      requestId,
      userId,
      hasApiToken: !!req.body.api_token,
      hasAccountId: !!req.body.account_id,
    },
    "Cloudflare settings partial update requested",
  );

  try {
    // Validate request body
    const validationResult = updateCloudflareSettingSchema.safeParse(req.body);
    if (!validationResult.success) {
      logger.warn(
        {
          requestId,
          userId,
          errors: validationResult.error.flatten(),
        },
        "Invalid Cloudflare settings update request",
      );

      return res.status(400).json({
        success: false,
        error: "Invalid request parameters",
        details: validationResult.error.flatten(),
      });
    }

    const { api_token, account_id } = validationResult.data;

    // Update only provided fields
    if (api_token) {
      await cloudflareConfigService.setApiToken(api_token, userId);
    }
    if (account_id !== undefined) {
      if (account_id) {
        await cloudflareConfigService.setAccountId(account_id, userId);
      } else {
        // Allow clearing account_id
        await cloudflareConfigService.delete("account_id", userId);
      }
    }

    // Validate the configuration
    const validationResponse = await cloudflareConfigService.validate();

    const currentAccountId = await cloudflareConfigService.get("account_id");

    const response: CloudflareSettingResponse = {
      success: true,
      data: {
        isConfigured: true,
        hasApiToken: true,
        accountId: currentAccountId || undefined,
        isValid: validationResponse.isValid,
        validationMessage: validationResponse.message,
      },
    };

    logger.info(
      {
        requestId,
        userId,
        isValid: validationResponse.isValid,
      },
      "Cloudflare settings updated successfully",
    );

    res.json(response);
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to update Cloudflare settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * DELETE /api/settings/cloudflare - Remove Cloudflare configuration
 */
router.delete("/", requireAuth, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.info(
    {
      requestId,
      userId,
    },
    "Cloudflare settings deletion requested",
  );

  try {
    // Delete all Cloudflare settings
    await cloudflareConfigService.delete("api_token", userId);
    await cloudflareConfigService.delete("account_id", userId);

    logger.info(
      {
        requestId,
        userId,
      },
      "Cloudflare settings deleted successfully",
    );

    const response: CloudflareSettingResponse = {
      success: true,
      data: {
        isConfigured: false,
        hasApiToken: false,
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
      "Failed to delete Cloudflare settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/cloudflare/test - Test Cloudflare API connectivity
 */
router.post("/test", requireAuth, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.info(
    {
      requestId,
      userId,
    },
    "Cloudflare connection test requested",
  );

  try {
    // Validate request body
    const validationResult = validateCloudflareConnectionSchema.safeParse(
      req.body,
    );
    if (!validationResult.success) {
      logger.warn(
        {
          requestId,
          userId,
          errors: validationResult.error.flatten(),
        },
        "Invalid Cloudflare validation request",
      );

      return res.status(400).json({
        success: false,
        error: "Invalid request parameters",
        details: validationResult.error.flatten(),
      });
    }

    const { api_token } = validationResult.data;

    // If api_token is provided, temporarily set it for validation
    let originalApiToken: string | null = null;
    if (api_token) {
      originalApiToken = await cloudflareConfigService.get("api_token");
      await cloudflareConfigService.setApiToken(api_token, userId);
    }

    try {
      // Validate the configuration
      const validationResponse = await cloudflareConfigService.validate();

      const response: CloudflareValidationResponse = {
        success: validationResponse.isValid,
        data: {
          isValid: validationResponse.isValid,
          message: validationResponse.message,
          errorCode: validationResponse.errorCode,
          metadata: validationResponse.metadata,
          responseTimeMs: validationResponse.responseTimeMs || 0,
        },
      };

      logger.info(
        {
          requestId,
          userId,
          isValid: validationResponse.isValid,
          responseTimeMs: validationResponse.responseTimeMs,
        },
        "Cloudflare connection test completed",
      );

      res.json(response);
    } finally {
      // Restore original api_token if temporarily changed
      if (api_token && originalApiToken !== null) {
        await cloudflareConfigService.setApiToken(originalApiToken, userId);
      }
    }
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to test Cloudflare connection",
    );

    next(error);
  }
}) as RequestHandler);

export default router;