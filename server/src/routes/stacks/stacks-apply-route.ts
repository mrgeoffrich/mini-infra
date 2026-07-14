import { Router } from 'express';
import prisma from '../../lib/prisma';
import { getLogger } from '../../lib/logger-factory';
import { asyncHandler } from '../../lib/async-handler';
import { getUserId } from '../../lib/get-user-id';
import { requirePermission } from '../../middleware/auth';
import { restoreHAProxyRuntimeState } from '../../services/haproxy/haproxy-post-apply';
import { MonitoringService } from '../../services/monitoring';
import { applyStackSchema } from '../../services/stacks/schemas';
import { buildStackOperationServices } from '../../services/stacks/stack-operation-context';
import { stackOperationLock } from '../../services/stacks/operation-lock';
import { StackUserEvent } from '../../services/stacks/stack-user-event';
import { findEmptyStackParameters } from '../../services/stacks/parameter-validation';
import { evaluatePrerequisites } from '../../services/stacks/template-prerequisites';
import { runStackVaultApplyPhase } from '../../services/stacks/stack-vault-apply-orchestrator';
import { runStackNatsApplyPhase } from '../../services/stacks/stack-nats-apply-orchestrator';
import { applyJobPoolStreamsForStack } from '../../services/stacks/job-pool-stream-reconciler';
import { JobPoolCronRegistry } from '../../services/stacks/job-pool-cron-registry';
import { JobPoolNatsRegistry } from '../../services/stacks/job-pool-nats-registry';
import { dryRunJobPoolCredentials } from '../../services/stacks/job-pool-credential-dry-run';
import { materialiseTriggersForStack } from '../../services/backup/backup-job-pool-materialiser';
import { EgressPolicyLifecycleService } from '../../services/egress/egress-policy-lifecycle';
import { pruneOrphanedInputValues as doPruneOrphanedInputValues } from '../../services/stacks/orphan-input-pruner';
import { markStackErrored } from '../../services/stacks/stack-deployment-logger';
import {
  emitStackApplyStarted,
  emitStackApplyServiceResult,
  emitStackApplyCompleted,
  emitStackApplyFailed,
  emitStackAddonProvisioned,
  emitStackAddonFailed,
} from '../../services/stacks/stack-socket-emitter';
import { TailscaleService } from '../../services/tailscale/tailscale-service';
import type { ExpansionProgress } from '../../services/stack-addons';
import {
  formatPlanStep,
  formatServiceStep,
  formatResourceGroupStep,
} from '../../services/stacks/stack-event-log-formatter';
import type {
  ResourceResult,
  ResourceType,
  ServiceApplyResult,
} from '@mini-infra/types';
import { ErrorCode, Permission } from '@mini-infra/types';
import { ConflictError, ValidationError } from '../../lib/errors';
import { assertStackFound } from '../../services/stacks/utils';

const logger = getLogger("stacks", "stacks-apply-route");
const router = Router();

// GET /:stackId/prerequisites — Precheck cross-stack prereqs for a stack.
// Same shape as the body of the 409 PREREQUISITES_NOT_MET response on
// POST /:stackId/apply, so the frontend can use one rendering path.
router.get(
  '/:stackId/prerequisites',
  requirePermission(Permission.StacksRead),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    assertStackFound(
      await prisma.stack.findUnique({ where: { id: stackId }, select: { id: true } }),
      stackId,
    );
    try {
      const result = await evaluatePrerequisites(prisma, stackId);
      return res.json({ success: true, ...result });
    } catch (err) {
      return res.status(422).json({
        success: false,
        message: err instanceof Error ? err.message : 'Prerequisite evaluation failed',
        code: 'PREREQUISITES_INVALID',
      });
    }
  }),
);

