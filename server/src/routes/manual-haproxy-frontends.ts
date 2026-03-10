import express, { Request, Response, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import prisma from "../lib/prisma";
import { manualFrontendManager } from "../services/haproxy/manual-frontend-manager";
import { ManualFrontendSetupService } from "../services/haproxy/manual-frontend-setup-service";
import { HAProxyDataPlaneClient } from "../services/haproxy/haproxy-dataplane-client";
import DockerService from "../services/docker";
import { emitToChannel } from "../lib/socket";
import { TlsConfigService } from "../services/tls/tls-config";
import { AzureStorageCertificateStore } from "../services/tls/azure-storage-certificate-store";
import { AcmeClientManager } from "../services/tls/acme-client-manager";
import { DnsChallenge01Provider } from "../services/tls/dns-challenge-provider";
import { CertificateLifecycleManager } from "../services/tls/certificate-lifecycle-manager";
import { CertificateDistributor } from "../services/tls/certificate-distributor";
import { CertificateProvisioningService } from "../services/tls/certificate-provisioning-service";
import { CloudflareService } from "../services/cloudflare";
import { AzureStorageService } from "../services/azure-storage-service";
import { HAProxyService } from "../services/haproxy/haproxy-service";
import { DockerExecutorService } from "../services/docker-executor";
import {
  EligibleContainersResponse,
  CreateManualFrontendRequest,
  UpdateManualFrontendRequest,
  ManualFrontendResponse,
  DeleteManualFrontendResponse,
  HAProxyFrontendInfo,
  Channel,
  ServerEvent,
} from "@mini-infra/types";

const logger = appLogger();
const router = express.Router();

// ====================
// Validation Schemas
// ====================

const createManualFrontendSchema = z.object({
  environmentId: z.string().cuid(),
  containerId: z.string().min(1),
  containerName: z.string().min(1),
  containerPort: z.number().int().min(1).max(65535),
  hostname: z.string().min(1).regex(/^[a-z0-9.-]+$/i, "Invalid hostname format"),
  enableSsl: z.boolean().optional(),
  healthCheckPath: z.string().optional(),
  needsNetworkJoin: z.boolean().optional(),
});

// Concurrency guard — one setup per environment at a time
const settingUpFrontends = new Set<string>();

/**
 * Initialize all TLS services needed for the manual frontend setup
 */
async function buildSetupService(): Promise<ManualFrontendSetupService> {
  const tlsConfig = new TlsConfigService(prisma);
  const azureConfig = new AzureStorageService(prisma);
  const containerName = await tlsConfig.getCertificateContainerName();
  const connectionString = await azureConfig.getConnectionString();
  if (!connectionString) throw new Error("Azure Storage not configured");

  const certificateStore = new AzureStorageCertificateStore(connectionString, containerName);
  const acmeClient = new AcmeClientManager(tlsConfig, certificateStore);
  const cloudflareConfig = new CloudflareService(prisma);
  const dnsChallenge = new DnsChallenge01Provider(cloudflareConfig);
  await acmeClient.initialize();

  const haproxyService = new HAProxyService();
  const dockerExecutor = new DockerExecutorService();
  await dockerExecutor.initialize();
  const distributor = new CertificateDistributor(certificateStore, haproxyService, dockerExecutor);

  const lifecycleManager = new CertificateLifecycleManager(
    acmeClient, certificateStore, dnsChallenge, prisma, containerName, distributor,
  );
  const provisioningService = new CertificateProvisioningService(lifecycleManager, prisma);

  return new ManualFrontendSetupService(
    manualFrontendManager, provisioningService, lifecycleManager, distributor, prisma,
  );
}

const updateManualFrontendSchema = z.object({
  hostname: z.string().min(1).regex(/^[a-z0-9.-]+$/i, "Invalid hostname format").optional(),
  enableSsl: z.boolean().optional(),
  tlsCertificateId: z.string().cuid().optional(),
  healthCheckPath: z.string().optional(),
});

// ====================
// Helper Functions
// ====================

function serializeFrontend(frontend: any): HAProxyFrontendInfo {
  return {
    id: frontend.id,
    deploymentConfigId: frontend.deploymentConfigId,
    frontendType: frontend.frontendType,
    containerName: frontend.containerName,
    containerId: frontend.containerId,
    containerPort: frontend.containerPort,
    environmentId: frontend.environmentId,
    frontendName: frontend.frontendName,
    backendName: frontend.backendName,
    hostname: frontend.hostname,
    bindPort: frontend.bindPort,
    bindAddress: frontend.bindAddress,
    useSSL: frontend.useSSL,
    tlsCertificateId: frontend.tlsCertificateId ?? null,
    sslBindPort: frontend.sslBindPort,
    isSharedFrontend: frontend.isSharedFrontend ?? false,
    sharedFrontendId: frontend.sharedFrontendId ?? null,
    routesCount: frontend._count?.routes ?? frontend.routes?.length,
    status: frontend.status as 'active' | 'pending' | 'failed' | 'removed',
    errorMessage: frontend.errorMessage,
    createdAt: frontend.createdAt.toISOString(),
    updatedAt: frontend.updatedAt.toISOString(),
  };
}

async function getHAProxyClient(environmentId: string): Promise<{ client: HAProxyDataPlaneClient; haproxyContainerId: string }> {
  // Get environment details
  const environment = await prisma.environment.findUnique({
    where: { id: environmentId },
    include: {
      services: {
        where: {
          serviceName: "haproxy",
        },
      },
    },
  });

  if (!environment) {
    throw new Error(`Environment not found: ${environmentId}`);
  }

  const haproxyService = environment.services.find((s) => s.serviceName === "haproxy");

  if (!haproxyService) {
    throw new Error(`HAProxy service not found for environment: ${environmentId}`);
  }

  // Find HAProxy container using Docker
  const dockerService = DockerService.getInstance();
  await dockerService.initialize();
  const containers = await dockerService.listContainers();

  // Look for HAProxy container with environment label
  const haproxyContainer = containers.find((container: any) => {
    const labels = container.labels || {};
    return (
      labels["mini-infra.service"] === "haproxy" &&
      labels["mini-infra.environment"] === environmentId &&
      container.status === "running"
    );
  });

  if (!haproxyContainer) {
    throw new Error(
      `No running HAProxy container found for environment: ${environment.name}. ` +
      `Ensure HAProxy is deployed and running.`
    );
  }

  logger.info(
    {
      environmentId,
      environmentName: environment.name,
      haproxyContainerId: haproxyContainer.id.slice(0, 12),
    },
    "Found HAProxy container for manual frontend operation"
  );

  // Initialize HAProxy client with container ID
  const client = new HAProxyDataPlaneClient();
  await client.initialize(haproxyContainer.id);

  return { client, haproxyContainerId: haproxyContainer.id };
}

// ====================
// Routes
// ====================

/**
 * GET /api/haproxy/manual-frontends/containers
 * List available containers for manual frontend creation
 */
router.get(
  "/containers",
  requirePermission('haproxy:read') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { environmentId } = req.query;

      if (!environmentId || typeof environmentId !== "string") {
        return res.status(400).json({
          success: false,
          error: "environmentId query parameter is required",
        });
      }

      // Validate CUID format
      if (!z.string().cuid().safeParse(environmentId).success) {
        return res.status(400).json({
          success: false,
          error: "Invalid environment ID format",
        });
      }

      const result = await manualFrontendManager.getEligibleContainers(
        environmentId,
        prisma
      );

      const response: EligibleContainersResponse = {
        success: true,
        data: result,
      };

      res.json(response);
    } catch (error: any) {
      logger.error({ error: error.message }, "Failed to get eligible containers");
      res.status(500).json({
        success: false,
        error: "Failed to get eligible containers",
        message: error.message,
      });
    }
  }
);

