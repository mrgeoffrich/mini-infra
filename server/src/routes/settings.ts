import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import logger from "../lib/logger";
import { requireAuth, getAuthenticatedUser } from "../lib/auth-middleware";
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
  SettingsAudit,
  SettingsAuditInfo,
  SettingsAuditListResponse,
  AuditAction,
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

// Helper function to convert SettingsAudit to SettingsAuditInfo for API responses
function serializeSettingsAudit(audit: SettingsAudit): SettingsAuditInfo {
  return {
    ...audit,
    createdAt: audit.createdAt.toISOString(),
  };
}

// Rate limiting specific to settings endpoints: 30 requests per minute per user
const settingsRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per windowMs
  keyGenerator: (req: any) => {
    // Use user ID if available, otherwise use default
    return req.user?.id || "user-default";
  },
  validate: {
    // Disable trust proxy validation since we want to use it in production
    trustProxy: false,
    // Disable IPv6 validation since we're not using IP addresses as the primary key
    keyGeneratorIpFallback: false,
  },
  message: {
    error: "Too Many Requests",
    message:
      "Settings API rate limit exceeded. Maximum 30 requests per minute.",
    timestamp: new Date().toISOString(),
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
  skip: (req: any) => {
    // Skip rate limiting in test environment
    return process.env.NODE_ENV === "test";
  },
});

// Query parameter validation schema for listing settings
const settingsQuerySchema = z.object({
  category: z.enum(["docker", "cloudflare", "azure"]).optional(),
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
  category: z.enum(["docker", "cloudflare", "azure"]),
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

// Audit query parameter validation schema
const auditQuerySchema = z.object({
  category: z.enum(["docker", "cloudflare", "azure"]).optional(),
  action: z.enum(["create", "update", "delete", "validate"]).optional(),
  userId: z.string().optional(),
  success: z
    .string()
    .optional()
    .transform((val) => val === "true"),
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
  sortBy: z.string().optional().default("createdAt"),
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
      return Math.min(parsed, 100); // Maximum 100 audit entries per page
    }),
  search: z.string().optional(), // Search in action, category, key fields
});

/**
 * GET /api/settings - List system settings with filtering and pagination
 */
router.get("/", settingsRateLimit, requireAuth, (async (
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
router.post("/", settingsRateLimit, requireAuth, (async (
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

    // Create audit log entry
    await prisma.settingsAudit.create({
      data: {
        category,
        key,
        action: "create",
        newValue: isEncrypted ? "[ENCRYPTED]" : value,
        userId,
        ipAddress: req.ip,
        userAgent: req.get("User-Agent"),
        success: true,
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
 * GET /api/settings/audit - List settings audit logs with filtering and pagination
 */
router.get("/audit", settingsRateLimit, requireAuth, (async (
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
    "Settings audit logs requested",
  );

  try {
    // Validate query parameters
    const queryValidation = auditQuerySchema.safeParse(req.query);
    if (!queryValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          validationErrors: queryValidation.error.issues,
        },
        "Invalid query parameters for audit logs",
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
      action,
      userId: filterUserId,
      success,
      startDate,
      endDate,
      sortBy,
      sortOrder,
      page,
      limit,
      search,
    } = queryValidation.data;

    // Build filter conditions
    const where: any = { success: false }; // Default to failed audits
    if (category) where.category = category;
    if (action) where.action = action;
    if (filterUserId) where.userId = filterUserId;
    if (typeof success === "boolean") where.success = success;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }

    // Add search functionality
    if (search) {
      where.OR = [
        { category: { contains: search, mode: "insensitive" } },
        { key: { contains: search, mode: "insensitive" } },
        { action: { contains: search, mode: "insensitive" } },
      ];
    }

    // Build sort conditions
    const orderBy: any = {};
    orderBy[sortBy] = sortOrder;

    // Calculate pagination
    const skip = (page - 1) * limit;

    // Fetch audit logs with filtering and pagination
    const [auditLogs, totalCount] = await Promise.all([
      prisma.settingsAudit.findMany({
        where,
        orderBy,
        skip,
        take: limit,
      }),
      prisma.settingsAudit.count({ where }),
    ]);

    // Serialize audit logs for API response
    const serializedAuditLogs = auditLogs.map(serializeSettingsAudit);

    logger.info(
      {
        requestId,
        userId,
        totalAuditLogs: totalCount,
        returnedAuditLogs: serializedAuditLogs.length,
        filters: {
          category,
          action,
          userId: filterUserId,
          success,
          startDate: startDate?.toISOString(),
          endDate: endDate?.toISOString(),
          search,
        },
        sortBy,
        sortOrder,
        page,
        limit,
      },
      "Settings audit logs returned successfully",
    );

    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    const response: SettingsAuditListResponse = {
      success: true,
      data: serializedAuditLogs,
      totalCount,
      page,
      limit,
      totalPages,
      hasNextPage,
      hasPreviousPage,
      message: `Found ${totalCount} audit log entries`,
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
      "Failed to fetch audit logs",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/validate/:service - Validate external service connectivity
 */
router.post("/validate/:service", settingsRateLimit, requireAuth, (async (
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
    if (!["docker", "cloudflare", "azure"].includes(service)) {
      return res.status(400).json({
        error: "Bad Request",
        message: `Invalid service '${service}'. Must be one of: docker, cloudflare, azure`,
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

    // Create audit log entry
    await prisma.settingsAudit.create({
      data: {
        category: service,
        key: "validation",
        action: "validate",
        userId,
        ipAddress: req.ip,
        userAgent: req.get("User-Agent"),
        success: validationResult.isValid,
        errorMessage: validationResult.isValid
          ? null
          : validationResult.message,
      },
    });

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

    // Create audit log entry for failed validation
    try {
      await prisma.settingsAudit.create({
        data: {
          category: service,
          key: "validation",
          action: "validate",
          userId: userId || "unknown",
          ipAddress: req.ip,
          userAgent: req.get("User-Agent"),
          success: false,
          errorMessage:
            error instanceof Error ? error.message : "Unknown validation error",
        },
      });
    } catch (auditError) {
      logger.error(
        {
          auditError,
          requestId,
          userId,
          service,
        },
        "Failed to create audit log entry for validation error",
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
router.get("/:id", settingsRateLimit, requireAuth, (async (
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
router.put("/:id", settingsRateLimit, requireAuth, (async (
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

    // Create audit log entry
    await prisma.settingsAudit.create({
      data: {
        category: existingSetting.category,
        key: existingSetting.key,
        action: "update",
        oldValue: existingSetting.isEncrypted
          ? "[ENCRYPTED]"
          : existingSetting.value,
        newValue:
          (isEncrypted ?? existingSetting.isEncrypted) ? "[ENCRYPTED]" : value,
        userId,
        ipAddress: req.ip,
        userAgent: req.get("User-Agent"),
        success: true,
      },
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
router.delete("/:id", settingsRateLimit, requireAuth, (async (
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

    // Create audit log entry
    await prisma.settingsAudit.create({
      data: {
        category: existingSetting.category,
        key: existingSetting.key,
        action: "delete",
        oldValue: existingSetting.isEncrypted
          ? "[ENCRYPTED]"
          : existingSetting.value,
        userId,
        ipAddress: req.ip,
        userAgent: req.get("User-Agent"),
        success: true,
      },
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
