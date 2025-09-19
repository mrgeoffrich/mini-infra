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
const createVolumeSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'Name must contain only letters, numbers, underscores, and hyphens'),
  driver: z.string().min(1).default('local'),
  options: z.record(z.string(), z.any()).optional()
});

const updateVolumeSchema = z.object({
  driver: z.string().min(1).optional(),
  options: z.record(z.string(), z.any()).optional()
});

// GET /api/environments/:id/volumes - List environment volumes
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

    res.json({ volumes: environment.volumes });

  } catch (error) {
    logger.error({ error, environmentId: req.params.id }, 'Failed to list environment volumes');
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to retrieve environment volumes'
    });
  }
});

// POST /api/environments/:id/volumes - Create environment volume
router.post('/', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const validatedData = createVolumeSchema.parse(req.body);

    const environment = await environmentManager.getEnvironmentById(id);
    if (!environment) {
      return res.status(404).json({
        error: 'Environment not found',
        message: `Environment with ID ${id} does not exist`
      });
    }

    // Create environment-prefixed volume name
    const prefixedVolumeName = `${environment.name}-${validatedData.name}`;

    // Check if volume name already exists in this environment
    const existingVolume = environment.volumes.find(v => v.name === prefixedVolumeName);
    if (existingVolume) {
      return res.status(409).json({
        error: 'Volume name already exists',
        message: 'A volume with this name already exists in the environment'
      });
    }

    const volume = await prisma.environmentVolume.create({
      data: {
        environmentId: id,
        name: prefixedVolumeName,
        driver: validatedData.driver,
        options: validatedData.options || {}
      }
    });

    logger.info({
      environmentId: id,
      volumeName: validatedData.name
    }, 'Volume created for environment');

    res.status(201).json(volume);

  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Invalid request data',
        message: 'Validation failed',
        details: error.issues
      });
    }

    logger.error({ error, environmentId: req.params.id, request: req.body }, 'Failed to create volume');
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to create volume'
    });
  }
});

// PUT /api/environments/:id/volumes/:volumeId - Update environment volume
router.put('/:volumeId', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id, volumeId } = req.params;
    const validatedData = updateVolumeSchema.parse(req.body);

    const environment = await environmentManager.getEnvironmentById(id);
    if (!environment) {
      return res.status(404).json({
        error: 'Environment not found',
        message: `Environment with ID ${id} does not exist`
      });
    }

    // Check if volume exists in this environment
    const existingVolume = environment.volumes.find(v => v.id === volumeId);
    if (!existingVolume) {
      return res.status(404).json({
        error: 'Volume not found',
        message: `Volume with ID ${volumeId} does not exist in this environment`
      });
    }

    const volume = await prisma.environmentVolume.update({
      where: { id: volumeId },
      data: {
        driver: validatedData.driver,
        options: validatedData.options
      }
    });

    logger.info({
      environmentId: id,
      volumeId,
      updates: Object.keys(validatedData)
    }, 'Volume updated for environment');

    res.json(volume);

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
      volumeId: req.params.volumeId,
      request: req.body
    }, 'Failed to update volume');

    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to update volume'
    });
  }
});

// DELETE /api/environments/:id/volumes/:volumeId - Delete environment volume
router.delete('/:volumeId', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id, volumeId } = req.params;

    const environment = await environmentManager.getEnvironmentById(id);
    if (!environment) {
      return res.status(404).json({
        error: 'Environment not found',
        message: `Environment with ID ${id} does not exist`
      });
    }

    // Check if volume exists in this environment
    const existingVolume = environment.volumes.find(v => v.id === volumeId);
    if (!existingVolume) {
      return res.status(404).json({
        error: 'Volume not found',
        message: `Volume with ID ${volumeId} does not exist in this environment`
      });
    }

    // Check if any services are using this volume
    const servicesUsingVolume = [];
    for (const service of environment.services) {
      const serviceMetadata = serviceRegistry.getServiceMetadata(service.serviceType);
      if (serviceMetadata?.requiredVolumes.some(v => `${environment.name}-${v.name}` === existingVolume.name)) {
        servicesUsingVolume.push(service.serviceName);
      }
    }

    if (servicesUsingVolume.length > 0) {
      return res.status(400).json({
        error: 'Volume in use',
        message: 'Cannot delete volume that is required by services',
        details: { servicesUsingVolume }
      });
    }

    await prisma.environmentVolume.delete({
      where: { id: volumeId }
    });

    logger.info({
      environmentId: id,
      volumeId,
      volumeName: existingVolume.name
    }, 'Volume deleted from environment');

    res.status(204).send();

  } catch (error) {
    logger.error({
      error,
      environmentId: req.params.id,
      volumeId: req.params.volumeId
    }, 'Failed to delete volume');

    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to delete volume'
    });
  }
});

export default router;