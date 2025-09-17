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
import prisma from "../lib/prisma";
import { ConfigurationServiceFactory } from "../services/configuration-factory";
import {
  CreateSettingRequest,
  UpdateSettingRequest,
  SettingResponse,
  SettingsListResponse,
  SystemSettings,
  SystemSettingsInfo,
  SettingsCategory,
  ValidationStatus,
  SettingsFilter,
  SettingsSortOptions,
  ValidateServiceRequest,
  ValidateServiceResponse,
  ConnectivityStatus,
  ConnectivityStatusInfo,
  ConnectivityStatusListResponse,
  ConnectivityService,
  ConnectivityStatusType,
} from "@mini-infra/types";

const router = express.Router();

// Create configuration service factory
const configFactory = new ConfigurationServiceFactory(prisma);

// Helper function to convert SystemSettings to SystemSettingsInfo for API responses
function serializeSystemSetting(setting: SystemSettings): SystemSettingsInfo {
  return {
    ...setting,
    lastValidatedAt: setting.lastValidatedAt?.toISOString() || null,
    createdAt: setting.createdAt.toISOString(),
    updatedAt: setting.updatedAt.toISOString(),
  };
}

// Helper function to convert ConnectivityStatus to ConnectivityStatusInfo for API responses
function serializeConnectivityStatus(
  status: ConnectivityStatus,
): ConnectivityStatusInfo {
  return {
    ...status,
    responseTimeMs: status.responseTimeMs
      ? Number(status.responseTimeMs)
      : null,
    lastSuccessfulAt: status.lastSuccessfulAt?.toISOString() || null,
    checkedAt: status.checkedAt.toISOString(),
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
    ])
    .optional(),
  isActive: z
    .string()
    .optional()
    .transform((val) => val === "true"),
  validationStatus: z.enum(["valid", "invalid", "pending", "error"]).optional(),
  sortBy: z.string().optional().default("category"),
  sortOrder: z.enum(["asc", "desc"]).optional().default("asc"),
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
  ]),
  key: z.string().min(1, "Key is required").max(255),
  value: z.string().min(1, "Value is required"),
  isEncrypted: z.boolean().optional().default(false),
});

const updateSettingSchema = z.object({
  value: z.string().min(1, "Value is required"),
  isEncrypted: z.boolean().optional(),
});

// Validation request schema
const validateServiceSchema = z.object({
  settings: z.record(z.string(), z.string()).optional(), // Optional settings to validate with
});

// Connectivity query parameter validation schema
const connectivityQuerySchema = z.object({
  service: z
    .enum([
      "docker",
      "cloudflare",
      "azure",
      "postgres",
      "system",
      "deployments",
    ])
    .optional(),
  status: z
    .enum(["connected", "failed", "timeout", "unreachable", "error"])
    .optional(),
  checkInitiatedBy: z.string().optional(),
  startDate: z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (!val) return undefined;
      const parsed = new Date(val);
      if (isNaN(parsed.getTime())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Start date must be a valid ISO date string",
        });
        return z.NEVER;
      }
      return parsed;
    }),
  endDate: z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (!val) return undefined;
      const parsed = new Date(val);
      if (isNaN(parsed.getTime())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "End date must be a valid ISO date string",
        });
        return z.NEVER;
      }
      return parsed;
    }),
  sortBy: z.string().optional().default("checkedAt"),
  sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
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
      return Math.min(parsed, 100); // Maximum 100 connectivity entries per page
    }),
});

/**
 * GET /api/settings - List system settings with filtering and pagination
 */
