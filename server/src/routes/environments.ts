import { Router } from 'express';
import { z } from 'zod';
import {
  CreateEnvironmentRequest,
  UpdateEnvironmentRequest,
  AddServiceToEnvironmentRequest,
  UpdateEnvironmentServiceRequest,
  ListEnvironmentsRequest,
  EnvironmentType,
  ServiceConfiguration,
  ServiceStatus,
  ServiceStatusValues
} from '@mini-infra/types';
import { EnvironmentManager } from '../services/environment-manager';
import { ServiceRegistry } from '../services/service-registry';
import { requireSessionOrApiKey } from '../middleware/auth';
import prisma from '../lib/prisma';
import { appLogger } from '../lib/logger-factory';

const router = Router();
const logger = appLogger();

// Initialize services
const environmentManager = EnvironmentManager.getInstance(prisma);
const serviceRegistry = ServiceRegistry.getInstance();

// Validation schemas
const createEnvironmentSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'Name must contain only letters, numbers, underscores, and hyphens'),
  description: z.string().optional(),
  type: z.enum(['production', 'nonproduction']),
  networkType: z.enum(['local', 'internet']).optional(),
  services: z.array(z.object({
    serviceName: z.string().min(1).max(100),
    serviceType: z.string().min(1),
    config: z.record(z.string(), z.any()).optional()
  })).optional()
});

const updateEnvironmentSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  description: z.string().optional(),
  type: z.enum(['production', 'nonproduction']).optional(),
  networkType: z.enum(['local', 'internet']).optional(),
  isActive: z.boolean().optional()
});

const addServiceSchema = z.object({
  serviceName: z.string().min(1).max(100),
  serviceType: z.string().min(1),
  config: z.record(z.string(), z.any()).optional()
});

const updateServiceSchema = z.object({
  config: z.record(z.string(), z.any()).optional()
});

const listEnvironmentsSchema = z.object({
  type: z.enum(['production', 'nonproduction']).optional(),
  status: z.string().optional(),
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional()
});


