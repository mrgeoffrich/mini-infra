import express, {
  Request,
  Response,
  RequestHandler,
} from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { getLogger } from "../lib/logger-factory";
import { asyncHandler } from "../lib/async-handler";
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import {
  TailscaleService,
  TailscaleAuthkeyMinter,
} from "../services/tailscale";
import {
  TAILSCALE_DEFAULT_TAG,
  TailscaleErrorCode,
  TailscaleSettingsResponse,
  TailscaleValidationResponse,
  buildAclSnippet,
} from "@mini-infra/types";

const logger = getLogger("integrations", "tailscale-settings");

const tagRegex = /^tag:[a-z0-9-]+$/;

const upsertSchema = z.object({
  client_id: z.string().min(8, "OAuth client_id must be at least 8 characters"),
  client_secret: z
    .string()
    .min(8, "OAuth client_secret must be at least 8 characters")
    .optional(),
  extra_tags: z
    .array(
      z
        .string()
        .regex(tagRegex, "Tags must match tag:[a-z0-9-]+"),
    )
    .max(20, "At most 20 extra tags allowed")
    .optional()
    .default([]),
});

const validateSchema = z.object({
  client_id: z.string().min(1).optional(),
  client_secret: z.string().min(1).optional(),
});

function getUserId(req: Request): string {
  return getAuthenticatedUser(req)?.id || "system";
}

function respondValidationError(res: Response, error: z.ZodError): Response {
  return res.status(400).json({
    success: false,
    error: "Invalid request parameters",
    details: error.flatten(),
  });
}

const tailscaleService = new TailscaleService(prisma);
const authkeyMinter = new TailscaleAuthkeyMinter(tailscaleService);

const router = express.Router();

router.get(
  "/",
  requirePermission("settings:read") as RequestHandler,
  asyncHandler(async (req, res) => {
    const requestId = req.headers["x-request-id"] as string | undefined;

    const clientId = await tailscaleService.getClientId();
    const hasClientSecret = !!(await tailscaleService.getClientSecret());
    const extraTags = await tailscaleService.getExtraTags();

    const response: TailscaleSettingsResponse = {
      success: true,
      data: {
        isConfigured: !!(clientId && hasClientSecret),
        hasClientSecret,
        clientId: clientId || undefined,
        extraTags,
        aclSnippet: buildAclSnippet(extraTags),
      },
    };

    logger.debug(
      { requestId, isConfigured: response.data.isConfigured },
      "Tailscale settings retrieved",
    );
    res.json(response);
  }),
);

router.post(
  "/",
  requirePermission("settings:write") as RequestHandler,
  asyncHandler(async (req, res) => {
    const requestId = req.headers["x-request-id"] as string | undefined;
    const userId = getUserId(req);

    const validation = upsertSchema.safeParse(req.body);
    if (!validation.success) {
      logger.warn(
        { requestId, userId, errors: validation.error.flatten() },
        "Invalid Tailscale settings request",
      );
      return respondValidationError(res, validation.error);
    }

    const { client_id, client_secret, extra_tags } = validation.data;

    await tailscaleService.setClientId(client_id, userId);
    if (client_secret !== undefined) {
      await tailscaleService.setClientSecret(client_secret, userId);
    }
    await tailscaleService.setExtraTags(extra_tags ?? [], userId);

    const validationResult = await tailscaleService.validate();

    const response: TailscaleSettingsResponse = {
      success: true,
      data: {
        isConfigured: true,
        hasClientSecret: !!(await tailscaleService.getClientSecret()),
        clientId: client_id,
        extraTags: extra_tags ?? [],
        aclSnippet: buildAclSnippet(extra_tags ?? []),
        isValid: validationResult.isValid,
        validationMessage: validationResult.message,
        validationErrorCode: validationResult.errorCode as
          | TailscaleErrorCode
          | undefined,
      },
    };
    res.json(response);
  }),
);

router.delete(
  "/",
  requirePermission("settings:write") as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    await tailscaleService.removeConfiguration(userId);

    const response: TailscaleSettingsResponse = {
      success: true,
      data: {
        isConfigured: false,
        hasClientSecret: false,
        extraTags: [],
        aclSnippet: buildAclSnippet([]),
      },
    };
    res.json(response);
  }),
);

router.post(
  "/test",
  requirePermission("settings:write") as RequestHandler,
  asyncHandler(async (req, res) => {
    const requestId = req.headers["x-request-id"] as string | undefined;
    const userId = getUserId(req);

    const validation = validateSchema.safeParse(req.body);
    if (!validation.success) {
      logger.warn(
        { requestId, userId, errors: validation.error.flatten() },
        "Invalid Tailscale validation request",
      );
      return respondValidationError(res, validation.error);
    }

    const settings = validation.data.client_id
      ? {
          clientId: validation.data.client_id,
          clientSecret: validation.data.client_secret,
        }
      : undefined;

    const startTime = Date.now();
    const result = await tailscaleService.validate(
      settings as Record<string, string> | undefined,
    );

    const response: TailscaleValidationResponse = {
      success: result.isValid,
      data: {
        isValid: result.isValid,
        message: result.message,
        errorCode: result.errorCode,
        metadata: result.metadata,
        responseTimeMs: result.responseTimeMs ?? Date.now() - startTime,
      },
    };
    res.json(response);
  }),
);

router.get(
  "/acl-snippet",
  requirePermission("settings:read") as RequestHandler,
  asyncHandler(async (_req, res) => {
    const extraTags = await tailscaleService.getExtraTags();
    res.json({
      success: true,
      data: {
        defaultTag: TAILSCALE_DEFAULT_TAG,
        extraTags,
        snippet: buildAclSnippet(extraTags),
      },
    });
  }),
);

router.post(
  "/probe-tag-ownership",
  requirePermission("settings:write") as RequestHandler,
  asyncHandler(async (_req, res) => {
    const startTime = Date.now();
    try {
      await authkeyMinter.probeTagOwnership();
      res.json({
        success: true,
        data: {
          isValid: true,
          message: "OAuth client owns the configured tags",
          responseTimeMs: Date.now() - startTime,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Tag ownership probe failed";
      const errorCode =
        error && typeof error === "object" && "errorCode" in error
          ? (error as { errorCode: string }).errorCode
          : "TAILSCALE_API_ERROR";
      res.status(400).json({
        success: false,
        data: {
          isValid: false,
          message,
          errorCode,
          responseTimeMs: Date.now() - startTime,
        },
      });
    }
  }),
);

export default router;
