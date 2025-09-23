import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey, getAuthenticatedUser } from "../middleware/auth";
import prisma from "../lib/prisma";
import { AzureConfigService } from "../services/azure-config";
import {
  CreateAzureSettingRequest,
  UpdateAzureSettingRequest,
  ValidateAzureConnectionRequest,
  AzureSettingResponse,
  AzureValidationResponse,
  AzureContainerListResponse,
  AzureContainerAccessResponse,
} from "@mini-infra/types";

const router = express.Router();
const logger = appLogger();

// Create Azure configuration service instance
const azureConfigService = new AzureConfigService(prisma);

// Request validation schemas
const createAzureSettingSchema = z.object({
  connectionString: z
    .string()
    .min(1, "Connection string is required")
    .refine(
      (val) => {
        const requiredKeys = [
          "DefaultEndpointsProtocol",
          "AccountName",
          "AccountKey",
        ];
        return requiredKeys.every((key) => val.includes(`${key}=`));
      },
      {
        message:
          "Invalid connection string format. Must include DefaultEndpointsProtocol, AccountName, and AccountKey",
      },
    ),
  accountName: z.string().optional(),
});

const updateAzureSettingSchema = z.object({
  connectionString: z
    .string()
    .min(1, "Connection string is required")
    .refine(
      (val) => {
        const requiredKeys = [
          "DefaultEndpointsProtocol",
          "AccountName",
          "AccountKey",
        ];
        return requiredKeys.every((key) => val.includes(`${key}=`));
      },
      {
        message:
          "Invalid connection string format. Must include DefaultEndpointsProtocol, AccountName, and AccountKey",
      },
    )
    .optional(),
  accountName: z.string().optional(),
});

const validateAzureConnectionSchema = z.object({
  connectionString: z.string().optional(),
  testContainerAccess: z.boolean().optional().default(false),
});

const testContainerAccessSchema = z.object({
  containerName: z.string().min(1, "Container name is required"),
});

/**
 * GET /api/settings/azure - Get current Azure configuration
 */
