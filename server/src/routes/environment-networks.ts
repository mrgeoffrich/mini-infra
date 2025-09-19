import { Router } from 'express';
import { z } from 'zod';
import { EnvironmentManager } from '../services/environment-manager';
import { ServiceRegistry } from '../services/service-registry';
import { requireSessionOrApiKey } from '../middleware/auth';
import prisma from '../lib/prisma';
import { servicesLogger } from '../lib/logger-factory';

const router = Router({ mergeParams: true });
const logger = servicesLogger();

// Initialize services
const environmentManager = EnvironmentManager.getInstance(prisma);
const serviceRegistry = ServiceRegistry.getInstance();

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

// GET /api/environments/:id/networks - List environment networks
router.get('/', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;

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

// POST /api/environments/:id/networks - Create environment network
router.post('/', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;
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

    logger.info({
      environmentId: id,
      networkName: validatedData.name
    }, 'Network created for environment');

    res.status(201).json(network);

  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Invalid request data',
        message: 'Validation failed',
        details: error.errors
      });
    }

    logger.error({ error, environmentId: req.params.id, request: req.body }, 'Failed to create network');
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to create network'
    });
  }
});

// PUT /api/environments/:id/networks/:networkId - Update environment network
router.put('/:networkId', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id, networkId } = req.params;
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

    logger.info({
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
        details: error.errors
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

// DELETE /api/environments/:id/networks/:networkId - Delete environment network
router.delete('/:networkId', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id, networkId } = req.params;

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

    // Check if any services are using this network
    const servicesUsingNetwork = [];
    for (const service of environment.services) {
      const serviceMetadata = serviceRegistry.getServiceMetadata(service.serviceType);
      if (serviceMetadata?.requiredNetworks.some(n => `${environment.name}-${n.name}` === existingNetwork.name)) {
        servicesUsingNetwork.push(service.serviceName);
      }
    }

    if (servicesUsingNetwork.length > 0) {
      return res.status(400).json({
        error: 'Network in use',
        message: 'Cannot delete network that is required by services',
        details: { servicesUsingNetwork }
      });
    }

    await prisma.environmentNetwork.delete({
      where: { id: networkId }
    });

    logger.info({
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