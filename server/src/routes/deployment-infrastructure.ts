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
import { NetworkRequirement, VolumeRequirement } from "../services/interfaces/application-service";
import { portUtils } from "../services/port-utils";
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

    // Validate port availability before deployment
    try {
      const portConfig = await portUtils.getHAProxyPortsForEnvironment(environmentId);
      const validation = await portUtils.validateHAProxyPorts(
        portConfig.httpPort,
        portConfig.httpsPort
      );

      if (!validation.isValid) {
        logger.warn(
          {
            requestId,
            userId,
            environmentId,
            httpPort: portConfig.httpPort,
            httpsPort: portConfig.httpsPort,
            validation,
          },
          "Port validation failed for HAProxy deployment"
        );

        return res.status(400).json({
          error: "Port Conflict",
          message: validation.message,
          details: {
            httpPort: portConfig.httpPort,
            httpsPort: portConfig.httpsPort,
            conflicts: validation.conflicts,
            suggestedPorts: validation.suggestedPorts,
          },
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      logger.info(
        {
          requestId,
          userId,
          environmentId,
          httpPort: portConfig.httpPort,
          httpsPort: portConfig.httpsPort,
        },
        "Port validation passed for HAProxy deployment"
      );
    } catch (error) {
      logger.error(
        {
          requestId,
          userId,
          environmentId,
          error,
        },
        "Failed to validate ports for HAProxy deployment"
      );

      return res.status(500).json({
        error: "Validation Error",
        message: `Failed to validate ports: ${error instanceof Error ? error.message : "Unknown error"}`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Deploy HAProxy using the HAProxy service directly
    const haproxyService = new HAProxyService('haproxy', environmentId);

    // Prepare prefixed networks and volumes for the environment
    const networks: NetworkRequirement[] = [
      {
        name: networkName,
        driver: networkDriver
      }
    ];

    const volumes: VolumeRequirement[] = [
      { name: `${environmentId}-haproxy_data` },
      { name: `${environmentId}-haproxy_run` },
      { name: `${environmentId}-haproxy_config` },
      { name: `${environmentId}-haproxy_certs` }
    ];

    try {
      await haproxyService.initialize(networks, volumes);
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

    // Prepare prefixed networks and volumes for the environment
    const networks: NetworkRequirement[] = [
      {
        name: networkName,
        driver: 'bridge' // Default driver for status checks
      }
    ];

    const volumes: VolumeRequirement[] = [
      { name: `${environmentId}-haproxy_data` },
      { name: `${environmentId}-haproxy_run` },
      { name: `${environmentId}-haproxy_config` },
      { name: `${environmentId}-haproxy_certs` }
    ];

    try {
      await haproxyService.initialize(networks, volumes);
      
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

    // Prepare prefixed networks and volumes for the environment
    const networks: NetworkRequirement[] = [
      {
        name: networkName,
        driver: 'bridge' // Default driver for cleanup
      }
    ];

    const volumes: VolumeRequirement[] = [
      { name: `${environmentId}-haproxy_data` },
      { name: `${environmentId}-haproxy_run` },
      { name: `${environmentId}-haproxy_config` },
      { name: `${environmentId}-haproxy_certs` }
    ];

    try {
      await haproxyService.initialize(networks, volumes);
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
