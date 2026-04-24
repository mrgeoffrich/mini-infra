import type { PrismaClient } from "../../generated/prisma/client";
import type {
  ServiceAction,
  StackDefinition,
  StackDnsRecord,
  StackParameterDefinition,
  StackParameterValue,
  StackPlan,
  StackTlsCertificate,
  StackTunnelIngress,
} from '@mini-infra/types';
import type { DockerExecutorService } from '../docker-executor';
import { computeDefinitionHash } from './definition-hash';
import { getLogger } from '../../lib/logger-factory';
import { buildStackTemplateContext, buildContainerMap, mergeParameterValues, toServiceDefinition, resolveServiceConfigs } from './utils';
import { generateDiffs, buildReason } from './stack-diff-generator';
import { detectConflicts } from './stack-conflict-detector';
import type { StackResourceReconciler } from './stack-resource-reconciler';

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

    const { resolvedDefinitions, serviceHashes } = resolveServiceConfigs(stack.services, templateContext);

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

      // Pool services are templates for on-demand instances; they never run
      // their own container at apply time. Always emit a no-op for them.
      if (svc.serviceType === 'Pool') {
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

    const definedServiceNames = new Set(stack.services.map((s) => s.serviceName));
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
    const templateUpdateAvailable =
      stack.templateVersion != null &&
      templateRef.template?.currentVersion?.version != null &&
      templateRef.template.currentVersion.version > stack.templateVersion;

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

    const plan: StackPlan = {
      stackId,
      stackName: stack.name,
      stackVersion: stack.version,
      planTime: new Date().toISOString(),
      actions,
      resourceActions,
      hasChanges: actions.some((a) => a.action !== 'no-op') || resourceActions.some((a) => a.action !== 'no-op'),
      templateUpdateAvailable,
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
