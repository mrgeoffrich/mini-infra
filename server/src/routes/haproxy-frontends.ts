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

const logger = appLogger();
const router = express.Router();

// ====================
// Helper Functions
// ====================

function serializeFrontend(frontend: any): HAProxyFrontendInfo {
  return {
    id: frontend.id,
    deploymentConfigId: frontend.deploymentConfigId,
    frontendName: frontend.frontendName,
    backendName: frontend.backendName,
    hostname: frontend.hostname,
    bindPort: frontend.bindPort,
    bindAddress: frontend.bindAddress,
    useSSL: frontend.useSSL,
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
  "/deployments/configs/:configId/frontend",
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

      if (!frontend) {
        return res.status(404).json({
          success: false,
          error: "HAProxy frontend not found for this deployment configuration",
        });
      }

      const response: HAProxyFrontendResponse = {
        success: true,
        data: serializeFrontend(frontend),
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
  "/deployments/configs/:configId/frontend/sync",
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

export default router;
