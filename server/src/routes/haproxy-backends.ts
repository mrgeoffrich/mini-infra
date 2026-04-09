import express, { Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requirePermission } from "../middleware/auth";
import prisma from "../lib/prisma";
import {
  HAProxyBackendInfo,
  HAProxyBackendListResponse,
  HAProxyBackendResponse,
  HAProxyServerInfo,
  HAProxyServerListResponse,
  HAProxyServerResponse,
  ForceDeleteBackendResponse,
  ForceDeleteServerResponse,
  BackendSourceType,
} from "@mini-infra/types";
import { HAProxyDataPlaneClient } from "../services/haproxy/haproxy-dataplane-client";
import DockerService from "../services/docker";
import { emitHAProxyUpdate } from "../services/haproxy-socket-emitter";

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
    sourceType: backend.sourceType as BackendSourceType,
    manualFrontendId: backend.manualFrontendId,
    status: backend.status as "active" | "failed",
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
    status: server.status as "active" | "draining",
    errorMessage: server.errorMessage,
    createdAt: server.createdAt.toISOString(),
    updatedAt: server.updatedAt.toISOString(),
  };
}

async function getHAProxyClient(environmentId: string): Promise<HAProxyDataPlaneClient> {
  const environment = await prisma.environment.findUnique({
    where: { id: environmentId },
  });

  if (!environment) {
    throw new Error(`Environment not found: ${environmentId}`);
  }

  const haproxyStack = await prisma.stack.findFirst({
    where: { environmentId, name: 'haproxy', status: { not: 'removed' } },
  });

  if (!haproxyStack) {
    throw new Error(`HAProxy stack not found for environment: ${environmentId}`);
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
  requirePermission('haproxy:read') as RequestHandler,
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
  requirePermission('haproxy:read') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const backendName = String(req.params.backendName);
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
  requirePermission('haproxy:write') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const backendName = String(req.params.backendName);
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
          await haproxyClient.updateBackend(backendName, haproxyUpdate);

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

      emitHAProxyUpdate();
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
  requirePermission('haproxy:read') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const backendName = String(req.params.backendName);
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
  requirePermission('haproxy:read') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const backendName = String(req.params.backendName); const serverName = String(req.params.serverName);
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
  requirePermission('haproxy:write') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const backendName = String(req.params.backendName); const serverName = String(req.params.serverName);
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




      const updates = validationResult.data;

      // Propagate runtime-modifiable fields to HAProxy
      const runtimeUpdates = ['weight', 'enabled', 'maintenance'] as const;
      const hasRuntimeUpdates = runtimeUpdates.some((key) => updates[key] !== undefined);

      if (hasRuntimeUpdates) {
        try {
          const haproxyClient = await getHAProxyClient(environmentId);

          // Build a single runtime payload with all updates
          const runtimePayload: Record<string, unknown> = {};

          if (updates.weight !== undefined) {
            runtimePayload.weight = updates.weight;
          }

          // Use the new value if provided, otherwise fall back to the current DB value
          const effectiveEnabled = updates.enabled !== undefined ? updates.enabled : server.enabled;
          const effectiveMaintenance = updates.maintenance !== undefined ? updates.maintenance : server.maintenance;

          runtimePayload.operational_state = effectiveEnabled ? "up" : "down";
          runtimePayload.admin_state = effectiveMaintenance ? "maint" : "ready";

          await haproxyClient.updateServerRuntime(backendName, serverName, runtimePayload);

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

      emitHAProxyUpdate();
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

/**
 * DELETE /api/haproxy/backends/:backendName/servers/:serverName
 * Force-delete a server from a backend. Removes from both HAProxy and the database.
 * Requires ?environmentId= query parameter.
 */
router.delete(
  "/:backendName/servers/:serverName",
  requirePermission('haproxy:write') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const backendName = String(req.params.backendName);
      const serverName = String(req.params.serverName);
      const { environmentId } = req.query;

      if (!environmentId || typeof environmentId !== "string") {
        return res.status(400).json({
          success: false,
          error: "environmentId query parameter is required",
        });
      }

      // Find the backend
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

      // Find the server
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

      // Try to remove from HAProxy — don't fail if HAProxy is unavailable
      let haproxyCleanedUp = false;
      try {
        const haproxyClient = await getHAProxyClient(environmentId);
        await haproxyClient.deleteServer(backendName, serverName);
        haproxyCleanedUp = true;
      } catch (haproxyError: any) {
        logger.warn(
          { error: haproxyError.message, backendName, serverName },
          "Failed to remove server from HAProxy during force-delete, cleaning up database only"
        );
      }

      // Delete from database
      await prisma.hAProxyServer.delete({
        where: { id: server.id },
      });

      logger.info(
        { backendName, serverName, haproxyCleanedUp },
        "Force-deleted server from backend"
      );

      emitHAProxyUpdate();

      const response: ForceDeleteServerResponse = {
        success: true,
        message: haproxyCleanedUp
          ? `Server '${serverName}' removed from HAProxy and database`
          : `Server '${serverName}' removed from database only (HAProxy was unavailable)`,
        backendName,
        serverName,
      };
      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, backendName: req.params.backendName, serverName: req.params.serverName },
        "Failed to force-delete server"
      );
      res.status(500).json({
        success: false,
        error: "Failed to force-delete server",
        message: error.message,
      });
    }
  }
);

