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
const createNetworkSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'Name must contain only letters, numbers, underscores, and hyphens'),
  driver: z.string().min(1).default('bridge'),
  options: z.record(z.string(), z.any()).optional()
});

const updateNetworkSchema = z.object({
  driver: z.string().min(1).optional(),
  options: z.record(z.string(), z.any()).optional()
});

/**
 * @swagger
 * /api/environments/{id}/networks:
 *   get:
 *     summary: List environment networks
 *     description: Retrieve all networks associated with a specific environment
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
 *         description: Environment networks retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 networks:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         example: "network_456"
 *                       name:
 *                         type: string
 *                         example: "myenv-frontend"
 *                       driver:
 *                         type: string
 *                         example: "bridge"
 *                       options:
 *                         type: object
 *                         nullable: true
 *                         example: {"com.docker.network.bridge.name": "myenv-br0"}
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
 *                   example: "Failed to retrieve environment networks"
 *
 * GET /api/environments/:id/networks - List environment networks
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

    res.json({ networks: environment.networks });

  } catch (error) {
    logger.error({ error, environmentId: req.params.id }, 'Failed to list environment networks');
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to retrieve environment networks'
    });
  }
});

/**
 * @swagger
 * /api/environments/{id}/networks:
 *   post:
 *     summary: Create environment network
 *     description: Create a new Docker network for a specific environment
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
 *                 description: Network name (alphanumeric, underscores, hyphens only)
 *                 example: "frontend"
 *               driver:
 *                 type: string
 *                 default: "bridge"
 *                 description: Docker network driver
 *                 example: "bridge"
 *               options:
 *                 type: object
 *                 additionalProperties: true
 *                 description: Additional network options
 *                 example: {"com.docker.network.bridge.name": "custom-br0"}
 *           examples:
 *             basicNetwork:
 *               summary: Basic bridge network
 *               value:
 *                 name: "frontend"
 *                 driver: "bridge"
 *             customNetwork:
 *               summary: Network with custom options
 *               value:
 *                 name: "backend"
 *                 driver: "bridge"
 *                 options:
 *                   "com.docker.network.bridge.name": "backend-br0"
 *                   "com.docker.network.driver.mtu": "1450"
 *     responses:
 *       201:
 *         description: Network created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   example: "network_789"
 *                 name:
 *                   type: string
 *                   example: "myenv-frontend"
 *                 driver:
 *                   type: string
 *                   example: "bridge"
 *                 options:
 *                   type: object
 *                   nullable: true
 *                   example: {"com.docker.network.bridge.name": "custom-br0"}
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
 *                   example: "Validation error"
 *                 message:
 *                   type: string
 *                   example: "Name must contain only letters, numbers, underscores, and hyphens"
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
 *         description: Conflict - network name already exists
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Network name already exists"
 *                 message:
 *                   type: string
 *                   example: "A network with this name already exists in the environment"
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
 *                   example: "Failed to create network"
 *
 * POST /api/environments/:id/networks - Create environment network
 */
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

/**
 * @swagger
 * /api/environments/{id}/networks/{networkId}:
 *   put:
 *     summary: Update environment network
 *     description: Update configuration of an existing network in a specific environment
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
 *         name: networkId
 *         required: true
 *         schema:
 *           type: string
 *         description: The network ID
 *         example: "network_789"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               driver:
 *                 type: string
 *                 description: Docker network driver
 *                 example: "bridge"
 *               options:
 *                 type: object
 *                 additionalProperties: true
 *                 description: Additional network options
 *                 example: {"com.docker.network.driver.mtu": "1450"}
 *           examples:
 *             updateDriver:
 *               summary: Update network driver
 *               value:
 *                 driver: "overlay"
 *             updateOptions:
 *               summary: Update network options
 *               value:
 *                 options:
 *                   "com.docker.network.driver.mtu": "1450"
 *                   "com.docker.network.bridge.enable_icc": "false"
 *     responses:
 *       200:
 *         description: Network updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   example: "network_789"
 *                 name:
 *                   type: string
 *                   example: "myenv-frontend"
 *                 driver:
 *                   type: string
 *                   example: "bridge"
 *                 options:
 *                   type: object
 *                   nullable: true
 *                   example: {"com.docker.network.driver.mtu": "1450"}
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
 *         description: Environment or network not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Network not found"
 *                 message:
 *                   type: string
 *                   example: "Network with ID network_789 does not exist in this environment"
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
 *                   example: "Failed to update network"
 *
 * PUT /api/environments/:id/networks/:networkId - Update environment network
 */
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

/**
 * @swagger
 * /api/environments/{id}/networks/{networkId}:
 *   delete:
 *     summary: Delete environment network
 *     description: Remove a network from a specific environment (only if not in use by services)
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
 *         name: networkId
 *         required: true
 *         schema:
 *           type: string
 *         description: The network ID
 *         example: "network_789"
 *     responses:
 *       204:
 *         description: Network deleted successfully (no content)
 *       400:
 *         description: Bad request - network is in use by services
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Network in use"
 *                 message:
 *                   type: string
 *                   example: "Cannot delete network that is required by services"
 *                 details:
 *                   type: object
 *                   properties:
 *                     servicesUsingNetwork:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["web-service", "api-service"]
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Environment or network not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Network not found"
 *                 message:
 *                   type: string
 *                   example: "Network with ID network_789 does not exist in this environment"
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
 *                   example: "Failed to delete network"
 *
 * DELETE /api/environments/:id/networks/:networkId - Delete environment network
 */
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