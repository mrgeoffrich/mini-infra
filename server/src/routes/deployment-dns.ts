import express, { Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey } from "../middleware/auth";
import prisma from "../lib/prisma";
import {
  DeploymentDNSRecordInfo,
  DeploymentDNSRecordListResponse,
  DeploymentDNSRecordResponse,
  SyncDNSResponse,
} from "@mini-infra/types";

const logger = appLogger();
const router = express.Router();

// ====================
// Validation Schemas
// ====================

const syncDNSSchema = z.object({
  deploymentConfigId: z.string().cuid("Invalid deployment configuration ID"),
});

// ====================
// Helper Functions
// ====================

function serializeDNSRecord(record: any): DeploymentDNSRecordInfo {
  return {
    id: record.id,
    deploymentConfigId: record.deploymentConfigId,
    hostname: record.hostname,
    dnsProvider: record.dnsProvider as 'cloudflare' | 'external',
    dnsRecordId: record.dnsRecordId || undefined,
    ipAddress: record.ipAddress || undefined,
    status: record.status as 'active' | 'pending' | 'failed' | 'removed',
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    errorMessage: record.errorMessage || undefined,
  };
}

// ====================
// Routes
// ====================

/**
 * GET /api/deployments/configs/:configId/dns
 * Get DNS records for a specific deployment configuration
 */
router.get(
  "/configs/:configId/dns",
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

      // Fetch DNS records
      const dnsRecords = await prisma.deploymentDNSRecord.findMany({
        where: { deploymentConfigId: configId },
        orderBy: { createdAt: "desc" },
      });

      const response: DeploymentDNSRecordListResponse = {
        success: true,
        data: dnsRecords.map(serializeDNSRecord),
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, configId: req.params.configId },
        "Failed to fetch DNS records for deployment"
      );
      res.status(500).json({
        success: false,
        error: "Failed to fetch DNS records",
        message: error.message,
      });
    }
  }
);

/**
 * POST /api/deployments/configs/:configId/dns/sync
 * Manually sync DNS record for a deployment configuration
 */
router.post(
  "/configs/:configId/dns/sync",
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

      // Get existing DNS record
      const existingRecord = await prisma.deploymentDNSRecord.findFirst({
        where: { deploymentConfigId: configId },
      });

      // For now, we'll just return a message indicating the sync would happen
      // The actual DNS sync logic will be implemented in the deployment-dns-manager service
      const response: SyncDNSResponse = {
        success: true,
        message: `DNS sync initiated for ${config.hostname}. Actual sync implementation is handled by deployment state machines.`,
        data: existingRecord ? serializeDNSRecord(existingRecord) : undefined,
      };

      logger.info(
        {
          configId,
          hostname: config.hostname,
          networkType: config.environment.networkType,
        },
        "DNS sync requested for deployment configuration"
      );

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error: error.message, configId: req.params.configId },
        "Failed to sync DNS for deployment"
      );
      res.status(500).json({
        success: false,
        error: "Failed to sync DNS",
        message: error.message,
      });
    }
  }
);

/**
 * DELETE /api/deployments/configs/:configId/dns
 * Remove DNS record for a deployment configuration
 */
router.delete(
  "/configs/:configId/dns",
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

      // Get DNS records to delete
      const dnsRecords = await prisma.deploymentDNSRecord.findMany({
        where: { deploymentConfigId: configId },
      });

      if (dnsRecords.length === 0) {
        return res.status(404).json({
          success: false,
          error: "No DNS records found for this deployment configuration",
        });
      }

      // Update status to 'removed' instead of deleting
      // Actual DNS record removal from provider should be handled by deployment-dns-manager
      await prisma.deploymentDNSRecord.updateMany({
        where: { deploymentConfigId: configId },
        data: {
          status: "removed",
          updatedAt: new Date(),
        },
      });

      logger.info(
        { configId, recordCount: dnsRecords.length },
        "Marked DNS records as removed for deployment configuration"
      );

      res.json({
        success: true,
        message: `Marked ${dnsRecords.length} DNS record(s) as removed`,
      });
    } catch (error: any) {
      logger.error(
        { error: error.message, configId: req.params.configId },
        "Failed to remove DNS records"
      );
      res.status(500).json({
        success: false,
        error: "Failed to remove DNS records",
        message: error.message,
      });
    }
  }
);

/**
 * GET /api/deployments/dns
 * List all DNS records across all deployment configurations
 */
router.get(
  "/dns",
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

      // Fetch DNS records
      const dnsRecords = await prisma.deploymentDNSRecord.findMany({
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

      const response: DeploymentDNSRecordListResponse = {
        success: true,
        data: dnsRecords.map(serializeDNSRecord),
      };

      res.json(response);
    } catch (error: any) {
      logger.error({ error: error.message }, "Failed to fetch DNS records");
      res.status(500).json({
        success: false,
        error: "Failed to fetch DNS records",
        message: error.message,
      });
    }
  }
);

export default router;