/**
 * DELETE /api/haproxy/backends/:backendName
 * Force-delete a backend and all its servers. Emergency cleanup endpoint — not for UI use.
 * Requires ?environmentId= query parameter.
 */
router.delete(
  "/:backendName",
  requirePermission('haproxy:write') as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const backendName = String(req.params.backendName);
      const { environmentId } = req.query;

      if (!environmentId || typeof environmentId !== "string") {
        return res.status(400).json({
          success: false,
          error: "environmentId query parameter is required",
        });
      }

      // Fetch backend with servers
      const backend = await prisma.hAProxyBackend.findUnique({
        where: {
          name_environmentId: {
            name: backendName,
            environmentId,
          },
        },
        include: { servers: true },
      });

      if (!backend) {
        return res.status(404).json({
          success: false,
          error: "Backend not found",
        });
      }

      // Try to clean up HAProxy config — but don't fail if HAProxy is unavailable
      let haproxyCleanedUp = false;
      try {
        const haproxyClient = await getHAProxyClient(environmentId);

        // Remove all servers from the backend in HAProxy
        for (const server of backend.servers) {
          try {
            await haproxyClient.deleteServer(backendName, server.name);
          } catch (serverError: any) {
            logger.warn(
              { error: serverError.message, serverName: server.name, backendName },
              "Failed to remove server from HAProxy during force-delete, continuing"
            );
          }
        }

        // Remove the backend itself from HAProxy
        try {
          await haproxyClient.deleteBackend(backendName);
        } catch (backendError: any) {
          logger.warn(
            { error: backendError.message, backendName },
            "Failed to remove backend from HAProxy during force-delete, continuing"
          );
        }

        haproxyCleanedUp = true;
      } catch (haproxyError: any) {
        logger.warn(
          { error: haproxyError.message, backendName },
          "HAProxy unavailable during force-delete, cleaning up database only"
        );
      }

      const totalDeletedServers = backend.servers.length;

      // Delete servers from database (cascade should handle this, but be explicit)
      await prisma.hAProxyServer.deleteMany({
        where: { backendId: backend.id },
      });

      // Delete the backend record
      await prisma.hAProxyBackend.delete({
        where: { id: backend.id },
      });

      logger.info(
        { backendName, deletedServers: totalDeletedServers, haproxyCleanedUp },
        "Force-deleted backend and all servers"
      );

      emitHAProxyUpdate();

      const response: ForceDeleteBackendResponse = {
        success: true,
        message: haproxyCleanedUp
          ? `Backend and ${totalDeletedServers} server(s) removed from HAProxy and database`
          : `Backend and ${totalDeletedServers} server(s) removed from database only (HAProxy was unavailable)`,
        deletedServers: totalDeletedServers,
        backendName,
      };
      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, backendName: req.params.backendName },
        "Failed to force-delete backend"
      );
      res.status(500).json({
        success: false,
        error: "Failed to force-delete backend",
        message: error.message,
      });
    }
  }
);

export default router;
