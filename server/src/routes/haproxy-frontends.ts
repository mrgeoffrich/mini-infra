import express from 'express';
import { requireSessionOrApiKey } from '../middleware/auth';
import { appLogger } from '../lib/logger-factory';
import prisma from '../lib/prisma';

const router = express.Router();
const logger = appLogger();

/**
 * GET /api/haproxy/frontends
 * List all HAProxy frontends
 */
router.get('/frontends', requireSessionOrApiKey, async (req, res) => {
  try {
    const frontends = await prisma.hAProxyFrontend.findMany({
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
      data: frontends
    });
  } catch (error) {
    logger.error({ error }, 'Failed to list HAProxy frontends');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/deployments/configs/:configId/frontend
 * Get HAProxy frontend for a deployment configuration
 */
router.get('/deployments/configs/:configId/frontend', requireSessionOrApiKey, async (req, res) => {
  try {
    const { configId } = req.params;

    const frontend = await prisma.hAProxyFrontend.findUnique({
      where: { deploymentConfigId: configId }
    });

    if (!frontend) {
      return res.status(404).json({
        success: false,
        error: 'Frontend not found'
      });
    }

    res.json({
      success: true,
      data: frontend
    });
  } catch (error) {
    logger.error({ error, configId: req.params.configId }, 'Failed to get HAProxy frontend');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
