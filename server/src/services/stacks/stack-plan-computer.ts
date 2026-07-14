import type { PrismaClient } from "../../generated/prisma/client";
import type {
  NetworkDriftItem,
  ServiceAction,
  StackDefinition,
  StackDnsRecord,
  StackParameterDefinition,
  StackParameterValue,
  StackPlan,
  StackTlsCertificate,
  StackTunnelIngress,
} from '@mini-infra/types';
import { computeTemplateVersionRelation } from '@mini-infra/types';
import type { DockerExecutorService } from '../docker-executor';
import { computeDefinitionHash } from './definition-hash';
import { getLogger } from '../../lib/logger-factory';
import { buildStackTemplateContext, buildContainerMap, mergeParameterValues, toServiceDefinition, resolveServiceConfigs } from './utils';
import { generateDiffs, buildReason } from './stack-diff-generator';
import { detectConflicts } from './stack-conflict-detector';
import type { StackResourceReconciler } from './stack-resource-reconciler';
import { createNetworkManager, reconcileStack } from '../networks';

/**
 * Computes the plan (diff) for a stack: compares desired state against
 * running containers and produces a set of create/recreate/remove/no-op actions.
 */
export class StackPlanComputer {
  constructor(
    private prisma: PrismaClient,
    private dockerExecutor: DockerExecutorService,
    private resourceReconciler?: StackResourceReconciler
  ) {}

