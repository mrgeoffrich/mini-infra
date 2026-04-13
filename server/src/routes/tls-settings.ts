/**
 * TLS Settings API Routes
 *
 * Provides a frontend-friendly API for managing TLS configuration settings.
 * Wraps the generic settings infrastructure with TLS-specific endpoints.
 *
 * Endpoints:
 * - GET /api/tls/settings - Get all TLS configuration settings
 * - PUT /api/tls/settings - Update TLS configuration settings
 * - POST /api/tls/connectivity/test - Test Azure Storage container connectivity
 * - GET /api/tls/containers - List available Azure Storage containers
 */

import express, { Request, Response, NextFunction, RequestHandler } from "express";
import { z } from "zod";
import { tlsLogger } from "../lib/logger-factory";
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import prisma from "../lib/prisma";
import { TlsConfigService } from "../services/tls/tls-config";
import { AzureStorageService } from "../services/azure-storage-service";
import { ACME_PROVIDERS } from "@mini-infra/types";
import { BlobServiceClient } from "@azure/storage-blob";

const logger = tlsLogger();
const router = express.Router();

// Create service instances
const tlsConfigService = new TlsConfigService(prisma);
const azureConfigService = new AzureStorageService(prisma);

/**
 * TLS Settings Response Structure
 */
interface TlsSettingsData {
  certificate_blob_container: string | null;
  default_acme_provider: string | null;
  default_acme_email: string | null;
  renewal_check_cron: string | null;
  renewal_days_before_expiry: string | null;
}

interface TlsSettingsResponse {
  success: boolean;
  data: TlsSettingsData;
  message?: string;
  timestamp?: string;
  requestId?: string;
}

interface TlsConnectivityTestResponse {
  success: boolean;
  data?: {
    isValid: boolean;
    responseTimeMs: number;
    keyVaultUrl?: string;
    error?: string;
    errorCode?: string;
    validatedAt: string;
  };
  message?: string;
  timestamp?: string;
  requestId?: string;
}

// Request validation schema for updating TLS settings
const updateTlsSettingsSchema = z.object({
  certificate_blob_container: z.preprocess(
    (val) => val === null || val === "" ? undefined : val,
    z.string().optional()
  ),
  default_acme_provider: z.preprocess(
    (val) => val === null || val === "" ? undefined : val,
    z.enum(ACME_PROVIDERS).optional()
  ),
  default_acme_email: z.preprocess(
    (val) => val === null || val === "" ? undefined : val,
    z.string().email().optional()
  ),
  renewal_check_cron: z.preprocess(
    (val) => val === null || val === "" ? undefined : val,
    z.string().optional()
  ),
  renewal_days_before_expiry: z.preprocess(
    (val) => val === null || val === "" ? undefined : val,
    z.coerce.number().min(1).max(90).optional()
  ),
});

// Request validation schema for testing connectivity
const testConnectivitySchema = z.object({
  certificate_blob_container: z.preprocess(
    (val) => val === null || val === "" ? undefined : val,
    z.string().optional()
  ),
});

/**
 * GET /api/tls/settings
 * Get all TLS configuration settings
 */
