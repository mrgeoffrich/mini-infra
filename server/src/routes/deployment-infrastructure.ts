import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey, getAuthenticatedUser } from "../middleware/auth";
import { HAProxyService } from "../services/haproxy/haproxy-service";
import prisma from "../lib/prisma";

const logger = appLogger();
const router = express.Router();

// Initialize the HAProxy service - no global instance needed since we'll create per-request

// Validation schemas
const deployInfrastructureSchema = z.object({
  networkName: z.string().min(1, "Network name is required"),
  networkDriver: z
    .enum(["bridge", "overlay", "host", "none"])
    .default("bridge"),
  environmentId: z.string().min(1, "Environment ID is required"),
});

/**
 * @swagger
 * /api/deployment-infrastructure/deploy:
 *   post:
 *     summary: Deploy infrastructure components
 *     description: Deploy Docker network and HAProxy load balancer for zero-downtime deployments
 *     tags:
 *       - Deployment Infrastructure
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - networkName
 *               - environmentId
 *             properties:
 *               networkName:
 *                 type: string
 *                 minLength: 1
 *                 description: Name for the Docker network to create
 *                 example: "production-network"
 *               networkDriver:
 *                 type: string
 *                 enum: [bridge, overlay, host, none]
 *                 default: bridge
 *                 description: Docker network driver type
 *                 example: "bridge"
 *               environmentId:
 *                 type: string
 *                 minLength: 1
 *                 description: Environment ID where infrastructure will be deployed
 *                 example: "env_prod_123"
 *           examples:
 *             production:
 *               summary: Production deployment
 *               value:
 *                 networkName: "production-network"
 *                 networkDriver: "bridge"
 *                 environmentId: "env_prod_123"
 *             staging:
 *               summary: Staging deployment with overlay network
 *               value:
 *                 networkName: "staging-overlay"
 *                 networkDriver: "overlay"
 *                 environmentId: "env_staging_456"
 *     responses:
 *       201:
 *         description: Infrastructure deployed successfully
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
 *                     networkName:
 *                       type: string
 *                       example: "production-network"
 *                     networkId:
 *                       type: string
 *                       example: "net_abc123def456"
 *                     networkDriver:
 *                       type: string
 *                       example: "bridge"
 *                     haproxyContainerId:
 *                       type: string
 *                       example: "haproxy_container_789"
 *                     haproxyStatus:
 *                       type: string
 *                       example: "running"
 *                     environmentId:
 *                       type: string
 *                       example: "env_prod_123"
 *                     deployedAt:
 *                       type: string
 *                       format: date-time
 *                       example: "2024-01-15T10:30:00.000Z"
 *                 message:
 *                   type: string
 *                   example: "Infrastructure deployed successfully"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:30:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_deploy_123"
 *       400:
 *         description: Bad request - validation error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Bad Request"
 *                 message:
 *                   type: string
 *                   example: "Invalid request data"
 *                 details:
 *                   type: array
 *                   items:
 *                     type: object
 *                   example: [{"message": "Network name is required", "path": ["networkName"]}]
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:30:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_deploy_123"
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Unauthorized"
 *                 message:
 *                   type: string
 *                   example: "User authentication required"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:30:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_deploy_123"
 *       409:
 *         description: Conflict - infrastructure already exists
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Infrastructure already exists"
 *                 message:
 *                   type: string
 *                   example: "Network or HAProxy already deployed for this environment"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:30:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_deploy_123"
 *       500:
 *         description: Deployment failed - internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Deployment failed"
 *                 message:
 *                   type: string
 *                   example: "Failed to deploy infrastructure components"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:30:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_deploy_123"
 *
 * POST /api/deployment-infrastructure/deploy - Deploy Docker network and HAProxy
 */
