import express, { Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey } from "../middleware/auth";
import prisma from "../lib/prisma";
import {
  HAProxyBackendInfo,
  HAProxyBackendListResponse,
  HAProxyBackendResponse,
  HAProxyServerInfo,
  HAProxyServerListResponse,
  HAProxyServerResponse,
} from "@mini-infra/types";
import { HAProxyDataPlaneClient } from "../services/haproxy/haproxy-dataplane-client";
import DockerService from "../services/docker";

const logger = appLogger();
const router = express.Router();

// ====================
// Helper Functions
// ====================

function serializeBackend(backend: any): HAProxyBackendInfo {
  return {
    id: backend.id,
    name: backend.name,
    environmentId: backend.environmentId,
    mode: backend.mode,
    balanceAlgorithm: backend.balanceAlgorithm,
    checkTimeout: backend.checkTimeout,
    connectTimeout: backend.connectTimeout,
    serverTimeout: backend.serverTimeout,
    sourceType: backend.sourceType as "deployment" | "manual",
    deploymentConfigId: backend.deploymentConfigId,
    manualFrontendId: backend.manualFrontendId,
    status: backend.status as "active" | "removed" | "failed",
    errorMessage: backend.errorMessage,
    serversCount: backend._count?.servers ?? backend.servers?.length ?? 0,
    servers: backend.servers?.map(serializeServer),
    createdAt: backend.createdAt.toISOString(),
    updatedAt: backend.updatedAt.toISOString(),
  };
}

function serializeServer(server: any): HAProxyServerInfo {
  return {
    id: server.id,
    name: server.name,
    backendId: server.backendId,
    backendName: server.backend?.name,
    address: server.address,
    port: server.port,
    check: server.check,
    checkPath: server.checkPath,
    inter: server.inter,
    rise: server.rise,
    fall: server.fall,
    weight: server.weight,
    enabled: server.enabled,
    maintenance: server.maintenance,
    containerId: server.containerId,
    containerName: server.containerName,
    deploymentId: server.deploymentId,
    status: server.status as "active" | "removed" | "draining",
    errorMessage: server.errorMessage,
    createdAt: server.createdAt.toISOString(),
    updatedAt: server.updatedAt.toISOString(),
  };
}

