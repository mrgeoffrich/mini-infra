import { Router } from 'express';
import { z } from 'zod';
import {
  CreateEnvironmentRequest,
  UpdateEnvironmentRequest,
  EnvironmentType,
} from '@mini-infra/types';
import { EnvironmentManager } from '../services/environment';
import { requirePermission } from '../middleware/auth';
import prisma from '../lib/prisma';
import { appLogger } from '../lib/logger-factory';
import { haproxyRemediationService, HAProxyDataPlaneClient } from '../services/haproxy';
import { haproxyMigrationService } from '../services/haproxy/haproxy-migration-service';
import { restoreHAProxyRuntimeState } from '../services/haproxy/haproxy-post-apply';
import { emitToChannel } from '../lib/socket';
import { Channel, ServerEvent } from '@mini-infra/types';
import { emitHAProxyUpdate } from '../services/haproxy-socket-emitter';
import DockerService from '../services/docker';

const router = Router();
const logger = appLogger();

// Track in-progress migrations to prevent concurrent runs
const migratingEnvironments = new Set<string>();

// Initialize services
const environmentManager = EnvironmentManager.getInstance(prisma);

// Validation schemas
const createEnvironmentSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'Name must contain only letters, numbers, underscores, and hyphens'),
  description: z.string().optional(),
  type: z.enum(['production', 'nonproduction']),
  networkType: z.enum(['local', 'internet']).optional(),
});

const updateEnvironmentSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  description: z.string().optional(),
  type: z.enum(['production', 'nonproduction']).optional(),
  networkType: z.enum(['local', 'internet']).optional(),
  tunnelId: z.string().optional().nullable(),
  tunnelServiceUrl: z.string().optional().nullable(),
});

const listEnvironmentsSchema = z.object({
  type: z.enum(['production', 'nonproduction']).optional(),
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional()
});



