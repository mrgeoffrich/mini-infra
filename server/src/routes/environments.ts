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


router.post('/', requireSessionOrApiKey, async (req, res) => {
  try {
    const request: CreateEnvironmentRequest = req.body;
    const userId = (req.user as any)?.id;

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

    const environment = await environmentManager.createEnvironment(request, userId);

    logger.debug({
      environmentId: environment.id,
      environmentName: environment.name,
      serviceCount: environment.services.length,
      userId
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


router.delete('/:id', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const { deleteVolumes = 'false', deleteNetworks = 'false' } = req.query;
    const userId = (req.user as any)?.id;

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
      deleteNetworks: shouldDeleteNetworks,
      userId
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
      deleteNetworks: shouldDeleteNetworks,
      userId
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


router.post('/:id/start', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = (req.user as any)?.id;

    const result = await environmentManager.startEnvironment(id, userId);

    if (!result.success) {
      return res.status(400).json({
        error: 'Failed to start environment',
        message: result.message,
        details: result.details
      });
    }

    logger.debug({
      environmentId: id,
      duration: result.duration,
      userId
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


router.post('/:id/stop', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = (req.user as any)?.id;

    const result = await environmentManager.stopEnvironment(id, userId);

    if (!result.success) {
      return res.status(400).json({
        error: 'Failed to stop environment',
        message: result.message,
        details: result.details
      });
    }

    logger.debug({
      environmentId: id,
      duration: result.duration,
      userId
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


router.get('/services/available/:serviceType', requireSessionOrApiKey, async (req, res) => {
  try {
    const { serviceType } = req.params;
    const { environmentId } = req.query;

    const definition = serviceRegistry.getServiceDefinition(serviceType);

    if (!definition) {
      return res.status(404).json({
        error: 'Service type not found',
        message: `Service type ${serviceType} is not available`,
        availableTypes: serviceRegistry.getAvailableServiceTypes()
      });
    }

    // Clone the metadata to avoid modifying the cached version
    let exposedPorts = [...definition.metadata.exposedPorts];

    // For HAProxy, calculate dynamic ports based on environment context
    if (serviceType === 'haproxy' && environmentId && typeof environmentId === 'string') {
      try {
        const { portUtils } = await import('../services/port-utils');
        const portConfig = await portUtils.getHAProxyPortsForEnvironment(environmentId);

        // Update the HTTP and HTTPS port mappings with dynamic values
        exposedPorts = exposedPorts.map(port => {
          if (port.name === 'http') {
            return { ...port, hostPort: portConfig.httpPort };
          } else if (port.name === 'https') {
            return { ...port, hostPort: portConfig.httpsPort };
          }
          return port;
        });

        logger.debug({
          serviceType,
          environmentId,
          httpPort: portConfig.httpPort,
          httpsPort: portConfig.httpsPort,
          source: portConfig.source
        }, 'Dynamic HAProxy ports calculated for environment');
      } catch (error) {
        logger.warn({ error, environmentId }, 'Failed to get dynamic HAProxy ports, using defaults');
        // Fall back to default ports if calculation fails
      }
    }

    res.json({
      serviceType: definition.serviceType,
      description: definition.description,
      version: definition.metadata.version,
      requiredNetworks: definition.metadata.requiredNetworks,
      requiredVolumes: definition.metadata.requiredVolumes,
      exposedPorts: exposedPorts,
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

// Networks routes - inline instead of sub-router to avoid Express 5 mounting complexity
router.get('/:id/networks', requireSessionOrApiKey, async (req, res) => {
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

// Volumes routes - inline instead of sub-router to avoid Express 5 mounting complexity
router.get('/:id/volumes', requireSessionOrApiKey, async (req, res) => {
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

export default router;