  async compute(stackId: string): Promise<StackPlan> {
    const log = getLogger("stacks", "stack-plan-computer").child({ operation: 'stack-plan', stackId });

    const stack = await this.prisma.stack.findUniqueOrThrow({
      where: { id: stackId },
      include: {
        services: { orderBy: { order: 'asc' } },
        environment: true,
        template: { select: { currentVersion: { select: { version: true } } } },
      },
    });

    log.info({ stackName: stack.name, serviceCount: stack.services.length }, 'Computing plan');

    const currentResources = this.resourceReconciler
      ? await this.prisma.stackResource.findMany({ where: { stackId } })
      : [];

    const params = mergeParameterValues(
      (stack.parameters as unknown as StackParameterDefinition[]) ?? [],
      (stack.parameterValues as unknown as Record<string, StackParameterValue>) ?? {}
    );
    const templateContext = buildStackTemplateContext(stack, params);

    // Plan-time addon expansion runs in `dryRun` mode: synthetic sidecars
    // appear in the plan diff but no `provision()` side-effects fire. See
    // ExpansionContext.dryRun on the addon framework for the full contract.
    const { resolvedDefinitions, serviceHashes } = await resolveServiceConfigs(
      stack.services,
      templateContext,
      { dryRun: true },
    );

    const docker = this.dockerExecutor.getDockerClient();
    const rawContainers = await docker.listContainers({
      all: true,
      filters: { label: [`mini-infra.stack-id=${stackId}`] },
    });
    // Pool instance containers share the stack label but represent on-demand
    // instances, not declared services — exclude them from plan comparison.
    const containers = rawContainers.filter(
      (c) => c.Labels['mini-infra.pool-instance'] !== 'true',
    );

    const projectName = stack.environment ? `${stack.environment.name}-${stack.name}` : stack.name;
    const planWarnings = await detectConflicts(resolvedDefinitions, stackId, projectName, docker);

    const containerMap = buildContainerMap(containers);

    const actions: ServiceAction[] = [];
    const snapshot = stack.lastAppliedSnapshot as unknown as StackDefinition | null;

    for (const svc of stack.services) {
      const desiredHash = serviceHashes.get(svc.serviceName)!;

      // Pool and JobPool services are templates for on-demand / triggered
      // instances; they never run their own container at apply time. Always
      // emit a no-op for them — apply-time orchestration for both is a Phase-3
      // ahead concern (Pool: instance-ensure HTTP route, JobPool: trigger
      // registries).
      if (svc.serviceType === 'Pool' || svc.serviceType === 'JobPool') {
        actions.push({ serviceName: svc.serviceName, action: 'no-op' });
        continue;
      }

      if (svc.serviceType === 'AdoptedWeb') {
        const adopted = svc.adoptedContainer as unknown as { containerName: string; listeningPort: number } | null;
        if (!adopted) {
          planWarnings.push({
            type: 'adopted-container' as const,
            serviceName: svc.serviceName,
            containerName: 'unknown',
            issue: 'missing' as const,
            message: `AdoptedWeb service "${svc.serviceName}" has no adoptedContainer configuration`,
          });
          actions.push({ serviceName: svc.serviceName, action: 'no-op' });
          continue;
        }

        const adoptedContainers = await docker.listContainers({
          all: true,
          filters: { name: [adopted.containerName] },
        });
        const target = adoptedContainers.find((c) =>
          c.Names.some((n) => n.replace(/^\//, '') === adopted.containerName)
        );

        if (!target) {
          planWarnings.push({
            type: 'adopted-container' as const,
            serviceName: svc.serviceName,
            containerName: adopted.containerName,
            issue: 'missing' as const,
            message: `Adopted container "${adopted.containerName}" not found`,
          });
        } else if (target.State !== 'running') {
          planWarnings.push({
            type: 'adopted-container' as const,
            serviceName: svc.serviceName,
            containerName: adopted.containerName,
            issue: 'not-running' as const,
            message: `Adopted container "${adopted.containerName}" is ${target.State}`,
          });
        }

        const snapshotSvc = snapshot?.services?.find((s) => s.serviceName === svc.serviceName);
        if (!snapshotSvc) {
          actions.push({
            serviceName: svc.serviceName,
            action: 'create',
            reason: 'routing not configured',
            desiredImage: `adopted:${adopted.containerName}`,
          });
        } else {
          const snapshotHash = computeDefinitionHash(snapshotSvc);
          if (snapshotHash === desiredHash) {
            actions.push({ serviceName: svc.serviceName, action: 'no-op' });
          } else {
            const diffs = generateDiffs(svc.serviceName, snapshot, toServiceDefinition(svc));
            actions.push({
              serviceName: svc.serviceName,
              action: 'recreate',
              reason: 'routing configuration changed',
              diff: diffs.length > 0 ? diffs : undefined,
              desiredImage: `adopted:${adopted.containerName}`,
            });
          }
        }
        continue;
      }

      const container = containerMap.get(svc.serviceName);
      const desiredImage = `${svc.dockerImage}:${svc.dockerTag}`;

      if (!container) {
        actions.push({
          serviceName: svc.serviceName,
          action: 'create',
          reason: 'service not deployed',
          desiredImage,
        });
        continue;
      }

      const currentHash = container.Labels['mini-infra.definition-hash'];
      const currentImage = container.Image;
      const isRunning = container.State === 'running';

      if (!isRunning) {
        actions.push({
          serviceName: svc.serviceName,
          action: 'recreate',
          reason: 'container not running',
          currentImage,
          desiredImage,
        });
        continue;
      }

      if (currentHash === desiredHash) {
        actions.push({
          serviceName: svc.serviceName,
          action: 'no-op',
          currentImage,
          desiredImage,
        });
        continue;
      }

      const diffs = generateDiffs(svc.serviceName, snapshot, toServiceDefinition(svc));
      const reason = buildReason(currentImage, desiredImage, diffs);

      actions.push({
        serviceName: svc.serviceName,
        action: 'recreate',
        reason,
        diff: diffs.length > 0 ? diffs : undefined,
        currentImage,
        desiredImage,
      });
    }

    // Synthetic sidecars produced by the addon render pipeline live in
    // `resolvedDefinitions` but have no DB row in `stack.services` — the loop
    // above skipped them. Iterate the rendered map for any names not handled
    // yet and emit Stateful-shaped actions so the apply path actually creates
    // them. Synthetics are always Stateful per the addon framework contract.
    const authoredServiceNames = new Set(stack.services.map((s) => s.serviceName));
    for (const [serviceName, def] of resolvedDefinitions) {
      if (authoredServiceNames.has(serviceName)) continue;
      const desiredHash = serviceHashes.get(serviceName);
      if (!desiredHash) continue;
      const desiredImage = `${def.dockerImage}:${def.dockerTag}`;
      const container = containerMap.get(serviceName);

      if (!container) {
        actions.push({
          serviceName,
          action: 'create',
          reason: 'addon-derived sidecar not deployed',
          desiredImage,
        });
        continue;
      }

      const currentHash = container.Labels['mini-infra.definition-hash'];
      const currentImage = container.Image;

      if (container.State !== 'running') {
        actions.push({
          serviceName,
          action: 'recreate',
          reason: 'sidecar container not running',
          currentImage,
          desiredImage,
        });
        continue;
      }

      if (currentHash === desiredHash) {
        actions.push({
          serviceName,
          action: 'no-op',
          currentImage,
          desiredImage,
        });
        continue;
      }

      actions.push({
        serviceName,
        action: 'recreate',
        reason: 'addon configuration changed',
        currentImage,
        desiredImage,
      });
    }

    // Orphan-removal: any container labelled with this stack's id whose
    // service name no longer maps to either an authored service OR a
    // currently-rendered synthetic sidecar. The earlier behaviour omitted
    // synthetics from the defined set, so a correctly-applied sidecar was
    // flagged for removal on every subsequent plan.
    const definedServiceNames = new Set([
      ...authoredServiceNames,
      ...resolvedDefinitions.keys(),
    ]);
    for (const [serviceName, container] of containerMap) {
      if (!definedServiceNames.has(serviceName)) {
        actions.push({
          serviceName,
          action: 'remove',
          reason: 'service removed from definition',
          currentImage: container.Image,
        });
      }
    }

    const templateRef = stack as { template?: { currentVersion?: { version: number } | null } | null };
    const templateVersionRelation = computeTemplateVersionRelation(
      stack.templateVersion,
      templateRef.template?.currentVersion?.version,
    );
    const templateUpdateAvailable = templateVersionRelation === 'behind';

    const resourceActions = this.resourceReconciler
      ? this.resourceReconciler.planResources(
          {
            tlsCertificates: (stack.tlsCertificates as unknown as StackTlsCertificate[]) ?? [],
            dnsRecords: (stack.dnsRecords as unknown as StackDnsRecord[]) ?? [],
            tunnelIngress: (stack.tunnelIngress as unknown as StackTunnelIngress[]) ?? [],
          },
          currentResources
        )
      : [];

    if (this.resourceReconciler) {
      const serviceDefs = [...resolvedDefinitions.values()];
      const refWarnings = this.resourceReconciler.validateResourceReferences(
        serviceDefs,
        {
          tlsCertificates: (stack.tlsCertificates as unknown as StackTlsCertificate[]) ?? [],
          dnsRecords: (stack.dnsRecords as unknown as StackDnsRecord[]) ?? [],
          tunnelIngress: (stack.tunnelIngress as unknown as StackTunnelIngress[]) ?? [],
        },
      );
      planWarnings.push(...refWarnings);
    }

    // Network overhaul Phase 7 — network drift (missing networks, unattached
    // services, stale attachments, spec mismatches), computed against the
    // desired-state `ManagedNetwork`/`NetworkMembership` rows Phase 6 writes.
    // Report-only: `NetworkReconciler` never mutates Docker. Failures are
    // caught and logged rather than allowed to fail the whole plan — this is
    // net-new functionality layered onto an existing, load-bearing endpoint,
    // and a bug here must not regress container-level planning.
    let networkActions: NetworkDriftItem[] = [];
    try {
      const networkManager = createNetworkManager(this.dockerExecutor);
      const networkReport = await reconcileStack(stackId, {
        prisma: this.prisma,
        networkManager,
        dockerExecutor: this.dockerExecutor,
        log,
      });
      networkActions = networkReport.items;
    } catch (err) {
      log.warn(
        { stackId, error: err instanceof Error ? err.message : String(err) },
        'Network reconcile failed while computing plan — continuing with container/resource actions only',
      );
    }

    const plan: StackPlan = {
      stackId,
      stackName: stack.name,
      stackVersion: stack.version,
      planTime: new Date().toISOString(),
      actions,
      resourceActions,
      networkActions,
      hasChanges:
        actions.some((a) => a.action !== 'no-op') ||
        resourceActions.some((a) => a.action !== 'no-op') ||
        networkActions.length > 0,
      templateUpdateAvailable,
      templateVersionRelation,
      warnings: planWarnings.length > 0 ? planWarnings : undefined,
    };

    log.info(
      {
        hasChanges: plan.hasChanges,
        creates: actions.filter((a) => a.action === 'create').length,
        recreates: actions.filter((a) => a.action === 'recreate').length,
        removes: actions.filter((a) => a.action === 'remove').length,
        noOps: actions.filter((a) => a.action === 'no-op').length,
      },
      'Plan computed'
    );

    return plan;
  }
}
