import express, {
  Request,
  Response,
  RequestHandler,
} from "express";
import { z } from "zod";
import { appLogger } from "../../lib/logger-factory";
import { asyncHandler } from "../../lib/async-handler";
import { requirePermission, getAuthenticatedUser } from "../../middleware/auth";
import { CloudflareService } from "../../services/cloudflare";
import { DnsCacheService } from "../../services/dns";
import {
  CloudflareSettingResponse,
  CloudflareValidationResponse,
} from "@mini-infra/types";

const logger = appLogger();

const createCloudflareSettingSchema = z.object({
  api_token: z.string().min(40, "API token must be at least 40 characters"),
  account_id: z
    .string()
    .min(1, "Account ID is required")
    .regex(
      /^[a-f0-9]{32}$/,
      "Account ID must be a valid 32-character hex string",
    ),
  encrypt: z.boolean().optional().default(true),
});

const updateCloudflareSettingSchema = z.object({
  api_token: z
    .string()
    .min(40, "API token must be at least 40 characters")
    .optional(),
  account_id: z
    .string()
    .min(1, "Account ID is required")
    .regex(
      /^[a-f0-9]{32}$/,
      "Account ID must be a valid 32-character hex string",
    )
    .optional(),
  encrypt: z.boolean().optional().default(true),
});

const validateCloudflareConnectionSchema = z.object({
  api_token: z.string().optional(),
});

function respondValidationError(
  res: Response,
  error: z.ZodError,
): Response {
  return res.status(400).json({
    success: false,
    error: "Invalid request parameters",
    details: error.flatten(),
  });
}

function getUserId(req: Request): string {
  return getAuthenticatedUser(req)?.id || "system";
}

export function createCloudflareSettingsRouter(
  cloudflareConfigService: CloudflareService,
): express.Router {
  const router = express.Router();

  router.get(
    "/",
    requirePermission("settings:read") as RequestHandler,
    asyncHandler(async (req, res) => {
      const requestId = req.headers["x-request-id"] as string;
      const userId = getUserId(req);

      logger.debug({ requestId, userId }, "Cloudflare settings requested");

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

      logger.debug(
        { requestId, userId, isConfigured: response.data.isConfigured },
        "Cloudflare settings retrieved successfully",
      );
      res.json(response);
    }),
  );

  router.post(
    "/",
    requirePermission("settings:write") as RequestHandler,
    asyncHandler(async (req, res) => {
      const requestId = req.headers["x-request-id"] as string;
      const userId = getUserId(req);

      const validation = createCloudflareSettingSchema.safeParse(req.body);
      if (!validation.success) {
        logger.warn(
          { requestId, userId, errors: validation.error.flatten() },
          "Invalid Cloudflare settings request",
        );
        return respondValidationError(res, validation.error);
      }

      const { api_token, account_id } = validation.data;
      await cloudflareConfigService.setApiToken(api_token, userId);
      await cloudflareConfigService.setAccountId(account_id, userId);

      const validationResponse = await cloudflareConfigService.validate();

      // Kick the DNS cache so any new zones become immediately visible.
      // Fire-and-forget — the route should not wait for a DNS refresh.
      if (validationResponse.isValid) {
        try {
          DnsCacheService.getInstance()
            ?.refreshCache()
            .catch((err) =>
              logger.warn(
                { error: err },
                "Failed to refresh DNS cache after Cloudflare configuration",
              ),
            );
        } catch (err) {
          logger.warn({ error: err }, "Failed to trigger DNS cache refresh");
        }
      }

      const response: CloudflareSettingResponse = {
        success: true,
        data: {
          isConfigured: true,
          hasApiToken: true,
          accountId: account_id,
          isValid: validationResponse.isValid,
          validationMessage: validationResponse.message,
        },
      };
      res.json(response);
    }),
  );

  router.patch(
    "/",
    requirePermission("settings:write") as RequestHandler,
    asyncHandler(async (req, res) => {
      const requestId = req.headers["x-request-id"] as string;
      const userId = getUserId(req);

      const validation = updateCloudflareSettingSchema.safeParse(req.body);
      if (!validation.success) {
        logger.warn(
          { requestId, userId, errors: validation.error.flatten() },
          "Invalid Cloudflare settings update request",
        );
        return respondValidationError(res, validation.error);
      }

      const { api_token, account_id } = validation.data;

      if (api_token) {
        await cloudflareConfigService.setApiToken(api_token, userId);
      }
      if (account_id !== undefined) {
        if (account_id) {
          await cloudflareConfigService.setAccountId(account_id, userId);
        } else {
          await cloudflareConfigService.delete("account_id", userId);
        }
      }

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

      logger.debug(
        { requestId, userId, isValid: validationResponse.isValid },
        "Cloudflare settings updated successfully",
      );
      res.json(response);
    }),
  );

  router.delete(
    "/",
    requirePermission("settings:write") as RequestHandler,
    asyncHandler(async (req, res) => {
      const userId = getUserId(req);

      await cloudflareConfigService.delete("api_token", userId);
      await cloudflareConfigService.delete("account_id", userId);

      const response: CloudflareSettingResponse = {
        success: true,
        data: { isConfigured: false, hasApiToken: false },
      };
      res.json(response);
    }),
  );

  router.post(
    "/test",
    requirePermission("settings:write") as RequestHandler,
    asyncHandler(async (req, res, next) => {
      const requestId = req.headers["x-request-id"] as string;
      const userId = getUserId(req);

      const validation = validateCloudflareConnectionSchema.safeParse(req.body);
      if (!validation.success) {
        logger.warn(
          { requestId, userId, errors: validation.error.flatten() },
          "Invalid Cloudflare validation request",
        );
        return respondValidationError(res, validation.error);
      }

      const { api_token } = validation.data;

      // When an api_token is supplied, we temporarily swap it in so that
      // `validate()` exercises the incoming token, then restore the
      // previously-stored token regardless of the outcome.
      let originalApiToken: string | null = null;
      if (api_token) {
        originalApiToken = await cloudflareConfigService.get("api_token");
        await cloudflareConfigService.setApiToken(api_token, userId);
      }

      try {
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

        res.json(response);
      } catch (err) {
        next(err);
      } finally {
        if (api_token && originalApiToken !== null) {
          await cloudflareConfigService.setApiToken(originalApiToken, userId);
        }
      }
    }),
  );

  return router;
}