/**
 * POST /api/haproxy/manual-frontends
 * Create a manual frontend for a container (async with Socket.IO progress)
 */
router.post(
  "/",
  requirePermission('haproxy:write') as RequestHandler,
  async (req: Request, res: Response) => {
    let guardedEnvironmentId: string | null = null;
    try {
      // Validate request body
      const validationResult = createManualFrontendSchema.safeParse(req.body);

      if (!validationResult.success) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: validationResult.error.issues,
        });
      }

      const request: CreateManualFrontendRequest = validationResult.data;
      const user = getAuthenticatedUser(req);
      const userId = user?.id ?? "unknown";
      const operationId = randomUUID();

      // Concurrency guard — set BEFORE any await to prevent race conditions
      if (settingUpFrontends.has(request.environmentId)) {
        return res.status(409).json({
          success: false,
          message: "Manual frontend setup already in progress for this environment",
        });
      }
      guardedEnvironmentId = request.environmentId;
      settingUpFrontends.add(guardedEnvironmentId);

      // Pre-flight: resolve HAProxy client synchronously (fails fast before 200)
      const { client: haproxyClient, haproxyContainerId } = await getHAProxyClient(request.environmentId);

      const hasNetworkJoin = request.needsNetworkJoin === true;
      const totalSteps = (hasNetworkJoin ? 1 : 0) + (request.enableSsl ? 4 : 2);
      const stepNames: string[] = [];
      if (hasNetworkJoin) stepNames.push("Connect container to HAProxy network");
      stepNames.push("Validate container connectivity");
      if (request.enableSsl) {
        stepNames.push("Find or issue TLS certificate");
        stepNames.push("Deploy certificate to HAProxy");
      }
      stepNames.push("Create backend, frontend and route");

      // Respond immediately — progress comes via Socket.IO
      res.json({ success: true, data: { started: true, operationId, environmentId: request.environmentId } });

      // Run setup in background
      (async () => {
        try {
          emitToChannel(Channel.HAPROXY, ServerEvent.FRONTEND_SETUP_STARTED, {
            operationId,
            environmentId: request.environmentId,
            hostname: request.hostname,
            totalSteps,
            stepNames,
          });

          const setupService = await buildSetupService();
          const result = await setupService.setup(
            request,
            haproxyClient,
            userId,
            haproxyContainerId,
            (step, completedCount, totalSteps) => {
              try {
                emitToChannel(Channel.HAPROXY, ServerEvent.FRONTEND_SETUP_STEP, {
                  operationId, step, completedCount, totalSteps,
                });
              } catch { /* never break setup */ }
            },
          );

          logger.info({ operationId, success: result.success, stepCount: result.steps.length }, "Manual frontend setup completed");

          emitToChannel(Channel.HAPROXY, ServerEvent.FRONTEND_SETUP_COMPLETED, {
            ...result,
            operationId,
          });
        } catch (error: any) {
          logger.error({ error: error.message, operationId }, "Background manual frontend setup failed");
          emitToChannel(Channel.HAPROXY, ServerEvent.FRONTEND_SETUP_COMPLETED, {
            success: false,
            operationId,
            steps: [],
            errors: [error.message],
          });
        } finally {
          settingUpFrontends.delete(request.environmentId);
        }
      })();
    } catch (error: any) {
      if (guardedEnvironmentId) settingUpFrontends.delete(guardedEnvironmentId);
      logger.error({ error: error.message }, "Failed to start manual frontend setup");

      let statusCode = 500;
      if (error.message.includes("not found")) statusCode = 404;
      else if (error.message.includes("Invalid")) statusCode = 400;

      res.status(statusCode).json({
        success: false,
        error: "Failed to start manual frontend setup",
        message: error.message,
      });
    }
  }
);