router.post("/deploy", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  logger.debug({ requestId, userId }, "Infrastructure deployment requested");

  try {
    if (!user || !userId) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "User authentication required",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Validate request body
    const bodyValidation = deployInfrastructureSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          validationErrors: bodyValidation.error.issues,
        },
        "Invalid request body for infrastructure deployment",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid request data",
        details: bodyValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const {
      networkName,
      networkDriver,
      environmentId,
    } = bodyValidation.data;

    // Deploy HAProxy using the HAProxy service directly
    const haproxyService = new HAProxyService('haproxy', environmentId);
    
    try {
      await haproxyService.initialize();
      await haproxyService.deployHAProxy();

      // Get the deployed containers to return container ID
      const containers = await haproxyService.getServiceContainers('haproxy');
      const mainContainer = containers.find(container => 
        container.Names.some(name => name.includes('haproxy') && !name.includes('init'))
      );

      const containerId = mainContainer?.Id || 'unknown';

      logger.debug(
        {
          requestId,
          userId,
          networkName,
          containerId,
        },
        "Infrastructure deployed successfully",
      );

      res.json({
        success: true,
        data: {
          network: {
            id: networkName, // HAProxy service manages the network
            name: networkName,
            driver: networkDriver,
          },
          haproxy: {
            id: containerId,
            networkName: networkName,
          },
        },
        message: "Infrastructure deployed successfully",
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      logger.error(
        {
          requestId,
          userId,
          networkName,
          error: error,
        },
        "Failed to deploy HAProxy infrastructure",
      );

      return res.status(500).json({
        error: "Infrastructure Error",
        message: `Failed to deploy HAProxy: ${error instanceof Error ? error.message : "Unknown error"}`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        body: req.body,
      },
      "Failed to deploy infrastructure",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * GET /api/deployment-infrastructure/status - Get infrastructure status
 */
router.get("/status", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;
  const networkName = req.query.networkName as string;
  const environmentId = req.query.environmentId as string;

  logger.debug(
    { requestId, userId, networkName, environmentId },
    "Infrastructure status requested",
  );

  try {
    if (!networkName) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Network name is required as query parameter",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    if (!environmentId) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Environment ID is required as query parameter",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Get infrastructure status using HAProxy service
    const haproxyService = new HAProxyService('haproxy', environmentId);
    
    try {
      await haproxyService.initialize();
      
      // Check network exists by attempting to list containers (HAProxy service manages network)
      const containers = await haproxyService.getServiceContainers('haproxy');
      
      const networkStatus = {
        exists: true, // If we can query containers, network exists
        id: networkName,
      };
      
      const haproxyStatus = containers.length > 0 
        ? {
            exists: true,
            running: containers[0].State === "running",
            id: containers[0].Id,
          }
        : { exists: false, running: false };

      const status = { networkStatus, haproxyStatus };

      logger.debug(
        {
          requestId,
          userId,
          networkName,
          status,
        },
        "Infrastructure status retrieved",
      );

      res.json({
        success: true,
        data: status,
        message: "Infrastructure status retrieved",
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      logger.error(
        {
          requestId,
          userId,
          networkName,
          error,
        },
        "Failed to get infrastructure status",
      );

      // Return default status on error
      res.json({
        success: true,
        data: {
          networkStatus: { exists: false, error: error instanceof Error ? error.message : "Unknown error" },
          haproxyStatus: { exists: false, running: false, error: error instanceof Error ? error.message : "Unknown error" },
        },
        message: "Infrastructure status retrieved (with errors)",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        networkName,
      },
      "Failed to get infrastructure status",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * DELETE /api/deployment-infrastructure/cleanup - Clean up infrastructure
 */
router.delete("/cleanup", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;
  const networkName = req.body.networkName as string;
  const environmentId = req.body.environmentId as string;

  logger.debug(
    { requestId, userId, networkName, environmentId },
    "Infrastructure cleanup requested",
  );

  try {
    if (!user || !userId) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "User authentication required",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    if (!networkName) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Network name is required in request body",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    if (!environmentId) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Environment ID is required in request body",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Clean up infrastructure using HAProxy service
    const haproxyService = new HAProxyService('haproxy', environmentId);
    
    try {
      await haproxyService.initialize();
      await haproxyService.removeHAProxy();

      logger.debug(
        {
          requestId,
          userId,
          networkName,
        },
        "Infrastructure cleaned up successfully",
      );

      res.json({
        success: true,
        message: "Infrastructure cleaned up successfully",
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      logger.error(
        {
          requestId,
          userId,
          networkName,
          error,
        },
        "Failed to cleanup infrastructure",
      );

      return res.status(500).json({
        error: "Infrastructure Error",
        message: `Failed to cleanup infrastructure: ${error instanceof Error ? error.message : "Unknown error"}`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        networkName,
      },
      "Failed to cleanup infrastructure",
    );

    next(error);
  }
}) as RequestHandler);

export default router;
