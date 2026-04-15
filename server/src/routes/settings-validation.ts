import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { getLogger } from "../lib/logger-factory";

const logger = getLogger("http", "settings-validation");
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import prisma from "../lib/prisma";
import { ConfigurationServiceFactory } from "../services/configuration-factory";
import {
  SettingsCategory,
} from "@mini-infra/types";

const router = express.Router();

// Create configuration service factory
const configFactory = new ConfigurationServiceFactory(prisma);

type TimeoutPromise<T> = Promise<T> & { cleanup: () => void };

// Utility function to handle Promise race with proper timeout cleanup
function createTimeoutPromise<T>(timeoutMs: number, errorMessage: string): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });

  // Add cleanup method to the promise
  (timeoutPromise as TimeoutPromise<T>).cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  };

  return timeoutPromise;
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  const timeoutPromise = createTimeoutPromise<T>(timeoutMs, errorMessage);

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    (timeoutPromise as TimeoutPromise<T>).cleanup();
    return result;
  } catch (error) {
    (timeoutPromise as TimeoutPromise<T>).cleanup();
    throw error;
  }
}

// Validation request schema
const validateServiceSchema = z.object({
  settings: z.record(z.string(), z.string()).optional(), // Optional settings to validate with
});

/**
 * POST /api/settings/validate/:service - Validate external service connectivity
 */
router.post("/:service", requirePermission('settings:write') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;
  const service = String(req.params.service);

  logger.debug(
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
        "system",
        "deployments",
        "haproxy",
        "tls",
        "github-app",
      ].includes(service)
    ) {
      return res.status(400).json({
        error: "Bad Request",
        message: `Invalid service '${service}'. Must be one of: docker, cloudflare, azure, system, deployments, haproxy, tls, github-app`,
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
    const validationResult = (await raceWithTimeout(
      configService.validate(settings),
      30000,
      "Validation timeout",
    )) as {
      isValid: boolean;
      message?: string;
      errorCode?: string;
      metadata?: Record<string, unknown>;
    };

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

    logger.debug(
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

export default router;