/**
 * GET /api/haproxy/manual-frontends/:frontendName
 * Get details of a specific manual frontend
 */
router.get(
  "/:frontendName",
  requirePermission('haproxy:read') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { frontendName } = req.params;

      // Fetch frontend
      const frontend = await prisma.hAProxyFrontend.findUnique({
        where: { frontendName },
      });

      if (!frontend) {
        return res.status(404).json({
          success: false,
          error: "Frontend not found",
        });
      }

      if (frontend.frontendType !== "manual") {
        return res.status(400).json({
          success: false,
          error: "Frontend is not a manual frontend",
        });
      }

      const response: ManualFrontendResponse = {
        success: true,
        data: serializeFrontend(frontend),
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, frontendName: req.params.frontendName },
        "Failed to fetch manual frontend"
      );
      res.status(500).json({
        success: false,
        error: "Failed to fetch manual frontend",
        message: error.message,
      });
    }
  }
);

/**
 * PUT /api/haproxy/manual-frontends/:frontendName
 * Update a manual frontend
 */
router.put(
  "/:frontendName",
  requirePermission('haproxy:write') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { frontendName } = req.params;

      // Validate request body
      const validationResult = updateManualFrontendSchema.safeParse(req.body);

      if (!validationResult.success) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: validationResult.error.issues,
        });
      }

      const updates: UpdateManualFrontendRequest = validationResult.data;

      // Get frontend to determine environment
      const existingFrontend = await prisma.hAProxyFrontend.findUnique({
        where: { frontendName },
      });

      if (!existingFrontend) {
        return res.status(404).json({
          success: false,
          error: "Frontend not found",
        });
      }

      if (existingFrontend.frontendType !== "manual") {
        return res.status(400).json({
          success: false,
          error: "Cannot update deployment frontend via manual frontend API",
        });
      }

      if (!existingFrontend.environmentId) {
        return res.status(400).json({
          success: false,
          error: "Frontend has no environment ID",
        });
      }

      // Get HAProxy client
      const { client: haproxyClient } = await getHAProxyClient(existingFrontend.environmentId);

      // Update manual frontend
      const frontend = await manualFrontendManager.updateManualFrontend(
        frontendName,
        updates,
        haproxyClient,
        prisma
      );

      const response: ManualFrontendResponse = {
        success: true,
        data: serializeFrontend(frontend),
        message: "Manual frontend updated successfully",
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, frontendName: req.params.frontendName },
        "Failed to update manual frontend"
      );

      let statusCode = 500;
      if (error.message.includes("not found")) {
        statusCode = 404;
      } else if (error.message.includes("already in use")) {
        statusCode = 409;
      }

      res.status(statusCode).json({
        success: false,
        error: "Failed to update manual frontend",
        message: error.message,
      });
    }
  }
);

