import express, { Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requirePermission } from "../middleware/auth";
import prisma from "../lib/prisma";
import {
  HAProxyFrontendInfo,
  HAProxyFrontendListResponse,
  HAProxyFrontendResponse,
  ForceDeleteFrontendResponse,
} from "@mini-infra/types";
import { haproxyFrontendManager, HAProxyDataPlaneClient } from "../services/haproxy";
import { haproxyCertificateDeployer } from "../services/haproxy/haproxy-certificate-deployer";
import DockerService from "../services/docker";
import { emitHAProxyUpdate } from "../services/haproxy-socket-emitter";

const logger = appLogger();
const router = express.Router();

// ====================
// Helper Functions
// ====================

function serializeFrontend(
  frontend: any,
  sharedFrontendNameLookup?: Map<string, string>
): HAProxyFrontendInfo {
  // Extract hostnames from routes if available
  const routeHostnames = frontend.routes?.map((route: any) => route.hostname) ?? [];

  // Resolve shared frontend name for manual frontends
  const sharedFrontendName = frontend.sharedFrontendId
    ? sharedFrontendNameLookup?.get(frontend.sharedFrontendId) ?? null
    : null;

  return {
    id: frontend.id,
    frontendType: frontend.frontendType || 'shared',
    containerName: frontend.containerName,
    containerId: frontend.containerId,
    containerPort: frontend.containerPort,
    environmentId: frontend.environmentId ?? null,
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
    sharedFrontendName,
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
  requirePermission('haproxy:read') as RequestHandler,
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
          routes: {
            select: {
              hostname: true,
            },
            orderBy: { createdAt: "asc" },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      // Build lookup map for shared frontend names (so manual frontends
      // can display which shared frontend they route through)
      const sharedFrontendNameLookup = new Map<string, string>();
      for (const f of frontends) {
        if (f.isSharedFrontend) {
          sharedFrontendNameLookup.set(f.id, f.frontendName);
        }
      }

      const response: HAProxyFrontendListResponse = {
        success: true,
        data: frontends.map((f) => serializeFrontend(f, sharedFrontendNameLookup)),
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

// Validation schema for creating a shared frontend
const createSharedFrontendSchema = z.object({
  environmentId: z.string().cuid("Invalid environment ID"),
  type: z.enum(["http", "https"]),
  bindPort: z.number().int().min(1).max(65535).optional(),
  tlsCertificateId: z.string().cuid("Invalid certificate ID").optional(),
});

/**
 * POST /api/haproxy/frontends/shared
 * Create a shared frontend for an environment
 */
router.post(
  "/shared",
  requirePermission('haproxy:write') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const validationResult = createSharedFrontendSchema.safeParse(req.body);

      if (!validationResult.success) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: validationResult.error.issues,
        });
      }

      const { environmentId, type, bindPort, tlsCertificateId } = validationResult.data;

      // If HTTPS with certificate, validate the certificate exists
      if (type === "https" && tlsCertificateId) {
        const certificate = await prisma.tlsCertificate.findUnique({
          where: { id: tlsCertificateId },
        });
        if (!certificate) {
          return res.status(404).json({
            success: false,
            error: "Certificate not found",
          });
        }
        if (!certificate.blobName) {
          return res.status(400).json({
            success: false,
            error: "Certificate has no blob name - not yet provisioned",
          });
        }
      }

      // Get environment details
      const environment = await prisma.environment.findUnique({
        where: { id: environmentId },
      });

      if (!environment) {
        return res.status(404).json({
          success: false,
          error: "Environment not found",
        });
      }

      const haproxyStack = await prisma.stack.findFirst({
        where: { environmentId, name: 'haproxy', status: { not: 'removed' } },
      });

      if (!haproxyStack) {
        return res.status(400).json({
          success: false,
          error: "Environment does not have HAProxy stack",
        });
      }

      // Find HAProxy container
      const dockerService = DockerService.getInstance();
      await dockerService.initialize();
      const containers = await dockerService.listContainers();

      const haproxyContainer = containers.find((container: any) => {
        const labels = container.labels || {};
        return (
          labels["mini-infra.service"] === "haproxy" &&
          labels["mini-infra.environment"] === environmentId &&
          container.status === "running"
        );
      });

      if (!haproxyContainer) {
        return res.status(503).json({
          success: false,
          error: "HAProxy container not found or not running",
        });
      }

      // Initialize HAProxy client
      const haproxyClient = new HAProxyDataPlaneClient();
      await haproxyClient.initialize(haproxyContainer.id);

      // Create the shared frontend
      const defaultPort = type === "https" ? 443 : 80;
      const sharedFrontend = await haproxyFrontendManager.getOrCreateSharedFrontend(
        environmentId,
        type,
        haproxyClient,
        prisma,
        {
          bindPort: bindPort ?? defaultPort,
          bindAddress: "*",
          tlsCertificateId,
        }
      );

      logger.info(
        { environmentId, type, frontendName: sharedFrontend.frontendName },
        "Created shared frontend via API"
      );

      emitHAProxyUpdate();
      res.status(201).json({
        success: true,
        data: {
          id: sharedFrontend.id,
          frontendName: sharedFrontend.frontendName,
          environmentId: sharedFrontend.environmentId,
          isSharedFrontend: sharedFrontend.isSharedFrontend,
          bindPort: sharedFrontend.bindPort,
          bindAddress: sharedFrontend.bindAddress,
          useSSL: sharedFrontend.useSSL,
          tlsCertificateId: sharedFrontend.tlsCertificateId,
          type,
        },
        message: sharedFrontend.useSSL
          ? `Shared ${type.toUpperCase()} frontend created with SSL configured`
          : `Shared ${type.toUpperCase()} frontend created successfully`,
      });
    } catch (error: any) {
      logger.error({ error: error.message }, "Failed to create shared frontend");
      res.status(500).json({
        success: false,
        error: "Failed to create shared frontend",
        message: error.message,
      });
    }
  }
);