async function getHAProxyClient(environmentId: string): Promise<HAProxyDataPlaneClient> {
  const environment = await prisma.environment.findUnique({
    where: { id: environmentId },
    include: {
      services: {
        where: { serviceName: "haproxy" },
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
    throw new Error(
      `No running HAProxy container found for environment: ${environment.name}. ` +
      `Ensure HAProxy is deployed and running.`
    );
  }

  const client = new HAProxyDataPlaneClient();
  await client.initialize(haproxyContainer.id);
  return client;
}

// ====================
// Validation Schemas
// ====================

const updateBackendSchema = z.object({
  balanceAlgorithm: z.enum(["roundrobin", "leastconn", "source"]).optional(),
  checkTimeout: z.number().int().min(0).optional(),
  connectTimeout: z.number().int().min(0).optional(),
  serverTimeout: z.number().int().min(0).optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

const updateServerSchema = z.object({
  weight: z.number().int().min(0).max(256).optional(),
  enabled: z.boolean().optional(),
  maintenance: z.boolean().optional(),
  checkPath: z.string().optional(),
  inter: z.number().int().min(0).optional(),
  rise: z.number().int().min(1).optional(),
  fall: z.number().int().min(1).optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

// ====================
// Routes
// ====================

/**
 * GET /api/haproxy/backends
 * List HAProxy backends (filter by environmentId, status, sourceType, name)
 */
router.get(
  "/",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { environmentId, status, sourceType, name } = req.query;

      const where: any = {};

      if (environmentId && typeof environmentId === "string") {
        where.environmentId = environmentId;
      }
      if (status && typeof status === "string") {
        where.status = status;
      }
      if (sourceType && typeof sourceType === "string") {
        where.sourceType = sourceType;
      }
      if (name && typeof name === "string") {
        where.name = { contains: name };
      }

      const backends = await prisma.hAProxyBackend.findMany({
        where,
        include: {
          _count: {
            select: { servers: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      const response: HAProxyBackendListResponse = {
        success: true,
        data: backends.map(serializeBackend),
      };

      res.json(response);
    } catch (error: any) {
      logger.error({ error: error.message }, "Failed to fetch HAProxy backends");
      res.status(500).json({
        success: false,
        error: "Failed to fetch HAProxy backends",
        message: error.message,
      });
    }
  }
);

/**
 * GET /api/haproxy/backends/:backendName
 * Get a specific backend with its servers (requires ?environmentId=)
 */
router.get(
  "/:backendName",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { backendName } = req.params;
      const { environmentId } = req.query;

      if (!environmentId || typeof environmentId !== "string") {
        return res.status(400).json({
          success: false,
          error: "environmentId query parameter is required",
        });
      }

      const backend = await prisma.hAProxyBackend.findUnique({
        where: {
          name_environmentId: {
            name: backendName,
            environmentId,
          },
        },
        include: {
          servers: {
            orderBy: { createdAt: "asc" },
          },
          _count: {
            select: { servers: true },
          },
        },
      });

      if (!backend) {
        return res.status(404).json({
          success: false,
          error: "Backend not found",
        });
      }

      const response: HAProxyBackendResponse = {
        success: true,
        data: serializeBackend(backend),
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, backendName: req.params.backendName },
        "Failed to fetch HAProxy backend"
      );
      res.status(500).json({
        success: false,
        error: "Failed to fetch HAProxy backend",
        message: error.message,
      });
    }
  }
);

/**
 * PATCH /api/haproxy/backends/:backendName
 * Update backend config — propagate balanceAlgorithm/timeouts to HAProxy
 * Requires ?environmentId= query parameter
 */
router.patch(
  "/:backendName",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { backendName } = req.params;
      const { environmentId } = req.query;

      if (!environmentId || typeof environmentId !== "string") {
        return res.status(400).json({
          success: false,
          error: "environmentId query parameter is required",
        });
      }

      const validationResult = updateBackendSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: validationResult.error.issues,
        });
      }

      // Find backend in DB
      const backend = await prisma.hAProxyBackend.findUnique({
        where: {
          name_environmentId: {
            name: backendName,
            environmentId,
          },
        },
      });

      if (!backend) {
        return res.status(404).json({
          success: false,
          error: "Backend not found",
        });
      }

      if (backend.status === "removed") {
        return res.status(400).json({
          success: false,
          error: "Cannot update a removed backend",
        });
      }

      const updates = validationResult.data;

      // Propagate to HAProxy via DataPlane API
      try {
        const haproxyClient = await getHAProxyClient(environmentId);

        // Get current backend config from HAProxy
        const existingBackend = await haproxyClient.getBackend(backendName);
        if (existingBackend) {
          // Build update payload for HAProxy DataPlane API
          const haproxyUpdate: any = {
            name: backendName,
            mode: backend.mode,
          };

          if (updates.balanceAlgorithm) {
            haproxyUpdate.balance = { algorithm: updates.balanceAlgorithm };
          }

          // Apply timeouts if provided
          if (updates.checkTimeout !== undefined) {
            haproxyUpdate.check_timeout = updates.checkTimeout;
          }
          if (updates.connectTimeout !== undefined) {
            haproxyUpdate.connect_timeout = updates.connectTimeout;
          }
          if (updates.serverTimeout !== undefined) {
            haproxyUpdate.server_timeout = updates.serverTimeout;
          }

          // Use DataPlane API to update backend
          const version = await haproxyClient.getVersion();
          await (haproxyClient as any).axiosInstance.put(
            `/services/haproxy/configuration/backends/${backendName}?version=${version}`,
            haproxyUpdate
          );

          logger.info(
            { backendName, updates },
            "Backend config propagated to HAProxy"
          );
        }
      } catch (haproxyError: any) {
        logger.warn(
          { backendName, error: haproxyError.message },
          "Failed to propagate backend update to HAProxy (updating DB only)"
        );
      }

      // Update database
      const dbUpdate: any = {};
      if (updates.balanceAlgorithm) dbUpdate.balanceAlgorithm = updates.balanceAlgorithm;
      if (updates.checkTimeout !== undefined) dbUpdate.checkTimeout = updates.checkTimeout;
      if (updates.connectTimeout !== undefined) dbUpdate.connectTimeout = updates.connectTimeout;
      if (updates.serverTimeout !== undefined) dbUpdate.serverTimeout = updates.serverTimeout;

      const updatedBackend = await prisma.hAProxyBackend.update({
        where: { id: backend.id },
        data: dbUpdate,
        include: {
          servers: true,
          _count: { select: { servers: true } },
        },
      });

      const response: HAProxyBackendResponse = {
        success: true,
        data: serializeBackend(updatedBackend),
        message: "Backend updated successfully",
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, backendName: req.params.backendName },
        "Failed to update HAProxy backend"
      );
      res.status(500).json({
        success: false,
        error: "Failed to update HAProxy backend",
        message: error.message,
      });
    }
  }
);

/**
 * GET /api/haproxy/backends/:backendName/servers
 * List servers in a backend (requires ?environmentId=)
 */
router.get(
  "/:backendName/servers",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { backendName } = req.params;
      const { environmentId } = req.query;

      if (!environmentId || typeof environmentId !== "string") {
        return res.status(400).json({
          success: false,
          error: "environmentId query parameter is required",
        });
      }

      const backend = await prisma.hAProxyBackend.findUnique({
        where: {
          name_environmentId: {
            name: backendName,
            environmentId,
          },
        },
        include: {
          servers: {
            orderBy: { createdAt: "asc" },
          },
        },
      });

      if (!backend) {
        return res.status(404).json({
          success: false,
          error: "Backend not found",
        });
      }

      const response: HAProxyServerListResponse = {
        success: true,
        data: backend.servers.map((s: any) => serializeServer({ ...s, backend: { name: backendName } })),
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, backendName: req.params.backendName },
        "Failed to fetch servers for backend"
      );
      res.status(500).json({
        success: false,
        error: "Failed to fetch servers",
        message: error.message,
      });
    }
  }
);

