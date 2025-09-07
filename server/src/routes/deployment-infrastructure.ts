import express, { Request, Response, NextFunction, RequestHandler } from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey } from "../lib/api-key-middleware";
import { getAuthenticatedUser } from "../lib/auth-middleware";
import { DeploymentInfrastructureService } from "../services/deployment-infrastructure";
import prisma from "../lib/prisma";

const logger = appLogger();
const router = express.Router();

// Initialize the deployment infrastructure service
const infrastructureService = new DeploymentInfrastructureService();

// Validation schemas
const deployInfrastructureSchema = z.object({
  networkName: z.string().min(1, "Network name is required"),
  networkDriver: z.enum(["bridge", "overlay", "host", "none"]).default("bridge"),
  traefikImage: z.string().min(1, "Traefik image is required"),
  webPort: z.number().int().min(1).max(65535),
  dashboardPort: z.number().int().min(1).max(65535),
  configYaml: z.string().min(1, "Configuration YAML is required"),
});

/**
 * POST /api/deployment-infrastructure/deploy - Deploy Docker network and Traefik
 */
router.post("/deploy", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  logger.info({ requestId, userId }, "Infrastructure deployment requested");

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
      logger.warn({
        requestId,
        userId,
        validationErrors: bodyValidation.error.issues,
      }, "Invalid request body for infrastructure deployment");

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
      traefikImage,
      webPort,
      dashboardPort,
      configYaml
    } = bodyValidation.data;

    // Ensure the Docker network exists
    const networkResult = await infrastructureService.ensureDeploymentNetwork(
      networkName,
      networkDriver
    );

    if (!networkResult.success) {
      logger.error({
        requestId,
        userId,
        networkName,
        networkDriver,
        error: networkResult.error,
      }, "Failed to create deployment network");

      return res.status(500).json({
        error: "Infrastructure Error",
        message: `Failed to create network: ${networkResult.error}`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Deploy Traefik container
    const traefikResult = await infrastructureService.ensureTraefikContainer({
      image: traefikImage,
      webPort,
      dashboardPort,
      configYaml,
      networkName,
    });

    if (!traefikResult.success) {
      logger.error({
        requestId,
        userId,
        traefikImage,
        webPort,
        dashboardPort,
        error: traefikResult.error,
      }, "Failed to deploy Traefik container");

      return res.status(500).json({
        error: "Infrastructure Error",
        message: `Failed to deploy Traefik: ${traefikResult.error}`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    logger.info({
      requestId,
      userId,
      networkId: networkResult.networkId,
      containerId: traefikResult.containerId,
    }, "Infrastructure deployed successfully");

    res.json({
      success: true,
      data: {
        network: {
          id: networkResult.networkId,
          name: networkName,
          driver: networkDriver,
        },
        traefik: {
          id: traefikResult.containerId,
          image: traefikImage,
          webPort,
          dashboardPort,
        }
      },
      message: "Infrastructure deployed successfully",
      timestamp: new Date().toISOString(),
      requestId,
    });

  } catch (error) {
    logger.error({
      error,
      requestId,
      userId,
      body: req.body,
    }, "Failed to deploy infrastructure");

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

  logger.info({ requestId, userId, networkName }, "Infrastructure status requested");

  try {
    if (!networkName) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Network name is required as query parameter",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const status = await infrastructureService.getInfrastructureStatus(networkName);

    logger.info({
      requestId,
      userId,
      networkName,
      status,
    }, "Infrastructure status retrieved");

    res.json({
      success: true,
      data: status,
      message: "Infrastructure status retrieved",
      timestamp: new Date().toISOString(),
      requestId,
    });

  } catch (error) {
    logger.error({
      error,
      requestId,
      userId,
      networkName,
    }, "Failed to get infrastructure status");

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

  logger.info({ requestId, userId, networkName }, "Infrastructure cleanup requested");

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

    const result = await infrastructureService.cleanupInfrastructure(networkName);

    if (!result.success) {
      logger.error({
        requestId,
        userId,
        networkName,
        error: result.error,
      }, "Failed to cleanup infrastructure");

      return res.status(500).json({
        error: "Infrastructure Error",
        message: `Failed to cleanup infrastructure: ${result.error}`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    logger.info({
      requestId,
      userId,
      networkName,
    }, "Infrastructure cleaned up successfully");

    res.json({
      success: true,
      message: "Infrastructure cleaned up successfully",
      timestamp: new Date().toISOString(),
      requestId,
    });

  } catch (error) {
    logger.error({
      error,
      requestId,
      userId,
      networkName,
    }, "Failed to cleanup infrastructure");

    next(error);
  }
}) as RequestHandler);

export default router;