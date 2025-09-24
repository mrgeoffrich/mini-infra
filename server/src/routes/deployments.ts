import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey, getAuthenticatedUser } from "../middleware/auth";
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
  HostnameValidationRequest,
  HostnameValidationResponse,
  UninstallDeploymentConfigResponse,
} from "@mini-infra/types";

const logger = appLogger();
const router = express.Router();

// Initialize services
const deploymentConfigService = new DeploymentConfigService(prisma, process.env.ENCRYPTION_KEY);
const deploymentOrchestrator = new DeploymentOrchestrator();
// Initialize the deployment orchestrator
deploymentOrchestrator.initialize().catch(error => {
  logger.error({ error: error.message }, "Failed to initialize deployment orchestrator");
});

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
  rollbackConfig: z.object({
    enabled: z.boolean(),
    maxWaitTime: z.number().int().min(1000),
    keepOldContainer: z.boolean(),
  }),
  listeningPort: z.number().int().min(1).max(65535).optional(),
  environmentId: z.string().min(1, "Environment ID is required"),
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
  environmentId: z.string().optional(),
  isActive: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return undefined;
      return val.toLowerCase() === "true";
    }),
});

const hostnameValidationSchema = z.object({
  hostname: z
    .string()
    .min(1, "Hostname is required")
    .max(253, "Hostname must be 253 characters or less")
    .regex(
      /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/,
      "Hostname must be a valid domain name (e.g., example.com, api.example.com)"
    ),
  excludeConfigId: z.string().uuid().optional(),
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
 * @swagger
 * /api/deployments/configs:
 *   get:
 *     summary: List deployment configurations
 *     description: Retrieve a paginated list of all deployment configurations in the system with optional filtering
 *     tags:
 *       - Deployment Configurations
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - $ref: '#/components/parameters/PaginationPage'
 *       - $ref: '#/components/parameters/PaginationLimit'
 *       - name: applicationName
 *         in: query
 *         description: Filter by application name (partial match)
 *         required: false
 *         schema:
 *           type: string
 *         example: 'my-app'
 *       - name: dockerImage
 *         in: query
 *         description: Filter by Docker image name (partial match)
 *         required: false
 *         schema:
 *           type: string
 *         example: 'nginx'
 *       - name: environmentId
 *         in: query
 *         description: Filter by environment ID
 *         required: false
 *         schema:
 *           type: string
 *           format: uuid
 *         example: 'env123'
 *       - name: isActive
 *         in: query
 *         description: Filter by active status
 *         required: false
 *         schema:
 *           type: boolean
 *         example: true
 *     responses:
 *       200:
 *         description: Deployment configurations retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/DeploymentConfigurationInfo'
 *                 pagination:
 *                   $ref: '#/components/schemas/PaginationInfo'
 *               required:
 *                 - success
 *                 - data
 *                 - pagination
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationError'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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

      const { page, limit, applicationName, dockerImage, environmentId, isActive } =
        queryResult.data;

      // Build filter
      const filter: DeploymentConfigFilter = {};
      if (applicationName) filter.applicationName = applicationName;
      if (dockerImage) filter.dockerImage = dockerImage;
      if (environmentId) filter.environmentId = environmentId;
      if (isActive !== undefined) filter.isActive = isActive;

      // Calculate pagination
      const offset = (page - 1) * limit;

      // Get configurations
      const configs = await deploymentConfigService.listDeploymentConfigs(
        filter,
        { field: "createdAt", order: "desc" },
        limit,
        offset,
      );

      // Get total count for pagination
      const totalCount = await prisma.deploymentConfiguration.count({
        where: {
          ...(applicationName && {
            applicationName: { contains: applicationName },
          }),
          ...(dockerImage && {
            dockerImage: { contains: dockerImage },
          }),
          ...(environmentId && { environmentId }),
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
 * @swagger
 * /api/deployments/configs:
 *   post:
 *     summary: Create deployment configuration
 *     description: Create a new deployment configuration with Docker container settings, health checks, and rollback configuration
 *     tags:
 *       - Deployment Configurations
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateDeploymentConfigRequest'
 *           example:
 *             applicationName: 'my-web-app'
 *             dockerImage: 'nginx:latest'
 *             dockerRegistry: 'docker.io'
 *             containerConfig:
 *               ports:
 *                 - containerPort: 80
 *                   hostPort: 8080
 *                   protocol: 'tcp'
 *               volumes:
 *                 - hostPath: '/host/data'
 *                   containerPath: '/app/data'
 *                   mode: 'rw'
 *               environment:
 *                 - name: 'NODE_ENV'
 *                   value: 'production'
 *               labels:
 *                 app: 'my-web-app'
 *                 version: 'v1.0'
 *               networks:
 *                 - 'bridge'
 *             healthCheckConfig:
 *               endpoint: '/health'
 *               method: 'GET'
 *               expectedStatus: [200]
 *               timeout: 5000
 *               retries: 3
 *               interval: 10000
 *             rollbackConfig:
 *               enabled: true
 *               maxWaitTime: 30000
 *               keepOldContainer: false
 *             listeningPort: 8080
 *             environmentId: 'prod-env-123'
 *     responses:
 *       201:
 *         description: Deployment configuration created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/DeploymentConfigurationInfo'
 *                 message:
 *                   type: string
 *                   example: 'Deployment configuration created successfully'
 *               required:
 *                 - success
 *                 - data
 *                 - message
 *       400:
 *         description: Invalid configuration data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationError'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Configuration already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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
 * @swagger
 * /api/deployments/configs/{id}:
 *   get:
 *     summary: Get deployment configuration
 *     description: Retrieve a specific deployment configuration by its unique identifier
 *     tags:
 *       - Deployment Configurations
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: id
 *         in: path
 *         description: Deployment configuration unique identifier
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         example: 'config-123'
 *     responses:
 *       200:
 *         description: Deployment configuration retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/DeploymentConfigurationInfo'
 *               required:
 *                 - success
 *                 - data
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Deployment configuration not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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
 * @swagger
 * /api/deployments/configs/{id}:
 *   put:
 *     summary: Update deployment configuration
 *     description: Update an existing deployment configuration. All fields are optional and will only update the provided values.
 *     tags:
 *       - Deployment Configurations
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: id
 *         in: path
 *         description: Deployment configuration unique identifier
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         example: 'config-123'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateDeploymentConfigRequest'
 *           example:
 *             dockerImage: 'nginx:1.21'
 *             isActive: false
 *             containerConfig:
 *               environment:
 *                 - name: 'NODE_ENV'
 *                   value: 'staging'
 *     responses:
 *       200:
 *         description: Deployment configuration updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/DeploymentConfigurationInfo'
 *                 message:
 *                   type: string
 *                   example: 'Deployment configuration updated successfully'
 *               required:
 *                 - success
 *                 - data
 *                 - message
 *       400:
 *         description: Invalid configuration data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationError'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Deployment configuration not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Configuration name already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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
 * @swagger
 * /api/deployments/configs/{id}/uninstall:
 *   delete:
 *     summary: Uninstall deployment configuration
 *     description: Initiate the uninstallation of a deployment configuration using the removal state machine. This removes the application from the load balancer, stops containers, and cleans up resources.
 *     tags:
 *       - Deployment Configurations
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: id
 *         in: path
 *         description: Deployment configuration unique identifier
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         example: 'config-123'
 *     responses:
 *       202:
 *         description: Deployment configuration uninstall initiated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: 'Deployment configuration uninstall initiated'
 *                 data:
 *                   type: object
 *                   properties:
 *                     removalId:
 *                       type: string
 *                       description: Unique identifier for tracking the removal operation
 *                       example: 'removal-456'
 *                     status:
 *                       type: string
 *                       description: Current status of the removal operation
 *                       example: 'in_progress'
 *                   required:
 *                     - removalId
 *                     - status
 *               required:
 *                 - success
 *                 - message
 *                 - data
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Deployment configuration not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.delete(
  "/configs/:id/uninstall",
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

      const result = await deploymentConfigService.deleteDeploymentConfig(id, user.id);

      res.status(202).json({
        success: true,
        message: "Deployment configuration uninstall initiated",
        data: {
          removalId: result.removalId,
          status: "in_progress"
        },
      });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to uninstall deployment configuration",
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
 * @swagger
 * /api/deployments/trigger:
 *   post:
 *     summary: Trigger new deployment
 *     description: Trigger a zero-downtime deployment for a configured application. Optionally specify a Docker image tag and force deployment even if no changes detected.
 *     tags:
 *       - Deployment Operations
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TriggerDeploymentRequest'
 *           example:
 *             applicationName: 'my-web-app'
 *             tag: 'v1.2.3'
 *             force: false
 *     responses:
 *       202:
 *         description: Deployment triggered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/DeploymentInfo'
 *                 message:
 *                   type: string
 *                   example: 'Deployment triggered successfully'
 *               required:
 *                 - success
 *                 - data
 *                 - message
 *       400:
 *         description: Invalid deployment data or configuration not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationError'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Deployment configuration not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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
        ? config.dockerImage.includes(':')
          ? `${config.dockerImage.split(':')[0]}:${tag}`
          : `${config.dockerImage}:${tag}`
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
 * @swagger
 * /api/deployments/{id}/status:
 *   get:
 *     summary: Get deployment status
 *     description: Retrieve detailed status information for a specific deployment including progress, steps, and recent logs
 *     tags:
 *       - Deployment Operations
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: id
 *         in: path
 *         description: Deployment unique identifier
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         example: 'deploy-123'
 *     responses:
 *       200:
 *         description: Deployment status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   allOf:
 *                     - $ref: '#/components/schemas/DeploymentInfo'
 *                     - type: object
 *                       properties:
 *                         progress:
 *                           type: integer
 *                           minimum: 0
 *                           maximum: 100
 *                           description: Deployment progress percentage
 *                           example: 75
 *                         steps:
 *                           type: array
 *                           description: List of deployment steps with their status
 *                           items:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: string
 *                                 example: 'step-123'
 *                               deploymentId:
 *                                 type: string
 *                                 example: 'deploy-123'
 *                               stepName:
 *                                 type: string
 *                                 example: 'pull-image'
 *                               status:
 *                                 type: string
 *                                 enum: ['pending', 'running', 'completed', 'failed']
 *                                 example: 'completed'
 *                               startedAt:
 *                                 type: string
 *                                 format: date-time
 *                                 example: '2025-09-24T12:00:00.000Z'
 *                               completedAt:
 *                                 type: string
 *                                 format: date-time
 *                                 nullable: true
 *                                 example: '2025-09-24T12:01:30.000Z'
 *                               duration:
 *                                 type: integer
 *                                 nullable: true
 *                                 description: Step duration in milliseconds
 *                                 example: 90000
 *                               output:
 *                                 type: string
 *                                 nullable: true
 *                                 description: Step execution output
 *                                 example: 'Image pulled successfully'
 *                               errorMessage:
 *                                 type: string
 *                                 nullable: true
 *                                 description: Error message if step failed
 *                         logs:
 *                           type: array
 *                           description: Recent deployment logs (last 50 lines)
 *                           items:
 *                             type: string
 *                           example:
 *                             - '[pull-image] Pulling docker image nginx:latest'
 *                             - '[start-container] Container started successfully'
 *               required:
 *                 - success
 *                 - data
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Deployment not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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
 * @swagger
 * /api/deployments/{id}/rollback:
 *   post:
 *     summary: Rollback deployment
 *     description: Rollback a deployment to the previous version. Only deployments in completed, failed, or health_checking states can be rolled back.
 *     tags:
 *       - Deployment Operations
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: id
 *         in: path
 *         description: Deployment unique identifier to rollback
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         example: 'deploy-123'
 *     responses:
 *       200:
 *         description: Deployment rollback initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/DeploymentInfo'
 *                 message:
 *                   type: string
 *                   example: 'Deployment rollback initiated successfully'
 *               required:
 *                 - success
 *                 - data
 *                 - message
 *       400:
 *         description: Deployment cannot be rolled back in its current state
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Deployment not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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

      // Verify deployment exists
      const deployment = await prisma.deployment.findFirst({
        where: {
          id,
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
 * @swagger
 * /api/deployments/history:
 *   get:
 *     summary: Get deployment history
 *     description: Retrieve a paginated list of all deployment executions with configuration information, ordered by most recent first
 *     tags:
 *       - Deployment Operations
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - $ref: '#/components/parameters/PaginationPage'
 *       - $ref: '#/components/parameters/PaginationLimit'
 *     responses:
 *       200:
 *         description: Deployment history retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     allOf:
 *                       - $ref: '#/components/schemas/DeploymentInfo'
 *                       - type: object
 *                         properties:
 *                           applicationName:
 *                             type: string
 *                             description: Name of the deployed application
 *                             example: 'my-web-app'
 *                 pagination:
 *                   $ref: '#/components/schemas/PaginationInfo'
 *               required:
 *                 - success
 *                 - data
 *                 - pagination
 *             example:
 *               success: true
 *               data:
 *                 - id: 'deploy-123'
 *                   configurationId: 'config-456'
 *                   status: 'completed'
 *                   triggerType: 'manual'
 *                   triggeredBy: 'user-789'
 *                   dockerImage: 'nginx:1.21'
 *                   startedAt: '2025-09-24T12:00:00.000Z'
 *                   completedAt: '2025-09-24T12:05:30.000Z'
 *                   rollbackDeploymentId: null
 *                   applicationName: 'my-web-app'
 *               pagination:
 *                 page: 1
 *                 limit: 20
 *                 totalCount: 45
 *                 hasMore: true
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationError'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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
      const totalCount = await prisma.deployment.count();

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

/**
 * @swagger
 * /api/deployments/configs/validate-hostname:
 *   post:
 *     summary: Validate hostname availability
 *     description: Check if a hostname is valid and available for use in a deployment configuration. Optionally exclude a specific configuration from the check (useful for updates).
 *     tags:
 *       - Deployment Configurations
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/HostnameValidationRequest'
 *           example:
 *             hostname: 'api.myapp.com'
 *             excludeConfigId: 'config-123'
 *     responses:
 *       200:
 *         description: Hostname validation completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/HostnameValidationResponse'
 *               required:
 *                 - success
 *                 - data
 *             example:
 *               success: true
 *               data:
 *                 hostname: 'api.myapp.com'
 *                 isValid: true
 *                 isAvailable: true
 *                 validationErrors: []
 *                 conflictingConfigId: null
 *       400:
 *         description: Invalid request data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationError'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post(
  "/configs/validate-hostname",
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
      const validationResult = hostnameValidationSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid request data",
          errors: validationResult.error.issues.map((e) => ({
            field: e.path.join("."),
            message: e.message,
          })),
        });
      }

      const { hostname, excludeConfigId } = validationResult.data;

      // Validate hostname
      const hostnameValidation = await deploymentConfigService.validateHostname(
        hostname,
        excludeConfigId
      );

      const response: HostnameValidationResponse = {
        success: true,
        data: hostnameValidation,
      };

      res.json(response);

      logger.info(
        {
          hostname,
          isValid: hostnameValidation.isValid,
          isAvailable: hostnameValidation.isAvailable,
          userId: user.id,
        },
        "Hostname validation completed"
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          hostname: req.body?.hostname,
        },
        "Failed to validate hostname"
      );
      next(error);
    }
  }) as RequestHandler,
);

/**
 * @swagger
 * /api/deployments/removal/{removalId}/status:
 *   get:
 *     summary: Get removal operation status
 *     description: Check the status of a deployment configuration removal operation initiated by the uninstall endpoint
 *     tags:
 *       - Deployment Operations
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: removalId
 *         in: path
 *         description: Unique identifier for the removal operation
 *         required: true
 *         schema:
 *           type: string
 *         example: 'removal-456'
 *     responses:
 *       200:
 *         description: Removal operation status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     removalId:
 *                       type: string
 *                       description: Unique identifier for the removal operation
 *                       example: 'removal-456'
 *                     isActive:
 *                       type: boolean
 *                       description: Whether the removal operation is currently active
 *                       example: true
 *                     currentState:
 *                       type: string
 *                       description: Current state of the removal state machine
 *                       enum: ['idle', 'removingFromLB', 'stoppingApplication', 'removingApplication', 'cleanup', 'completed', 'failed']
 *                       example: 'stoppingApplication'
 *                     progress:
 *                       type: integer
 *                       minimum: 0
 *                       maximum: 100
 *                       description: Removal operation progress percentage
 *                       example: 50
 *                     applicationName:
 *                       type: string
 *                       nullable: true
 *                       description: Name of the application being removed
 *                       example: 'my-web-app'
 *                     error:
 *                       type: string
 *                       nullable: true
 *                       description: Error message if removal failed
 *                     containersToRemove:
 *                       type: integer
 *                       description: Number of containers to be removed
 *                       example: 2
 *                     lbRemovalComplete:
 *                       type: boolean
 *                       description: Whether load balancer removal is complete
 *                       example: true
 *                     applicationStopped:
 *                       type: boolean
 *                       description: Whether the application has been stopped
 *                       example: false
 *                     applicationRemoved:
 *                       type: boolean
 *                       description: Whether the application has been removed
 *                       example: false
 *                   required:
 *                     - removalId
 *                     - isActive
 *                     - progress
 *                     - containersToRemove
 *                     - lbRemovalComplete
 *                     - applicationStopped
 *                     - applicationRemoved
 *               required:
 *                 - success
 *                 - data
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Removal operation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get(
  "/removal/:removalId/status",
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

      const { removalId } = req.params;

      // Get removal operation status from orchestrator
      const status = deploymentOrchestrator.getRemovalOperationStatus(removalId);

      if (!status.isActive && !status.currentState) {
        return res.status(404).json({
          success: false,
          message: "Removal operation not found",
        });
      }

      // Calculate progress based on current state
      let progress = 0;
      const stateProgressMap: Record<string, number> = {
        'idle': 0,
        'removingFromLB': 25,
        'stoppingApplication': 50,
        'removingApplication': 75,
        'cleanup': 90,
        'completed': 100,
        'failed': 0,
      };

      if (status.currentState && stateProgressMap[status.currentState] !== undefined) {
        progress = stateProgressMap[status.currentState];
      }

      res.json({
        success: true,
        data: {
          removalId,
          isActive: status.isActive,
          currentState: status.currentState,
          progress,
          applicationName: status.context?.applicationName,
          error: status.context?.error,
          containersToRemove: status.context?.containersToRemove?.length || 0,
          lbRemovalComplete: status.context?.lbRemovalComplete || false,
          applicationStopped: status.context?.applicationStopped || false,
          applicationRemoved: status.context?.applicationRemoved || false,
        },
      });

      logger.info(
        {
          removalId,
          userId: user.id,
          isActive: status.isActive,
          currentState: status.currentState,
        },
        "Removal operation status checked"
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          removalId: req.params?.removalId,
        },
        "Failed to get removal operation status"
      );
      next(error);
    }
  }) as RequestHandler,
);

export default router;
