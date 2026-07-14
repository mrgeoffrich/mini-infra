import { Router } from 'express';
import prisma from '../../lib/prisma';
import { getLogger } from '../../lib/logger-factory';
import { asyncHandler } from '../../lib/async-handler';
import { getUserId } from '../../lib/get-user-id';
import { requirePermission } from '../../middleware/auth';
import { DockerExecutorService } from '../../services/docker-executor';
import { StackReconciler } from '../../services/stacks/stack-reconciler';
import { stackOperationLock } from '../../services/stacks/operation-lock';
import { StackUserEvent } from '../../services/stacks/stack-user-event';
import {
  emitStackStopStarted,
  emitStackStopCompleted,
  emitStackStopFailed,
} from '../../services/stacks/stack-socket-emitter';
import { ErrorCode, Permission } from '@mini-infra/types';
import { ConflictError } from '../../lib/errors';
import { assertStackFound } from '../../services/stacks/utils';

const logger = getLogger('stacks', 'stacks-stop-route');
const router = Router();

// POST /:stackId/stop — Stop the stack's containers but KEEP its definition +
// DB row. Status becomes `undeployed`, so the operator can Deploy/Apply again
// without re-instantiating (and Stateful services keep their volumes). This is
// the honest "Stop" — distinct from /destroy, which deletes the stack record.
router.post(
  '/:stackId/stop',
  requirePermission(Permission.StacksWrite),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const stack = assertStackFound(
      await prisma.stack.findUnique({ where: { id: stackId }, select: { id: true, name: true } }),
      stackId,
    );

    if (stackOperationLock.has(stackId)) {
      throw new ConflictError(
        ErrorCode.STACK_OPERATION_IN_PROGRESS,
        'An operation is already in progress for this stack',
        {
          resource: { type: 'stack', id: stackId },
          action: 'Wait for the in-flight operation to finish before retrying.',
        },
      );
    }
    stackOperationLock.tryAcquire(stackId);

    emitStackStopStarted(stackId, stack.name);
    res.json({ success: true, data: { started: true, stackId } });

    const triggeredBy = getUserId(req);
    void runStopInBackground(stackId, stack.name, triggeredBy);
  }),
);

async function runStopInBackground(
  stackId: string,
  stackName: string,
  triggeredBy: string | undefined,
): Promise<void> {
  const startTime = Date.now();
  const userEvent = new StackUserEvent(prisma);

  await userEvent.begin(
    {
      eventType: 'stack_stop',
      eventCategory: 'infrastructure',
      eventName: `Stop ${stackName}`,
      userId: triggeredBy,
      triggeredBy: triggeredBy ? 'manual' : 'api',
      resourceId: stackId,
      resourceType: 'stack',
      resourceName: stackName,
      status: 'running',
      progress: 0,
      description: `Stopping stack ${stackName} (containers stopped, definition kept)`,
    },
    'Failed to create user event for stack stop',
  );

  try {
    // stopStack only needs Docker + Prisma — it stops/removes the stack's
    // containers and flips status to `undeployed`. No resource reconciler
    // (Cloudflare/Azure/ACME) is required, so construct the lightweight
    // reconciler directly rather than through buildStackOperationServices.
    const dockerExecutor = new DockerExecutorService();
    await dockerExecutor.initialize();
    const reconciler = new StackReconciler(dockerExecutor, prisma);

    const result = await reconciler.stopStack(stackId, { triggeredBy });

    await userEvent.update({
      status: 'completed',
      progress: 100,
      resultSummary: `Stopped ${result.stoppedContainers} container(s); stack kept for redeploy`,
    });

    const payload = {
      success: result.success,
      stackId,
      stoppedContainers: result.stoppedContainers,
      duration: Date.now() - startTime,
    };
    logger.info(payload, 'Stack stopped (definition kept)');
    emitStackStopCompleted(payload);
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), stackId },
      'Background stack stop failed',
    );
    await userEvent.fail(error);
    emitStackStopFailed(stackId, error, startTime);
  } finally {
    stackOperationLock.release(stackId);
  }
}

export default router;