/**
 * GET /api/haproxy/backends/:backendName/servers/:serverName
 * Get a specific server (requires ?environmentId=)
 */
router.get(
  "/:backendName/servers/:serverName",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { backendName, serverName } = req.params;
      const { environmentId } = req.query;

      if (!environmentId || typeof environmentId !== "string") {
        return res.status(400).json({
          success: false,
          error: "environmentId query parameter is required",
        });
      }

      const backend = await prisma.hAProxyBackend.findUnique({
        where: {
          name_environmentId: {
            name: backendName,
            environmentId,
          },
        },
      });

      if (!backend) {
        return res.status(404).json({
          success: false,
          error: "Backend not found",
        });
      }

      const server = await prisma.hAProxyServer.findUnique({
        where: {
          name_backendId: {
            name: serverName,
            backendId: backend.id,
          },
        },
      });

      if (!server) {
        return res.status(404).json({
          success: false,
          error: "Server not found",
        });
      }

      const response: HAProxyServerResponse = {
        success: true,
        data: serializeServer({ ...server, backend: { name: backendName } }),
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, backendName: req.params.backendName, serverName: req.params.serverName },
        "Failed to fetch server"
      );
      res.status(500).json({
        success: false,
        error: "Failed to fetch server",
        message: error.message,
      });
    }
  }
);

/**
 * PATCH /api/haproxy/backends/:backendName/servers/:serverName
 * Update server — propagate weight/enabled/maintenance to HAProxy runtime API;
 * checkPath/inter/rise/fall are DB-only (applied on next remediation/sync)
 * Requires ?environmentId= query parameter
 */
