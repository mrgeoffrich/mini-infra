import { Router } from 'express';
import prisma from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { requirePermission } from '../../middleware/auth';
import { DockerExecutorService } from '../../services/docker-executor';
import { serializeStack, mapContainerStatus } from '../../services/stacks/utils';

const router = Router();

// GET /:stackId/status — Stack + live container status
router.get(
  '/:stackId/status',
  requirePermission('stacks:read'),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const stack = await prisma.stack.findUnique({
      where: { id: stackId },
      include: {
        services: { orderBy: { order: 'asc' } },
        template: { select: { currentVersion: { select: { version: true } } } },
      },
    });

    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    let containerStatus: Array<ReturnType<typeof mapContainerStatus> & { health: string }> = [];
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
      data: { stack: serializeStack(stack), containerStatus },
    });
  }),
);

// GET /:stackId/history — Deployment history list
router.get(
  '/:stackId/history',
  requirePermission('stacks:read'),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const stack = await prisma.stack.findUnique({
      where: { id: stackId },
      select: { id: true },
    });
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
  }),
);

// GET /:stackId/history/:deploymentId — Specific deployment record
router.get(
  '/:stackId/history/:deploymentId',
  requirePermission('stacks:read'),
  asyncHandler(async (req, res) => {
    const deployment = await prisma.stackDeployment.findFirst({
      where: {
        id: String(req.params.deploymentId),
        stackId: String(req.params.stackId),
      },
    });

    if (!deployment) {
      return res.status(404).json({ success: false, message: 'Deployment not found' });
    }

    res.json({ success: true, data: deployment });
  }),
);

export default router;
