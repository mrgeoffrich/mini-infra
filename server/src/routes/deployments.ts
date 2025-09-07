import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { servicesLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey } from "../lib/api-key-middleware";
import { getAuthenticatedUser } from "../lib/auth-middleware";
import { DeploymentConfigService } from "../services/deployment-config";
import { DeploymentOrchestrator } from "../services/deployment-orchestrator";
import prisma from "../lib/prisma";
import {
  CreateDeploymentConfigRequest,
  UpdateDeploymentConfigRequest,
  TriggerDeploymentRequest,
  DeploymentConfigResponse,
  DeploymentConfigListResponse,
  DeploymentResponse,
  DeploymentListResponse,
  DeploymentConfigurationInfo,
  DeploymentInfo,
  DeploymentFilter,
  DeploymentConfigFilter,
  DeploymentConfigSortOptions,
} from "@mini-infra/types";

const logger = servicesLogger();
const router = express.Router();

// Initialize services
const deploymentConfigService = new DeploymentConfigService(prisma, process.env.ENCRYPTION_KEY);
const deploymentOrchestrator = new DeploymentOrchestrator();

// ====================
// Validation Schemas
// ====================

const createConfigSchema = z.object({
  applicationName: z
    .string()
    .min(1, "Application name is required")
    .max(100, "Application name must be 100 characters or less")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Application name can only contain letters, numbers, hyphens, and underscores",
    ),
  dockerImage: z.string().min(1, "Docker image is required"),
  dockerRegistry: z.string().optional(),
  containerConfig: z.object({
    ports: z.array(
      z.object({
        containerPort: z.number().int().min(1).max(65535),
        hostPort: z.number().int().min(1).max(65535).optional(),
        protocol: z.enum(["tcp", "udp"]).optional(),
      }),
    ),
    volumes: z.array(
      z.object({
        hostPath: z.string().min(1),
        containerPath: z.string().min(1),
        mode: z.enum(["rw", "ro"]).optional(),
      }),
    ),
    environment: z.array(
      z.object({
        name: z.string().min(1),
        value: z.string(),
      }),
    ),
    labels: z.record(z.string(), z.string()),
    networks: z.array(z.string()),
  }),
  healthCheckConfig: z.object({
    endpoint: z.string().min(1),
    method: z.enum(["GET", "POST"]),
    expectedStatus: z.array(z.number().int().min(100).max(599)),
    responseValidation: z.string().optional(),
    timeout: z.number().int().min(1000),
    retries: z.number().int().min(1),
    interval: z.number().int().min(1000),
  }),
  traefikConfig: z.object({
    routerName: z.string().min(1),
    serviceName: z.string().min(1),
    rule: z.string().min(1),
    middlewares: z.array(z.string()).optional(),
    tls: z.boolean().optional(),
  }),
  rollbackConfig: z.object({
    enabled: z.boolean(),
    maxWaitTime: z.number().int().min(1000),
    keepOldContainer: z.boolean(),
  }),
});

const updateConfigSchema = createConfigSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const triggerDeploymentSchema = z.object({
  applicationName: z.string().min(1, "Application name is required"),
  tag: z.string().optional(),
  force: z.boolean().optional().default(false),
});

const deploymentQuerySchema = z.object({
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
      if (isNaN(parsed) || parsed < 1 || parsed > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Limit must be between 1 and 100",
        });
        return z.NEVER;
      }
      return parsed;
    }),
  applicationName: z.string().optional(),
  dockerImage: z.string().optional(),
  isActive: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return undefined;
      return val.toLowerCase() === "true";
    }),
});

// ====================
// Helper Functions
// ====================

function serializeDeploymentConfig(
  config: DeploymentConfigurationInfo,
): DeploymentConfigurationInfo {
  return {
    ...config,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

function serializeDeployment(deployment: any): DeploymentInfo {
  return {
    ...deployment,
    startedAt: deployment.startedAt.toISOString(),
    completedAt: deployment.completedAt?.toISOString() || null,
  };
}

// ====================
// Deployment Configuration Routes
// ====================

/**
 * GET /api/deployments/configs
 * List deployment configurations for authenticated user
 */
router.get(
  "/configs",
  requireSessionOrApiKey as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      // Validate query parameters
      const queryResult = deploymentQuerySchema.safeParse(req.query);
      if (!queryResult.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid query parameters",
          errors: queryResult.error.issues.map((e) => ({
            field: e.path.join("."),
            message: e.message,
          })),
        });
      }

      const { page, limit, applicationName, dockerImage, isActive } =
        queryResult.data;

      // Build filter
      const filter: DeploymentConfigFilter = {};
      if (applicationName) filter.applicationName = applicationName;
      if (dockerImage) filter.dockerImage = dockerImage;
      if (isActive !== undefined) filter.isActive = isActive;

      // Calculate pagination
      const offset = (page - 1) * limit;

      // Get configurations
      const configs = await deploymentConfigService.listDeploymentConfigs(
        user.id,
        filter,
        { field: "createdAt", order: "desc" },
        limit,
        offset,
      );

      // Get total count for pagination
      const totalCount = await prisma.deploymentConfiguration.count({
        where: {
          userId: user.id,
          ...(applicationName && {
            applicationName: { contains: applicationName },
          }),
          ...(dockerImage && {
            dockerImage: { contains: dockerImage },
          }),
          ...(isActive !== undefined && { isActive }),
        },
      });

      const response: DeploymentConfigListResponse = {
        success: true,
        data: configs.map(serializeDeploymentConfig),
        pagination: {
          page,
          limit,
          totalCount,
          hasMore: offset + configs.length < totalCount,
        },
      };

      res.json(response);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to list deployment configurations",
      );
      next(error);
    }
  }) as RequestHandler,
);