// POST /:stackId/apply — Apply changes (fire-and-forget with Socket.IO progress)
router.post(
  '/:stackId/apply',
  requirePermission(Permission.StacksWrite),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const parsed = applyStackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        issues: parsed.error.issues,
      });
    }

    if (stackOperationLock.has(stackId)) {
      throw new ConflictError(ErrorCode.STACK_OPERATION_IN_PROGRESS, 'Stack apply already in progress', {
        resource: { type: 'stack', id: stackId },
        action: 'Wait for the in-flight operation to finish before retrying.',
      });
    }

    const stack = assertStackFound(
      await prisma.stack.findUnique({
        where: { id: stackId },
        select: { parameters: true, parameterValues: true },
      }),
      stackId,
    );

    const emptyParams = findEmptyStackParameters(stack.parameters, stack.parameterValues);
    if (emptyParams.length > 0) {
      throw new ValidationError(
        ErrorCode.STACK_PARAMETERS_NOT_CONFIGURED,
        'Stack has parameters that are not configured',
        {
          resource: { type: 'stack', id: stackId },
          action: 'Configure the missing parameters before applying.',
          details: { parameters: emptyParams.map((p) => ({ name: p.name, description: p.description })) },
        },
      );
    }

    // Cross-stack prerequisites gate (Phase 1 of split-vault-nats). Runs
    // after permission + parameter checks (those have nothing to do with
    // prereqs) and before any apply-side state mutations — a failed
    // precheck must NOT create a UserEvent or acquire the operation lock.
    let prereqs;
    try {
      prereqs = await evaluatePrerequisites(prisma, stackId);
    } catch (err) {
      // Authoring errors (e.g. same-environment requirement on a
      // host-scoped stack) surface here. 422 keeps it distinct from
      // both 400 (bad client input) and 409 (state conflict) — kept as a
      // locally-built response since the 4xx taxonomy has no 422 member.
      logger.warn(
        { stackId, error: err instanceof Error ? err.message : String(err) },
        'Prerequisite evaluation threw — refusing to apply',
      );
      return res.status(422).json({
        success: false,
        message: err instanceof Error ? err.message : 'Prerequisite evaluation failed',
        code: 'PREREQUISITES_INVALID',
      });
    }
    if (!prereqs.ok) {
      throw new ConflictError(
        ErrorCode.STACK_PREREQUISITES_NOT_MET,
        'One or more cross-stack prerequisites are not met',
        {
          resource: { type: 'stack', id: stackId },
          action: 'Resolve the listed prerequisites before applying.',
          details: { failures: prereqs.failures },
        },
      );
    }

    stackOperationLock.tryAcquire(stackId);

    const triggeredBy = getUserId(req);
    const isForcePull = !!parsed.data.forcePull;

    res.json({ success: true, data: { started: true, stackId } });

    // Background: plan + apply with Socket.IO progress + audit log
    void runApplyInBackground({
      stackId,
      triggeredBy,
      isForcePull,
      applyArgs: parsed.data,
    });
  }),
);

interface RunApplyArgs {
  stackId: string;
  triggeredBy: string | undefined;
  isForcePull: boolean;
  applyArgs: ReturnType<typeof applyStackSchema.parse>;
}

/**
 * Kick off a background apply for the given stack, identical to the surface
 * the `POST /:stackId/apply` route uses. Exported so other routes can trigger
 * an apply as a side effect of a state-changing operation (e.g. the
 * `git-deploy-key` DELETE handler triggers a re-apply so the env var
 * disappears from the running container without an operator round-trip —
 * review #5).
 *
 * Caller responsibilities:
 *   - The stack MUST exist and have no in-progress apply (use
 *     `stackOperationLock.has(stackId)` to gate); this function does not
 *     pre-check those.
 *   - Failures are surfaced via `emitStackApplyFailed` / the user-event log,
 *     not returned to the caller. The promise resolves once the background
 *     work is scheduled.
 *
 * The implementation lives at the apply route to keep the apply pipeline
 * (Vault phase, NATS phase, egress reconciliation, reconciler.apply) in a
 * single place; exporting the entry point keeps the side-effect callers
 * decoupled from those internals.
 */
