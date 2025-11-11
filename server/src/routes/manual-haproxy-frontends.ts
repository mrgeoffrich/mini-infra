import express, { Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey } from "../middleware/auth";
import prisma from "../lib/prisma";
import { manualFrontendManager } from "../services/haproxy/manual-frontend-manager";
import { HAProxyDataPlaneClient } from "../services/haproxy/haproxy-dataplane-client";
import {
  EligibleContainersResponse,
  CreateManualFrontendRequest,
  UpdateManualFrontendRequest,
  ManualFrontendResponse,
  DeleteManualFrontendResponse,
  HAProxyFrontendInfo,
} from "@mini-infra/types";

const logger = appLogger();
const router = express.Router();

// ====================
// Validation Schemas
// ====================

const createManualFrontendSchema = z.object({
  environmentId: z.string().cuid(),
  containerId: z.string().min(1),
  containerName: z.string().min(1),
  containerPort: z.number().int().min(1).max(65535),
  hostname: z.string().min(1).regex(/^[a-z0-9.-]+$/i, "Invalid hostname format"),
  enableSsl: z.boolean().optional(),
  tlsCertificateId: z.string().cuid().optional(),
  healthCheckPath: z.string().optional(),
});

const updateManualFrontendSchema = z.object({
  hostname: z.string().min(1).regex(/^[a-z0-9.-]+$/i, "Invalid hostname format").optional(),
  enableSsl: z.boolean().optional(),
  tlsCertificateId: z.string().cuid().optional(),
  healthCheckPath: z.string().optional(),
});

// ====================
// Helper Functions
// ====================

function serializeFrontend(frontend: any): HAProxyFrontendInfo {
  return {
    id: frontend.id,
    deploymentConfigId: frontend.deploymentConfigId,
    frontendType: frontend.frontendType,
    containerName: frontend.containerName,
    containerId: frontend.containerId,
    containerPort: frontend.containerPort,
    environmentId: frontend.environmentId,
    frontendName: frontend.frontendName,
    backendName: frontend.backendName,
    hostname: frontend.hostname,
    bindPort: frontend.bindPort,
    bindAddress: frontend.bindAddress,
    useSSL: frontend.useSSL,
    sslBindPort: frontend.sslBindPort,
    status: frontend.status as 'active' | 'pending' | 'failed' | 'removed',
    errorMessage: frontend.errorMessage,
    createdAt: frontend.createdAt.toISOString(),
    updatedAt: frontend.updatedAt.toISOString(),
  };
}

async function getHAProxyClient(environmentId: string): Promise<HAProxyDataPlaneClient> {
  // Get environment details
  const environment = await prisma.environment.findUnique({
    where: { id: environmentId },
    include: {
      services: {
        where: {
          serviceName: "haproxy",
        },
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

  // Get HAProxy container to connect to DataPlane API
  // For now, use default localhost:5555
  // TODO: Improve this to dynamically find HAProxy container
  const client = new HAProxyDataPlaneClient();
  // Note: Client will need to be initialized with container ID in a real scenario
  // For now, assuming HAProxy is accessible at localhost:5555
  return client;
}

// ====================
// Routes
// ====================

/**
 * GET /api/haproxy/manual-frontends/containers
 * List available containers for manual frontend creation
 */
router.get(
  "/containers",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { environmentId } = req.query;

      if (!environmentId || typeof environmentId !== "string") {
        return res.status(400).json({
          success: false,
          error: "environmentId query parameter is required",
        });
      }

      // Validate CUID format
      if (!z.string().cuid().safeParse(environmentId).success) {
        return res.status(400).json({
          success: false,
          error: "Invalid environment ID format",
        });
      }

      const result = await manualFrontendManager.getEligibleContainers(
        environmentId,
        prisma
      );

      const response: EligibleContainersResponse = {
        success: true,
        data: result,
      };

      res.json(response);
    } catch (error: any) {
      logger.error({ error: error.message }, "Failed to get eligible containers");
      res.status(500).json({
        success: false,
        error: "Failed to get eligible containers",
        message: error.message,
      });
    }
  }
);

/**
 * POST /api/haproxy/manual-frontends
 * Create a manual frontend for a container
 */
router.post(
  "/",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      // Validate request body
      const validationResult = createManualFrontendSchema.safeParse(req.body);

      if (!validationResult.success) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: validationResult.error.issues,
        });
      }

      const request: CreateManualFrontendRequest = validationResult.data;

      // Get HAProxy client
      const haproxyClient = await getHAProxyClient(request.environmentId);

      // Create manual frontend
      const frontend = await manualFrontendManager.createManualFrontend(
        request,
        haproxyClient,
        prisma
      );

      const response: ManualFrontendResponse = {
        success: true,
        data: serializeFrontend(frontend),
        message: "Manual frontend created successfully",
      };

      res.status(201).json(response);
    } catch (error: any) {
      logger.error({ error: error.message }, "Failed to create manual frontend");

      // Determine appropriate status code based on error
      let statusCode = 500;
      if (error.message.includes("not found")) {
        statusCode = 404;
      } else if (error.message.includes("already in use") || error.message.includes("validation failed")) {
        statusCode = 409;
      } else if (error.message.includes("Invalid")) {
        statusCode = 400;
      }

      res.status(statusCode).json({
        success: false,
        error: "Failed to create manual frontend",
        message: error.message,
      });
    }
  }
);