/**
 * POST /api/deployments/configs
 * Create a new deployment configuration
 */
router.post(
  "/configs",
  requireSessionOrApiKey as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      // Validate request body
      const parseResult = createConfigSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid configuration data",
          errors: parseResult.error.issues.map((e) => ({
            field: e.path.join("."),
            message: e.message,
          })),
        });
      }

      const configData: CreateDeploymentConfigRequest = {
        ...parseResult.data,
        containerConfig: {
          ...parseResult.data.containerConfig,
          labels: parseResult.data.containerConfig.labels as Record<string, string>,
        },
      };

      // Create configuration
      const config = await deploymentConfigService.createDeploymentConfig(
        configData,
        user.id,
      );

      const response: DeploymentConfigResponse = {
        success: true,
        data: serializeDeploymentConfig(config),
        message: "Deployment configuration created successfully",
      };

      res.status(201).json(response);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to create deployment configuration",
      );

      if (error instanceof Error && error.message.includes("already exists")) {
        return res.status(409).json({
          success: false,
          message: error.message,
        });
      }

      next(error);
    }
  }) as RequestHandler,
);

/**
 * GET /api/deployments/configs/:id
 * Get a specific deployment configuration
 */
router.get(
  "/configs/:id",
  requireSessionOrApiKey as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      const { id } = req.params;

      const config = await deploymentConfigService.getDeploymentConfig(
        id,
        user.id,
      );

      if (!config) {
        return res.status(404).json({
          success: false,
          message: "Deployment configuration not found",
        });
      }

      const response: DeploymentConfigResponse = {
        success: true,
        data: serializeDeploymentConfig(config),
      };

      res.json(response);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to get deployment configuration",
      );
      next(error);
    }
  }) as RequestHandler,
);

/**
 * PUT /api/deployments/configs/:id
 * Update a deployment configuration
 */
router.put(
  "/configs/:id",
  requireSessionOrApiKey as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      const { id } = req.params;

      // Validate request body
      const parseResult = updateConfigSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid configuration data",
          errors: parseResult.error.issues.map((e) => ({
            field: e.path.join("."),
            message: e.message,
          })),
        });
      }

      const updateData: UpdateDeploymentConfigRequest = parseResult.data as UpdateDeploymentConfigRequest;

      const config = await deploymentConfigService.updateDeploymentConfig(
        id,
        updateData,
        user.id,
      );

      const response: DeploymentConfigResponse = {
        success: true,
        data: serializeDeploymentConfig(config),
        message: "Deployment configuration updated successfully",
      };

      res.json(response);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to update deployment configuration",
      );

      if (error instanceof Error && error.message.includes("not found")) {
        return res.status(404).json({
          success: false,
          message: error.message,
        });
      }

      if (error instanceof Error && error.message.includes("already exists")) {
        return res.status(409).json({
          success: false,
          message: error.message,
        });
      }

      next(error);
    }
  }) as RequestHandler,
);

/**
 * DELETE /api/deployments/configs/:id
 * Delete a deployment configuration
 */
router.delete(
  "/configs/:id",
  requireSessionOrApiKey as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      const { id } = req.params;

      await deploymentConfigService.deleteDeploymentConfig(id, user.id);

      res.json({
        success: true,
        message: "Deployment configuration deleted successfully",
      });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to delete deployment configuration",
      );

      if (error instanceof Error && error.message.includes("not found")) {
        return res.status(404).json({
          success: false,
          message: error.message,
        });
      }

      next(error);
    }
  }) as RequestHandler,
);

// ====================
// Deployment Operations Routes
// ====================

/**
 * POST /api/deployments/trigger
 * Trigger a new deployment
 */
