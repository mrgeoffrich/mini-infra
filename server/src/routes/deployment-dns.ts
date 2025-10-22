import express from 'express';
import { requireSessionOrApiKey } from '../middleware/auth';
import { appLogger } from '../lib/logger-factory';
import prisma from '../lib/prisma';
import { deploymentDNSManager } from '../services/deployment-dns-manager';

const router = express.Router();
const logger = appLogger();

/**
 * GET /api/deployments/configs/:configId/dns
 * Get DNS records for a deployment configuration
 */
router.get('/configs/:configId/dns', requireSessionOrApiKey, async (req, res) => {
  try {
    const { configId } = req.params;

    const dnsRecords = await prisma.deploymentDNSRecord.findMany({
      where: { deploymentConfigId: configId }
    });

    res.json({
      success: true,
      data: dnsRecords
    });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err, configId: req.params.configId }, 'Failed to get DNS records');
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/deployments/configs/:configId/dns/sync
 * Manually sync DNS record for a deployment configuration
 */
router.post('/configs/:configId/dns/sync', requireSessionOrApiKey, async (req, res) => {
  try {
    const { configId } = req.params;

    // Get deployment configuration with environment
    const deploymentConfig = await prisma.deploymentConfiguration.findUnique({
      where: { id: configId },
      include: { environment: true }
    });

    if (!deploymentConfig) {
      return res.status(404).json({
        success: false,
        error: 'Deployment configuration not found'
      });
    }

    // Create/update DNS record
    await deploymentDNSManager.createDNSRecordForDeployment(deploymentConfig);

    // Get updated records
    const dnsRecords = await prisma.deploymentDNSRecord.findMany({
      where: { deploymentConfigId: configId }
    });

    res.json({
      success: true,
      message: 'DNS records synced successfully',
      data: dnsRecords
    });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err, configId: req.params.configId }, 'Failed to sync DNS records');
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * DELETE /api/deployments/configs/:configId/dns
 * Remove DNS records for a deployment configuration
 */
router.delete('/configs/:configId/dns', requireSessionOrApiKey, async (req, res) => {
  try {
    const { configId } = req.params;

    await deploymentDNSManager.removeDNSRecordForDeployment(configId);

    res.json({
      success: true,
      message: 'DNS records removed successfully'
    });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err, configId: req.params.configId }, 'Failed to remove DNS records');
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/deployments/dns
 * List all DNS records
 */
router.get('/dns', requireSessionOrApiKey, async (req, res) => {
  try {
    const dnsRecords = await prisma.deploymentDNSRecord.findMany({
      include: {
        deploymentConfig: {
          select: {
            id: true,
            applicationName: true,
            hostname: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      data: dnsRecords
    });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err }, 'Failed to list DNS records');
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

export default router;
