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
import { runStackVaultReconciler } from '../../services/stacks/stack-vault-reconciler';
import { vaultServicesReady } from '../../services/vault/vault-services';
import { pruneOrphanedInputValues as doPruneOrphanedInputValues } from '../../services/stacks/orphan-input-pruner';
import type {
  TemplateInputDeclaration,
  TemplateVaultAppRole,
  TemplateVaultKv,
  TemplateVaultPolicy,
} from '@mini-infra/types';
import {
  emitStackApplyStarted,
  emitStackApplyServiceResult,
  emitStackApplyCompleted,
  emitStackApplyFailed,
} from '../../services/stacks/stack-socket-emitter';
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

const logger = getLogger("stacks", "stacks-apply-route");
const router = Router();

// POST /:stackId/apply — Apply changes (fire-and-forget with Socket.IO progress)
router.post(
  '/:stackId/apply',
  requirePermission('stacks:write'),
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
      return res.status(409).json({
        success: false,
        message: 'Stack apply already in progress',
      });
    }

    const stack = await prisma.stack.findUnique({
      where: { id: stackId },
      select: { parameters: true, parameterValues: true },
    });
    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    const emptyParams = findEmptyStackParameters(stack.parameters, stack.parameterValues);
    if (emptyParams.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Stack has parameters that are not configured',
        parameters: emptyParams.map((p) => ({ name: p.name, description: p.description })),
      });
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

async function runApplyInBackground(args: RunApplyArgs): Promise<void> {
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
      // Pre-service Vault reconciliation phase — only when the template version
      // declares a non-empty vault section and Vault services are ready.
      await runVaultPhaseIfNeeded(stackId, triggeredBy);

      const result = await reconciler.apply(stackId, {
        ...applyArgs,
        triggeredBy,
        plan,
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

      await finalizeApplyEvent(userEvent, result);
      emitStackApplyCompleted({ ...result, postApply });
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stackId,
        },
        'Background stack apply failed',
      );
      await userEvent.fail(error);
      emitStackApplyFailed(stackId, error);
    }
  } catch (error) {
    // Failure during service init / plan (before reconciler.apply was called)
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        stackId,
      },
      'Stack apply setup failed',
    );
    await userEvent.fail(error);
    emitStackApplyFailed(stackId, error);
  } finally {
    stackOperationLock.release(stackId);
  }
}

/**
 * Load the stack's current template version and run the Vault pre-service
 * reconciliation phase if the template has a non-empty vault section.
 *
 * After a successful vault phase, writes `StackService.vaultAppRoleId` for any
 * service whose template-declared `vaultAppRoleRef` resolves to a concrete
 * AppRole ID created by this apply. The snapshot write and service ID writes
 * are committed in a single transaction so a crash between them cannot leave
 * the snapshot recorded while services remain unbound.
 */
async function runVaultPhaseIfNeeded(
  stackId: string,
  triggeredBy: string | undefined,
): Promise<void> {
  const stack = await prisma.stack.findUnique({
    where: { id: stackId },
    select: {
      templateId: true,
      templateVersion: true,
      services: { select: { id: true, serviceName: true } },
    },
  });

  if (!stack?.templateId || stack.templateVersion == null) return;

  const templateVersion = await prisma.stackTemplateVersion.findFirst({
    where: {
      templateId: stack.templateId,
      version: stack.templateVersion,
    },
    select: {
      version: true,
      inputs: true,
      vaultPolicies: true,
      vaultAppRoles: true,
      vaultKv: true,
      services: { select: { serviceName: true, vaultAppRoleRef: true } },
    },
  });

  if (!templateVersion) return;

  const policies = (templateVersion.vaultPolicies as TemplateVaultPolicy[] | null) ?? [];
  const appRoles = (templateVersion.vaultAppRoles as TemplateVaultAppRole[] | null) ?? [];
  const kv = (templateVersion.vaultKv as TemplateVaultKv[] | null) ?? [];
  const inputs = (templateVersion.inputs as TemplateInputDeclaration[] | null) ?? [];

  const hasVault = policies.length > 0 || appRoles.length > 0 || kv.length > 0;
  if (!hasVault) return;

  if (!vaultServicesReady()) {
    throw new Error('Vault services are not initialised; cannot run vault reconciliation phase');
  }

  const vaultResult = await runStackVaultReconciler(prisma, stackId, {
    stackId,
    templateVersion: templateVersion.version,
    inputs,
    vault: { policies, appRoles, kv },
    userId: triggeredBy,
  });

  if (vaultResult.status === 'error') {
    throw new Error(vaultResult.error ?? 'Vault reconciliation phase failed');
  }

  // On noop the snapshot is already in the DB — nothing to write.
  if (vaultResult.status === 'noop' || !vaultResult.encryptedSnapshot) return;

  // Build a map from serviceName → vaultAppRoleRef using the template version's
  // service definitions. `StackService` rows do not carry vaultAppRoleRef (that
  // field lives only on StackTemplateServiceDefinition).
  const templateRefByServiceName = new Map<string, string>(
    templateVersion.services
      .filter((s) => s.vaultAppRoleRef != null)
      .map((s) => [s.serviceName, s.vaultAppRoleRef as string]),
  );

  // Pair each running StackService with the concrete AppRole ID resolved during
  // this apply, then commit both the snapshot update and all service ID writes
  // in a single transaction so a crash cannot leave them out of sync.
  const serviceUpdates = (stack.services ?? [])
    .map((svc) => {
      const ref = templateRefByServiceName.get(svc.serviceName);
      const concreteId = ref ? vaultResult.appliedAppRoleIdByName[ref] : undefined;
      return concreteId ? { id: svc.id, vaultAppRoleId: concreteId } : null;
    })
    .filter((u): u is { id: string; vaultAppRoleId: string } => u !== null);

  await prisma.$transaction([
    prisma.stack.update({
      where: { id: stackId },
      data: {
        lastAppliedVaultSnapshot: vaultResult.encryptedSnapshot,
        lastFailureReason: null,
      },
    }),
    ...serviceUpdates.map((u) =>
      prisma.stackService.update({
        where: { id: u.id },
        data: { vaultAppRoleId: u.vaultAppRoleId },
      }),
    ),
  ]);
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