router.get('/', requirePermission('environments:read'), async (req, res) => {
  try {
    // Validate query parameters
    const validatedQuery = listEnvironmentsSchema.parse(req.query);
    const { type, page = 1, limit = 20 } = validatedQuery;

    const result = await environmentManager.listEnvironments(
      type,
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


router.post('/', requirePermission('environments:write'), async (req, res) => {
  try {
    const request: CreateEnvironmentRequest = req.body;
    const userId = (req.user as any)?.id;

    const environment = await environmentManager.createEnvironment(request, userId);

    logger.debug({
      environmentId: environment.id,
      environmentName: environment.name,
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


router.get('/:id', requirePermission('environments:read'), async (req, res) => {
  try {
    const id = String(req.params.id);

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


router.put('/:id', requirePermission('environments:write'), async (req, res) => {
  try {
    const id = String(req.params.id);
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


// Check if environment can be deleted (pre-flight validation)
router.get('/:id/delete-check', requirePermission('environments:read'), async (req, res) => {
  try {
    const id = String(req.params.id);

    const [stacks, deploymentConfigs, haproxyFrontends, haproxyBackends, stackTemplates] = await Promise.all([
      prisma.stack.findMany({
        where: { environmentId: id },
        select: { id: true, name: true },
      }),
      prisma.deploymentConfiguration.findMany({
        where: { environmentId: id },
        select: { id: true, applicationName: true },
      }),
      prisma.hAProxyFrontend.findMany({
        where: { environmentId: id },
        select: { id: true, frontendName: true, hostname: true },
      }),
      prisma.hAProxyBackend.findMany({
        where: { environmentId: id },
        select: { id: true, name: true },
      }),
      prisma.stackTemplate.findMany({
        where: { environmentId: id },
        select: { id: true, name: true },
      }),
    ]);

    const dependencies = {
      stacks: stacks.map(s => ({ id: s.id, name: s.name })),
      deploymentConfigurations: deploymentConfigs.map(d => ({ id: d.id, name: d.applicationName })),
      haproxyFrontends: haproxyFrontends.map(f => ({ id: f.id, name: f.hostname || f.frontendName })),
      haproxyBackends: haproxyBackends.map(b => ({ id: b.id, name: b.name })),
      stackTemplates: stackTemplates.map(t => ({ id: t.id, name: t.name })),
    };

    const canDelete = Object.values(dependencies).every(arr => arr.length === 0);

    res.json({ canDelete, dependencies });
  } catch (error) {
    logger.error({ error, environmentId: req.params.id }, 'Failed to check environment delete eligibility');
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to check delete eligibility',
    });
  }
});

router.delete('/:id', requirePermission('environments:write'), async (req, res) => {
  try {
    const id = String(req.params.id);
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


// Networks routes - inline instead of sub-router to avoid Express 5 mounting complexity
router.get('/:id/networks', requirePermission('environments:read'), async (req, res) => {
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

// Volumes routes - inline instead of sub-router to avoid Express 5 mounting complexity
router.get('/:id/volumes', requirePermission('environments:read'), async (req, res) => {
  try {
    const id = String(req.params.id);

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

// ====================
// HAProxy Remediation Routes
// ====================

/**
 * Helper function to get HAProxy DataPlane client for an environment
 */
async function getHAProxyClientForEnvironment(environmentId: string): Promise<HAProxyDataPlaneClient> {
  // Get environment details
  const environment = await prisma.environment.findUnique({
    where: { id: environmentId },
  });

  if (!environment) {
    throw new Error(`Environment not found: ${environmentId}`);
  }

  const haproxyStack = await prisma.stack.findFirst({
    where: { environmentId, name: 'haproxy', status: { not: 'removed' } },
  });

  if (!haproxyStack) {
    throw new Error(`HAProxy stack not configured for environment: ${environment.name}`);
  }

  // Find HAProxy container using Docker
  const dockerService = DockerService.getInstance();
  await dockerService.initialize();
  const containers = await dockerService.listContainers();

  // Look for HAProxy container with environment label
  const haproxyContainer = containers.find((container: any) => {
    const labels = container.labels || {};
    return (
      labels["mini-infra.service"] === "haproxy" &&
      labels["mini-infra.environment"] === environmentId &&
      container.status === "running"
    );
  });

  if (!haproxyContainer) {
    throw new Error(
      `No running HAProxy container found for environment: ${environment.name}. ` +
      `Ensure HAProxy is deployed and running.`
    );
  }

  // Initialize HAProxy client with container ID
  const client = new HAProxyDataPlaneClient();
  await client.initialize(haproxyContainer.id);

  return client;
}

// Network remediation is now handled by the InfraResource system during stack apply

/**
 * POST /api/environments/:id/remediate-haproxy
 * Trigger full HAProxy remediation for an environment
 */
router.post('/:id/remediate-haproxy', requirePermission('environments:write'), async (req, res) => {
  try {
    const id = String(req.params.id);

    // Verify environment exists
    const environment = await environmentManager.getEnvironmentById(id);
    if (!environment) {
      return res.status(404).json({
        error: 'Environment not found',
        message: `Environment with ID ${id} does not exist`
      });
    }

    // Check if environment has HAProxy stack
    const haproxyStack = await prisma.stack.findFirst({
      where: { environmentId: id, name: 'haproxy', status: { not: 'removed' } },
    });
    if (!haproxyStack) {
      return res.status(400).json({
        error: 'No HAProxy stack',
        message: 'This environment does not have an HAProxy stack configured'
      });
    }

    // Perform full rebuild of HAProxy runtime state from DB
    logger.info({ environmentId: id, environmentName: environment.name }, 'Starting full HAProxy rebuild via API');
    const result = await restoreHAProxyRuntimeState(id, prisma);

    logger.info({
      environmentId: id,
      result
    }, 'HAProxy rebuild completed via API');

    res.json({
      success: result.success,
      data: {
        steps: result.steps,
        errors: result.errors,
      },
      message: result.success
        ? 'HAProxy rebuild completed successfully'
        : 'HAProxy rebuild completed with errors'
    });

  } catch (error) {
    logger.error({ error, environmentId: req.params.id }, 'Failed to remediate HAProxy');
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to remediate HAProxy'
    });
  }
});

/**
 * GET /api/environments/:id/haproxy-status
 * Get HAProxy configuration status for an environment
 */
router.get('/:id/haproxy-status', requirePermission('environments:read'), async (req, res) => {
  try {
    const id = String(req.params.id);

    // Verify environment exists
    const environment = await environmentManager.getEnvironmentById(id);
    if (!environment) {
      return res.status(404).json({
        error: 'Environment not found',
        message: `Environment with ID ${id} does not exist`
      });
    }

    // Check if environment has HAProxy stack
    const haproxyStack = await prisma.stack.findFirst({
      where: { environmentId: id, name: 'haproxy', status: { not: 'removed' } },
    });
    if (!haproxyStack) {
      return res.status(200).json({
        success: true,
        data: {
          hasHAProxy: false,
          message: 'This environment does not have an HAProxy stack configured'
        }
      });
    }

    // Get HAProxy frontends for this environment
    const frontends = await prisma.hAProxyFrontend.findMany({
      where: {
        environmentId: id,
        status: { not: 'removed' }
      },
      include: {
        routes: true
      }
    });

    // Check if using shared frontend architecture
    const sharedFrontends = frontends.filter(f => f.isSharedFrontend);
    const manualFrontends = frontends.filter(f => !f.isSharedFrontend);

    // Get deployment configs with hostnames
    const deploymentConfigs = await prisma.deploymentConfiguration.findMany({
      where: {
        environmentId: id,
        isActive: true,
        hostname: { not: null }
      },
      select: {
        id: true,
        applicationName: true,
        hostname: true,
        enableSsl: true
      }
    });

    // Determine if remediation is recommended
    const needsRemediation =
      deploymentConfigs.length > 0 && sharedFrontends.length === 0;

    res.json({
      success: true,
      data: {
        hasHAProxy: true,
        sharedFrontendsCount: sharedFrontends.length,
        manualFrontendsCount: manualFrontends.length,
        totalRoutesCount: sharedFrontends.reduce((acc, f) => acc + (f.routes?.length || 0), 0),
        deploymentConfigsWithHostnames: deploymentConfigs.length,
        needsRemediation,
        frontends: frontends.map(f => ({
          id: f.id,
          frontendName: f.frontendName,
          frontendType: f.frontendType,
          isSharedFrontend: f.isSharedFrontend,
          hostname: f.hostname,
          bindPort: f.bindPort,
          status: f.status,
          routesCount: f.routes?.length || 0
        }))
      }
    });

  } catch (error) {
    logger.error({ error, environmentId: req.params.id }, 'Failed to get HAProxy status');
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to retrieve HAProxy status'
    });
  }
});

/**
 * GET /api/environments/:id/remediation-preview
 * Get preview of what HAProxy remediation would do
 */
router.get('/:id/remediation-preview', requirePermission('environments:read'), async (req, res) => {
  try {
    const id = String(req.params.id);

    // Verify environment exists
    const environment = await environmentManager.getEnvironmentById(id);
    if (!environment) {
      return res.status(404).json({
        error: 'Environment not found',
        message: `Environment with ID ${id} does not exist`
      });
    }

    // Check if environment has HAProxy stack
    const haproxyStackCheck = await prisma.stack.findFirst({
      where: { environmentId: id, name: 'haproxy', status: { not: 'removed' } },
    });
    if (!haproxyStackCheck) {
      return res.status(400).json({
        error: 'No HAProxy stack',
        message: 'This environment does not have an HAProxy stack configured'
      });
    }

    // Get HAProxy client
    let haproxyClient: HAProxyDataPlaneClient;
    try {
      haproxyClient = await getHAProxyClientForEnvironment(id);
    } catch (error) {
      return res.status(503).json({
        error: 'HAProxy unavailable',
        message: error instanceof Error ? error.message : 'Failed to connect to HAProxy'
      });
    }

    // Get remediation preview
    const preview = await haproxyRemediationService.getRemediationPreview(id, haproxyClient, prisma);

    res.json({
      success: true,
      data: preview
    });

  } catch (error) {
    logger.error({ error, environmentId: req.params.id }, 'Failed to get remediation preview');
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to get remediation preview'
    });
  }
});

/**
 * GET /api/environments/:id/migration-preview
 * Check if environment needs migration from legacy to stack-managed HAProxy
 */
router.get('/:id/migration-preview', requirePermission('environments:read'), async (req, res) => {
  try {
    const id = String(req.params.id);

    const environment = await environmentManager.getEnvironmentById(id);
    if (!environment) {
      return res.status(404).json({
        error: 'Environment not found',
        message: `Environment with ID ${id} does not exist`
      });
    }

    const preview = await haproxyMigrationService.getMigrationPreview(id, prisma);

    res.json({
      success: true,
      data: preview
    });

  } catch (error) {
    logger.error({ error, environmentId: req.params.id }, 'Failed to get migration preview');
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to get migration preview'
    });
  }
});

/**
 * POST /api/environments/:id/migrate-haproxy
 * Migrate legacy HAProxy to stack-managed HAProxy (fire-and-forget with Socket.IO progress)
 */
router.post('/:id/migrate-haproxy', requirePermission('environments:write'), async (req, res) => {
  try {
    const id = String(req.params.id);

    const environment = await environmentManager.getEnvironmentById(id);
    if (!environment) {
      return res.status(404).json({
        error: 'Environment not found',
        message: `Environment with ID ${id} does not exist`
      });
    }

    if (migratingEnvironments.has(id)) {
      return res.status(409).json({
        success: false,
        message: 'HAProxy migration already in progress for this environment'
      });
    }

    migratingEnvironments.add(id);

    // Emit started event
    emitToChannel(Channel.STACKS, ServerEvent.MIGRATION_STARTED, {
      environmentId: id,
      environmentName: environment.name,
      totalSteps: 5,
    });

    // Respond immediately — progress comes via Socket.IO
    res.json({ success: true, data: { started: true, environmentId: id } });

    logger.info({ environmentId: id, environmentName: environment.name }, 'Starting HAProxy migration via API');

    // Run migration in background
    (async () => {
      try {
        const result = await haproxyMigrationService.migrate(id, prisma, (step, completedCount, totalSteps) => {
          try {
            emitToChannel(Channel.STACKS, ServerEvent.MIGRATION_STEP, {
              environmentId: id,
              step,
              completedCount,
              totalSteps,
            });
          } catch { /* never break migration */ }
        });

        logger.info({ environmentId: id, result: { success: result.success, stepCount: result.steps.length } }, 'HAProxy migration completed via API');

        emitToChannel(Channel.STACKS, ServerEvent.MIGRATION_COMPLETED, {
          ...result,
          environmentId: id,
        });
        emitHAProxyUpdate();
      } catch (error: any) {
        logger.error({ error: error.message, environmentId: id }, 'Background HAProxy migration failed');
        emitToChannel(Channel.STACKS, ServerEvent.MIGRATION_COMPLETED, {
          success: false,
          steps: [],
          errors: [error.message],
          environmentId: id,
        });
      } finally {
        migratingEnvironments.delete(id);
      }
    })();

  } catch (error) {
    logger.error({ error, environmentId: req.params.id }, 'Failed to start HAProxy migration');
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to start HAProxy migration'
    });
  }
});

export default router;