router.get("/", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  logger.info(
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
      isActive,
      validationStatus,
      sortBy,
      sortOrder,
      page,
      limit,
    } = queryValidation.data;

    // Build filter conditions
    const where: any = { isActive: false }; // Default to inactive settings
    if (category) where.category = category;
    if (typeof isActive === "boolean") where.isActive = isActive;
    if (validationStatus) where.validationStatus = validationStatus;

    // Build sort conditions
    const orderBy: any = {};
    orderBy[sortBy] = sortOrder;

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

    logger.info(
      {
        requestId,
        userId,
        totalSettings: totalCount,
        returnedSettings: serializedSettings.length,
        filters: { category, isActive, validationStatus },
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
router.post("/", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  logger.info(
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

    logger.info(
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
 * GET /api/settings/connectivity - List connectivity status logs with filtering and pagination
 */
router.get("/connectivity", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  logger.info(
    {
      requestId,
      userId,
      query: req.query,
    },
    "Connectivity status requested",
  );

  try {
    // Validate query parameters
    const queryValidation = connectivityQuerySchema.safeParse(req.query);
    if (!queryValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          validationErrors: queryValidation.error.issues,
        },
        "Invalid query parameters for connectivity status",
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
      service,
      status,
      checkInitiatedBy,
      startDate,
      endDate,
      sortBy,
      sortOrder,
      page,
      limit,
    } = queryValidation.data;

    // Build filter conditions
    const where: any = {};
    if (service) where.service = service;
    if (status) where.status = status;
    if (checkInitiatedBy) where.checkInitiatedBy = checkInitiatedBy;
    if (startDate || endDate) {
      where.checkedAt = {};
      if (startDate) where.checkedAt.gte = startDate;
      if (endDate) where.checkedAt.lte = endDate;
    }

    // Build sort conditions
    const orderBy: any = {};
    orderBy[sortBy] = sortOrder;

    // Calculate pagination
    const skip = (page - 1) * limit;

    // Fetch connectivity status entries with filtering and pagination
    const [connectivityEntries, totalCount] = await Promise.all([
      prisma.connectivityStatus.findMany({
        where,
        orderBy,
        skip,
        take: limit,
      }),
      prisma.connectivityStatus.count({ where }),
    ]);

    // Serialize connectivity entries for API response
    const serializedConnectivityEntries = connectivityEntries.map(
      serializeConnectivityStatus,
    );

    logger.info(
      {
        requestId,
        userId,
        totalConnectivityEntries: totalCount,
        returnedConnectivityEntries: serializedConnectivityEntries.length,
        filters: {
          service,
          status,
          checkInitiatedBy,
          startDate: startDate?.toISOString(),
          endDate: endDate?.toISOString(),
        },
        sortBy,
        sortOrder,
        page,
        limit,
      },
      "Connectivity status returned successfully",
    );

    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    const response: ConnectivityStatusListResponse = {
      success: true,
      data: serializedConnectivityEntries,
      totalCount,
      page,
      limit,
      totalPages,
      hasNextPage,
      hasPreviousPage,
      message: `Found ${totalCount} connectivity status entries`,
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
      "Failed to fetch connectivity status",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/validate/:service - Validate external service connectivity
 */
router.post("/validate/:service", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;
  const service = req.params.service;

  logger.info(
    {
      requestId,
      userId,
      service,
    },
    "Service validation requested",
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

    // Validate service parameter
    if (
      ![
        "docker",
        "cloudflare",
        "azure",
        "postgres",
        "system",
        "deployments",
      ].includes(service)
    ) {
      return res.status(400).json({
        error: "Bad Request",
        message: `Invalid service '${service}'. Must be one of: docker, cloudflare, azure, postgres, system, deployments`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Validate request body
    const bodyValidation = validateServiceSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          service,
          validationErrors: bodyValidation.error.issues,
        },
        "Invalid request body for service validation",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid request data",
        details: bodyValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const { settings } = bodyValidation.data;

    // Get the configuration service for the requested service type
    const configService = configFactory.create({
      category: service as SettingsCategory,
    });

    // Perform validation with timeout protection
    const startTime = Date.now();
    const validationResult = (await Promise.race([
      configService.validate(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Validation timeout")), 30000),
      ),
    ])) as any;

    const responseTime = Date.now() - startTime;

    // Store validation results in ConnectivityStatus database
    await prisma.connectivityStatus.create({
      data: {
        service,
        status: validationResult.isValid ? "connected" : "failed",
        responseTimeMs: responseTime,
        errorMessage: validationResult.isValid
          ? null
          : validationResult.message,
        errorCode: validationResult.errorCode,
        lastSuccessfulAt: validationResult.isValid ? new Date() : null,
        checkInitiatedBy: userId,
        metadata: validationResult.metadata
          ? JSON.stringify(validationResult.metadata)
          : null,
      },
    });

    // Update SystemSettings validation status if validating current configuration
    if (!settings) {
      // Update all settings for this service category
      await prisma.systemSettings.updateMany({
        where: {
          category: service,
          isActive: true,
        },
        data: {
          validationStatus: validationResult.isValid ? "valid" : "invalid",
          validationMessage: validationResult.isValid
            ? null
            : validationResult.message,
          lastValidatedAt: new Date(),
        },
      });
    }

    logger.info(
      {
        requestId,
        userId,
        service,
        isValid: validationResult.isValid,
        responseTimeMs: responseTime,
        errorCode: validationResult.errorCode,
      },
      "Service validation completed",
    );

    res.json({
      success: true,
      data: {
        service,
        isValid: validationResult.isValid,
        responseTimeMs: responseTime,
        error: validationResult.isValid ? undefined : validationResult.message,
        errorCode: validationResult.errorCode,
        metadata: validationResult.metadata,
        validatedAt: new Date().toISOString(),
      },
      message: validationResult.isValid
        ? `${service} service validation successful`
        : `${service} service validation failed`,
      timestamp: new Date().toISOString(),
      requestId,
    });
  } catch (error) {
    const responseTime = Date.now() - (Date.now() - 30000); // Fallback time calculation

    // Store failed validation in ConnectivityStatus database
    try {
      await prisma.connectivityStatus.create({
        data: {
          service,
          status: "error",
          responseTimeMs: responseTime,
          errorMessage:
            error instanceof Error ? error.message : "Unknown validation error",
          errorCode: "VALIDATION_ERROR",
          checkInitiatedBy: userId,
        },
      });
    } catch (dbError) {
      logger.error(
        {
          dbError,
          requestId,
          userId,
          service,
        },
        "Failed to store validation error in database",
      );
    }

    logger.error(
      {
        error,
        requestId,
        userId,
        service,
      },
      "Service validation failed with error",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * GET /api/settings/:id - Get specific setting by ID
 */
router.get("/:id", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;
  const settingId = req.params.id;

  logger.info(
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

    logger.info(
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
router.put("/:id", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;
  const settingId = req.params.id;

  logger.info(
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
    const updateData: any = {
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

    logger.info(
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
router.delete("/:id", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;
  const settingId = req.params.id;

  logger.info(
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

    logger.info(
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
