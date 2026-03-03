import express from "express";
import { z } from "zod";
import { appLogger } from "../../lib/logger-factory";
import { requirePermission, getCurrentUserId } from "../../middleware/auth";
import postgresServerService from "../../services/postgres-server/server-manager";
import serverHealthScheduler from "../../services/postgres-server/health-scheduler";

const logger = appLogger();
const router = express.Router();

// Helper to extract userId or throw
function getUserId(req: express.Request): string {
  const userId = getCurrentUserId(req);
  if (!userId) {
    throw new Error("Unauthorized");
  }
  return userId;
}

// Validation schemas
const createServerSchema = z.object({
  name: z.string().min(1, "Name is required"),
  host: z.string().min(1, "Host is required"),
  port: z.number().int().min(1).max(65535).default(5432),
  adminUsername: z.string().min(1, "Admin username is required"),
  adminPassword: z.string().min(1, "Admin password is required"),
  sslMode: z.enum(["prefer", "require", "disable"]).default("prefer"),
  tags: z.array(z.string()).optional(),
  linkedContainerId: z.string().optional(),
  linkedContainerName: z.string().optional(),
});

const updateServerSchema = z.object({
  name: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  adminUsername: z.string().min(1).optional(),
  adminPassword: z.string().min(1).optional(),
  sslMode: z.enum(["prefer", "require", "disable"]).optional(),
  tags: z.array(z.string()).optional(),
  linkedContainerId: z.string().nullable().optional(),
  linkedContainerName: z.string().nullable().optional(),
});

const testConnectionSchema = z.object({
  host: z.string().min(1, "Host is required"),
  port: z.number().int().min(1).max(65535).default(5432),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  sslMode: z.enum(["prefer", "require", "disable"]).default("prefer"),
});

/**
 * GET /api/postgres-server/servers
 * List all servers for the authenticated user
 */
router.get("/", requirePermission('postgres:read'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const servers = await postgresServerService.listServers(userId);

    // Remove encrypted connection strings from response
    const sanitizedServers = servers.map((server) => {
      const { connectionString, ...rest } = server;
      return rest;
    });

    res.json({
      success: true,
      data: sanitizedServers,
    });
  } catch (error: any) {
    logger.error({ error: error.message }, "Failed to list servers");
    res.status(500).json({
      success: false,
      error: "Failed to list servers",
      message: error.message,
    });
  }
});

/**
 * POST /api/postgres-server/servers
 * Create a new server connection
 */
router.post("/", requirePermission('postgres:write'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const validatedData = createServerSchema.parse(req.body);

    const { server, syncResults } = await postgresServerService.createServer({
      ...validatedData,
      userId,
    });

    // Trigger immediate health check for the newly created server
    try {
      await serverHealthScheduler.performHealthCheckForServer(server.id, userId);
      logger.info({ serverId: server.id }, "Immediate health check completed after server creation");
    } catch (healthCheckError: any) {
      // Log error but don't fail the request - health check will retry on next scheduled run
      logger.warn(
        { serverId: server.id, error: healthCheckError.message },
        "Immediate health check failed after server creation, will retry on next scheduled run"
      );
    }

    // Remove encrypted connection string from response
    const { connectionString, ...sanitizedServer } = server;

    res.status(201).json({
      success: true,
      data: {
        server: sanitizedServer,
        syncResults,
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.issues,
      });
    }

    logger.error({ error: error.message }, "Failed to create server");
    res.status(500).json({
      success: false,
      error: "Failed to create server",
      message: error.message,
    });
  }
});

/**
 * GET /api/postgres-server/servers/:id
 * Get server details
 */
router.get("/:id", requirePermission('postgres:read'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = req.params.id;

    const server = await postgresServerService.getServer(serverId, userId);

    // Remove encrypted connection string from response
    const { connectionString, ...sanitizedServer } = server;

    res.json({
      success: true,
      data: sanitizedServer,
    });
  } catch (error: any) {
    if (error.message === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    logger.error({ error: error.message }, "Failed to get server");
    res.status(500).json({
      success: false,
      error: "Failed to get server",
      message: error.message,
    });
  }
});

