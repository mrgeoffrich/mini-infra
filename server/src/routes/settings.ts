import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { getLogger } from "../lib/logger-factory";

const logger = getLogger("http", "settings");
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import prisma from "../lib/prisma";
import { Prisma } from "../generated/prisma/client";
import {
  SettingResponse,
  SettingsListResponse,
  SystemSettings,
  SystemSettingsInfo,
  VALIDATION_STATUSES,
  SORT_ORDERS,
} from "@mini-infra/types";

const router = express.Router();

// Helper function to convert SystemSettings to SystemSettingsInfo for API responses
function serializeSystemSetting(setting: SystemSettings): SystemSettingsInfo {
  return {
    ...setting,
    lastValidatedAt: setting.lastValidatedAt?.toISOString() || null,
    createdAt: setting.createdAt.toISOString(),
    updatedAt: setting.updatedAt.toISOString(),
  };
}

// Query parameter validation schema for listing settings
const settingsQuerySchema = z.object({
  category: z
    .enum([
      "docker",
      "cloudflare",
      "azure",
      "postgres",
      "system",
      "deployments",
      "haproxy",
      "tls",
      "self-backup",
    ])
    .optional(),
  key: z.string().optional(),
  isActive: z
    .string()
    .optional()
    .transform((val) => val === "true"),
  validationStatus: z.enum(VALIDATION_STATUSES).optional(),
  sortBy: z.string().optional().default("category"),
  sortOrder: z.enum(SORT_ORDERS).optional().default("asc"),
  page: z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (!val) return 1;
      const parsed = parseInt(val);
      if (isNaN(parsed) || parsed < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Page must be a positive integer",
        });
        return z.NEVER;
      }
      return parsed;
    }),
  limit: z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (!val) return 20;
      const parsed = parseInt(val);
      if (isNaN(parsed) || parsed < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Limit must be a positive integer",
        });
        return z.NEVER;
      }
      return Math.min(parsed, 100); // Maximum 100 settings per page
    }),
});

// Request body validation schemas
const createSettingSchema = z.object({
  category: z.enum([
    "docker",
    "cloudflare",
    "azure",
    "postgres",
    "system",
    "deployments",
    "haproxy",
    "tls",
    "self-backup",
  ]),
  key: z.string().min(1, "Key is required").max(255),
  value: z.string().min(1, "Value is required"),
  isEncrypted: z.boolean().optional().default(false),
});

const updateSettingSchema = z.object({
  value: z.string().min(1, "Value is required"),
  isEncrypted: z.boolean().optional(),
});

/**
 * GET /api/settings - List system settings with filtering and pagination
 */
