import express, { RequestHandler } from "express";
import { z } from "zod";
import { ErrorCode } from "@mini-infra/types";
import { getLogger } from "../../lib/logger-factory";
import { asyncHandler } from "../../lib/async-handler";
import { UnauthorizedError } from "../../lib/errors";
import { requirePermission, getCurrentUserId } from "../../middleware/auth";
import postgresServerService from "../../services/postgres-server/server-manager";
import serverHealthScheduler from "../../services/postgres-server/health-scheduler";
import { POSTGRES_SSL_MODES, Permission } from "@mini-infra/types";

const logger = getLogger("db", "servers");
const router = express.Router();

// Helper to extract userId or throw
function getUserId(req: express.Request): string {
  const userId = getCurrentUserId(req);
  if (!userId) {
    throw new UnauthorizedError(ErrorCode.USER_NOT_AUTHENTICATED, "User not authenticated");
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
  sslMode: z.enum(POSTGRES_SSL_MODES).default("prefer"),
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
  sslMode: z.enum(POSTGRES_SSL_MODES).optional(),
  tags: z.array(z.string()).optional(),
  linkedContainerId: z.string().nullable().optional(),
  linkedContainerName: z.string().nullable().optional(),
});

const testConnectionSchema = z.object({
  host: z.string().min(1, "Host is required"),
  port: z.number().int().min(1).max(65535).default(5432),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  sslMode: z.enum(POSTGRES_SSL_MODES).default("prefer"),
});

/**
 * GET /api/postgres-server/servers
 * List all servers for the authenticated user
 */
router.get(
  "/",
  requirePermission(Permission.PostgresRead) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const servers = await postgresServerService.listServers(userId);

    // Never leak connection strings (contain passwords) to the client
    const sanitizedServers = servers.map((server) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { connectionString, ...rest } = server;
      return rest;
    });

    res.json({
      success: true,
      data: sanitizedServers,
    });
  }),
);

/**
 * POST /api/postgres-server/servers
 * Create a new server connection
 */
router.post(
  "/",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
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
    } catch (healthCheckError: unknown) {
      // Log error but don't fail the request - health check will retry on next scheduled run
      logger.warn(
        { serverId: server.id, error: healthCheckError instanceof Error ? healthCheckError.message : String(healthCheckError) },
        "Immediate health check failed after server creation, will retry on next scheduled run"
      );
    }

    // Remove encrypted connection string from response
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { connectionString, ...sanitizedServer } = server;

    res.status(201).json({
      success: true,
      data: {
        server: sanitizedServer,
        syncResults,
      },
    });
  }),
);

/**
 * GET /api/postgres-server/servers/:id
 * Get server details
 */
router.get(
  "/:id",
  requirePermission(Permission.PostgresRead) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const serverId = String(req.params.id);

    const server = await postgresServerService.getServer(serverId, userId);

    // Remove encrypted connection string from response
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { connectionString, ...sanitizedServer } = server;

    res.json({
      success: true,
      data: sanitizedServer,
    });
  }),
);

/**
 * PUT /api/postgres-server/servers/:id
 * Update server
 */
router.put(
  "/:id",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const serverId = String(req.params.id);
    const validatedData = updateServerSchema.parse(req.body);

    const server = await postgresServerService.updateServer(serverId, userId, validatedData);

    // Remove encrypted connection string from response
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { connectionString, ...sanitizedServer } = server;

    res.json({
      success: true,
      data: sanitizedServer,
    });
  }),
);

/**
 * DELETE /api/postgres-server/servers/:id
 * Delete server
 */
router.delete(
  "/:id",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const serverId = String(req.params.id);

    await postgresServerService.deleteServer(serverId, userId);

    res.json({
      success: true,
      message: "Server deleted successfully",
    });
  }),
);

/**
 * POST /api/postgres-server/servers/:id/sync
 * Sync databases and users for an existing server from the live PostgreSQL instance
 */
router.post(
  "/:id/sync",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const serverId = String(req.params.id);

    const syncResults = await postgresServerService.syncServer(serverId, userId);

    res.json({
      success: true,
      data: syncResults,
      message: "Server synced successfully",
    });
  }),
);

/**
 * POST /api/postgres-server/servers/test-connection
 * Test connection to a PostgreSQL server (without creating a server record)
 */
router.post(
  "/test-connection",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
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
  }),
);

/**
 * POST /api/postgres-server/servers/:id/test
 * Test connection for an existing server
 */
router.post(
  "/:id/test",
  requirePermission(Permission.PostgresWrite) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const serverId = String(req.params.id);

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
  }),
);

/**
 * GET /api/postgres-server/servers/:id/info
 * Get server information (version, uptime, database count, etc.)
 */
router.get(
  "/:id/info",
  requirePermission(Permission.PostgresRead) as RequestHandler,
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const serverId = String(req.params.id);

    const info = await postgresServerService.getServerInfo(serverId, userId);

    res.json({
      success: true,
      data: info,
    });
  }),
);

// Import and mount sub-routers for databases and users
import postgresServerDatabasesRoutes from './databases';
import postgresServerUsersRoutes from './users';

// Mount sub-routers with path parameters (Express 5 supports this with mergeParams)
router.use('/:serverId/databases', postgresServerDatabasesRoutes);
router.use('/:serverId/users', postgresServerUsersRoutes);

export default router;