/**
 * @swagger
 * /api/environments:
 *   get:
 *     summary: List all environments
 *     description: Retrieve a paginated list of all environments with optional filtering by type and status
 *     tags:
 *       - Environment Management
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: type
 *         in: query
 *         description: Filter by environment type
 *         required: false
 *         schema:
 *           type: string
 *           enum: ['production', 'nonproduction']
 *         example: 'production'
 *       - name: status
 *         in: query
 *         description: Filter by environment status
 *         required: false
 *         schema:
 *           type: string
 *         example: 'running'
 *       - name: page
 *         in: query
 *         description: Page number for pagination
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         example: 1
 *       - name: limit
 *         in: query
 *         description: Number of items per page (1-100)
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         example: 20
 *     responses:
 *       200:
 *         description: Environments retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 environments:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/EnvironmentInfo'
 *                 total:
 *                   type: integer
 *                   description: Total number of environments
 *                   example: 45
 *                 page:
 *                   type: integer
 *                   description: Current page number
 *                   example: 1
 *                 limit:
 *                   type: integer
 *                   description: Items per page
 *                   example: 20
 *                 totalPages:
 *                   type: integer
 *                   description: Total number of pages
 *                   example: 3
 *                 hasNextPage:
 *                   type: boolean
 *                   description: Whether there are more pages
 *                   example: true
 *                 hasPreviousPage:
 *                   type: boolean
 *                   description: Whether there are previous pages
 *                   example: false
 *               required:
 *                 - environments
 *                 - total
 *                 - page
 *                 - limit
 *                 - totalPages
 *                 - hasNextPage
 *                 - hasPreviousPage
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationError'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/', requireSessionOrApiKey, async (req, res) => {
  try {
    // Validate query parameters
    const validatedQuery = listEnvironmentsSchema.parse(req.query);
    const { type, status, page = 1, limit = 20 } = validatedQuery;

    const result = await environmentManager.listEnvironments(
      type,
      status as ServiceStatus | undefined,
      page,
      limit
    );

    const totalPages = Math.ceil(result.total / limit);

    res.json({
      environments: result.environments,
      total: result.total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Invalid query parameters',
        message: 'Validation failed',
        details: error.issues
      });
    }

    logger.error({ error }, 'Failed to list environments');
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to list environments'
    });
  }
});

/**
 * @swagger
 * /api/environments:
 *   post:
 *     summary: Create new environment
 *     description: Create a new environment with optional initial services. Service types must be available in the service registry.
 *     tags:
 *       - Environment Management
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateEnvironmentRequest'
 *           example:
 *             name: 'production'
 *             description: 'Production environment for web applications'
 *             type: 'production'
 *             networkType: 'internet'
 *             services:
 *               - serviceName: 'web-server'
 *                 serviceType: 'nginx'
 *                 config:
 *                   port: 80
 *                   ssl: true
 *               - serviceName: 'database'
 *                 serviceType: 'postgres'
 *                 config:
 *                   version: '14'
 *                   database: 'myapp'
 *     responses:
 *       201:
 *         description: Environment created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EnvironmentInfo'
 *       400:
 *         description: Invalid service type or validation error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: 'Invalid service type'
 *                 message:
 *                   type: string
 *                   example: 'Unknown service type: invalid-service'
 *                 availableTypes:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ['nginx', 'postgres', 'redis']
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Environment name already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/', requireSessionOrApiKey, async (req, res) => {
  try {
    const request: CreateEnvironmentRequest = req.body;

    // Validate service types if provided
    if (request.services) {
      for (const serviceConfig of request.services) {
        if (!serviceRegistry.isServiceTypeAvailable(serviceConfig.serviceType)) {
          return res.status(400).json({
            error: 'Invalid service type',
            message: `Unknown service type: ${serviceConfig.serviceType}`,
            availableTypes: serviceRegistry.getAvailableServiceTypes()
          });
        }
      }
    }

    const environment = await environmentManager.createEnvironment(request);

    logger.debug({
      environmentId: environment.id,
      environmentName: environment.name,
      serviceCount: environment.services.length
    }, 'Environment created via API');

    res.status(201).json(environment);

  } catch (error) {
    logger.error({ error, request: req.body }, 'Failed to create environment');

    if (error instanceof Error && error.message.includes('Unique constraint')) {
      return res.status(409).json({
        error: 'Environment name already exists',
        message: 'An environment with this name already exists'
      });
    }

    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to create environment'
    });
  }
});

/**
 * @swagger
 * /api/environments/{id}:
 *   get:
 *     summary: Get environment details
 *     description: Retrieve detailed information about a specific environment including all its services
 *     tags:
 *       - Environment Management
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: id
 *         in: path
 *         description: Environment unique identifier
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         example: 'env-123'
 *     responses:
 *       200:
 *         description: Environment details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EnvironmentInfo'
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
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/:id', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    const environment = await environmentManager.getEnvironmentById(id);

    if (!environment) {
      return res.status(404).json({
        error: 'Environment not found',
        message: `Environment with ID ${id} does not exist`
      });
    }

    res.json(environment);

  } catch (error) {
    logger.error({ error, environmentId: req.params.id }, 'Failed to get environment');
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to retrieve environment'
    });
  }
});

/**
 * @swagger
 * /api/environments/{id}:
 *   put:
 *     summary: Update environment
 *     description: Update an existing environment's properties. All fields are optional and will only update the provided values.
 *     tags:
 *       - Environment Management
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: id
 *         in: path
 *         description: Environment unique identifier
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         example: 'env-123'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateEnvironmentRequest'
 *           example:
 *             name: 'production-updated'
 *             description: 'Updated production environment'
 *             isActive: false
 *     responses:
 *       200:
 *         description: Environment updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EnvironmentInfo'
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
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Environment name already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.put('/:id', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const request: UpdateEnvironmentRequest = req.body;

    const environment = await environmentManager.updateEnvironment(id, request);

    if (!environment) {
      return res.status(404).json({
        error: 'Environment not found',
        message: `Environment with ID ${id} does not exist`
      });
    }

    logger.debug({
      environmentId: id,
      updates: Object.keys(request)
    }, 'Environment updated via API');

    res.json(environment);

  } catch (error) {
    logger.error({ error, environmentId: req.params.id, request: req.body }, 'Failed to update environment');

    if (error instanceof Error && error.message.includes('Unique constraint')) {
      return res.status(409).json({
        error: 'Environment name already exists',
        message: 'An environment with this name already exists'
      });
    }

    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to update environment'
    });
  }
});

/**
 * @swagger
 * /api/environments/{id}:
 *   delete:
 *     summary: Delete environment
 *     description: Delete an environment and optionally clean up associated volumes and networks. Cannot delete environments with active deployment configurations.
 *     tags:
 *       - Environment Management
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: id
 *         in: path
 *         description: Environment unique identifier
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         example: 'env-123'
 *       - name: deleteVolumes
 *         in: query
 *         description: Whether to delete associated Docker volumes
 *         required: false
 *         schema:
 *           type: boolean
 *           default: false
 *         example: true
 *       - name: deleteNetworks
 *         in: query
 *         description: Whether to delete associated Docker networks
 *         required: false
 *         schema:
 *           type: boolean
 *           default: false
 *         example: true
 *     responses:
 *       204:
 *         description: Environment deleted successfully
 *       400:
 *         description: Environment has associated deployments or is running
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: 'Environment has associated deployments'
 *                 message:
 *                   type: string
 *                   example: 'Cannot delete environment with existing deployment configurations. Please delete the following deployment configurations first: app1, app2'
 *                 deploymentConfigurations:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       applicationName:
 *                         type: string
 *                   example:
 *                     - id: 'deploy-123'
 *                       applicationName: 'app1'
 *                     - id: 'deploy-456'
 *                       applicationName: 'app2'
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
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.delete('/:id', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const { deleteVolumes = 'false', deleteNetworks = 'false' } = req.query;

    // Parse boolean query parameters
    const shouldDeleteVolumes = deleteVolumes === 'true';
    const shouldDeleteNetworks = deleteNetworks === 'true';

    // Check if environment has associated deployment configurations
    const deploymentConfigs = await prisma.deploymentConfiguration.findMany({
      where: { environmentId: id },
      select: { id: true, applicationName: true }
    });

    if (deploymentConfigs.length > 0) {
      const appNames = deploymentConfigs.map(config => config.applicationName).join(', ');
      return res.status(400).json({
        error: 'Environment has associated deployments',
        message: `Cannot delete environment with existing deployment configurations. Please delete the following deployment configurations first: ${appNames}`,
        deploymentConfigurations: deploymentConfigs
      });
    }

    const success = await environmentManager.deleteEnvironment(id, {
      deleteVolumes: shouldDeleteVolumes,
      deleteNetworks: shouldDeleteNetworks
    });

    if (!success) {
      return res.status(404).json({
        error: 'Environment not found',
        message: `Environment with ID ${id} does not exist`
      });
    }

    logger.debug({
      environmentId: id,
      deleteVolumes: shouldDeleteVolumes,
      deleteNetworks: shouldDeleteNetworks
    }, 'Environment deleted via API');

    res.status(204).send();

  } catch (error) {
    logger.error({ error, environmentId: req.params.id }, 'Failed to delete environment');

    if (error instanceof Error && error.message.includes('Cannot delete a running environment')) {
      return res.status(400).json({
        error: 'Environment is running',
        message: 'Cannot delete a running environment. Stop it first.'
      });
    }

    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to delete environment'
    });
  }
});

/**
 * @swagger
 * /api/environments/{id}/status:
 *   get:
 *     summary: Get environment status
 *     description: Retrieve the current status of an environment including health checks for all services
 *     tags:
 *       - Environment Management
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: id
 *         in: path
 *         description: Environment unique identifier
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         example: 'env-123'
 *     responses:
 *       200:
 *         description: Environment status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 environmentId:
 *                   type: string
 *                   description: Environment unique identifier
 *                   example: 'env-123'
 *                 status:
 *                   type: string
 *                   description: Overall environment status
 *                   enum: ['running', 'stopped', 'starting', 'stopping', 'error']
 *                   example: 'running'
 *                 serviceStatuses:
 *                   type: array
 *                   description: Status of individual services
 *                   items:
 *                     type: object
 *                     properties:
 *                       serviceName:
 *                         type: string
 *                         example: 'web-server'
 *                       serviceType:
 *                         type: string
 *                         example: 'nginx'
 *                       status:
 *                         type: string
 *                         enum: ['running', 'stopped', 'starting', 'stopping', 'error']
 *                         example: 'running'
 *                       healthCheck:
 *                         type: object
 *                         properties:
 *                           healthy:
 *                             type: boolean
 *                             example: true
 *                           lastCheck:
 *                             type: string
 *                             format: date-time
 *                             example: '2025-09-24T12:00:00.000Z'
 *                           responseTime:
 *                             type: integer
 *                             description: Health check response time in milliseconds
 *                             example: 45
 *                 lastUpdated:
 *                   type: string
 *                   format: date-time
 *                   description: When the status was last updated
 *                   example: '2025-09-24T12:00:00.000Z'
 *               required:
 *                 - environmentId
 *                 - status
 *                 - serviceStatuses
 *                 - lastUpdated
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
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/:id/status', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    const status = await environmentManager.getEnvironmentStatus(id);

    if (!status) {
      return res.status(404).json({
        error: 'Environment not found',
        message: `Environment with ID ${id} does not exist`
      });
    }

    res.json(status);

  } catch (error) {
    logger.error({ error, environmentId: req.params.id }, 'Failed to get environment status');
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to retrieve environment status'
    });
  }
});

/**
 * @swagger
 * /api/environments/{id}/start:
 *   post:
 *     summary: Start environment
 *     description: Start all services in an environment. This will create and start Docker containers for all configured services.
 *     tags:
 *       - Environment Operations
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: id
 *         in: path
 *         description: Environment unique identifier
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         example: 'env-123'
 *     responses:
 *       200:
 *         description: Environment started successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: 'Environment started successfully'
 *                 duration:
 *                   type: integer
 *                   description: Time taken to start the environment in milliseconds
 *                   example: 15000
 *                 details:
 *                   type: object
 *                   description: Additional details about the operation
 *                   properties:
 *                     servicesStarted:
 *                       type: integer
 *                       example: 3
 *                     containerIds:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ['container-123', 'container-456']
 *               required:
 *                 - success
 *                 - message
 *                 - duration
 *       400:
 *         description: Failed to start environment
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: 'Failed to start environment'
 *                 message:
 *                   type: string
 *                   example: 'Unable to start service web-server: Port 80 already in use'
 *                 details:
 *                   type: object
 *                   description: Additional error details
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/:id/start', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await environmentManager.startEnvironment(id);

    if (!result.success) {
      return res.status(400).json({
        error: 'Failed to start environment',
        message: result.message,
        details: result.details
      });
    }

    logger.debug({
      environmentId: id,
      duration: result.duration
    }, 'Environment started via API');

    res.json(result);

  } catch (error) {
    logger.error({ error, environmentId: req.params.id }, 'Failed to start environment');
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to start environment'
    });
  }
});

/**
 * @swagger
 * /api/environments/{id}/stop:
 *   post:
 *     summary: Stop environment
 *     description: Stop all running services in an environment. This will gracefully stop and remove Docker containers.
 *     tags:
 *       - Environment Operations
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: id
 *         in: path
 *         description: Environment unique identifier
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         example: 'env-123'
 *     responses:
 *       200:
 *         description: Environment stopped successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: 'Environment stopped successfully'
 *                 duration:
 *                   type: integer
 *                   description: Time taken to stop the environment in milliseconds
 *                   example: 8000
 *                 details:
 *                   type: object
 *                   description: Additional details about the operation
 *                   properties:
 *                     servicesStopped:
 *                       type: integer
 *                       example: 3
 *                     containersRemoved:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ['container-123', 'container-456']
 *               required:
 *                 - success
 *                 - message
 *                 - duration
 *       400:
 *         description: Failed to stop environment
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: 'Failed to stop environment'
 *                 message:
 *                   type: string
 *                   example: 'Unable to stop service database: Container not responding'
 *                 details:
 *                   type: object
 *                   description: Additional error details
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/:id/stop', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await environmentManager.stopEnvironment(id);

    if (!result.success) {
      return res.status(400).json({
        error: 'Failed to stop environment',
        message: result.message,
        details: result.details
      });
    }

    logger.debug({
      environmentId: id,
      duration: result.duration
    }, 'Environment stopped via API');

    res.json(result);

  } catch (error) {
    logger.error({ error, environmentId: req.params.id }, 'Failed to stop environment');
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to stop environment'
    });
  }
});

/**
 * @swagger
 * /api/environments/{id}/services:
 *   get:
 *     summary: List services in environment
 *     description: Retrieve all services configured in a specific environment
 *     tags:
 *       - Environment Services
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: id
 *         in: path
 *         description: Environment unique identifier
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         example: 'env-123'
 *     responses:
 *       200:
 *         description: Environment services retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                     description: Service unique identifier
 *                     example: 'service-123'
 *                   serviceName:
 *                     type: string
 *                     description: Name of the service
 *                     example: 'web-server'
 *                   serviceType:
 *                     type: string
 *                     description: Type of service
 *                     example: 'nginx'
 *                   config:
 *                     type: object
 *                     description: Service configuration
 *                     additionalProperties: true
 *                     example:
 *                       port: 80
 *                       ssl: true
 *                   status:
 *                     type: string
 *                     description: Current status of the service
 *                     enum: ['running', 'stopped', 'starting', 'stopping', 'error']
 *                     example: 'running'
 *                   createdAt:
 *                     type: string
 *                     format: date-time
 *                     example: '2025-09-24T10:00:00.000Z'
 *                   updatedAt:
 *                     type: string
 *                     format: date-time
 *                     example: '2025-09-24T12:00:00.000Z'
 *                 required:
 *                   - id
 *                   - serviceName
 *                   - serviceType
 *                   - status
 *                   - createdAt
 *                   - updatedAt
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
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/:id/services', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    const environment = await environmentManager.getEnvironmentById(id);

    if (!environment) {
      return res.status(404).json({
        error: 'Environment not found',
        message: `Environment with ID ${id} does not exist`
      });
    }

    res.json(environment.services);

  } catch (error) {
    logger.error({ error, environmentId: req.params.id }, 'Failed to list environment services');
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to retrieve environment services'
    });
  }
});

/**
 * @swagger
 * /api/environments/{id}/services:
 *   post:
 *     summary: Add service to environment
 *     description: Add a new service to an existing environment. The service type must be available in the service registry.
 *     tags:
 *       - Environment Services
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: id
 *         in: path
 *         description: Environment unique identifier
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         example: 'env-123'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AddServiceToEnvironmentRequest'
 *           example:
 *             serviceName: 'cache-server'
 *             serviceType: 'redis'
 *             config:
 *               port: 6379
 *               maxMemory: '512mb'
 *               persistence: false
 *     responses:
 *       201:
 *         description: Service added to environment successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EnvironmentInfo'
 *       400:
 *         description: Invalid service type
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: 'Invalid service type'
 *                 message:
 *                   type: string
 *                   example: 'Unknown service type: invalid-service'
 *                 availableTypes:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ['nginx', 'postgres', 'redis']
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Service name already exists in environment
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/:id/services', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const request: AddServiceToEnvironmentRequest = req.body;

    // Validate service type
    if (!serviceRegistry.isServiceTypeAvailable(request.serviceType)) {
      return res.status(400).json({
        error: 'Invalid service type',
        message: `Unknown service type: ${request.serviceType}`,
        availableTypes: serviceRegistry.getAvailableServiceTypes()
      });
    }

    await environmentManager.addServiceToEnvironment(id, request);

    // Return updated environment
    const environment = await environmentManager.getEnvironmentById(id);

    logger.debug({
      environmentId: id,
      serviceName: request.serviceName,
      serviceType: request.serviceType
    }, 'Service added to environment via API');

    res.status(201).json(environment);

  } catch (error) {
    logger.error({
      error,
      environmentId: req.params.id,
      request: req.body
    }, 'Failed to add service to environment');

    if (error instanceof Error && error.message.includes('Unique constraint')) {
      return res.status(409).json({
        error: 'Service name already exists',
        message: 'A service with this name already exists in the environment'
      });
    }

    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to add service to environment'
    });
  }
});

/**
 * @swagger
 * /api/environments/services/available:
 *   get:
 *     summary: List available service types
 *     description: Retrieve all service types available in the service registry for use in environments
 *     tags:
 *       - Service Registry
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     responses:
 *       200:
 *         description: Available service types retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 services:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       serviceType:
 *                         type: string
 *                         description: Unique identifier for the service type
 *                         example: 'nginx'
 *                       description:
 *                         type: string
 *                         description: Human-readable description
 *                         example: 'NGINX web server'
 *                       version:
 *                         type: string
 *                         description: Service definition version
 *                         example: '1.0.0'
 *                       tags:
 *                         type: array
 *                         items:
 *                           type: string
 *                         description: Categories or tags for the service
 *                         example: ['web-server', 'proxy']
 *                       requiredNetworks:
 *                         type: array
 *                         items:
 *                           type: string
 *                         description: Docker networks required by this service
 *                         example: ['web']
 *                       exposedPorts:
 *                         type: array
 *                         items:
 *                           type: integer
 *                         description: Ports exposed by this service
 *                         example: [80, 443]
 *                     required:
 *                       - serviceType
 *                       - description
 *                       - version
 *               required:
 *                 - services
 *             example:
 *               services:
 *                 - serviceType: 'nginx'
 *                   description: 'NGINX web server and reverse proxy'
 *                   version: '1.0.0'
 *                   tags: ['web-server', 'proxy']
 *                   requiredNetworks: ['web']
 *                   exposedPorts: [80, 443]
 *                 - serviceType: 'postgres'
 *                   description: 'PostgreSQL database server'
 *                   version: '1.0.0'
 *                   tags: ['database', 'sql']
 *                   requiredNetworks: ['database']
 *                   exposedPorts: [5432]
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/services/available', requireSessionOrApiKey, async (req, res) => {
  try {
    const services = serviceRegistry.getAllServiceMetadata();

    res.json({ services });

  } catch (error) {
    logger.error({ error }, 'Failed to get available services');
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to retrieve available services'
    });
  }
});

/**
 * @swagger
 * /api/environments/services/available/{serviceType}:
 *   get:
 *     summary: Get service type metadata
 *     description: Retrieve detailed metadata for a specific service type including requirements and configuration options
 *     tags:
 *       - Service Registry
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - name: serviceType
 *         in: path
 *         description: Service type identifier
 *         required: true
 *         schema:
 *           type: string
 *         example: 'nginx'
 *     responses:
 *       200:
 *         description: Service type metadata retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 serviceType:
 *                   type: string
 *                   description: Service type identifier
 *                   example: 'nginx'
 *                 description:
 *                   type: string
 *                   description: Human-readable description
 *                   example: 'NGINX web server and reverse proxy'
 *                 version:
 *                   type: string
 *                   description: Service definition version
 *                   example: '1.0.0'
 *                 requiredNetworks:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Docker networks required by this service
 *                   example: ['web']
 *                 requiredVolumes:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Docker volumes required by this service
 *                   example: ['nginx-config', 'nginx-logs']
 *                 exposedPorts:
 *                   type: array
 *                   items:
 *                     type: integer
 *                   description: Ports exposed by this service
 *                   example: [80, 443]
 *                 dependencies:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Other services this service depends on
 *                   example: ['postgres']
 *                 tags:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Categories or tags for the service
 *                   example: ['web-server', 'proxy']
 *               required:
 *                 - serviceType
 *                 - description
 *                 - version
 *                 - requiredNetworks
 *                 - requiredVolumes
 *                 - exposedPorts
 *                 - dependencies
 *                 - tags
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Service type not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: 'Service type not found'
 *                 message:
 *                   type: string
 *                   example: 'Service type nginx is not available'
 *                 availableTypes:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ['postgres', 'redis', 'mongodb']
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/services/available/:serviceType', requireSessionOrApiKey, async (req, res) => {
  try {
    const { serviceType } = req.params;

    const definition = serviceRegistry.getServiceDefinition(serviceType);

    if (!definition) {
      return res.status(404).json({
        error: 'Service type not found',
        message: `Service type ${serviceType} is not available`,
        availableTypes: serviceRegistry.getAvailableServiceTypes()
      });
    }

    res.json({
      serviceType: definition.serviceType,
      description: definition.description,
      version: definition.metadata.version,
      requiredNetworks: definition.metadata.requiredNetworks,
      requiredVolumes: definition.metadata.requiredVolumes,
      exposedPorts: definition.metadata.exposedPorts,
      dependencies: definition.metadata.dependencies,
      tags: definition.metadata.tags
    });

  } catch (error) {
    logger.error({ error, serviceType: req.params.serviceType }, 'Failed to get service type metadata');
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to retrieve service type metadata'
    });
  }
});

export default router;