router.get("/", requirePermission('settings:read') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  logger.debug(
    {
      requestId,
      userId,
      query: req.query,
    },
    "Settings list requested",
  );

  try {
    // Validate query parameters
    const queryValidation = settingsQuerySchema.safeParse(req.query);
    if (!queryValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          validationErrors: queryValidation.error.issues,
        },
        "Invalid query parameters for settings list",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid query parameters",
        details: queryValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const {
      category,
      key,
      isActive,
      validationStatus,
      sortBy,
      sortOrder,
      page,
      limit,
    } = queryValidation.data;

    // Build filter conditions
    const where: Prisma.SystemSettingsWhereInput = { isActive: false }; // Default to inactive settings
    if (category) where.category = category;
    if (key) where.key = key;
    if (typeof isActive === "boolean") where.isActive = isActive;
    if (validationStatus) where.validationStatus = validationStatus;

    // Build sort conditions
    const orderBy: Prisma.SystemSettingsOrderByWithRelationInput = {
      [sortBy]: sortOrder,
    };

    // Calculate pagination
    const skip = (page - 1) * limit;

    // Fetch settings with filtering and pagination
    const [settings, totalCount] = await Promise.all([
      prisma.systemSettings.findMany({
        where,
        orderBy,
        skip,
        take: limit,
      }),
      prisma.systemSettings.count({ where }),
    ]);

    // Serialize settings for API response
    const serializedSettings = settings.map(serializeSystemSetting);

    logger.debug(
      {
        requestId,
        userId,
        totalSettings: totalCount,
        returnedSettings: serializedSettings.length,
        filters: { category, key, isActive, validationStatus },
        sortBy,
        sortOrder,
        page,
        limit,
      },
      "Settings list returned successfully",
    );

    const response: SettingsListResponse = {
      success: true,
      data: serializedSettings,
      message: `Found ${totalCount} settings`,
    };

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        query: req.query,
      },
      "Failed to fetch settings list",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings - Create a new system setting
 */
router.post("/", requirePermission('settings:write') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  logger.debug(
    {
      requestId,
      userId,
      body: { ...req.body, value: "[REDACTED]" }, // Redact sensitive value
    },
    "Create setting requested",
  );

  try {
    if (!user || !userId) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "User authentication required",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Validate request body
    const bodyValidation = createSettingSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          validationErrors: bodyValidation.error.issues,
        },
        "Invalid request body for create setting",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid request data",
        details: bodyValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const { category, key, value, isEncrypted } = bodyValidation.data;

    // Check if setting with same category/key already exists
    const existingSetting = await prisma.systemSettings.findUnique({
      where: {
        category_key: {
          category,
          key,
        },
      },
    });

    if (existingSetting) {
      logger.warn(
        {
          requestId,
          userId,
          category,
          key,
        },
        "Setting with same category/key already exists",
      );

      return res.status(409).json({
        error: "Conflict",
        message: `Setting with category '${category}' and key '${key}' already exists`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Create the setting
    const setting = await prisma.systemSettings.create({
      data: {
        category,
        key,
        value,
        isEncrypted: isEncrypted || false,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      },
    });

    // Invalidate caches for known dynamic settings
    if (category === "system") {
      const { invalidatePublicUrlCache, invalidateCorsEnabledCache } = await import("../lib/public-url-service");
      if (key === "public_url") invalidatePublicUrlCache();
      if (key === "cors_enabled") invalidateCorsEnabledCache();
    }

    logger.debug(
      {
        requestId,
        userId,
        settingId: setting.id,
        category,
        key,
      },
      "Setting created successfully",
    );

    const response: SettingResponse = {
      success: true,
      data: serializeSystemSetting(setting),
      message: "Setting created successfully",
    };

    res.status(201).json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        body: { ...req.body, value: "[REDACTED]" },
      },
      "Failed to create setting",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * GET /api/settings/:id - Get specific setting by ID
 */
router.get("/:id", requirePermission('settings:read') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;
  const settingId = String(req.params.id);

  logger.debug(
    {
      requestId,
      userId,
      settingId,
    },
    "Setting details requested",
  );

  try {
    // Validate setting ID format
    if (!settingId || settingId.length < 8) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid setting ID format",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const setting = await prisma.systemSettings.findUnique({
      where: { id: settingId },
    });

    if (!setting) {
      logger.warn(
        {
          requestId,
          userId,
          settingId,
        },
        "Setting not found",
      );

      return res.status(404).json({
        error: "Not Found",
        message: `Setting with ID '${settingId}' not found`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    logger.debug(
      {
        requestId,
        userId,
        settingId,
        category: setting.category,
        key: setting.key,
      },
      "Setting details returned successfully",
    );

    const response: SettingResponse = {
      success: true,
      data: serializeSystemSetting(setting),
    };

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        settingId,
      },
      "Failed to fetch setting details",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * PUT /api/settings/:id - Update an existing system setting
 */
router.put("/:id", requirePermission('settings:write') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;
  const settingId = String(req.params.id);

  logger.debug(
    {
      requestId,
      userId,
      settingId,
      body: { ...req.body, value: "[REDACTED]" },
    },
    "Update setting requested",
  );

  try {
    if (!user || !userId) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "User authentication required",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Validate setting ID format
    if (!settingId || settingId.length < 8) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid setting ID format",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Validate request body
    const bodyValidation = updateSettingSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          settingId,
          validationErrors: bodyValidation.error.issues,
        },
        "Invalid request body for update setting",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid request data",
        details: bodyValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const { value, isEncrypted } = bodyValidation.data;

    // Get existing setting for audit log
    const existingSetting = await prisma.systemSettings.findUnique({
      where: { id: settingId },
    });

    if (!existingSetting) {
      logger.warn(
        {
          requestId,
          userId,
          settingId,
        },
        "Setting not found for update",
      );

      return res.status(404).json({
        error: "Not Found",
        message: `Setting with ID '${settingId}' not found`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Prepare update data
    const updateData: Prisma.SystemSettingsUpdateInput = {
      value,
      updatedBy: userId,
    };

    if (typeof isEncrypted === "boolean") {
      updateData.isEncrypted = isEncrypted;
    }

    // Update the setting
    const updatedSetting = await prisma.systemSettings.update({
      where: { id: settingId },
      data: updateData,
    });

    // Invalidate caches for known dynamic settings
    if (existingSetting.category === "system") {
      const { invalidatePublicUrlCache, invalidateCorsEnabledCache } = await import("../lib/public-url-service");
      if (existingSetting.key === "public_url") invalidatePublicUrlCache();
      if (existingSetting.key === "cors_enabled") invalidateCorsEnabledCache();
    }

    logger.debug(
      {
        requestId,
        userId,
        settingId,
        category: existingSetting.category,
        key: existingSetting.key,
      },
      "Setting updated successfully",
    );

    const response: SettingResponse = {
      success: true,
      data: serializeSystemSetting(updatedSetting),
      message: "Setting updated successfully",
    };

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        settingId,
        body: { ...req.body, value: "[REDACTED]" },
      },
      "Failed to update setting",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * DELETE /api/settings/:id - Delete a system setting
 */
router.delete("/:id", requirePermission('settings:write') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;
  const settingId = String(req.params.id);

  logger.debug(
    {
      requestId,
      userId,
      settingId,
    },
    "Delete setting requested",
  );

  try {
    if (!user || !userId) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "User authentication required",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Validate setting ID format
    if (!settingId || settingId.length < 8) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid setting ID format",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Get existing setting for audit log
    const existingSetting = await prisma.systemSettings.findUnique({
      where: { id: settingId },
    });

    if (!existingSetting) {
      logger.warn(
        {
          requestId,
          userId,
          settingId,
        },
        "Setting not found for deletion",
      );

      return res.status(404).json({
        error: "Not Found",
        message: `Setting with ID '${settingId}' not found`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Delete the setting
    await prisma.systemSettings.delete({
      where: { id: settingId },
    });

    // Invalidate caches for known dynamic settings
    if (existingSetting.category === "system") {
      const { invalidatePublicUrlCache, invalidateCorsEnabledCache } = await import("../lib/public-url-service");
      if (existingSetting.key === "public_url") invalidatePublicUrlCache();
      if (existingSetting.key === "cors_enabled") invalidateCorsEnabledCache();
    }

    logger.debug(
      {
        requestId,
        userId,
        settingId,
        category: existingSetting.category,
        key: existingSetting.key,
      },
      "Setting deleted successfully",
    );

    res.json({
      success: true,
      message: "Setting deleted successfully",
      timestamp: new Date().toISOString(),
      requestId,
    });
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        settingId,
      },
      "Failed to delete setting",
    );

    next(error);
  }
}) as RequestHandler);

export default router;
