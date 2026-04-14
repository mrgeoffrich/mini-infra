import { Router } from 'express';
import prisma from '../../lib/prisma';
import { appLogger } from '../../lib/logger-factory';
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

const logger = appLogger();
const router = Router();

// POST /:stackId/update — Pull latest images and redeploy changed containers
router.post(
  '/:stackId/update',
  requirePermission('stacks:write'),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);

    if (stackOperationLock.has(stackId)) {
      return res.status(409).json({
        success: false,
        message: 'Stack operation already in progress',
      });
    }

    const stack = await prisma.stack.findUnique({
      where: { id: stackId },
      select: { id: true, name: true, status: true },
    });
    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }
    if (stack.status !== 'synced' && stack.status !== 'drifted') {
      return res.status(400).json({
        success: false,
        message: `Stack must be deployed to update (current status: ${stack.status})`,
      });
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
      logger.error(
        { error: error instanceof Error ? error.message : String(error), stackId },
        'Background stack update failed',
      );
      await userEvent.fail(error);
      emitStackApplyFailed(stackId, error);
    }
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), stackId },
      'Stack update setup failed',
    );
    await userEvent.fail(error);
    emitStackApplyFailed(stackId, error);
  } finally {
    stackOperationLock.release(stackId);
  }
}

export default router;