/**
 * DELETE /api/haproxy/manual-frontends/:frontendName
 * Delete a manual frontend
 */
router.delete(
  "/:frontendName",
  requirePermission('haproxy:write') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { frontendName } = req.params;

      // Get frontend to determine environment
      const frontend = await prisma.hAProxyFrontend.findUnique({
        where: { frontendName },
      });

      if (!frontend) {
        return res.status(404).json({
          success: false,
          error: "Frontend not found",
        });
      }

      if (frontend.frontendType !== "manual") {
        return res.status(403).json({
          success: false,
          error: "Cannot delete deployment frontend via manual frontend API",
        });
      }

      if (!frontend.environmentId) {
        return res.status(400).json({
          success: false,
          error: "Frontend has no environment ID",
        });
      }

      // Get HAProxy client
      const { client: haproxyClient } = await getHAProxyClient(frontend.environmentId);

      // Delete manual frontend
      await manualFrontendManager.deleteManualFrontend(
        frontendName,
        haproxyClient,
        prisma
      );

      const response: DeleteManualFrontendResponse = {
        success: true,
        message: "Manual frontend deleted successfully",
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, frontendName: req.params.frontendName },
        "Failed to delete manual frontend"
      );

      let statusCode = 500;
      if (error.message.includes("not found")) {
        statusCode = 404;
      } else if (error.message.includes("Cannot delete deployment frontend")) {
        statusCode = 403;
      }

      res.status(statusCode).json({
        success: false,
        error: "Failed to delete manual frontend",
        message: error.message,
      });
    }
  }
);

export default router;
