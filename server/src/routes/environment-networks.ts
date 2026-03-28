import { Router } from 'express';
import { z } from 'zod';
import { EnvironmentManager } from '../services/environment';
import { requirePermission } from '../middleware/auth';
import prisma from '../lib/prisma';
import { appLogger } from '../lib/logger-factory';

const router = Router({ mergeParams: true });
const logger = appLogger();

// Initialize services
const environmentManager = EnvironmentManager.getInstance(prisma);

// Validation schemas
const createNetworkSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'Name must contain only letters, numbers, underscores, and hyphens'),
  driver: z.string().min(1).default('bridge'),
  options: z.record(z.string(), z.any()).optional()
});

const updateNetworkSchema = z.object({
  driver: z.string().min(1).optional(),
  options: z.record(z.string(), z.any()).optional()
});


router.get('/', requirePermission('environments:read'), async (req, res) => {
  try {
    const id = String(req.params.id);

    const environment = await environmentManager.getEnvironmentById(id);
    if (!environment) {
      return res.status(404).json({
        error: 'Environment not found',
        message: `Environment with ID ${id} does not exist`
      });
    }

    res.json({ networks: environment.networks });

  } catch (error) {
    logger.error({ error, environmentId: req.params.id }, 'Failed to list environment networks');
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to retrieve environment networks'
    });
  }
});


router.post('/', requirePermission('environments:write'), async (req, res) => {
  try {
    const id = String(req.params.id);
    const validatedData = createNetworkSchema.parse(req.body);

    const environment = await environmentManager.getEnvironmentById(id);
    if (!environment) {
      return res.status(404).json({
        error: 'Environment not found',
        message: `Environment with ID ${id} does not exist`
      });
    }

    // Create environment-prefixed network name
    const prefixedNetworkName = `${environment.name}-${validatedData.name}`;

    // Check if network name already exists in this environment
    const existingNetwork = environment.networks.find(n => n.name === prefixedNetworkName);
    if (existingNetwork) {
      return res.status(409).json({
        error: 'Network name already exists',
        message: 'A network with this name already exists in the environment'
      });
    }

    const network = await prisma.environmentNetwork.create({
      data: {
        environmentId: id,
        name: prefixedNetworkName,
        driver: validatedData.driver,
        options: validatedData.options || {}
      }
    });

    logger.debug({
      environmentId: id,
      networkName: validatedData.name
    }, 'Network created for environment');

    res.status(201).json(network);

  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Invalid request data',
        message: 'Validation failed',
        details: error.issues
      });
    }

    logger.error({ error, environmentId: req.params.id, request: req.body }, 'Failed to create network');
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to create network'
    });
  }
});


router.put('/:networkId', requirePermission('environments:write'), async (req, res) => {
  try {
    const id = String(req.params.id); const networkId = String(req.params.networkId);
    const validatedData = updateNetworkSchema.parse(req.body);

    const environment = await environmentManager.getEnvironmentById(id);
    if (!environment) {
      return res.status(404).json({
        error: 'Environment not found',
        message: `Environment with ID ${id} does not exist`
      });
    }

    // Check if network exists in this environment
    const existingNetwork = environment.networks.find(n => n.id === networkId);
    if (!existingNetwork) {
      return res.status(404).json({
        error: 'Network not found',
        message: `Network with ID ${networkId} does not exist in this environment`
      });
    }

    const network = await prisma.environmentNetwork.update({
      where: { id: networkId },
      data: {
        driver: validatedData.driver,
        options: validatedData.options
      }
    });

    logger.debug({
      environmentId: id,
      networkId,
      updates: Object.keys(validatedData)
    }, 'Network updated for environment');

    res.json(network);

  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Invalid request data',
        message: 'Validation failed',
        details: error.issues
      });
    }

    logger.error({
      error,
      environmentId: req.params.id,
      networkId: req.params.networkId,
      request: req.body
    }, 'Failed to update network');

    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to update network'
    });
  }
});


router.delete('/:networkId', requirePermission('environments:write'), async (req, res) => {
  try {
    const id = String(req.params.id); const networkId = String(req.params.networkId);

    const environment = await environmentManager.getEnvironmentById(id);
    if (!environment) {
      return res.status(404).json({
        error: 'Environment not found',
        message: `Environment with ID ${id} does not exist`
      });
    }

    // Check if network exists in this environment
    const existingNetwork = environment.networks.find(n => n.id === networkId);
    if (!existingNetwork) {
      return res.status(404).json({
        error: 'Network not found',
        message: `Network with ID ${networkId} does not exist in this environment`
      });
    }

    await prisma.environmentNetwork.delete({
      where: { id: networkId }
    });

    logger.debug({
      environmentId: id,
      networkId,
      networkName: existingNetwork.name
    }, 'Network deleted from environment');

    res.status(204).send();

  } catch (error) {
    logger.error({
      error,
      environmentId: req.params.id,
      networkId: req.params.networkId
    }, 'Failed to delete network');

    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to delete network'
    });
  }
});

export default router;