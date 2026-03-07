import { Router } from 'express';
import prisma from '../lib/prisma';
import { appLogger } from '../lib/logger-factory';
import { requirePermission } from '../middleware/auth';
import { DockerExecutorService } from '../services/docker-executor';
import { StackReconciler } from '../services/stacks/stack-reconciler';
import { StackRoutingManager } from '../services/stacks/stack-routing-manager';
import { HAProxyFrontendManager } from '../services/haproxy';
import {
  createStackSchema,
  updateStackSchema,
  updateStackServiceSchema,
  applyStackSchema,
} from '../services/stacks/schemas';
import {
  serializeStack,
  toServiceCreateInput,
  isDockerConnectionError,
  mapContainerStatus,
} from '../services/stacks/utils';

const router = Router();
const logger = appLogger();

// GET / — List stacks
router.get('/', requirePermission('stacks:read'), async (req, res) => {
  try {
    const { environmentId, scope } = req.query;
    const where: any = {};
    if (scope === 'host') {
      where.environmentId = null;
    } else if (environmentId && typeof environmentId === 'string') {
      where.environmentId = environmentId;
    }

    const stacks = await prisma.stack.findMany({
      where,
      include: { services: true },
      orderBy: { name: 'asc' },
    });

    res.json({ success: true, data: stacks.map(serializeStack) });
  } catch (error) {
    logger.error({ error }, 'Failed to list stacks');
    res.status(500).json({ success: false, message: 'Failed to list stacks' });
  }
});

// GET /:stackId — Get stack with services
router.get('/:stackId', requirePermission('stacks:read'), async (req, res) => {
  try {
    const stack = await prisma.stack.findUnique({
      where: { id: req.params.stackId },
      include: { services: { orderBy: { order: 'asc' } } },
    });

    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    res.json({ success: true, data: serializeStack(stack) });
  } catch (error) {
    logger.error({ error, stackId: req.params.stackId }, 'Failed to get stack');
    res.status(500).json({ success: false, message: 'Failed to get stack' });
  }
});

// POST / — Create stack
router.post('/', requirePermission('stacks:write'), async (req, res) => {
  try {
    const parsed = createStackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const { name, description, environmentId, networks, volumes, services } = parsed.data;

    if (environmentId) {
      // Check environment exists
      const environment = await prisma.environment.findUnique({ where: { id: environmentId } });
      if (!environment) {
        return res.status(404).json({ success: false, message: 'Environment not found' });
      }

      // Check uniqueness within environment
      const existing = await prisma.stack.findFirst({ where: { name, environmentId } });
      if (existing) {
        return res.status(409).json({ success: false, message: 'A stack with this name already exists in this environment' });
      }
    } else {
      // Host-level stack: enforce singleton
      const existing = await prisma.stack.findFirst({ where: { name, environmentId: null } });
      if (existing) {
        return res.status(409).json({ success: false, message: 'A host-level stack with this name already exists' });
      }
    }

    const stack = await prisma.stack.create({
      data: {
        name,
        description: description ?? null,
        environmentId: environmentId ?? undefined,
        networks: networks as any,
        volumes: volumes as any,
        services: {
          create: services.map(toServiceCreateInput),
        },
      },
      include: { services: true },
    });

    logger.info({ stackId: stack.id, stackName: stack.name }, 'Stack created');
    res.status(201).json({ success: true, data: serializeStack(stack) });
  } catch (error) {
    logger.error({ error }, 'Failed to create stack');
    res.status(500).json({ success: false, message: 'Failed to create stack' });
  }
});

