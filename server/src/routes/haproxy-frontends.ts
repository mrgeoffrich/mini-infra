import express, { Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey } from "../middleware/auth";
import prisma from "../lib/prisma";
import {
  HAProxyFrontendInfo,
  HAProxyFrontendListResponse,
  HAProxyFrontendResponse,
  SyncFrontendResponse,
} from "@mini-infra/types";
import { haproxyFrontendManager, HAProxyDataPlaneClient } from "../services/haproxy";
import DockerService from "../services/docker";

const logger = appLogger();
const router = express.Router();

// ====================
// Helper Functions
// ====================

function serializeFrontend(frontend: any): HAProxyFrontendInfo {
  // Extract hostnames from routes if available
  const routeHostnames = frontend.routes?.map((route: any) => route.hostname) ?? [];

  return {
    id: frontend.id,
    deploymentConfigId: frontend.deploymentConfigId,
    frontendType: frontend.frontendType || 'deployment',
    containerName: frontend.containerName,
    containerId: frontend.containerId,
    containerPort: frontend.containerPort,
    environmentId: frontend.environmentId ?? frontend.deploymentConfig?.environmentId ?? null,
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
    routesCount: frontend._count?.routes ?? frontend.routes?.length ?? 0,
    routeHostnames,
    status: frontend.status as 'active' | 'pending' | 'failed' | 'removed',
    errorMessage: frontend.errorMessage,
    createdAt: frontend.createdAt.toISOString(),
    updatedAt: frontend.updatedAt.toISOString(),
  };
}

// ====================
// Routes
// ====================

/**
 * GET /api/haproxy/frontends
 * List all HAProxy frontends
 */
router.get(
  "/",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { status, hostname } = req.query;

      // Build filter
      const where: any = {};

      if (status && typeof status === "string") {
        where.status = status;
      }

      if (hostname && typeof hostname === "string") {
        where.hostname = {
          contains: hostname,
          mode: "insensitive",
        };
      }

      // Fetch frontends
      const frontends = await prisma.hAProxyFrontend.findMany({
        where,
        include: {
          deploymentConfig: {
            select: {
              applicationName: true,
              environmentId: true,
            },
          },
          routes: {
            select: {
              hostname: true,
            },
            orderBy: { createdAt: "asc" },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      const response: HAProxyFrontendListResponse = {
        success: true,
        data: frontends.map(serializeFrontend),
      };

      res.json(response);
    } catch (error: any) {
      logger.error({ error: error.message }, "Failed to fetch HAProxy frontends");
      res.status(500).json({
        success: false,
        error: "Failed to fetch HAProxy frontends",
        message: error.message,
      });
    }
  }
);

/**
 * GET /api/haproxy/frontends/:frontendName
 * Get details of a specific HAProxy frontend by name
 */
router.get(
  "/:frontendName",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { frontendName } = req.params;

      // Fetch frontend
      const frontend = await prisma.hAProxyFrontend.findUnique({
        where: { frontendName },
        include: {
          deploymentConfig: {
            select: {
              applicationName: true,
              environmentId: true,
            },
          },
          _count: {
            select: {
              routes: true,
            },
          },
        },
      });

      if (!frontend) {
        return res.status(404).json({
          success: false,
          error: "HAProxy frontend not found",
        });
      }

      const response: HAProxyFrontendResponse = {
        success: true,
        data: serializeFrontend(frontend),
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, frontendName: req.params.frontendName },
        "Failed to fetch HAProxy frontend"
      );
      res.status(500).json({
        success: false,
        error: "Failed to fetch HAProxy frontend",
        message: error.message,
      });
    }
  }
);

/**
 * GET /api/deployments/configs/:configId/frontend
 * Get HAProxy frontend for a specific deployment configuration
 */
router.get(
  "/configs/:configId/frontend",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { configId } = req.params;

      // Validate CUID format
      if (!z.string().cuid().safeParse(configId).success) {
        return res.status(400).json({
          success: false,
          error: "Invalid deployment configuration ID format",
        });
      }

      // Check if deployment config exists
      const config = await prisma.deploymentConfiguration.findUnique({
        where: { id: configId },
      });

      if (!config) {
        return res.status(404).json({
          success: false,
          error: "Deployment configuration not found",
        });
      }

      // Fetch frontend
      const frontend = await prisma.hAProxyFrontend.findUnique({
        where: { deploymentConfigId: configId },
      });

      // Return empty data if no frontend exists (not an error, just not configured yet)
      const response = {
        success: true,
        data: frontend ? serializeFrontend(frontend) : null,
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, configId: req.params.configId },
        "Failed to fetch HAProxy frontend for deployment"
      );
      res.status(500).json({
        success: false,
        error: "Failed to fetch HAProxy frontend",
        message: error.message,
      });
    }
  }
);