router.get("/settings", requirePermission('tls:read'), (async (
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
    },
    "TLS settings requested",
  );

  try {
    // Fetch all TLS settings from the database
    const settings = await prisma.systemSettings.findMany({
      where: {
        category: "tls",
        isActive: true,
      },
    });

    // Convert array of settings to flat object
    const settingsData: TlsSettingsData = {
      certificate_blob_container: null,
      default_acme_provider: null,
      default_acme_email: null,
      renewal_check_cron: null,
      renewal_days_before_expiry: null,
    };

    settings.forEach((setting) => {
      if (setting.key in settingsData) {
        settingsData[setting.key as keyof TlsSettingsData] = setting.value;
      }
    });

    const response: TlsSettingsResponse = {
      success: true,
      data: settingsData,
      message: "TLS settings retrieved successfully",
      timestamp: new Date().toISOString(),
      requestId,
    };

    logger.debug(
      {
        requestId,
        userId,
        hasCertificateContainer: !!settingsData.certificate_blob_container,
        hasAcmeEmail: !!settingsData.default_acme_email,
      },
      "TLS settings returned successfully",
    );

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
      },
      "Failed to fetch TLS settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * PUT /api/tls/settings
 * Update TLS configuration settings
 */
router.put("/settings", requirePermission('tls:write'), (async (
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
      body: {
        ...req.body,
        key_vault_client_secret: req.body.key_vault_client_secret ? "[REDACTED]" : undefined,
      },
    },
    "TLS settings update requested",
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
    const bodyValidation = updateTlsSettingsSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          validationErrors: bodyValidation.error.issues,
        },
        "Invalid request body for TLS settings update",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid request data",
        details: bodyValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const settingsToUpdate = bodyValidation.data;

    // Update each setting that was provided
    for (const [key, value] of Object.entries(settingsToUpdate)) {
      if (value !== undefined) {
        // Convert number to string for storage
        const stringValue = typeof value === "number" ? value.toString() : value;
        await tlsConfigService.set(key, stringValue, userId);
      }
    }

    // Fetch updated settings
    const settings = await prisma.systemSettings.findMany({
      where: {
        category: "tls",
        isActive: true,
      },
    });

    // Convert array of settings to flat object
    const settingsData: TlsSettingsData = {
      certificate_blob_container: null,
      default_acme_provider: null,
      default_acme_email: null,
      renewal_check_cron: null,
      renewal_days_before_expiry: null,
    };

    settings.forEach((setting) => {
      if (setting.key in settingsData) {
        settingsData[setting.key as keyof TlsSettingsData] = setting.value;
      }
    });

    const response: TlsSettingsResponse = {
      success: true,
      data: settingsData,
      message: "TLS settings updated successfully",
      timestamp: new Date().toISOString(),
      requestId,
    };

    logger.debug(
      {
        requestId,
        userId,
        updatedKeys: Object.keys(settingsToUpdate),
      },
      "TLS settings updated successfully",
    );

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        body: {
          ...req.body,
          key_vault_client_secret: req.body.key_vault_client_secret ? "[REDACTED]" : undefined,
        },
      },
      "Failed to update TLS settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/tls/connectivity/test
 * Test Azure Storage container connectivity with optional temporary settings
 */
router.post("/connectivity/test", requirePermission('tls:write'), (async (
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
      hasTestSettings: Object.keys(req.body).length > 0,
    },
    "TLS connectivity test requested",
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
    const bodyValidation = testConnectivitySchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          validationErrors: bodyValidation.error.issues,
        },
        "Invalid request body for TLS connectivity test",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid request data",
        details: bodyValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const testSettings = bodyValidation.data;

    // Perform validation with optional test settings
    const validationResult = await tlsConfigService.validate(
      Object.keys(testSettings).length > 0 ? testSettings : undefined
    );

    const response: TlsConnectivityTestResponse = {
      success: validationResult.isValid,
      data: {
        isValid: validationResult.isValid,
        responseTimeMs: validationResult.responseTimeMs || 0,
        keyVaultUrl: validationResult.metadata?.containerName,
        error: validationResult.isValid ? undefined : validationResult.message,
        errorCode: validationResult.errorCode,
        validatedAt: new Date().toISOString(),
      },
      message: validationResult.isValid
        ? "Azure Storage container connection successful"
        : `Azure Storage connection failed: ${validationResult.message}`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    logger.debug(
      {
        requestId,
        userId,
        isValid: validationResult.isValid,
        responseTimeMs: validationResult.responseTimeMs,
        errorCode: validationResult.errorCode,
      },
      "TLS connectivity test completed",
    );

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
      },
      "TLS connectivity test failed with error",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * GET /api/tls/containers
 * List available Azure Storage containers
 */
router.get("/containers", requirePermission('tls:read'), (async (
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
    },
    "TLS containers list requested",
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

    // Get Azure Storage connection string
    const connectionString = await azureConfigService.getConnectionString();

    if (!connectionString) {
      return res.status(400).json({
        error: "Configuration Missing",
        message: "Azure Storage not configured. Please configure Azure Storage first.",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // List containers
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containers: string[] = [];

    for await (const container of blobServiceClient.listContainers()) {
      containers.push(container.name);
    }

    logger.debug(
      {
        requestId,
        userId,
        containerCount: containers.length,
      },
      "TLS containers listed successfully",
    );

    res.json({
      success: true,
      data: {
        containers,
      },
      message: "Containers retrieved successfully",
      timestamp: new Date().toISOString(),
      requestId,
    });
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
      },
      "Failed to list TLS containers",
    );

    next(error);
  }
}) as RequestHandler);

export default router;
