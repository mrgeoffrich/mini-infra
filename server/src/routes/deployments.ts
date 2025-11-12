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
import DockerService from "../services/docker";
import prisma from "../lib/prisma";
import { CertificateProvisioningService } from "../services/tls/certificate-provisioning-service";
import { CertificateLifecycleManager } from "../services/tls/certificate-lifecycle-manager";
import { TlsConfigService } from "../services/tls/tls-config";
import { AzureStorageCertificateStore } from "../services/tls/azure-storage-certificate-store";
import { AcmeClientManager } from "../services/tls/acme-client-manager";
import { DnsChallenge01Provider } from "../services/tls/dns-challenge-provider";
import { CloudflareConfigService } from "../services/cloudflare-config";
import { AzureConfigService } from "../services/azure-config";
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

/**
 * Helper to initialize certificate provisioning service
 */
async function initializeCertificateProvisioningService(): Promise<CertificateProvisioningService | null> {
  try {
    // Initialize config services
    const tlsConfig = new TlsConfigService(prisma);
    const azureConfig = new AzureConfigService(prisma);

    // Get certificate container name
    const containerName = await tlsConfig.get("certificate_blob_container");
    if (!containerName) {
      logger.warn("Certificate blob container not configured - SSL certificate provisioning will be disabled");
      return null;
    }

    // Get Azure Storage connection string
    const connectionString = await azureConfig.getConnectionString();
    if (!connectionString) {
      logger.warn("Azure Storage not configured - SSL certificate provisioning will be disabled");
      return null;
    }

    // Initialize services
    const certificateStore = new AzureStorageCertificateStore(connectionString, containerName);
    const acmeClient = new AcmeClientManager(tlsConfig, certificateStore);
    const cloudflareConfig = new CloudflareConfigService(prisma);
    const dnsChallenge = new DnsChallenge01Provider(cloudflareConfig);

    // Initialize ACME client
    await acmeClient.initialize();

    const lifecycleManager = new CertificateLifecycleManager(
      acmeClient,
      certificateStore,
      dnsChallenge,
      prisma,
      containerName
    );

    return new CertificateProvisioningService(lifecycleManager, prisma);
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to initialize certificate provisioning service - SSL certificate provisioning will be disabled"
    );
    return null;
  }
}

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
  hostname: z
    .string()
    .min(1, "Hostname cannot be empty")
    .max(253, "Hostname must be 253 characters or less")
    .regex(
      /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/,
      "Hostname must be a valid domain name (e.g., example.com, api.example.com)",
    )
    .optional(),
  environmentId: z.string().min(1, "Environment ID is required"),
  enableSsl: z.boolean().optional().default(false),
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

      // Handle SSL certificate provisioning if enabled
      if (parseResult.data.enableSsl && parseResult.data.hostname) {
        logger.info(
          { deploymentConfigId: config.id, hostname: parseResult.data.hostname },
          "SSL enabled - provisioning certificate"
        );

        try {
          const provisioningService = await initializeCertificateProvisioningService();

          if (provisioningService) {
            // Provision certificate asynchronously (don't wait for completion)
            provisioningService.provisionCertificateForDeployment({
              deploymentConfigId: config.id,
              hostname: parseResult.data.hostname,
              userId: user.id,
            }).catch((error) => {
              logger.error(
                { deploymentConfigId: config.id, error: error.message },
                "Failed to provision certificate after deployment config creation"
              );
            });
          } else {
            logger.warn(
              { deploymentConfigId: config.id },
              "Certificate provisioning service not available - SSL will not be configured"
            );
          }
        } catch (error) {
          logger.warn(
            { deploymentConfigId: config.id, error: error instanceof Error ? error.message : String(error) },
            "Failed to initialize certificate provisioning - SSL will not be configured"
          );
        }
      }

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

      // Get deployment configuration
      const config = await deploymentConfigService.getDeploymentConfig(id);

      if (!config) {
        return res.status(404).json({
          success: false,
          message: "Deployment configuration not found",
        });
      }

      // Check if there are any running containers (check actual Docker, not just DB records)
      const latestDeployment = await prisma.deployment.findFirst({
        where: {
          configurationId: id,
          status: "completed",
        },
        orderBy: {
          startedAt: "desc",
        },
        include: {
          containers: true,
        },
      });

      // Verify actual container status in Docker
      if (latestDeployment?.containers && latestDeployment.containers.length > 0) {
        const dockerService = DockerService.getInstance();
        const runningContainers = [];

        for (const container of latestDeployment.containers) {
          try {
            const containerInfo = await dockerService.getContainer(container.containerId);
            if (containerInfo && containerInfo.status === "running") {
              runningContainers.push(container.containerName);
            }
          } catch (error) {
            // Container doesn't exist in Docker, skip it
            logger.debug(
              { containerId: container.containerId, error: error instanceof Error ? error.message : String(error) },
              "Container not found in Docker (likely already removed)"
            );
          }
        }

        if (runningContainers.length > 0) {
          return res.status(400).json({
            success: false,
            message: `Cannot delete configuration while containers are still running: ${runningContainers.join(", ")}. Please remove the deployment first.`,
          });
        }
      }

      // Check for HAProxy frontend
      const frontend = await prisma.hAProxyFrontend.findUnique({
        where: { deploymentConfigId: id },
      });

      if (frontend && frontend.status === "active") {
        return res.status(400).json({
          success: false,
          message: "Cannot delete configuration while HAProxy frontend is active. Please remove the deployment first.",
        });
      }

      // Delete the configuration (will cascade delete related records)
      await prisma.deploymentConfiguration.delete({
        where: { id },
      });

      res.json({
        success: true,
        message: "Deployment configuration deleted successfully",
      });

      logger.info(
        {
          configId: id,
          userId: user.id,
          applicationName: config.applicationName,
        },
        "Deployment configuration deleted"
      );
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

      // Get deployment with steps and containers
      const deployment = await prisma.deployment.findFirst({
        where: {
          id,
        },
        include: {
          deploymentSteps: {
            orderBy: { startedAt: "asc" },
          },
          containers: {
            orderBy: { capturedAt: "asc" },
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

      // Serialize containers
      const containers = deployment.containers.map((container) => ({
        id: container.id,
        deploymentId: container.deploymentId,
        containerId: container.containerId,
        containerName: container.containerName,
        containerRole: container.containerRole,
        dockerImage: container.dockerImage,
        imageId: container.imageId,
        containerConfig: container.containerConfig,
        status: container.status,
        ipAddress: container.ipAddress,
        createdAt: container.createdAt.toISOString(),
        startedAt: container.startedAt?.toISOString() || null,
        capturedAt: container.capturedAt.toISOString(),
      }));

      res.json({
        success: true,
        data: {
          ...serializeDeployment(deployment),
          progress: Math.round(progress),
          steps,
          logs,
          containers,
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

      // Get deployments with configuration info and containers
      const deployments = await prisma.deployment.findMany({
        include: {
          configuration: {
            select: {
              applicationName: true,
              dockerImage: true,
            },
          },
          containers: {
            orderBy: { capturedAt: "asc" },
          },
        },
        orderBy: { startedAt: "desc" },
        take: limit,
        skip: offset,
      });

      // Get total count
      const totalCount = await prisma.deployment.count();

      // Serialize deployments with containers
      const serializedDeployments = deployments.map((deployment) => ({
        ...serializeDeployment(deployment),
        applicationName: deployment.configuration.applicationName,
        containers: deployment.containers.map((container) => ({
          id: container.id,
          deploymentId: container.deploymentId,
          containerId: container.containerId,
          containerName: container.containerName,
          containerRole: container.containerRole,
          dockerImage: container.dockerImage,
          imageId: container.imageId,
          containerConfig: container.containerConfig,
          status: container.status,
          ipAddress: container.ipAddress,
          createdAt: container.createdAt.toISOString(),
          startedAt: container.startedAt?.toISOString() || null,
          capturedAt: container.capturedAt.toISOString(),
        })),
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


router.get(
  "/:id/containers",
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

      // Get deployment with containers
      const deployment = await prisma.deployment.findFirst({
        where: {
          id,
        },
        include: {
          containers: {
            orderBy: { capturedAt: "asc" },
          },
        },
      });

      if (!deployment) {
        return res.status(404).json({
          success: false,
          message: "Deployment not found",
        });
      }

      // Serialize containers
      const containers = deployment.containers.map((container) => ({
        id: container.id,
        deploymentId: container.deploymentId,
        containerId: container.containerId,
        containerName: container.containerName,
        containerRole: container.containerRole,
        dockerImage: container.dockerImage,
        imageId: container.imageId,
        containerConfig: container.containerConfig,
        status: container.status,
        ipAddress: container.ipAddress,
        createdAt: container.createdAt.toISOString(),
        startedAt: container.startedAt?.toISOString() || null,
        capturedAt: container.capturedAt.toISOString(),
      }));

      res.json({
        success: true,
        data: containers,
      });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to get deployment containers",
      );
      next(error);
    }
  }) as RequestHandler,
);


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


router.delete(
  "/configs/:id/remove-containers",
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

      // Get deployment configuration
      const config = await deploymentConfigService.getDeploymentConfig(id);

      if (!config) {
        return res.status(404).json({
          success: false,
          message: "Deployment configuration not found",
        });
      }

      // Get the latest deployment for this configuration
      const latestDeployment = await prisma.deployment.findFirst({
        where: {
          configurationId: id,
          status: "completed",
        },
        orderBy: {
          startedAt: "desc",
        },
        include: {
          containers: true,
        },
      });

      if (!latestDeployment || !latestDeployment.containers.length) {
        return res.status(404).json({
          success: false,
          message: "No deployed containers found for this configuration",
        });
      }

      // Trigger container removal through the orchestrator
      const result = await deploymentConfigService.deleteDeploymentConfig(id, user.id);

      res.status(202).json({
        success: true,
        message: "Container removal initiated",
        data: {
          removalId: result.removalId,
          status: "in_progress",
          containersToRemove: latestDeployment.containers.length,
        },
      });

      logger.info(
        {
          configId: id,
          userId: user.id,
          removalId: result.removalId,
          containersCount: latestDeployment.containers.length,
        },
        "Container removal initiated"
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          configId: req.params?.id,
        },
        "Failed to remove containers"
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

export default router;