// PUT /:stackId — Update stack definition
router.put('/:stackId', requirePermission('stacks:write'), async (req, res) => {
  try {
    const parsed = updateStackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const { stackId } = req.params;
    const existing = await prisma.stack.findUnique({
      where: { id: stackId },
      include: { services: true },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    const { services, ...fields } = parsed.data;

    if (services) {
      // Transaction: delete existing services, update stack, recreate services
      const stack = await prisma.$transaction(async (tx) => {
        await tx.stackService.deleteMany({ where: { stackId } });

        return tx.stack.update({
          where: { id: stackId },
          data: {
            ...fields,
            networks: fields.networks ? (fields.networks as any) : undefined,
            volumes: fields.volumes ? (fields.volumes as any) : undefined,
            version: existing.version + 1,
            status: 'pending',
            services: {
              create: services.map(toServiceCreateInput),
            },
          },
          include: { services: true },
        });
      });

      res.json({ success: true, data: serializeStack(stack) });
    } else {
      const stack = await prisma.stack.update({
        where: { id: stackId },
        data: {
          ...fields,
          networks: fields.networks ? (fields.networks as any) : undefined,
          volumes: fields.volumes ? (fields.volumes as any) : undefined,
          version: existing.version + 1,
          status: 'pending',
        },
        include: { services: true },
      });

      res.json({ success: true, data: serializeStack(stack) });
    }
  } catch (error) {
    logger.error({ error, stackId: req.params.stackId }, 'Failed to update stack');
    res.status(500).json({ success: false, message: 'Failed to update stack' });
  }
});

// DELETE /:stackId — Delete stack
router.delete('/:stackId', requirePermission('stacks:write'), async (req, res) => {
  try {
    const { stackId } = req.params;
    const stack = await prisma.stack.findUnique({ where: { id: stackId } });

    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    if (stack.status !== 'undeployed' && stack.status !== 'pending') {
      // Check if there are running containers
      try {
        const dockerExecutor = new DockerExecutorService();
        await dockerExecutor.initialize();
        const docker = dockerExecutor.getDockerClient();
        const containers = await docker.listContainers({
          filters: { label: [`mini-infra.stack-id=${stackId}`] },
        });

        if (containers.length > 0) {
          return res.status(400).json({
            success: false,
            message: 'Cannot delete stack with running containers. Remove containers first or set status to undeployed.',
          });
        }
      } catch {
        // If Docker is unavailable, be conservative
        return res.status(400).json({
          success: false,
          message: 'Cannot verify container state. Stack status must be "undeployed" to delete without Docker access.',
        });
      }
    }

    await prisma.stack.delete({ where: { id: stackId } });
    res.json({ success: true, message: 'Stack deleted' });
  } catch (error) {
    logger.error({ error, stackId: req.params.stackId }, 'Failed to delete stack');
    res.status(500).json({ success: false, message: 'Failed to delete stack' });
  }
});

// PUT /:stackId/services/:serviceName — Update single service
router.put('/:stackId/services/:serviceName', requirePermission('stacks:write'), async (req, res) => {
  try {
    const parsed = updateStackServiceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const { stackId, serviceName } = req.params;

    const service = await prisma.stackService.findFirst({
      where: { stackId, serviceName },
    });

    if (!service) {
      return res.status(404).json({ success: false, message: 'Stack service not found' });
    }

    const updateData: any = {};
    const data = parsed.data;
    if (data.serviceType !== undefined) updateData.serviceType = data.serviceType;
    if (data.dockerImage !== undefined) updateData.dockerImage = data.dockerImage;
    if (data.dockerTag !== undefined) updateData.dockerTag = data.dockerTag;
    if (data.containerConfig !== undefined) updateData.containerConfig = data.containerConfig as any;
    if (data.configFiles !== undefined) updateData.configFiles = data.configFiles as any;
    if (data.initCommands !== undefined) updateData.initCommands = data.initCommands as any;
    if (data.dependsOn !== undefined) updateData.dependsOn = data.dependsOn;
    if (data.order !== undefined) updateData.order = data.order;
    if (data.routing !== undefined) updateData.routing = data.routing as any;

    await prisma.$transaction([
      prisma.stackService.update({
        where: { id: service.id },
        data: updateData,
      }),
      prisma.stack.update({
        where: { id: stackId },
        data: {
          version: { increment: 1 },
          status: 'pending',
        },
      }),
    ]);

    const stack = await prisma.stack.findUnique({
      where: { id: stackId },
      include: { services: { orderBy: { order: 'asc' } } },
    });

    res.json({ success: true, data: serializeStack(stack) });
  } catch (error) {
    logger.error({ error, stackId: req.params.stackId, serviceName: req.params.serviceName }, 'Failed to update stack service');
    res.status(500).json({ success: false, message: 'Failed to update stack service' });
  }
});

// GET /:stackId/plan — Compute plan
router.get('/:stackId/plan', requirePermission('stacks:read'), async (req, res) => {
  try {
    const dockerExecutor = new DockerExecutorService();
    await dockerExecutor.initialize();
    const reconciler = new StackReconciler(dockerExecutor, prisma);
    const plan = await reconciler.plan(req.params.stackId);

    res.json({ success: true, data: plan });
  } catch (error: any) {
    if (isDockerConnectionError(error)) {
      return res.status(503).json({ success: false, message: 'Docker is unavailable' });
    }
    logger.error({ error, stackId: req.params.stackId }, 'Failed to compute plan');
    res.status(500).json({ success: false, message: error?.message ?? 'Failed to compute plan' });
  }
});

// POST /:stackId/apply — Apply changes
router.post('/:stackId/apply', requirePermission('stacks:write'), async (req, res) => {
  try {
    const parsed = applyStackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const dockerExecutor = new DockerExecutorService();
    await dockerExecutor.initialize();
    const routingManager = new StackRoutingManager(prisma, new HAProxyFrontendManager());
    const reconciler = new StackReconciler(dockerExecutor, prisma, routingManager);
    const result = await reconciler.apply(req.params.stackId, {
      ...parsed.data,
      triggeredBy: (req as any).user?.id,
    });

    res.json({ success: true, data: result });
  } catch (error: any) {
    if (isDockerConnectionError(error)) {
      return res.status(503).json({ success: false, message: 'Docker is unavailable' });
    }
    logger.error({ error, stackId: req.params.stackId }, 'Failed to apply stack');
    res.status(500).json({ success: false, message: error?.message ?? 'Failed to apply stack' });
  }
});

// GET /:stackId/status — Current status with container state
router.get('/:stackId/status', requirePermission('stacks:read'), async (req, res) => {
  try {
    const { stackId } = req.params;
    const stack = await prisma.stack.findUnique({
      where: { id: stackId },
      include: { services: { orderBy: { order: 'asc' } } },
    });

    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    let containerStatus: any[] = [];
    try {
      const dockerExecutor = new DockerExecutorService();
      await dockerExecutor.initialize();
      const docker = dockerExecutor.getDockerClient();
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`mini-infra.stack-id=${stackId}`] },
      });

      containerStatus = containers.map((c) => ({
        ...mapContainerStatus(c),
        health: c.Labels['mini-infra.definition-hash'] ? 'tracked' : 'untracked',
      }));
    } catch {
      // Docker unavailable — return stack info without container status
    }

    res.json({
      success: true,
      data: {
        stack: serializeStack(stack),
        containerStatus,
      },
    });
  } catch (error) {
    logger.error({ error, stackId: req.params.stackId }, 'Failed to get stack status');
    res.status(500).json({ success: false, message: 'Failed to get stack status' });
  }
});