/**
 * POST /api/deployments/configs/:configId/frontend/sync
 * Manually sync HAProxy frontend for a deployment configuration
 */
router.post(
  "/configs/:configId/frontend/sync",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { configId } = req.params;

      // Validate CUID format
      if (!z.string().cuid().safeParse(configId).success) {
        return res.status(400).json({
          success: false,
          error: "Invalid deployment configuration ID format",
        });
      }

      // Check if deployment config exists
      const config = await prisma.deploymentConfiguration.findUnique({
        where: { id: configId },
        include: {
          environment: true,
        },
      });

      if (!config) {
        return res.status(404).json({
          success: false,
          error: "Deployment configuration not found",
        });
      }

      // Check if hostname is configured
      if (!config.hostname) {
        return res.status(400).json({
          success: false,
          error: "Deployment configuration does not have a hostname configured",
        });
      }

      // Get existing frontend
      const existingFrontend = await prisma.hAProxyFrontend.findUnique({
        where: { deploymentConfigId: configId },
      });

      // For now, we'll just return a message indicating the sync would happen
      // The actual frontend sync logic will be implemented in the haproxy-frontend-manager service
      const response: SyncFrontendResponse = {
        success: true,
        message: `Frontend sync initiated for ${config.hostname}. Actual sync implementation is handled by deployment state machines.`,
        data: existingFrontend ? serializeFrontend(existingFrontend) : undefined,
      };

      logger.info(
        {
          configId,
          hostname: config.hostname,
          frontendName: existingFrontend?.frontendName,
        },
        "Frontend sync requested for deployment configuration"
      );

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, configId: req.params.configId },
        "Failed to sync frontend for deployment"
      );
      res.status(500).json({
        success: false,
        error: "Failed to sync frontend",
        message: error.message,
      });
    }
  }
);

// ====================
// Routes API for Shared Frontends
// ====================

/**
 * Helper function to get HAProxy DataPlane client for a frontend's environment
 */
async function getHAProxyClientForFrontend(frontendName: string): Promise<HAProxyDataPlaneClient> {
  // Get frontend to find environment
  const frontend = await prisma.hAProxyFrontend.findUnique({
    where: { frontendName },
  });

  if (!frontend) {
    throw new Error(`Frontend not found: ${frontendName}`);
  }

  if (!frontend.environmentId) {
    throw new Error(`Frontend has no environment ID: ${frontendName}`);
  }

  // Get environment details
  const environment = await prisma.environment.findUnique({
    where: { id: frontend.environmentId },
    include: {
      services: {
        where: {
          serviceName: "haproxy",
        },
      },
    },
  });

  if (!environment) {
    throw new Error(`Environment not found: ${frontend.environmentId}`);
  }

  // Find HAProxy container using Docker
  const dockerService = DockerService.getInstance();
  await dockerService.initialize();
  const containers = await dockerService.listContainers();

  const haproxyContainer = containers.find((container: any) => {
    const labels = container.labels || {};
    return (
      labels["mini-infra.service"] === "haproxy" &&
      labels["mini-infra.environment"] === frontend.environmentId &&
      container.status === "running"
    );
  });

  if (!haproxyContainer) {
    throw new Error(
      `No running HAProxy container found for environment: ${environment.name}`
    );
  }

  const client = new HAProxyDataPlaneClient();
  await client.initialize(haproxyContainer.id);

  return client;
}

// Validation schema for creating a route
const createRouteSchema = z.object({
  hostname: z.string().min(1).regex(/^[a-z0-9.-]+$/i, "Invalid hostname format"),
  backendName: z.string().min(1),
  useSSL: z.boolean().optional().default(false),
  tlsCertificateId: z.string().cuid().optional(),
});

/**
 * GET /api/haproxy/frontends/:frontendName/routes
 * List all routes for a shared frontend
 */
router.get(
  "/:frontendName/routes",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { frontendName } = req.params;

      // Fetch frontend
      const frontend = await prisma.hAProxyFrontend.findUnique({
        where: { frontendName },
        include: {
          routes: {
            orderBy: { createdAt: "asc" },
          },
        },
      });

      if (!frontend) {
        return res.status(404).json({
          success: false,
          error: "Frontend not found",
        });
      }

      if (!frontend.isSharedFrontend) {
        return res.status(400).json({
          success: false,
          error: "Frontend is not a shared frontend",
          message: "Routes are only available for shared frontends",
        });
      }

      res.json({
        success: true,
        data: {
          frontendId: frontend.id,
          frontendName: frontend.frontendName,
          routes: frontend.routes.map((route) => ({
            id: route.id,
            hostname: route.hostname,
            aclName: route.aclName,
            backendName: route.backendName,
            sourceType: route.sourceType,
            deploymentConfigId: route.deploymentConfigId,
            manualFrontendId: route.manualFrontendId,
            useSSL: route.useSSL,
            tlsCertificateId: route.tlsCertificateId,
            status: route.status,
            priority: route.priority,
            createdAt: route.createdAt.toISOString(),
            updatedAt: route.updatedAt.toISOString(),
          })),
        },
      });
    } catch (error: any) {
      logger.error(
        { error: error.message, frontendName: req.params.frontendName },
        "Failed to fetch routes for frontend"
      );
      res.status(500).json({
        success: false,
        error: "Failed to fetch routes",
        message: error.message,
      });
    }
  }
);