export async function runApplyInBackground(args: RunApplyArgs): Promise<void> {
  const { stackId, triggeredBy, isForcePull, applyArgs } = args;
  const userEvent = new StackUserEvent(prisma);

  try {
    const { reconciler } = await buildStackOperationServices();

    const plan = await reconciler.plan(stackId);
    const activeActions = plan.actions.filter((a) => a.action !== 'no-op');

    let plannedActions = activeActions;
    if (applyArgs.serviceNames && applyArgs.serviceNames.length > 0) {
      const filterSet = new Set(applyArgs.serviceNames);
      plannedActions = activeActions.filter((a) => filterSet.has(a.serviceName));
    }

    const startedActions: Array<{ serviceName: string; action: string }> =
      isForcePull && plannedActions.length === 0
        ? plan.actions.map((a) => ({ serviceName: a.serviceName, action: 'pull' }))
        : plannedActions.map((a) => ({ serviceName: a.serviceName, action: a.action }));

    const activeResourceActions = (plan.resourceActions ?? [])
      .filter((ra) => ra.action !== 'no-op')
      .map((ra) => ({
        serviceName: `${ra.resourceType}:${ra.resourceName}`,
        action: ra.action,
      }));
    const allStartedActions = [...startedActions, ...activeResourceActions];

    emitStackApplyStarted({
      stackId,
      stackName: plan.stackName,
      totalActions: allStartedActions.length,
      actions: allStartedActions,
      forcePull: isForcePull,
    });

    await userEvent.begin(
      {
        eventType: 'stack_deploy',
        eventCategory: 'infrastructure',
        eventName: `Deploy ${plan.stackName} v${plan.stackVersion}`,
        userId: triggeredBy,
        triggeredBy: triggeredBy ? 'manual' : 'api',
        resourceId: stackId,
        resourceType: 'stack',
        resourceName: plan.stackName,
        status: 'running',
        progress: 0,
        description: `Deploying stack ${plan.stackName}`,
        metadata: {
          stackName: plan.stackName,
          version: plan.stackVersion,
          serviceActions: startedActions,
          forcePull: isForcePull,
        },
      },
      'Failed to create user event for stack apply',
    );

    const resourceTypes: ResourceType[] = ['tls', 'dns', 'tunnel'];
    const resourceGroupCount = resourceTypes.filter((rt) =>
      plan.resourceActions?.some((ra) => ra.resourceType === rt && ra.action !== 'no-op'),
    ).length;
    const totalSteps = 1 + startedActions.length + resourceGroupCount;
    let currentStep = 1;

    const actionCounts = {
      creates: startedActions.filter((a) => a.action === 'create').length,
      recreates: startedActions.filter((a) => a.action === 'recreate').length,
      removes: startedActions.filter((a) => a.action === 'remove').length,
      updates: startedActions.filter((a) => a.action === 'update' || a.action === 'pull').length,
    };
    await userEvent.appendLogs(formatPlanStep(currentStep, totalSteps, actionCounts));
    await userEvent.updateProgress(Math.round((currentStep / totalSteps) * 100));

    let emittedStepCount = 0;
    const totalEmitActions = allStartedActions.length;

    try {
      // Pre-service Vault reconciliation phase — short-circuits when the
      // template has no vault section. Throws if Vault is required but not
      // ready, or if the reconciler returns an error result.
      const vaultPhase = await runStackVaultApplyPhase(prisma, stackId, {
        triggeredBy,
        requireVaultReady: true,
      });
      if (vaultPhase.status === 'error') {
        throw new Error(vaultPhase.error ?? 'Vault reconciliation phase failed');
      }
      const natsPhase = await runStackNatsApplyPhase(prisma, stackId, {
        triggeredBy,
        requireNatsReady: true,
      });
      if (natsPhase.status === 'error') {
        throw new Error(natsPhase.error ?? 'NATS reconciliation phase failed');
      }
      // JobPool history streams (Phase 2 of job-pool-service-type): reconcile
      // one per-pool JetStream stream per JobPool service on the stack.
      // No-op when the stack has no JobPool services. Failures are logged
      // inside the reconciler — JobPool history streams are observability,
      // not correctness-critical, so a NATS-side blip can't fail the apply.
      try {
        await applyJobPoolStreamsForStack(prisma, stackId);
      } catch (err) {
        logger.warn(
          { stackId, err: err instanceof Error ? err.message : String(err) },
          'JobPool history-stream reconcile failed (continuing apply)',
        );
      }

      // JobPool credential dry-run (Phase 3 of job-pool-service-type): apply
      // fails fast if any JobPool service declares a `dynamicEnv` binding
      // that resolves to a missing Vault path / NATS credential. Without
      // this gate, a misconfigured pool silently apples — and only the
      // first triggered run discovers the problem.
      //
      // Throws on failure; the catch below converts that into the standard
      // apply-failure surface (userEvent.fail + apply-failed Socket.IO event).
      await dryRunJobPoolCredentials(prisma, stackId);

      // Re-promote `requiredEgress` declarations into template-source
      // EgressRules so addon-derived patterns (e.g. Tailscale's control-plane
      // hostnames from the synthetic sidecar) propagate to existing stacks
      // when the apply pipeline is the trigger — not just when the stack is
      // first created or PUT'd. Without this, a code-level change to which
      // hostnames an addon emits never updates the rules of stacks that
      // were instantiated before the change.
      //
      // Failures are logged inside `reconcileTemplateRules` and do not throw,
      // so an egress-side reconciliation issue can't block the stack apply.
      const egressLifecycle = new EgressPolicyLifecycleService(prisma);
      await egressLifecycle.reconcileTemplateRules(stackId, triggeredBy ?? null);

      // Service Addons render-pass plumbing — fan addon-provisioning
      // events out on the stacks channel (Phase 3) and hand the addon
      // framework a typed connected-services lookup so addons like
      // `tailscale-ssh` can mint authkeys without re-fetching credentials
      // here. Both fields tolerate absence — the framework no-ops the
      // progress callback and rejects any addon whose required service
      // is missing.
      const addonExpansion: {
        progress: ExpansionProgress;
        connectedServices: { tailscale: TailscaleService };
      } = {
        progress: {
          onProvisioned: (info) => {
            emitStackAddonProvisioned({ stackId, ...info });
          },
          onFailed: (info) => {
            emitStackAddonFailed({ stackId, ...info });
          },
        },
        connectedServices: {
          tailscale: new TailscaleService(prisma),
        },
      };

      const result = await reconciler.apply(stackId, {
        ...applyArgs,
        triggeredBy,
        plan,
        addonExpansion,
        onProgress: (progressResult) => {
          emittedStepCount++;
          emitStackApplyServiceResult(
            stackId,
            progressResult,
            emittedStepCount,
            totalEmitActions,
          );

          const isResource = 'resourceType' in progressResult;
          if (!isResource) {
            currentStep++;
            const serviceResult = progressResult as ServiceApplyResult;
            void userEvent.appendLogs(formatServiceStep(currentStep, totalSteps, serviceResult));
            void userEvent.updateProgress(Math.round((currentStep / totalSteps) * 100));
          }
        },
      });

      // Resource group logs from the final result
      if (result.resourceResults.length > 0) {
        const grouped = new Map<ResourceType, ResourceResult[]>();
        for (const rr of result.resourceResults) {
          const list = grouped.get(rr.resourceType) ?? [];
          list.push(rr);
          grouped.set(rr.resourceType, list);
        }
        for (const [rt, results] of grouped) {
          if (results.some((r) => r.action !== 'no-op')) {
            currentStep++;
            await userEvent.appendLogs(
              formatResourceGroupStep(
                currentStep,
                totalSteps,
                rt,
                results.filter((r) => r.action !== 'no-op'),
              ),
            );
          }
        }
      }

      const postApply = await maybeRestoreHAProxy(stackId, result.serviceResults);
      await maybeEnsureMonitoringNetwork(stackId, result.success);

      // Prune orphaned input values so keys removed from the template don't
      // accumulate silently across versions.
      if (result.success) {
        await doPruneOrphanedInputValues(prisma, stackId);
      }

      // JobPool trigger registries (Phase 3): reconcile declared cron +
      // nats-request triggers against live registrations. Only when the
      // apply itself succeeded — a partially-applied stack should not have
      // its triggers re-registered, because the underlying `StackService`
      // rows may no longer match the operator's intent. The next successful
      // apply re-establishes them. Registry failures are non-fatal: they
      // surface as a warning in the logs, not as an apply failure (the
      // services themselves are already up).
      if (result.success) {
        // Phase 4 (MINI-53): materialise pg-az-backup template triggers from
        // BackupConfiguration rows BEFORE the registry refresh below. The
        // materialiser is a no-op for non-pg-az-backup stacks. Catch and
        // continue — a materialisation failure means the cron triggers
        // won't reflect the latest BackupConfiguration set, but the apply
        // itself succeeded and the next mutation will reconcile.
        let materialisedCount = 0;
        try {
          const matResult = await materialiseTriggersForStack(prisma, stackId);
          materialisedCount = matResult.triggerCount;
        } catch (err) {
          logger.warn(
            { stackId, err: err instanceof Error ? err.message : String(err) },
            'pg-az-backup trigger materialisation failed (continuing apply)',
          );
        }
        // Re-run the JobPool history-stream reconciler after every
        // successful reconciler.apply — not just when the materialiser
        // ran. Three reasons:
        //
        // 1. User-authored JobPool templates write `jobPoolConfig`
        //    directly on the service row at apply time (via the
        //    file-loader / draft path). The first pass at line ~270 ran
        //    *before* `reconciler.apply` inserted those services, so
        //    no stream was created. Without this unconditional re-run,
        //    the registry refresh below would let triggers fire against
        //    a non-existent stream and the first run's `completed` /
        //    `failed` history event would be silently dropped by the
        //    JetStream publisher's `unchecked: true` swallow (MINI-50
        //    review finding M4).
        //
        // 2. The pg-az-backup materialiser also writes `jobPoolConfig`,
        //    so the previous `materialisedCount > 0` gate covered that
        //    case — but it left the user-authored case exposed.
        //
        // 3. The reconciler is idempotent; a redundant pass on a
        //    stack that has no JobPool services is a single
        //    `findMany({ where: { serviceType: 'JobPool' } })` + early
        //    return. Cheap.
        try {
          await applyJobPoolStreamsForStack(prisma, stackId);
        } catch (err) {
          logger.warn(
            { stackId, materialisedCount, err: err instanceof Error ? err.message : String(err) },
            'JobPool history-stream re-reconcile after reconciler.apply failed (continuing apply)',
          );
        }
        const cronRegistry = JobPoolCronRegistry.getInstance();
        if (cronRegistry) {
          try {
            await cronRegistry.refresh(stackId);
          } catch (err) {
            logger.warn(
              { stackId, err: err instanceof Error ? err.message : String(err) },
              'JobPool cron registry refresh failed (continuing apply)',
            );
          }
        }
        const natsRegistry = JobPoolNatsRegistry.getInstance();
        if (natsRegistry) {
          try {
            await natsRegistry.refresh(stackId);
          } catch (err) {
            logger.warn(
              { stackId, err: err instanceof Error ? err.message : String(err) },
              'JobPool NATS registry refresh failed (continuing apply)',
            );
          }
        }
      }

      await finalizeApplyEvent(userEvent, result);
      emitStackApplyCompleted({ ...result, postApply });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          error: message,
          stackId,
        },
        'Background stack apply failed',
      );
      // Persist a terminal `error` status + reason. Without this a stack that
      // was flipped to `pending` by a definition edit (PUT /:id or
      // PUT /services/:name) would stay `pending` forever on any pre-reconciler
      // failure (Vault / NATS / JobPool-dry-run), because the socket emit below
      // does no DB write and the reconciler's own status write is never reached.
      await markStackErrored(prisma, stackId, message, logger);
      await userEvent.fail(error);
      emitStackApplyFailed(stackId, error);
    }
  } catch (error) {
    // Failure during service init / plan (before reconciler.apply was called)
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      {
        error: message,
        stackId,
      },
      'Stack apply setup failed',
    );
    await markStackErrored(prisma, stackId, message, logger);
    await userEvent.fail(error);
    emitStackApplyFailed(stackId, error);
  } finally {
    stackOperationLock.release(stackId);
  }
}