// GET /:stackId/history — List deployment history
router.get('/:stackId/history', requirePermission('stacks:read'), async (req, res) => {
  try {
    const { stackId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const stack = await prisma.stack.findUnique({ where: { id: stackId }, select: { id: true } });
    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    const [data, total] = await Promise.all([
      prisma.stackDeployment.findMany({
        where: { stackId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.stackDeployment.count({ where: { stackId } }),
    ]);

    res.json({ success: true, data, total });
  } catch (error) {
    logger.error({ error, stackId: req.params.stackId }, 'Failed to get stack history');
    res.status(500).json({ success: false, message: 'Failed to get stack history' });
  }
});

// GET /:stackId/history/:deploymentId — Specific deployment record
router.get('/:stackId/history/:deploymentId', requirePermission('stacks:read'), async (req, res) => {
  try {
    const deployment = await prisma.stackDeployment.findFirst({
      where: { id: req.params.deploymentId, stackId: req.params.stackId },
    });

    if (!deployment) {
      return res.status(404).json({ success: false, message: 'Deployment not found' });
    }

    res.json({ success: true, data: deployment });
  } catch (error) {
    logger.error({ error, stackId: req.params.stackId }, 'Failed to get deployment record');
    res.status(500).json({ success: false, message: 'Failed to get deployment record' });
  }
});

export default router;