/**
 * POST /api/haproxy/frontends/:frontendName/routes
 * Add a new route to a shared frontend (for manual additions)
 */
router.post(
  "/:frontendName/routes",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { frontendName } = req.params;

      // Validate request body
      const validationResult = createRouteSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: validationResult.error.issues,
        });
      }

      const { hostname, backendName, useSSL, tlsCertificateId } = validationResult.data;

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

      if (!frontend.isSharedFrontend) {
        return res.status(400).json({
          success: false,
          error: "Frontend is not a shared frontend",
          message: "Routes can only be added to shared frontends",
        });
      }

      // Get HAProxy client
      let haproxyClient: HAProxyDataPlaneClient;
      try {
        haproxyClient = await getHAProxyClientForFrontend(frontendName);
      } catch (error) {
        return res.status(503).json({
          success: false,
          error: "HAProxy unavailable",
          message: error instanceof Error ? error.message : "Failed to connect to HAProxy",
        });
      }

      // Add route
      const route = await haproxyFrontendManager.addRouteToSharedFrontend(
        frontend.id,
        hostname,
        backendName,
        "manual",
        frontend.id, // For manual routes, source ID is the frontend itself
        haproxyClient,
        prisma,
        { useSSL, tlsCertificateId }
      );

      logger.info(
        { frontendName, hostname, backendName },
        "Route added to shared frontend via API"
      );

      res.status(201).json({
        success: true,
        data: route,
        message: "Route added successfully",
      });
    } catch (error: any) {
      logger.error(
        { error: error.message, frontendName: req.params.frontendName },
        "Failed to add route to frontend"
      );

      let statusCode = 500;
      if (error.message.includes("already exists")) {
        statusCode = 409;
      } else if (error.message.includes("not found")) {
        statusCode = 404;
      }

      res.status(statusCode).json({
        success: false,
        error: "Failed to add route",
        message: error.message,
      });
    }
  }
);

/**
 * DELETE /api/haproxy/frontends/:frontendName/routes/:routeId
 * Remove a route from a shared frontend
 */
router.delete(
  "/:frontendName/routes/:routeId",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { frontendName, routeId } = req.params;

      // Validate route ID
      if (!z.string().cuid().safeParse(routeId).success) {
        return res.status(400).json({
          success: false,
          error: "Invalid route ID format",
        });
      }

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

      if (!frontend.isSharedFrontend) {
        return res.status(400).json({
          success: false,
          error: "Frontend is not a shared frontend",
          message: "Routes can only be removed from shared frontends",
        });
      }

      // Fetch route
      const route = await prisma.hAProxyRoute.findUnique({
        where: { id: routeId },
      });

      if (!route) {
        return res.status(404).json({
          success: false,
          error: "Route not found",
        });
      }

      if (route.sharedFrontendId !== frontend.id) {
        return res.status(400).json({
          success: false,
          error: "Route does not belong to this frontend",
        });
      }

      // Get HAProxy client
      let haproxyClient: HAProxyDataPlaneClient;
      try {
        haproxyClient = await getHAProxyClientForFrontend(frontendName);
      } catch (error) {
        return res.status(503).json({
          success: false,
          error: "HAProxy unavailable",
          message: error instanceof Error ? error.message : "Failed to connect to HAProxy",
        });
      }

      // Remove route
      await haproxyFrontendManager.removeRouteFromSharedFrontend(
        frontend.id,
        route.hostname,
        haproxyClient,
        prisma
      );

      logger.info(
        { frontendName, routeId, hostname: route.hostname },
        "Route removed from shared frontend via API"
      );

      res.json({
        success: true,
        message: "Route removed successfully",
      });
    } catch (error: any) {
      logger.error(
        { error: error.message, frontendName: req.params.frontendName, routeId: req.params.routeId },
        "Failed to remove route from frontend"
      );
      res.status(500).json({
        success: false,
        error: "Failed to remove route",
        message: error.message,
      });
    }
  }
);

export default router;