/**
 * PUT /api/postgres-server/servers/:id
 * Update server
 */
router.put("/:id", requirePermission('postgres:write'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = req.params.id;
    const validatedData = updateServerSchema.parse(req.body);

    const server = await postgresServerService.updateServer(serverId, userId, validatedData);

    // Remove encrypted connection string from response
    const { connectionString, ...sanitizedServer } = server;

    res.json({
      success: true,
      data: sanitizedServer,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.issues,
      });
    }

    if (error.message === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    logger.error({ error: error.message }, "Failed to update server");
    res.status(500).json({
      success: false,
      error: "Failed to update server",
      message: error.message,
    });
  }
});

/**
 * DELETE /api/postgres-server/servers/:id
 * Delete server
 */
router.delete("/:id", requirePermission('postgres:write'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = req.params.id;

    await postgresServerService.deleteServer(serverId, userId);

    res.json({
      success: true,
      message: "Server deleted successfully",
    });
  } catch (error: any) {
    if (error.message === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    logger.error({ error: error.message }, "Failed to delete server");
    res.status(500).json({
      success: false,
      error: "Failed to delete server",
      message: error.message,
    });
  }
});

/**
 * POST /api/postgres-server/servers/test-connection
 * Test connection to a PostgreSQL server (without creating a server record)
 */
router.post("/test-connection", requirePermission('postgres:write'), async (req, res) => {
  try {
    const validatedData = testConnectionSchema.parse(req.body);

    const result = await postgresServerService.testConnection(validatedData);

    if (result.success) {
      res.json({
        success: true,
        message: "Connection successful",
        version: result.version,
      });
    } else {
      res.status(400).json({
        success: false,
        error: "Connection failed",
        message: result.error,
      });
    }
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.issues,
      });
    }

    logger.error({ error: error.message }, "Failed to test connection");
    res.status(500).json({
      success: false,
      error: "Failed to test connection",
      message: error.message,
    });
  }
});

/**
 * POST /api/postgres-server/servers/:id/test
 * Test connection for an existing server
 */
router.post("/:id/test", requirePermission('postgres:write'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = req.params.id;

    const result = await postgresServerService.testServerConnection(serverId, userId);

    if (result.success) {
      res.json({
        success: true,
        message: "Connection successful",
        version: result.version,
      });
    } else {
      res.status(400).json({
        success: false,
        error: "Connection failed",
        message: result.error,
      });
    }
  } catch (error: any) {
    if (error.message === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    logger.error({ error: error.message }, "Failed to test server connection");
    res.status(500).json({
      success: false,
      error: "Failed to test server connection",
      message: error.message,
    });
  }
});

/**
 * GET /api/postgres-server/servers/:id/info
 * Get server information (version, uptime, database count, etc.)
 */
router.get("/:id/info", requirePermission('postgres:read'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const serverId = req.params.id;

    const info = await postgresServerService.getServerInfo(serverId, userId);

    res.json({
      success: true,
      data: info,
    });
  } catch (error: any) {
    if (error.message === "Server not found") {
      return res.status(404).json({
        success: false,
        error: "Server not found",
      });
    }

    logger.error({ error: error.message }, "Failed to get server info");
    res.status(500).json({
      success: false,
      error: "Failed to get server info",
      message: error.message,
    });
  }
});

// Import and mount sub-routers for databases and users
import postgresServerDatabasesRoutes from './databases';
import postgresServerUsersRoutes from './users';

// Mount sub-routers with path parameters (Express 5 supports this with mergeParams)
router.use('/:serverId/databases', postgresServerDatabasesRoutes);
router.use('/:serverId/users', postgresServerUsersRoutes);

export default router;
