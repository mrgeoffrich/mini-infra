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
  removeStackInfraResources,
  removeStackManagedNetworks,
} from '../../services/stacks/stack-destroy-helpers';
import { revokeStackNatsSigningKeys } from '../../services/stacks/stack-nats-revocation';
import { JobPoolCronRegistry } from '../../services/stacks/job-pool-cron-registry';
import { JobPoolNatsRegistry } from '../../services/stacks/job-pool-nats-registry';
import type { StackNetwork, StackVolume } from '@mini-infra/types';
import { EgressPolicyLifecycleService } from '../../services/egress/egress-policy-lifecycle';
import { ErrorCode, Permission } from '@mini-infra/types';
import { ConflictError } from '../../lib/errors';
import { getStackProjectName } from '../../services/stacks/template-engine';
import { synthesiseDefaultNetworkIfNeeded, assertStackFound } from '../../services/stacks/utils';

const logger = getLogger("stacks", "stacks-destroy-route");
const router = Router();
const egressPolicyLifecycle = new EgressPolicyLifecycleService(prisma);

// POST /:stackId/destroy — Destroy stack: remove containers, networks, volumes, DB record
router.post(
  '/:stackId/destroy',
  requirePermission(Permission.StacksWrite),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const stack = assertStackFound(
      await prisma.stack.findUnique({ where: { id: stackId } }),
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
    // Single source of truth for the project-name prefix (fixes a prior bug
    // where this route derived it inline without the `mini-infra-` prefix
    // for host-scoped stacks, so destroy's network lookup silently missed
    // every network a host-scoped stack owned).
    const projectName = getStackProjectName(fullStack);
    const declaredNetworks = (fullStack.networks as unknown as StackNetwork[]) ?? [];
    // Include the synthesised `default` network so multi-service stacks that
    // never declared `networks[]` don't leak `${projectName}_default`.
    const networks = synthesiseDefaultNetworkIfNeeded(declaredNetworks, fullStack.services, logger);
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
      stackId,
      projectName,
      networks,
      volumes,
    );

    // Step 6: Archive egress policy before deleting the stack row so we can
    // record userId on the archived record while the stack is still resolvable.
    await egressPolicyLifecycle.archiveForStack(stackId, triggeredBy ?? null);

    // Step 6.5: Phase 4 — revoke any scoped NATS signing keys this stack owns.
    // The cascade-delete in Step 7 would drop the rows, but the running NATS
    // server would keep trusting the public keys until next restart. This
    // helper deletes the rows up front, re-issues + propagates the parent
    // account JWTs, recycles the NATS container if propagation failed, and
    // wipes seeds from Vault KV. Best-effort throughout — errors don't
    // block destroy because the stack record is going away regardless.
    await revokeStackNatsSigningKeys(prisma, stackId, logger);

    // Step 6.6 (Phase 3 of job-pool-service-type): tear down any JobPool
    // triggers this stack owned before its rows are cascade-deleted. The
    // registries reconcile against `StackService` rows, so after the
    // cascade they'd just be orphan node-cron handles / NATS subscriptions
    // until next refresh. removeStack() is idempotent.
    try {
      JobPoolCronRegistry.getInstance()?.removeStack(stackId);
      JobPoolNatsRegistry.getInstance()?.removeStack(stackId);
    } catch (err) {
      logger.warn(
        { stackId, err: err instanceof Error ? err.message : String(err) },
        'JobPool trigger registry teardown failed during destroy (non-fatal)',
      );
    }

    // Step 6.7: explicitly delete this stack's InfraResource rows (fixes L4 —
    // `stackId` is `onDelete: SetNull`, so without this the row would survive
    // the stack delete below with a dangling null FK forever).
    await removeStackInfraResources(stackId);

    // Step 6.8: explicitly delete this stack's ManagedNetwork/NetworkMembership
    // rows (fixes a PR #479 review HIGH — `ManagedNetwork.name` is globally
    // unique with no id component, so an orphaned row left behind here would
    // get silently reused by a later stack recreated under the same
    // env+name). Must run before the stack (and its services) are deleted
    // below — see `removeStackManagedNetworks`'s doc comment.
    await removeStackManagedNetworks(stackId);

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