async function maybeRestoreHAProxy(
  stackId: string,
  serviceResults: ServiceApplyResult[],
): Promise<{ success: boolean; errors?: string[] } | undefined> {
  const haproxyServiceApplied = serviceResults.some(
    (r) =>
      r.serviceName === 'haproxy' &&
      r.success &&
      (r.action === 'create' || r.action === 'recreate'),
  );
  if (!haproxyServiceApplied) return undefined;

  const stack = await prisma.stack.findUnique({
    where: { id: stackId },
    select: { name: true, environmentId: true },
  });
  if (stack?.name !== 'haproxy' || !stack.environmentId) return undefined;

  const postApplyResult = await restoreHAProxyRuntimeState(stack.environmentId, prisma);
  if (!postApplyResult.success) {
    logger.warn(
      { stackId, errors: postApplyResult.errors },
      'HAProxy post-apply restoration had errors',
    );
  }
  return { success: postApplyResult.success, errors: postApplyResult.errors };
}

export { pruneOrphanedInputValues } from '../../services/stacks/orphan-input-pruner';

async function maybeEnsureMonitoringNetwork(stackId: string, overallSuccess: boolean): Promise<void> {
  if (!overallSuccess) return;
  const stack = await prisma.stack.findUnique({
    where: { id: stackId },
    select: { name: true },
  });
  if (stack?.name !== 'monitoring') return;

  try {
    const monitoringService = new MonitoringService();
    await monitoringService.initialize();
    await monitoringService.ensureAppConnectedToMonitoringNetwork();
  } catch (err) {
    logger.warn({ error: err }, 'Failed to connect app to monitoring network after apply');
  }
}

async function finalizeApplyEvent(
  userEvent: StackUserEvent,
  result: {
    serviceResults: ServiceApplyResult[];
    resourceResults: ResourceResult[];
  },
): Promise<void> {
  const failedServices = result.serviceResults.filter((r) => !r.success);
  const failedResources = result.resourceResults.filter((r) => !r.success);
  const hasFailures = failedServices.length > 0 || failedResources.length > 0;

  await userEvent.update({
    status: hasFailures ? 'failed' : 'completed',
    progress: 100,
    resultSummary: hasFailures
      ? `${failedServices.length} service(s) and ${failedResources.length} resource(s) failed`
      : `${result.serviceResults.length} service(s) deployed successfully`,
    ...(hasFailures
      ? {
          errorMessage:
            failedServices.length > 0
              ? `Failed services: ${failedServices.map((s) => s.serviceName).join(', ')}`
              : `Failed resources: ${failedResources.map((r) => r.resourceName).join(', ')}`,
          errorDetails: { failedServices, failedResources },
        }
      : {}),
  });
}

export default router;