// Validation schema for configuring SSL on a frontend
const configureSSLSchema = z.object({
  tlsCertificateId: z.string().cuid("Invalid certificate ID"),
});

/**
 * POST /api/haproxy/frontends/:frontendName/ssl
 * Configure SSL on a shared frontend
 */
router.post(
  "/:frontendName/ssl",
  requirePermission('haproxy:write') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const frontendName = String(req.params.frontendName);
      const validationResult = configureSSLSchema.safeParse(req.body);

      if (!validationResult.success) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: validationResult.error.issues,
        });
      }

      const { tlsCertificateId } = validationResult.data;

      // Get frontend
      const frontend = await prisma.hAProxyFrontend.findUnique({
        where: { frontendName },
      });

      if (!frontend) {
        return res.status(404).json({
          success: false,
          error: "Frontend not found",
        });
      }

      if (!frontend.environmentId) {
        return res.status(400).json({
          success: false,
          error: "Frontend has no environment ID",
        });
      }

      // Get HAProxy client
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
        return res.status(503).json({
          success: false,
          error: "HAProxy container not found or not running",
        });
      }

      const haproxyClient = new HAProxyDataPlaneClient();
      await haproxyClient.initialize(haproxyContainer.id);

      // Deploy certificate to HAProxy via the certificate deployer
      const certFileName = await haproxyCertificateDeployer.fetchAndDeployCertificate(
        tlsCertificateId,
        prisma,
        haproxyClient,
      );

      if (!certFileName) {
        return res.status(404).json({
          success: false,
          error: "Certificate not found or not ready for deployment",
        });
      }

      // Delete existing bind if present (created without SSL when shared frontend was made)
      // The bind name follows the pattern bind_${port}
      try {
        await haproxyClient.deleteFrontendBind(frontendName, "bind_443");
        logger.info({ frontendName }, "Deleted existing bind_443 to replace with SSL-enabled bind");
      } catch (deleteError: any) {
        // If bind doesn't exist, that's fine - we'll just create it
        if (!deleteError.message?.includes("not found")) {
          throw deleteError;
        }
        logger.debug({ frontendName }, "No existing bind_443 to delete");
      }

      // Add SSL binding to frontend
      await haproxyClient.addFrontendBind(
        frontendName,
        "*",
        443,
        {
          ssl: true,
          ssl_certificate: `/etc/haproxy/ssl/${certFileName}`,
        }
      );

      // Update frontend record
      await prisma.hAProxyFrontend.update({
        where: { frontendName },
        data: {
          useSSL: true,
          tlsCertificateId,
        },
      });

      logger.info(
        { frontendName, tlsCertificateId, certFileName },
        "Configured SSL on frontend via API"
      );

      emitHAProxyUpdate();
      res.json({
        success: true,
        message: "SSL configured successfully",
        data: {
          frontendName,
          tlsCertificateId,
          certFileName,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, "Failed to configure SSL on frontend");
      res.status(500).json({
        success: false,
        error: "Failed to configure SSL",
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
  requirePermission('haproxy:read') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const frontendName = String(req.params.frontendName);

      // Fetch frontend
      const frontend = await prisma.hAProxyFrontend.findUnique({
        where: { frontendName },
        include: {
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

      // Look up shared frontend name if this is a manual frontend
      const sharedFrontendNameLookup = new Map<string, string>();
      if (frontend.sharedFrontendId) {
        const sharedFrontend = await prisma.hAProxyFrontend.findUnique({
          where: { id: frontend.sharedFrontendId },
          select: { id: true, frontendName: true },
        });
        if (sharedFrontend) {
          sharedFrontendNameLookup.set(sharedFrontend.id, sharedFrontend.frontendName);
        }
      }

      const response: HAProxyFrontendResponse = {
        success: true,
        data: serializeFrontend(frontend, sharedFrontendNameLookup),
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
  requirePermission('haproxy:read') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const frontendName = String(req.params.frontendName);

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
  requirePermission('haproxy:write') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const frontendName = String(req.params.frontendName);

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

      emitHAProxyUpdate();
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

// Validation schema for patching a route
const patchRouteSchema = z.object({
  hostname: z.string().min(1).regex(/^[a-z0-9.-]+$/i, "Invalid hostname format").optional(),
  backendName: z.string().min(1).optional(),
  useSSL: z.boolean().optional(),
  tlsCertificateId: z.string().cuid().nullable().optional(),
  priority: z.number().int().optional(),
  status: z.enum(["active", "inactive", "failed"]).optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

/**
 * PATCH /api/haproxy/frontends/:frontendName/routes/:routeId
 * Update a route on a shared frontend (propagates changes to HAProxy)
 */
router.patch(
  "/:frontendName/routes/:routeId",
  requirePermission('haproxy:write') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const frontendName = String(req.params.frontendName); const routeId = String(req.params.routeId);

      // Validate route ID
      if (!z.string().cuid().safeParse(routeId).success) {
        return res.status(400).json({
          success: false,
          error: "Invalid route ID format",
        });
      }

      // Validate request body
      const validationResult = patchRouteSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: validationResult.error.issues,
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
          message: "Routes can only be updated on shared frontends",
        });
      }

      // Fetch route and verify it belongs to this frontend
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

      // Check for hostname uniqueness if hostname is being changed
      if (validationResult.data.hostname && validationResult.data.hostname !== route.hostname) {
        const existingRoute = await prisma.hAProxyRoute.findFirst({
          where: {
            sharedFrontendId: frontend.id,
            hostname: validationResult.data.hostname,
            id: { not: routeId },
          },
        });

        if (existingRoute) {
          return res.status(409).json({
            success: false,
            error: "A route with this hostname already exists on this frontend",
          });
        }
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

      // Update route (propagates to HAProxy)
      await haproxyFrontendManager.updateRoute(
        routeId,
        validationResult.data,
        haproxyClient,
        prisma
      );

      // Fetch full updated record for response
      const updatedRoute = await prisma.hAProxyRoute.findUnique({
        where: { id: routeId },
      });

      logger.info(
        { frontendName, routeId, updates: validationResult.data },
        "Route updated on shared frontend via API"
      );

      emitHAProxyUpdate();
      res.json({
        success: true,
        data: updatedRoute ? {
          id: updatedRoute.id,
          hostname: updatedRoute.hostname,
          aclName: updatedRoute.aclName,
          backendName: updatedRoute.backendName,
          sourceType: updatedRoute.sourceType,
          manualFrontendId: updatedRoute.manualFrontendId,
          useSSL: updatedRoute.useSSL,
          tlsCertificateId: updatedRoute.tlsCertificateId,
          status: updatedRoute.status,
          priority: updatedRoute.priority,
          createdAt: updatedRoute.createdAt.toISOString(),
          updatedAt: updatedRoute.updatedAt.toISOString(),
        } : null,
        message: "Route updated successfully",
      });
    } catch (error: any) {
      logger.error(
        { error: error.message, frontendName: req.params.frontendName, routeId: req.params.routeId },
        "Failed to update route on frontend"
      );

      let statusCode = 500;
      if (error.message.includes("not found")) {
        statusCode = 404;
      }

      res.status(statusCode).json({
        success: false,
        error: "Failed to update route",
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
  requirePermission('haproxy:write') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const frontendName = String(req.params.frontendName); const routeId = String(req.params.routeId);

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

      emitHAProxyUpdate();
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

/**
 * DELETE /api/haproxy/frontends/:frontendName
 * Force-delete a frontend and all its routes. Emergency cleanup endpoint — not for UI use.
 */
router.delete(
  "/:frontendName",
  requirePermission('haproxy:write') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const frontendName = String(req.params.frontendName);

      // Fetch frontend with routes
      const frontend = await prisma.hAProxyFrontend.findUnique({
        where: { frontendName },
        include: { routes: true },
      });

      if (!frontend) {
        return res.status(404).json({
          success: false,
          error: "Frontend not found",
        });
      }

      // Try to clean up HAProxy config — but don't fail if HAProxy is unavailable
      let haproxyCleanedUp = false;
      try {
        const haproxyClient = await getHAProxyClientForFrontend(frontendName);

        // Remove all routes from HAProxy (ACLs and switching rules)
        for (const route of frontend.routes) {
          try {
            await haproxyFrontendManager.removeRouteFromSharedFrontend(
              frontend.id,
              route.hostname,
              haproxyClient,
              prisma
            );
          } catch (routeError: any) {
            logger.warn(
              { error: routeError.message, hostname: route.hostname, frontendName },
              "Failed to remove route from HAProxy during force-delete, continuing"
            );
          }
        }

        // Remove the frontend itself from HAProxy
        try {
          await haproxyFrontendManager.removeFrontend(frontendName, haproxyClient);
        } catch (frontendError: any) {
          logger.warn(
            { error: frontendError.message, frontendName },
            "Failed to remove frontend from HAProxy during force-delete, continuing"
          );
        }

        haproxyCleanedUp = true;
      } catch (haproxyError: any) {
        logger.warn(
          { error: haproxyError.message, frontendName },
          "HAProxy unavailable during force-delete, cleaning up database only"
        );
      }

      // Delete remaining routes from database (some may have been deleted by removeRouteFromSharedFrontend)
      await prisma.hAProxyRoute.deleteMany({
        where: { sharedFrontendId: frontend.id },
      });

      // Delete the frontend record
      await prisma.hAProxyFrontend.delete({
        where: { id: frontend.id },
      });

      const totalDeletedRoutes = frontend.routes.length;

      logger.info(
        { frontendName, deletedRoutes: totalDeletedRoutes, haproxyCleanedUp },
        "Force-deleted frontend and all routes"
      );

      emitHAProxyUpdate();

      const response: ForceDeleteFrontendResponse = {
        success: true,
        message: haproxyCleanedUp
          ? `Frontend and ${totalDeletedRoutes} route(s) removed from HAProxy and database`
          : `Frontend and ${totalDeletedRoutes} route(s) removed from database only (HAProxy was unavailable)`,
        deletedRoutes: totalDeletedRoutes,
        frontendName,
      };
      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, frontendName: req.params.frontendName },
        "Failed to force-delete frontend"
      );
      res.status(500).json({
        success: false,
        error: "Failed to force-delete frontend",
        message: error.message,
      });
    }
  }
);

export default router;