router.get("/", requireSessionOrApiKey, (async (
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
    "Azure settings requested",
  );

  try {
    const connectionString = await azureConfigService.getConnectionString();
    const accountName = await azureConfigService.getStorageAccountName();

    // Get latest validation status from connectivity status
    const healthStatus = await azureConfigService.getHealthStatus();

    // Get the corresponding system settings for metadata
    const azureSettings = await prisma.systemSettings.findMany({
      where: {
        category: "azure",
        isActive: true,
      },
    });

    const connectionSetting = azureSettings.find(
      (s) => s.key === "connection_string",
    );

    const response: AzureSettingResponse = {
      success: true,
      data: {
        id: connectionSetting?.id || "no-config",
        accountName,
        connectionConfigured: !!connectionString,
        lastValidatedAt: healthStatus.lastChecked?.toISOString() || null,
        validationStatus: healthStatus.status,
        validationMessage: healthStatus.errorMessage || null,
        createdAt:
          connectionSetting?.createdAt?.toISOString() ||
          new Date().toISOString(),
        updatedAt:
          connectionSetting?.updatedAt?.toISOString() ||
          new Date().toISOString(),
        createdBy: connectionSetting?.createdBy || "system",
        updatedBy: connectionSetting?.updatedBy || "system",
      },
      message: connectionString
        ? `Azure Storage configuration found (${accountName || "Unknown account"})`
        : "No Azure Storage configuration found",
      timestamp: new Date().toISOString(),
      requestId,
    };

    logger.debug(
      {
        requestId,
        userId,
        hasConfiguration: !!connectionString,
        accountName,
        validationStatus: healthStatus.status,
      },
      "Azure settings returned successfully",
    );

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
      },
      "Failed to fetch Azure settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * PUT /api/settings/azure - Update Azure configuration
 */
router.put("/", requireSessionOrApiKey, (async (
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
        connectionString: req.body.connectionString ? "[REDACTED]" : undefined,
      },
    },
    "Azure settings update requested",
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
    const bodyValidation = updateAzureSettingSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          validationErrors: bodyValidation.error.issues,
        },
        "Invalid request body for Azure settings update",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid request data",
        details: bodyValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const { connectionString, accountName } = bodyValidation.data;

    // Update connection string if provided
    if (connectionString) {
      await azureConfigService.setConnectionString(connectionString, userId);
    }

    // Set account name if provided
    if (accountName) {
      await azureConfigService.set("storage_account_name", accountName, userId);
    }

    // Get updated configuration
    const updatedConnectionString =
      await azureConfigService.getConnectionString();
    const updatedAccountName = await azureConfigService.getStorageAccountName();

    // Get the corresponding system setting for metadata
    const connectionSetting = await prisma.systemSettings.findFirst({
      where: {
        category: "azure",
        key: "connection_string",
        isActive: true,
      },
    });

    const response: AzureSettingResponse = {
      success: true,
      data: {
        id: connectionSetting?.id || "updated-config",
        accountName: updatedAccountName,
        connectionConfigured: !!updatedConnectionString,
        lastValidatedAt: null, // Will be updated on next validation
        validationStatus: "pending",
        validationMessage: "Configuration updated, validation pending",
        createdAt:
          connectionSetting?.createdAt?.toISOString() ||
          new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdBy: connectionSetting?.createdBy || userId,
        updatedBy: userId,
      },
      message: "Azure Storage configuration updated successfully",
      timestamp: new Date().toISOString(),
      requestId,
    };

    logger.debug(
      {
        requestId,
        userId,
        accountName: updatedAccountName,
        hasConnectionString: !!updatedConnectionString,
      },
      "Azure settings updated successfully",
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
          connectionString: req.body.connectionString
            ? "[REDACTED]"
            : undefined,
        },
      },
      "Failed to update Azure settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/azure/validate - Validate Azure connection
 */
router.post("/validate", requireSessionOrApiKey, (async (
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
    "Azure connection validation requested",
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
    const bodyValidation = validateAzureConnectionSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          validationErrors: bodyValidation.error.issues,
        },
        "Invalid request body for Azure connection validation",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid request data",
        details: bodyValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const { connectionString, testContainerAccess } = bodyValidation.data;

    // If a connection string is provided for testing, temporarily use it
    if (connectionString) {
      // Create temporary service instance for testing
      const tempService = new AzureConfigService(prisma);
      await tempService.setConnectionString(connectionString, userId);

      // Perform validation
      const validationResult = await tempService.validate();

      // Clean up temporary configuration
      await tempService.removeConfiguration(userId);

      const response: AzureValidationResponse = {
        success: true,
        data: {
          service: "azure",
          isValid: validationResult.isValid,
          responseTimeMs: validationResult.responseTimeMs || 0,
          accountInfo: validationResult.metadata?.accountName
            ? {
              accountName: validationResult.metadata.accountName,
              accountKind:
                validationResult.metadata.accountKind || "StorageV2",
              skuName: validationResult.metadata.skuName || "Unknown",
              skuTier: "Standard",
              primaryLocation: "Unknown",
            }
            : undefined,
          containerCount: validationResult.metadata?.containerCount,
          sampleContainers: validationResult.metadata?.containers?.map(
            (name: string) => ({
              name,
              lastModified: new Date().toISOString(),
              leaseStatus: "unlocked" as const,
              leaseState: "available" as const,
              hasImmutabilityPolicy: false,
              hasLegalHold: false,
            }),
          ),
          error: validationResult.isValid
            ? undefined
            : validationResult.message,
          errorCode: validationResult.errorCode,
          validatedAt: new Date().toISOString(),
        },
        message:
          validationResult.message ||
          (validationResult.isValid
            ? "Azure Storage connection validation successful"
            : "Azure Storage connection validation failed"),
        timestamp: new Date().toISOString(),
        requestId,
      };

      return res.json(response);
    }

    // Validate current configuration
    const validationResult = await azureConfigService.validate();

    const response: AzureValidationResponse = {
      success: true,
      data: {
        service: "azure",
        isValid: validationResult.isValid,
        responseTimeMs: validationResult.responseTimeMs || 0,
        accountInfo: validationResult.metadata?.accountName
          ? {
            accountName: validationResult.metadata.accountName,
            accountKind: validationResult.metadata.accountKind || "StorageV2",
            skuName: validationResult.metadata.skuName || "Unknown",
            skuTier: "Standard",
            primaryLocation: "Unknown",
          }
          : undefined,
        containerCount: validationResult.metadata?.containerCount,
        sampleContainers: validationResult.metadata?.containers?.map(
          (name: string) => ({
            name,
            lastModified: new Date().toISOString(),
            leaseStatus: "unlocked" as const,
            leaseState: "available" as const,
            hasImmutabilityPolicy: false,
            hasLegalHold: false,
          }),
        ),
        error: validationResult.isValid ? undefined : validationResult.message,
        errorCode: validationResult.errorCode,
        validatedAt: new Date().toISOString(),
      },
      message:
        validationResult.message ||
        (validationResult.isValid
          ? "Azure Storage connection validation successful"
          : "Azure Storage connection validation failed"),
      timestamp: new Date().toISOString(),
      requestId,
    };

    logger.debug(
      {
        requestId,
        userId,
        isValid: validationResult.isValid,
        responseTimeMs: validationResult.responseTimeMs,
        accountName: validationResult.metadata?.accountName,
        containerCount: validationResult.metadata?.containerCount,
      },
      "Azure connection validation completed",
    );

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
      },
      "Azure connection validation failed with error",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * DELETE /api/settings/azure - Remove Azure configuration
 */
router.delete("/", requireSessionOrApiKey, (async (
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
    "Azure settings deletion requested",
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

    const accountName = await azureConfigService.getStorageAccountName();

    // Remove Azure configuration
    await azureConfigService.removeConfiguration(userId);

    logger.debug(
      {
        requestId,
        userId,
        removedAccountName: accountName,
      },
      "Azure settings deleted successfully",
    );

    res.json({
      success: true,
      message: `Azure Storage configuration removed successfully${accountName ? ` (${accountName})` : ""}`,
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
      "Failed to delete Azure settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * GET /api/settings/azure/containers - List Azure Storage containers
 */
router.get("/containers", requireSessionOrApiKey, (async (
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
    "Azure containers list requested",
  );

  try {
    const accountName = await azureConfigService.getStorageAccountName();
    const containerInfo = await azureConfigService.getContainerInfo();

    const response: AzureContainerListResponse = {
      success: true,
      data: {
        accountName: accountName || "Unknown",
        containerCount: containerInfo.length,
        containers: containerInfo.map((container) => ({
          name: container.name,
          lastModified: container.lastModified
            ? new Date(container.lastModified).toISOString()
            : new Date().toISOString(),
          leaseStatus: container.leaseStatus || "unlocked",
          leaseState: container.leaseState || "available",
          hasImmutabilityPolicy: container.hasImmutabilityPolicy || false,
          hasLegalHold: container.hasLegalHold || false,
          metadata: container.metadata,
        })),
        hasMore: containerInfo.length >= 50, // Based on the limit in AzureConfigService
        nextMarker: undefined, // Not implemented in current service
      },
      message: `Found ${containerInfo.length} containers`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    logger.debug(
      {
        requestId,
        userId,
        accountName,
        containerCount: containerInfo.length,
      },
      "Azure containers list returned successfully",
    );

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
      },
      "Failed to fetch Azure containers",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/azure/test-container - Test access to specific container
 */
router.post("/test-container", requireSessionOrApiKey, (async (
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
      body: req.body,
    },
    "Azure container access test requested",
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
    const bodyValidation = testContainerAccessSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          validationErrors: bodyValidation.error.issues,
        },
        "Invalid request body for container access test",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid request data",
        details: bodyValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const { containerName } = bodyValidation.data;

    // Test container access (includes retry logic and caching)
    const testResult =
      await azureConfigService.testContainerAccess(containerName);

    // Get container metadata if accessible
    let containerMetadata = null;
    if (testResult.accessible) {
      try {
        const containers = await azureConfigService.getContainerInfo();
        containerMetadata = containers.find((c) => c.name === containerName);
      } catch (error) {
        logger.warn(
          {
            containerName,
            error: error instanceof Error ? error.message : "Unknown error",
          },
          "Failed to get container metadata, but access test succeeded",
        );
      }
    }

    const response: AzureContainerAccessResponse = {
      success: true,
      data: {
        containerName,
        accessible: testResult.accessible,
        responseTimeMs: testResult.responseTimeMs,
        lastModified: containerMetadata?.lastModified
          ? new Date(containerMetadata.lastModified).toISOString()
          : undefined,
        leaseStatus: containerMetadata?.leaseStatus,
        error: testResult.error,
        errorCode: testResult.errorCode,
        testedAt: new Date().toISOString(),
      },
      message: testResult.accessible
        ? `Container '${containerName}' is accessible${testResult.cached ? " (cached)" : ""}`
        : `Container '${containerName}' is not accessible: ${testResult.error || "Access denied"}`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    logger.debug(
      {
        requestId,
        userId,
        containerName,
        accessible: testResult.accessible,
        responseTimeMs: testResult.responseTimeMs,
        cached: testResult.cached,
      },
      "Azure container access test completed",
    );

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        body: req.body,
      },
      "Azure container access test failed with error",
    );

    next(error);
  }
}) as RequestHandler);

export default router;
