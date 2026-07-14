import { Router } from 'express';
import prisma from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { getLogger } from '../../lib/logger-factory';
import { requirePermission } from '../../middleware/auth';
import { DockerExecutorService } from '../../services/docker-executor';
import { serializeStack, mapContainerStatus, assertStackFound } from '../../services/stacks/utils';
import { stackOperationLock } from '../../services/stacks/operation-lock';
import {
  restoreStackFromSnapshot,
  isUsableSnapshot,
} from '../../services/stacks/stack-restore-service';
import { emitStackStatusChanged } from '../../services/stacks/stack-socket-emitter';
import { ErrorCode, Permission } from '@mini-infra/types';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';

const logger = getLogger('stacks', 'stacks-history-routes');
const router = Router();

// GET /:stackId/status — Stack + live container status
router.get(
  '/:stackId/status',
  requirePermission(Permission.StacksRead),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const stack = assertStackFound(
      await prisma.stack.findUnique({
        where: { id: stackId },
        include: {
          services: { orderBy: { order: 'asc' } },
          template: { select: { currentVersion: { select: { version: true } } } },
        },
      }),
      stackId,
    );

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
  requirePermission(Permission.StacksRead),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    assertStackFound(
      await prisma.stack.findUnique({ where: { id: stackId }, select: { id: true } }),
      stackId,
    );

    const [rows, total] = await Promise.all([
      prisma.stackDeployment.findMany({
        where: { stackId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.stackDeployment.count({ where: { stackId } }),
    ]);

    // The snapshot is a whole stack definition. Shipping up to 100 of them in a
    // list nobody asked to restore from would dwarf the rest of the payload, so
    // the list carries only whether one EXISTS; the restore route reads the real
    // thing by id.
    const data = rows.map(({ snapshot, ...rest }) => ({
      ...rest,
      hasSnapshot: snapshot != null,
    }));

    res.json({ success: true, data, total });
  }),
);

// POST /:stackId/history/:deploymentId/restore — Restore the stack's definition
// from what THIS deployment applied. Definition only: no containers are touched
// and nothing is deployed, so the stack lands `pending` and the operator applies
// when ready. That separation is deliberate — "put the definition back" and
// "push it to production" are different decisions, and a restore that silently
// redeployed would be the more dangerous of the two to trigger by accident.
router.post(
  '/:stackId/history/:deploymentId/restore',
  requirePermission(Permission.StacksWrite),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const deploymentId = String(req.params.deploymentId);

    const stack = assertStackFound(
      await prisma.stack.findUnique({
        where: { id: stackId },
        select: { id: true, name: true, version: true },
      }),
      stackId,
    );

    const deployment = await prisma.stackDeployment.findFirst({
      where: { id: deploymentId, stackId },
      select: { id: true, snapshot: true, version: true, createdAt: true },
    });
    if (!deployment) {
      throw new NotFoundError(ErrorCode.STACK_DEPLOYMENT_NOT_FOUND, 'Deployment not found', {
        resource: { type: 'stackDeployment', id: deploymentId },
        action: 'Check the deployment ID or refresh the history list.',
      });
    }

    if (!isUsableSnapshot(deployment.snapshot)) {
      throw new ValidationError(
        ErrorCode.STACK_NO_APPLIED_SNAPSHOT,
        'This deployment has no stored definition to restore',
        {
          resource: { type: 'stackDeployment', id: deploymentId },
          action:
            'Only deployments recorded since snapshots were introduced can be restored, and `stop` deployments never apply a definition.',
        },
      );
    }

    if (stackOperationLock.has(stackId)) {
      throw new ConflictError(
        ErrorCode.STACK_OPERATION_IN_PROGRESS,
        'An operation is already in progress for this stack',
        {
          resource: { type: 'stack', id: stackId },
          action: 'Wait for the in-flight operation to finish before restoring.',
        },
      );
    }
    stackOperationLock.tryAcquire(stackId);

    try {
      await restoreStackFromSnapshot(prisma, stackId, deployment.snapshot, {
        // Unlike revert-pending, the restored definition is NOT what is running —
        // it is an older one the operator has chosen to go back to. That is an
        // unapplied edit, which is precisely `pending`. And it is a new revision,
        // so the version counter moves forward rather than rewinding: the history
        // of what happened must not be rewritten by a restore.
        status: 'pending',
        bumpVersion: stack.version + 1,
      });
    } finally {
      stackOperationLock.release(stackId);
    }

    emitStackStatusChanged(stackId, 'pending');

    logger.info(
      { stackId, deploymentId, restoredVersion: deployment.version },
      'Stack definition restored from deployment history',
    );

    const updated = assertStackFound(
      await prisma.stack.findUnique({
        where: { id: stackId },
        include: {
          services: { orderBy: { order: 'asc' } },
          template: { select: { source: true, currentVersion: { select: { version: true } } } },
        },
      }),
      stackId,
    );
    res.json({ success: true, data: serializeStack(updated) });
  }),
);

// GET /:stackId/history/:deploymentId — Specific deployment record
router.get(
  '/:stackId/history/:deploymentId',
  requirePermission(Permission.StacksRead),
  asyncHandler(async (req, res) => {
    const deployment = await prisma.stackDeployment.findFirst({
      where: {
        id: String(req.params.deploymentId),
        stackId: String(req.params.stackId),
      },
    });

    if (!deployment) {
      throw new NotFoundError(ErrorCode.STACK_DEPLOYMENT_NOT_FOUND, 'Deployment not found', {
        resource: { type: 'stackDeployment', id: String(req.params.deploymentId) },
        action: 'Check the deployment ID or refresh the history list.',
      });
    }

    res.json({ success: true, data: deployment });
  }),
);

export default router;
