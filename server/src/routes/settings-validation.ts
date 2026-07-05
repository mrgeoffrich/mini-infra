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
import { githubAppService } from "../services/github-app/github-app-service";
import {
  SettingsCategory,
  Permission,
  type ConnectivityStatusType,
  type ValidationResult,
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

type ServiceValidator = (
  settings?: Record<string, string>,
) => Promise<ValidationResult>;

/**
 * Connectivity service name → the config category the factory validates it
 * under. Typed against `SettingsCategory`, so a non-existent category is a
 * compile error rather than a runtime "Unsupported configuration category"
 * throw. Aliases (`azure`/`storage` → `storage-azure`) are spelled out because
 * the manual-validation service name and the config category diverge.
 */
const FACTORY_VALIDATABLE_SERVICES: Record<string, SettingsCategory> = {
  docker: "docker",
  cloudflare: "cloudflare",
  azure: "storage-azure",
  storage: "storage-azure",
  "storage-azure": "storage-azure",
  tls: "tls",
  tailscale: "tailscale",
  vault: "vault",
};

const VALIDATABLE_SERVICE_NAMES = [
  ...Object.keys(FACTORY_VALIDATABLE_SERVICES),
  "github-app",
];

/**
 * Resolve the validator for a connectivity service, or `null` when the service
 * has no live connectivity check (e.g. `system`, `deployments`, `haproxy`,
 * `nats` — settings categories with no validator). `github-app` is validated by
 * its own on-demand service rather than the factory; it is intentionally kept
 * out of the factory so the periodic scheduler doesn't start hitting the GitHub
 * API every cycle.
 */
function getServiceValidator(service: string): ServiceValidator | null {
  if (service === "github-app") {
    return (settings) => githubAppService.validate(settings);
  }
  const category = FACTORY_VALIDATABLE_SERVICES[service];
  if (!category) return null;
  return (settings) => configFactory.create({ category }).validate(settings);
}

// Validation request schema
const validateServiceSchema = z.object({
  settings: z.record(z.string(), z.string()).optional(), // Optional settings to validate with
});

/**
 * POST /api/settings/validate/:service - Validate external service connectivity
 */
router.post("/:service", requirePermission(Permission.SettingsWrite) as RequestHandler, (async (
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

    // Resolve how this service is validated. Services with no live connectivity
    // check (system, deployments, haproxy, nats, …) resolve to null and are
    // rejected here — rather than throwing deeper in the factory and recording a
    // bogus "error" connectivity row.
    const validator = getServiceValidator(service);
    if (!validator) {
      return res.status(400).json({
        error: "Bad Request",
        message: `Service '${service}' does not support connectivity validation. Validatable services: ${VALIDATABLE_SERVICE_NAMES.join(", ")}`,
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

    // Perform validation with timeout protection
    const startTime = Date.now();
    const validationResult = await raceWithTimeout(
      validator(settings),
      30000,
      "Validation timeout",
    );

    const responseTime = Date.now() - startTime;

    // Store validation results in ConnectivityStatus database
    await prisma.connectivityStatus.create({
      data: {
        service,
        status: (validationResult.isValid
          ? "connected"
          : "failed") satisfies ConnectivityStatusType,
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
          status: "error" satisfies ConnectivityStatusType,
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
