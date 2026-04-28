import { Router } from 'express';
import prisma from '../../lib/prisma';
import { getLogger } from '../../lib/logger-factory';
import { asyncHandler } from '../../lib/async-handler';
import { getUserId } from '../../lib/get-user-id';
import { requirePermission } from '../../middleware/auth';
import { EnvironmentValidationService } from '../../services/environment';
import { stackOperationLock } from '../../services/stacks/operation-lock';
import { StackUserEvent } from '../../services/stacks/stack-user-event';
import { createResourceReconciler } from '../../services/stacks/resource-reconciler-factory';
import {
  emitStackDestroyStarted,
  emitStackDestroyCompleted,
  emitStackDestroyFailed,
} from '../../services/stacks/stack-socket-emitter';
import {
  formatDestroyContainerStep,
  formatDestroyNetworkStep,
  formatDestroyResourceStep,
  formatDestroyVolumeStep,
} from '../../services/stacks/stack-event-log-formatter';
import {
  listStackContainers,
  removeAdoptedServiceRouting,
  removeStackContainers,
  removeStackNetworksAndVolumes,
} from '../../services/stacks/stack-destroy-helpers';
import type { StackNetwork, StackVolume } from '@mini-infra/types';
import { EgressPolicyLifecycleService } from '../../services/egress/egress-policy-lifecycle';

const logger = getLogger("stacks", "stacks-destroy-route");
const router = Router();
const egressPolicyLifecycle = new EgressPolicyLifecycleService(prisma);

// POST /:stackId/destroy — Destroy stack: remove containers, networks, volumes, DB record
router.post(
  '/:stackId/destroy',
  requirePermission('stacks:write'),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const stack = await prisma.stack.findUnique({ where: { id: stackId } });
    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    if (stackOperationLock.has(stackId)) {
      return res.status(409).json({
        success: false,
        message: 'An operation is already in progress for this stack',
      });
    }
    stackOperationLock.tryAcquire(stackId);

    emitStackDestroyStarted(stackId, stack.name);
    res.json({ success: true, data: { started: true, stackId } });

    const triggeredBy = getUserId(req);
    void runDestroyInBackground(stackId, stack.name, triggeredBy);
  }),
);

async function runDestroyInBackground(
  stackId: string,
  stackName: string,
  triggeredBy: string | undefined,
): Promise<void> {
  const startTime = Date.now();
  const userEvent = new StackUserEvent(prisma);

  await userEvent.begin(
    {
      eventType: 'stack_destroy',
      eventCategory: 'infrastructure',
      eventName: `Destroy ${stackName}`,
      userId: triggeredBy,
      triggeredBy: triggeredBy ? 'manual' : 'api',
      resourceId: stackId,
      resourceType: 'stack',
      resourceName: stackName,
      status: 'running',
      progress: 0,
      description: `Destroying stack ${stackName} and all its resources`,
    },
    'Failed to create user event for stack destroy',
  );

  try {
    const fullStack = await prisma.stack.findUniqueOrThrow({
      where: { id: stackId },
      include: { services: true, environment: true },
    });
    const projectName = fullStack.environment
      ? `${fullStack.environment.name}-${fullStack.name}`
      : fullStack.name;
    const networks = (fullStack.networks as unknown as StackNetwork[]) ?? [];
    const volumes = (fullStack.volumes as unknown as StackVolume[]) ?? [];

    // Step 1: Destroy stack-level resources (DNS, tunnels) before container removal
    try {
      const resourceReconciler = await createResourceReconciler();
      await resourceReconciler.destroyAllResources(stackId);
      logger.info({ stackId }, 'Stack resources destroyed');
    } catch (err) {
      logger.warn(
        {
          error: err instanceof Error ? err.message : String(err),
          stackId,
        },
        'Resource destruction failed (non-fatal), continuing with container removal',
      );
    }

    // Step 1b: Clean up routing for AdoptedWeb services
    await removeAdoptedServiceRouting(fullStack, stackId);

    // Step 2: HAProxy context from environment (optional)
    let haproxyContainerId = '';
    let haproxyNetworkName = '';
    const environmentId = fullStack.environmentId ?? '';
    const environmentName = fullStack.environment?.name ?? '';
    if (fullStack.environmentId) {
      try {
        const envValidation = new EnvironmentValidationService();
        const haproxyCtx = await envValidation.getHAProxyEnvironmentContext(
          fullStack.environmentId,
        );
        if (haproxyCtx) {
          haproxyContainerId = haproxyCtx.haproxyContainerId;
          haproxyNetworkName = haproxyCtx.haproxyNetworkName;
        }
      } catch {
        /* no HAProxy available — LB steps will fail non-fatally */
      }
    }

    // Step 3: Find stack containers by label
    const stackContainers = await listStackContainers(stackId);
    logger.info(
      { stackId, containerCount: stackContainers.length },
      'Found stack containers for removal',
    );

    // Step 4: Run removal state machine per non-adopted service
    const containersRemoved = await removeStackContainers(
      fullStack,
      stackContainers,
      {
        stackId,
        environmentId,
        environmentName,
        haproxyContainerId,
        haproxyNetworkName,
        triggeredBy,
        startTime,
      },
      userEvent,
    );

    // Step 5: Remove networks and volumes
    const { networksRemoved, volumesRemoved } = await removeStackNetworksAndVolumes(
      projectName,
      networks,
      volumes,
    );

    // Step 6: Archive egress policy before deleting the stack row so we can
    // record userId on the archived record while the stack is still resolvable.
    await egressPolicyLifecycle.archiveForStack(stackId, triggeredBy ?? null);

    // Step 7: Delete stack record (cascades to deployments, services, resources)
    const duration = Date.now() - startTime;
    await prisma.stack.delete({ where: { id: stackId } });

    // Write structured destroy logs
    const totalSteps = 4;
    const logs =
      formatDestroyResourceStep(1, totalSteps, true) +
      formatDestroyContainerStep(2, totalSteps, containersRemoved, containersRemoved) +
      formatDestroyNetworkStep(3, totalSteps, networksRemoved) +
      formatDestroyVolumeStep(4, totalSteps, volumesRemoved);
    await userEvent.appendLogs(logs);
    await userEvent.update({
      status: 'completed',
      progress: 100,
      resultSummary: `Stack destroyed: ${containersRemoved} containers, ${networksRemoved.length} networks, ${volumesRemoved.length} volumes removed`,
    });

    const result = {
      success: true,
      stackId,
      containersRemoved,
      networksRemoved,
      volumesRemoved,
      duration,
    };
    logger.info(result, 'Stack destroyed via removal state machine');
    emitStackDestroyCompleted(result);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        stackId,
      },
      'Background stack destroy failed',
    );
    await userEvent.fail(error);
    emitStackDestroyFailed(stackId, error, startTime);
  } finally {
    stackOperationLock.release(stackId);
  }
}

export default router;
