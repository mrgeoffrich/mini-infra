import { Router } from 'express';
import prisma from '../../lib/prisma';
import { getLogger } from '../../lib/logger-factory';
import { asyncHandler } from '../../lib/async-handler';
import { getUserId } from '../../lib/get-user-id';
import { requirePermission } from '../../middleware/auth';
import { buildStackOperationServices } from '../../services/stacks/stack-operation-context';
import { stackOperationLock } from '../../services/stacks/operation-lock';
import { StackUserEvent } from '../../services/stacks/stack-user-event';
import {
  emitStackApplyStarted,
  emitStackApplyServiceResult,
  emitStackApplyCompleted,
  emitStackApplyFailed,
} from '../../services/stacks/stack-socket-emitter';
import {
  formatPlanStep,
  formatServiceStep,
} from '../../services/stacks/stack-event-log-formatter';
import { ErrorCode, Permission } from '@mini-infra/types';
import { ConflictError, ValidationError } from '../../lib/errors';
import { assertStackFound } from '../../services/stacks/utils';
import { markStackErrored } from '../../services/stacks/stack-deployment-logger';

const logger = getLogger("stacks", "stacks-update-route");
const router = Router();

// POST /:stackId/update — Pull latest images and redeploy changed containers
router.post(
  '/:stackId/update',
  requirePermission(Permission.StacksWrite),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);

    if (stackOperationLock.has(stackId)) {
      throw new ConflictError(ErrorCode.STACK_OPERATION_IN_PROGRESS, 'Stack operation already in progress', {
        resource: { type: 'stack', id: stackId },
        action: 'Wait for the in-flight operation to finish before retrying.',
      });
    }

    const stack = assertStackFound(
      await prisma.stack.findUnique({
        where: { id: stackId },
        select: { id: true, name: true, status: true },
      }),
      stackId,
    );
    if (stack.status !== 'synced' && stack.status !== 'drifted') {
      throw new ValidationError(
        ErrorCode.STACK_NOT_DEPLOYED,
        `Stack must be deployed to update (current status: ${stack.status})`,
        {
          resource: { type: 'stack', id: stackId, name: stack.name },
          action: 'Apply the stack first, then retry the update.',
        },
      );
    }

    stackOperationLock.tryAcquire(stackId);

    const triggeredBy = getUserId(req);
    res.json({ success: true, data: { started: true, stackId } });

    void runUpdateInBackground(stackId, triggeredBy);
  }),
);

async function runUpdateInBackground(
  stackId: string,
  triggeredBy: string | undefined,
): Promise<void> {
  const userEvent = new StackUserEvent(prisma);

  try {
    const { reconciler } = await buildStackOperationServices();
    const plan = await reconciler.plan(stackId);
    const startedActions = plan.actions.map((a) => ({
      serviceName: a.serviceName,
      action: 'update',
    }));

    emitStackApplyStarted({
      stackId,
      stackName: plan.stackName,
      totalActions: startedActions.length,
      actions: startedActions,
      forcePull: true,
    });

    await userEvent.begin(
      {
        eventType: 'stack_update',
        eventCategory: 'infrastructure',
        eventName: `Update ${plan.stackName}`,
        userId: triggeredBy,
        triggeredBy: triggeredBy ? 'manual' : 'api',
        resourceId: stackId,
        resourceType: 'stack',
        resourceName: plan.stackName,
        status: 'running',
        progress: 0,
        description: `Pulling latest images and updating stack ${plan.stackName}`,
        metadata: { stackName: plan.stackName, actions: startedActions },
      },
      'Failed to create user event for stack update',
    );

    const totalSteps = 1 + startedActions.length;
    let currentStep = 1;

    await userEvent.appendLogs(
      formatPlanStep(currentStep, totalSteps, {
        creates: 0,
        recreates: 0,
        removes: 0,
        updates: startedActions.length,
      }),
    );
    await userEvent.updateProgress(Math.round((currentStep / totalSteps) * 100));

    try {
      const result = await reconciler.update(stackId, {
        triggeredBy,
        forceRecreate: true,
        onProgress: (serviceResult, completedCount, totalActions) => {
          emitStackApplyServiceResult(stackId, serviceResult, completedCount, totalActions);
          currentStep++;
          void userEvent.appendLogs(formatServiceStep(currentStep, totalSteps, serviceResult));
          void userEvent.updateProgress(Math.round((currentStep / totalSteps) * 100));
        },
      });

      const failedServices = result.serviceResults.filter((r) => !r.success);
      const hasFailures = failedServices.length > 0;

      await userEvent.update({
        status: hasFailures ? 'failed' : 'completed',
        progress: 100,
        resultSummary: hasFailures
          ? `${failedServices.length} service(s) failed to update`
          : result.serviceResults.length === 0
            ? 'All images are up to date'
            : `${result.serviceResults.length} service(s) updated successfully`,
        ...(hasFailures
          ? {
              errorMessage: `Failed services: ${failedServices.map((s) => s.serviceName).join(', ')}`,
              errorDetails: { failedServices },
            }
          : {}),
      });

      emitStackApplyCompleted({ ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message, stackId }, 'Background stack update failed');
      await markStackErrored(prisma, stackId, message, logger);
      await userEvent.fail(error);
      emitStackApplyFailed(stackId, error);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message, stackId }, 'Stack update setup failed');
    await markStackErrored(prisma, stackId, message, logger);
    await userEvent.fail(error);
    emitStackApplyFailed(stackId, error);
  } finally {
    stackOperationLock.release(stackId);
  }
}

export default router;