router.post(
  "/trigger",
  requireSessionOrApiKey as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      // Validate request body
      const parseResult = triggerDeploymentSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid deployment trigger data",
          errors: parseResult.error.issues.map((e) => ({
            field: e.path.join("."),
            message: e.message,
          })),
        });
      }

      const { applicationName, tag, force } = parseResult.data;

      // Get deployment configuration
      const config = await deploymentConfigService.getDeploymentConfigByName(
        applicationName,
        user.id,
      );

      if (!config) {
        return res.status(404).json({
          success: false,
          message: `Deployment configuration for application '${applicationName}' not found`,
        });
      }

      if (!config.isActive) {
        return res.status(400).json({
          success: false,
          message: `Deployment configuration for application '${applicationName}' is not active`,
        });
      }

      // Determine Docker image with tag
      const dockerImage = tag
        ? `${config.dockerImage}:${tag}`
        : config.dockerImage;

      // Trigger deployment
      const deployment = await deploymentOrchestrator.triggerDeployment({
        configurationId: config.id,
        triggerType: "manual",
        triggeredBy: user.id,
        dockerImage,
        force,
      });

      const response: DeploymentResponse = {
        success: true,
        data: serializeDeployment(deployment),
        message: "Deployment triggered successfully",
      };

      res.status(202).json(response);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to trigger deployment",
      );
      next(error);
    }
  }) as RequestHandler,
);

/**
 * GET /api/deployments/:id/status
 * Get deployment status
 */
router.get(
  "/:id/status",
  requireSessionOrApiKey as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      const { id } = req.params;

      // Get deployment with steps
      const deployment = await prisma.deployment.findFirst({
        where: {
          id,
          configuration: {
            userId: user.id,
          },
        },
        include: {
          deploymentSteps: {
            orderBy: { startedAt: "asc" },
          },
        },
      });

      if (!deployment) {
        return res.status(404).json({
          success: false,
          message: "Deployment not found",
        });
      }

      // Calculate progress
      const totalSteps = deployment.deploymentSteps.length;
      const completedSteps = deployment.deploymentSteps.filter(
        (step) => step.status === "completed",
      ).length;
      const progress = totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0;

      // Serialize steps
      const steps = deployment.deploymentSteps.map((step) => ({
        id: step.id,
        deploymentId: step.deploymentId,
        stepName: step.stepName,
        status: step.status,
        startedAt: step.startedAt.toISOString(),
        completedAt: step.completedAt?.toISOString() || null,
        duration: step.duration,
        output: step.output,
        errorMessage: step.errorMessage,
      }));

      // Get recent logs (last 50 lines)
      const logs = deployment.deploymentSteps
        .filter((step) => step.output)
        .slice(-50)
        .map((step) => `[${step.stepName}] ${step.output}`)
        .filter(Boolean);

      res.json({
        success: true,
        data: {
          ...serializeDeployment(deployment),
          progress: Math.round(progress),
          steps,
          logs,
        },
      });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to get deployment status",
      );
      next(error);
    }
  }) as RequestHandler,
);

/**
 * POST /api/deployments/:id/rollback
 * Rollback a deployment
 */
router.post(
  "/:id/rollback",
  requireSessionOrApiKey as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      const { id } = req.params;

      // Verify deployment exists and belongs to user
      const deployment = await prisma.deployment.findFirst({
        where: {
          id,
          configuration: {
            userId: user.id,
          },
        },
        include: {
          configuration: true,
        },
      });

      if (!deployment) {
        return res.status(404).json({
          success: false,
          message: "Deployment not found",
        });
      }

      // Check if rollback is possible
      if (
        !["completed", "failed", "health_checking"].includes(deployment.status)
      ) {
        return res.status(400).json({
          success: false,
          message: "Deployment cannot be rolled back in its current state",
        });
      }

      // Trigger rollback
      const rolledBackDeployment =
        await deploymentOrchestrator.rollbackDeployment(id);

      const response: DeploymentResponse = {
        success: true,
        data: serializeDeployment(rolledBackDeployment),
        message: "Deployment rollback initiated successfully",
      };

      res.json(response);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to rollback deployment",
      );
      next(error);
    }
  }) as RequestHandler,
);

/**
 * GET /api/deployments/history
 * Get deployment history
 */
router.get(
  "/history",
  requireSessionOrApiKey as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      // Validate query parameters
      const queryResult = deploymentQuerySchema.safeParse(req.query);
      if (!queryResult.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid query parameters",
          errors: queryResult.error.issues.map((e) => ({
            field: e.path.join("."),
            message: e.message,
          })),
        });
      }

      const { page, limit } = queryResult.data;

      // Calculate pagination
      const offset = (page - 1) * limit;

      // Get deployments with configuration info
      const deployments = await prisma.deployment.findMany({
        where: {
          configuration: {
            userId: user.id,
          },
        },
        include: {
          configuration: {
            select: {
              applicationName: true,
              dockerImage: true,
            },
          },
        },
        orderBy: { startedAt: "desc" },
        take: limit,
        skip: offset,
      });

      // Get total count
      const totalCount = await prisma.deployment.count({
        where: {
          configuration: {
            userId: user.id,
          },
        },
      });

      // Serialize deployments
      const serializedDeployments = deployments.map((deployment) => ({
        ...serializeDeployment(deployment),
        applicationName: deployment.configuration.applicationName,
      }));

      const response: DeploymentListResponse = {
        success: true,
        data: serializedDeployments,
        pagination: {
          page,
          limit,
          totalCount,
          hasMore: offset + deployments.length < totalCount,
        },
      };

      res.json(response);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to get deployment history",
      );
      next(error);
    }
  }) as RequestHandler,
);

export default router;
