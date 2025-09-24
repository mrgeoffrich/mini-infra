import { Router } from 'express';
import { z } from 'zod';
import { EnvironmentManager } from '../services/environment-manager';
import { ServiceRegistry } from '../services/service-registry';
import { requireSessionOrApiKey } from '../middleware/auth';
import prisma from '../lib/prisma';
import { appLogger } from '../lib/logger-factory';

const router = Router({ mergeParams: true });
const logger = appLogger();

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

/**
 * @swagger
 * /api/environments/{id}/volumes:
 *   get:
 *     summary: List environment volumes
 *     description: Retrieve all Docker volumes associated with a specific environment
 *     tags:
 *       - Environment Management
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The environment ID
 *         example: "env_123"
 *     responses:
 *       200:
 *         description: Environment volumes retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 volumes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         example: "volume_456"
 *                       name:
 *                         type: string
 *                         example: "myenv-database-data"
 *                       driver:
 *                         type: string
 *                         example: "local"
 *                       options:
 *                         type: object
 *                         example: {"type": "nfs", "o": "addr=192.168.1.100,rw", "device": ":/path/to/dir"}
 *                       environmentId:
 *                         type: string
 *                         example: "env_123"
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                         example: "2024-01-15T10:30:00.000Z"
 *                       updatedAt:
 *                         type: string
 *                         format: date-time
 *                         example: "2024-01-15T10:30:00.000Z"
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Environment not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Environment not found"
 *                 message:
 *                   type: string
 *                   example: "Environment with ID env_123 does not exist"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Internal server error"
 *                 message:
 *                   type: string
 *                   example: "Failed to retrieve environment volumes"
 *
 * GET /api/environments/:id/volumes - List environment volumes
 */
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

/**
 * @swagger
 * /api/environments/{id}/volumes:
 *   post:
 *     summary: Create environment volume
 *     description: Create a new Docker volume for a specific environment
 *     tags:
 *       - Environment Management
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The environment ID
 *         example: "env_123"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 100
 *                 pattern: '^[a-zA-Z0-9_-]+$'
 *                 description: Volume name (alphanumeric, underscores, hyphens only)
 *                 example: "database-data"
 *               driver:
 *                 type: string
 *                 default: "local"
 *                 description: Docker volume driver
 *                 example: "local"
 *               options:
 *                 type: object
 *                 additionalProperties: true
 *                 description: Additional volume driver options
 *                 example: {"type": "nfs", "o": "addr=192.168.1.100,rw", "device": ":/path/to/dir"}
 *           examples:
 *             localVolume:
 *               summary: Basic local volume
 *               value:
 *                 name: "database-data"
 *                 driver: "local"
 *             nfsVolume:
 *               summary: NFS volume with options
 *               value:
 *                 name: "shared-storage"
 *                 driver: "local"
 *                 options:
 *                   type: "nfs"
 *                   o: "addr=192.168.1.100,rw"
 *                   device: ":/path/to/shared"
 *     responses:
 *       201:
 *         description: Volume created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   example: "volume_789"
 *                 name:
 *                   type: string
 *                   example: "myenv-database-data"
 *                 driver:
 *                   type: string
 *                   example: "local"
 *                 options:
 *                   type: object
 *                   example: {"type": "nfs", "o": "addr=192.168.1.100,rw", "device": ":/path/to/dir"}
 *                 environmentId:
 *                   type: string
 *                   example: "env_123"
 *                 createdAt:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:30:00.000Z"
 *                 updatedAt:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:30:00.000Z"
 *       400:
 *         description: Bad request - validation error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Invalid request data"
 *                 message:
 *                   type: string
 *                   example: "Validation failed"
 *                 details:
 *                   type: array
 *                   items:
 *                     type: object
 *                   example: [{"message": "Name must contain only letters, numbers, underscores, and hyphens"}]
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Environment not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Environment not found"
 *                 message:
 *                   type: string
 *                   example: "Environment with ID env_123 does not exist"
 *       409:
 *         description: Conflict - volume name already exists
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Volume name already exists"
 *                 message:
 *                   type: string
 *                   example: "A volume with this name already exists in the environment"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Internal server error"
 *                 message:
 *                   type: string
 *                   example: "Failed to create volume"
 *
 * POST /api/environments/:id/volumes - Create environment volume
 */
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

    logger.debug({
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

/**
 * @swagger
 * /api/environments/{id}/volumes/{volumeId}:
 *   put:
 *     summary: Update environment volume
 *     description: Update configuration of an existing volume in a specific environment
 *     tags:
 *       - Environment Management
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The environment ID
 *         example: "env_123"
 *       - in: path
 *         name: volumeId
 *         required: true
 *         schema:
 *           type: string
 *         description: The volume ID
 *         example: "volume_789"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               driver:
 *                 type: string
 *                 description: Docker volume driver
 *                 example: "local"
 *               options:
 *                 type: object
 *                 additionalProperties: true
 *                 description: Additional volume driver options
 *                 example: {"type": "nfs", "o": "addr=192.168.1.200,rw", "device": ":/new/path"}
 *           examples:
 *             updateDriver:
 *               summary: Update volume driver
 *               value:
 *                 driver: "nfs"
 *             updateOptions:
 *               summary: Update volume options
 *               value:
 *                 options:
 *                   type: "nfs"
 *                   o: "addr=192.168.1.200,rw"
 *                   device: ":/updated/path"
 *     responses:
 *       200:
 *         description: Volume updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   example: "volume_789"
 *                 name:
 *                   type: string
 *                   example: "myenv-database-data"
 *                 driver:
 *                   type: string
 *                   example: "local"
 *                 options:
 *                   type: object
 *                   example: {"type": "nfs", "o": "addr=192.168.1.200,rw", "device": ":/new/path"}
 *                 environmentId:
 *                   type: string
 *                   example: "env_123"
 *                 updatedAt:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:35:00.000Z"
 *       400:
 *         description: Bad request - validation error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Invalid request data"
 *                 message:
 *                   type: string
 *                   example: "Validation failed"
 *                 details:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Environment or volume not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Volume not found"
 *                 message:
 *                   type: string
 *                   example: "Volume with ID volume_789 does not exist in this environment"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Internal server error"
 *                 message:
 *                   type: string
 *                   example: "Failed to update volume"
 *
 * PUT /api/environments/:id/volumes/:volumeId - Update environment volume
 */
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

    logger.debug({
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

/**
 * @swagger
 * /api/environments/{id}/volumes/{volumeId}:
 *   delete:
 *     summary: Delete environment volume
 *     description: Remove a volume from a specific environment (only if not in use by services)
 *     tags:
 *       - Environment Management
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The environment ID
 *         example: "env_123"
 *       - in: path
 *         name: volumeId
 *         required: true
 *         schema:
 *           type: string
 *         description: The volume ID
 *         example: "volume_789"
 *     responses:
 *       204:
 *         description: Volume deleted successfully (no content)
 *       400:
 *         description: Bad request - volume is in use by services
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Volume in use"
 *                 message:
 *                   type: string
 *                   example: "Cannot delete volume that is required by services"
 *                 details:
 *                   type: object
 *                   properties:
 *                     servicesUsingVolume:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["database-service", "cache-service"]
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Environment or volume not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Volume not found"
 *                 message:
 *                   type: string
 *                   example: "Volume with ID volume_789 does not exist in this environment"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Internal server error"
 *                 message:
 *                   type: string
 *                   example: "Failed to delete volume"
 *
 * DELETE /api/environments/:id/volumes/:volumeId - Delete environment volume
 */
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

    logger.debug({
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