router.patch(
  "/:backendName/servers/:serverName",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { backendName, serverName } = req.params;
      const { environmentId } = req.query;

      if (!environmentId || typeof environmentId !== "string") {
        return res.status(400).json({
          success: false,
          error: "environmentId query parameter is required",
        });
      }

      const validationResult = updateServerSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: validationResult.error.issues,
        });
      }

      const backend = await prisma.hAProxyBackend.findUnique({
        where: {
          name_environmentId: {
            name: backendName,
            environmentId,
          },
        },
      });

      if (!backend) {
        return res.status(404).json({
          success: false,
          error: "Backend not found",
        });
      }

      const server = await prisma.hAProxyServer.findUnique({
        where: {
          name_backendId: {
            name: serverName,
            backendId: backend.id,
          },
        },
      });

      if (!server) {
        return res.status(404).json({
          success: false,
          error: "Server not found",
        });
      }

      if (server.status === "removed") {
        return res.status(400).json({
          success: false,
          error: "Cannot update a removed server",
        });
      }

      const updates = validationResult.data;

      // Propagate runtime-modifiable fields to HAProxy
      const runtimeUpdates = ['weight', 'enabled', 'maintenance'] as const;
      const hasRuntimeUpdates = runtimeUpdates.some((key) => updates[key] !== undefined);

      if (hasRuntimeUpdates) {
        try {
          const haproxyClient = await getHAProxyClient(environmentId);

          // Use runtime API to update server state
          if (updates.weight !== undefined) {
            await (haproxyClient as any).axiosInstance.put(
              `/services/haproxy/runtime/servers/${backendName}/${serverName}`,
              { operational_state: server.enabled ? "up" : "down", admin_state: server.maintenance ? "maint" : "ready", weight: updates.weight }
            );
          }

          if (updates.maintenance !== undefined) {
            const adminState = updates.maintenance ? "maint" : "ready";
            await (haproxyClient as any).axiosInstance.put(
              `/services/haproxy/runtime/servers/${backendName}/${serverName}`,
              { admin_state: adminState }
            );
          }

          if (updates.enabled !== undefined) {
            const opState = updates.enabled ? "up" : "down";
            await (haproxyClient as any).axiosInstance.put(
              `/services/haproxy/runtime/servers/${backendName}/${serverName}`,
              { operational_state: opState }
            );
          }

          logger.info(
            { backendName, serverName, updates },
            "Server runtime state propagated to HAProxy"
          );
        } catch (haproxyError: any) {
          logger.warn(
            { backendName, serverName, error: haproxyError.message },
            "Failed to propagate server update to HAProxy (updating DB only)"
          );
        }
      }

      // Update database
      const dbUpdate: any = {};
      if (updates.weight !== undefined) dbUpdate.weight = updates.weight;
      if (updates.enabled !== undefined) dbUpdate.enabled = updates.enabled;
      if (updates.maintenance !== undefined) dbUpdate.maintenance = updates.maintenance;
      if (updates.checkPath !== undefined) dbUpdate.checkPath = updates.checkPath;
      if (updates.inter !== undefined) dbUpdate.inter = updates.inter;
      if (updates.rise !== undefined) dbUpdate.rise = updates.rise;
      if (updates.fall !== undefined) dbUpdate.fall = updates.fall;

      const updatedServer = await prisma.hAProxyServer.update({
        where: { id: server.id },
        data: dbUpdate,
      });

      const response: HAProxyServerResponse = {
        success: true,
        data: serializeServer({ ...updatedServer, backend: { name: backendName } }),
        message: "Server updated successfully",
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, backendName: req.params.backendName, serverName: req.params.serverName },
        "Failed to update server"
      );
      res.status(500).json({
        success: false,
        error: "Failed to update server",
        message: error.message,
      });
    }
  }
);

export default router;