/**
 * GET /api/haproxy/manual-frontends/:frontendName
 * Get details of a specific manual frontend
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
      });

      if (!frontend) {
        return res.status(404).json({
          success: false,
          error: "Frontend not found",
        });
      }

      if (frontend.frontendType !== "manual") {
        return res.status(400).json({
          success: false,
          error: "Frontend is not a manual frontend",
        });
      }

      const response: ManualFrontendResponse = {
        success: true,
        data: serializeFrontend(frontend),
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, frontendName: req.params.frontendName },
        "Failed to fetch manual frontend"
      );
      res.status(500).json({
        success: false,
        error: "Failed to fetch manual frontend",
        message: error.message,
      });
    }
  }
);

/**
 * PUT /api/haproxy/manual-frontends/:frontendName
 * Update a manual frontend
 */
router.put(
  "/:frontendName",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { frontendName } = req.params;

      // Validate request body
      const validationResult = updateManualFrontendSchema.safeParse(req.body);

      if (!validationResult.success) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: validationResult.error.issues,
        });
      }

      const updates: UpdateManualFrontendRequest = validationResult.data;

      // Get frontend to determine environment
      const existingFrontend = await prisma.hAProxyFrontend.findUnique({
        where: { frontendName },
      });

      if (!existingFrontend) {
        return res.status(404).json({
          success: false,
          error: "Frontend not found",
        });
      }

      if (existingFrontend.frontendType !== "manual") {
        return res.status(400).json({
          success: false,
          error: "Cannot update deployment frontend via manual frontend API",
        });
      }

      if (!existingFrontend.environmentId) {
        return res.status(400).json({
          success: false,
          error: "Frontend has no environment ID",
        });
      }

      // Get HAProxy client
      const haproxyClient = await getHAProxyClient(existingFrontend.environmentId);

      // Update manual frontend
      const frontend = await manualFrontendManager.updateManualFrontend(
        frontendName,
        updates,
        haproxyClient,
        prisma
      );

      const response: ManualFrontendResponse = {
        success: true,
        data: serializeFrontend(frontend),
        message: "Manual frontend updated successfully",
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, frontendName: req.params.frontendName },
        "Failed to update manual frontend"
      );

      let statusCode = 500;
      if (error.message.includes("not found")) {
        statusCode = 404;
      } else if (error.message.includes("already in use")) {
        statusCode = 409;
      }

      res.status(statusCode).json({
        success: false,
        error: "Failed to update manual frontend",
        message: error.message,
      });
    }
  }
);

/**
 * DELETE /api/haproxy/manual-frontends/:frontendName
 * Delete a manual frontend
 */
router.delete(
  "/:frontendName",
  requireSessionOrApiKey as RequestHandler,
  async (req: Request, res: Response) => {
    try {
      const { frontendName } = req.params;

      // Get frontend to determine environment
      const frontend = await prisma.hAProxyFrontend.findUnique({
        where: { frontendName },
      });

      if (!frontend) {
        return res.status(404).json({
          success: false,
          error: "Frontend not found",
        });
      }

      if (frontend.frontendType !== "manual") {
        return res.status(403).json({
          success: false,
          error: "Cannot delete deployment frontend via manual frontend API",
        });
      }

      if (!frontend.environmentId) {
        return res.status(400).json({
          success: false,
          error: "Frontend has no environment ID",
        });
      }

      // Get HAProxy client
      const haproxyClient = await getHAProxyClient(frontend.environmentId);

      // Delete manual frontend
      await manualFrontendManager.deleteManualFrontend(
        frontendName,
        haproxyClient,
        prisma
      );

      const response: DeleteManualFrontendResponse = {
        success: true,
        message: "Manual frontend deleted successfully",
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, frontendName: req.params.frontendName },
        "Failed to delete manual frontend"
      );

      let statusCode = 500;
      if (error.message.includes("not found")) {
        statusCode = 404;
      } else if (error.message.includes("Cannot delete deployment frontend")) {
        statusCode = 403;
      }

      res.status(statusCode).json({
        success: false,
        error: "Failed to delete manual frontend",
        message: error.message,
      });
    }
  }
);

export default router;
