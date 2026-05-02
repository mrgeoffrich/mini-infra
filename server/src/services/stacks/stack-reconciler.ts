import type { Logger } from 'pino';
import { Prisma, PrismaClient } from "../../generated/prisma/client";
import {
  StackPlan,
  StackServiceDefinition,
  StackNetwork,
  StackParameterDefinition,
  StackParameterValue,
  StackVolume,
  StackResourceOutput,
  StackResourceInput,
  StackTlsCertificate,
  StackDnsRecord,
  StackTunnelIngress,
  ApplyOptions,
  ApplyResult,
  UpdateOptions,
  DestroyResult,
  ServiceApplyResult,
  ResourceResult,
} from '@mini-infra/types';
import { DockerExecutorService } from '../docker-executor';
import { StackContainerManager } from './stack-container-manager';
import { StackRoutingManager, type StackRoutingContext } from './stack-routing-manager';
import { StackResourceReconciler } from './stack-resource-reconciler';
import { getLogger } from '../../lib/logger-factory';
import { withOperation } from '../../lib/logging-context';
import {
  buildStackTemplateContext,
  buildContainerMap,
  mergeParameterValues,
  resolveServiceConfigs,
  synthesiseDefaultNetworkIfNeeded,
} from './utils';
import { runPostInstallActions } from './post-install-actions';
import { buildAppliedSnapshot } from './stack-applied-snapshot';
import { recordDeploymentFailure } from './stack-deployment-logger';
import { summariseServiceFailures } from './stack-failure-summary';
import { StackInfraResourceManager } from './stack-infra-resource-manager';
import { StackPlanComputer } from './stack-plan-computer';
import { StackServiceHandlers, type ServiceHandlerContext } from './stack-service-handlers';
import { VaultCredentialInjector } from '../vault/vault-credential-injector';
import { vaultServicesReady } from '../vault/vault-services';
import { NatsCredentialInjector } from '../nats/nats-credential-injector';
import { revokeStackNatsSigningKeys } from './stack-nats-revocation';
import { rotatePoolManagementTokens } from './pool-management-token';
import { resolveEffectiveVaultBinding } from './vault-binding-resolver';
import { EgressPolicyLifecycleService } from '../egress/egress-policy-lifecycle';

export class StackReconciler {
  private containerManager: StackContainerManager;
  private infraManager: StackInfraResourceManager;
  private planComputer: StackPlanComputer;
  private serviceHandlers: StackServiceHandlers;

  constructor(
    private dockerExecutor: DockerExecutorService,
    private prisma: PrismaClient,
    private routingManager?: StackRoutingManager,
    private resourceReconciler?: StackResourceReconciler
  ) {
    this.containerManager = new StackContainerManager(dockerExecutor, prisma);
    this.infraManager = new StackInfraResourceManager(dockerExecutor, prisma, this.containerManager);
    this.planComputer = new StackPlanComputer(prisma, dockerExecutor, resourceReconciler);
    this.serviceHandlers = new StackServiceHandlers(
      prisma, dockerExecutor, this.containerManager, this.infraManager, routingManager
    );
  }

  async plan(stackId: string): Promise<StackPlan> {
    return this.planComputer.compute(stackId);
  }

  async apply(stackId: string, options?: ApplyOptions): Promise<ApplyResult> {
    return withOperation(`stack-apply-${stackId}`, () =>
      this.applyInner(stackId, options),
    );
  }

  private async applyInner(stackId: string, options?: ApplyOptions): Promise<ApplyResult> {
    const startTime = Date.now();
    const log = getLogger("stacks", "stack-reconciler").child({ operation: 'stack-apply', stackId });

    // 1. Get plan (use pre-computed plan if provided)
    const plan = options?.plan ?? await this.plan(stackId);

    // 1b. Force-pull: pull all images and promote no-op services to recreate
    // if the pulled image digest differs from the running container's image.
    if (options?.forcePull) {
      await this.promoteStalePullActions(plan, stackId, log);
    }

    // 2. Filter actions if serviceNames provided
    let actions = plan.actions.filter((a) => a.action !== 'no-op');
    if (options?.serviceNames && options.serviceNames.length > 0) {
      const filterSet = new Set(options.serviceNames);
      actions = actions.filter((a) => filterSet.has(a.serviceName));
    }

    // 3. Dry run — return plan without executing
    if (options?.dryRun) {
      return {
        success: true,
        stackId,
        appliedVersion: plan.stackVersion,
        serviceResults: actions.map((a) => ({
          serviceName: a.serviceName,
          action: a.action,
          success: true,
          duration: 0,
        })),
        resourceResults: [],
        duration: Date.now() - startTime,
      };
    }

    // 4. Load stack for DB updates and service definitions
    const stack = await this.prisma.stack.findUniqueOrThrow({
      where: { id: stackId },
      include: {
        services: { orderBy: { order: 'asc' } },
        environment: true,
        template: { select: { name: true } },
      },
    });

    try {
      const projectName = stack.environment ? `${stack.environment.name}-${stack.name}` : `mini-infra-${stack.name}`;

      // Build template context with parameters and resolve service definitions
      const params = mergeParameterValues(
        (stack.parameters as unknown as StackParameterDefinition[]) ?? [],
        (stack.parameterValues as unknown as Record<string, StackParameterValue>) ?? {}
      );
      const templateContext = buildStackTemplateContext(stack, params);

      // Build maps for service definitions, hashes, and resolved configs
      const serviceMap = new Map(stack.services.map((s) => [s.serviceName, s]));
      const { resolvedConfigsMap, resolvedDefinitions, serviceHashes } = await resolveServiceConfigs(stack.services, templateContext);

      // 5a-i. Reconcile infra resource outputs (creates Docker networks + InfraResource records)
      const resourceOutputs = (stack.resourceOutputs as unknown as StackResourceOutput[]) ?? [];
      const resourceInputs = (stack.resourceInputs as unknown as StackResourceInput[]) ?? [];
      const outputNetworkMap = await this.infraManager.reconcileOutputs(stack, resourceOutputs, log);

      // 5a-ii. Resolve infra resource inputs from other stacks
      const inputNetworkMap = await this.infraManager.resolveInputs(stack.environmentId, resourceInputs, log);

      // 5a-iii. Merge output + input into a combined infra network map
      const infraNetworkMap = new Map([...outputNetworkMap, ...inputNetworkMap]);

      // 5b. Ensure stack-owned networks and volumes
      const declaredNetworks = (stack.networks as unknown as StackNetwork[]) ?? [];
      const networks = synthesiseDefaultNetworkIfNeeded(declaredNetworks, stack.services, log);
      const volumes = stack.volumes as unknown as StackVolume[];
      const stackLabels = { 'mini-infra.stack': stack.name, 'mini-infra.stack-id': stackId };

      for (const net of networks) {
        const netName = `${projectName}_${net.name}`;
        const exists = await this.dockerExecutor.networkExists(netName);
        if (!exists) {
          log.info({ network: netName }, 'Creating network');
          await this.dockerExecutor.createNetwork(netName, projectName, {
            driver: net.driver,
            labels: stackLabels,
          });
        }
      }

      for (const vol of volumes) {
        const volName = `${projectName}_${vol.name}`;
        const exists = await this.dockerExecutor.volumeExists(volName);
        if (!exists) {
          log.info({ volume: volName }, 'Creating volume');
          await this.dockerExecutor.createVolume(volName, projectName, { labels: stackLabels });
        }
      }

      // 5c. Reconcile stack-level resources (DNS → TLS → Tunnels)
      const allResourceResults: ResourceResult[] = [];
      if (this.resourceReconciler && plan.resourceActions.some((a) => a.action !== 'no-op')) {
        const definitions = {
          tlsCertificates: (stack.tlsCertificates as unknown as StackTlsCertificate[]) ?? [],
          dnsRecords: (stack.dnsRecords as unknown as StackDnsRecord[]) ?? [],
          tunnelIngress: (stack.tunnelIngress as unknown as StackTunnelIngress[]) ?? [],
        };

        const progressCallback = (result: ResourceResult) => {
          log.info({ stackId, result }, 'Resource reconciliation progress');
          if (result.action !== 'no-op' && options?.onProgress) {
            try {
              options.onProgress(result, 0, 0);
            } catch { /* never let callback errors break apply */ }
          }
        };

        // DNS first
        const dnsResults = await this.resourceReconciler.reconcileDns(
          plan.resourceActions, stackId, definitions.dnsRecords, progressCallback
        );
        allResourceResults.push(...dnsResults);
        if (dnsResults.some((r) => !r.success)) {
          const failed = dnsResults.find((r) => !r.success);
          throw new Error(`DNS reconciliation failed: ${failed?.error}`);
        }

        // TLS second
        const tlsResults = await this.resourceReconciler.reconcileTls(
          plan.resourceActions, stackId, definitions.tlsCertificates,
          options?.triggeredBy ?? 'system', progressCallback
        );
        allResourceResults.push(...tlsResults);
        if (tlsResults.some((r) => !r.success)) {
          const failed = tlsResults.find((r) => !r.success);
          throw new Error(`TLS reconciliation failed: ${failed?.error}`);
        }

        // Tunnel third
        const tunnelResults = await this.resourceReconciler.reconcileTunnel(
          plan.resourceActions, stackId, definitions.tunnelIngress, progressCallback
        );
        allResourceResults.push(...tunnelResults);
        if (tunnelResults.some((r) => !r.success)) {
          const failed = tunnelResults.find((r) => !r.success);
          throw new Error(`Tunnel reconciliation failed: ${failed?.error}`);
        }
      }

      // 6. Sort actions: creates first, then recreates, then removes
      const actionOrder: Record<string, number> = { create: 0, recreate: 1, remove: 2 };
      actions.sort((a, b) => {
        const orderDiff = (actionOrder[a.action] ?? 99) - (actionOrder[b.action] ?? 99);
        if (orderDiff !== 0) return orderDiff;
        // Within same action type, respect service order
        const svcA = serviceMap.get(a.serviceName);
        const svcB = serviceMap.get(b.serviceName);
        return (svcA?.order ?? 999) - (svcB?.order ?? 999);
      });

      // Resolve network names
      const networkNames = networks.map((n) => `${projectName}_${n.name}`);

      // 7. Execute actions
      const serviceResults: ServiceApplyResult[] = [];

      // Get current containers for recreate/remove operations. Exclude pool
      // instance containers — they share the stack-id label but aren't tied
      // to a declared service row.
      const docker = this.dockerExecutor.getDockerClient();
      const currentContainers = (await docker.listContainers({
        all: true,
        filters: { label: [`mini-infra.stack-id=${stackId}`] },
      })).filter((c) => c.Labels['mini-infra.pool-instance'] !== 'true');
      const containerByService = buildContainerMap(currentContainers);

      // 6.4. Mint fresh pool management tokens for every Pool service whose
      // `managedBy` caller is being (re)created in this apply. Tokens are
      // bound to the caller container's lifetime — no-op callers retain
      // their existing plaintext, so the stored hash must also stay put.
      const recreatedCallers = new Set(
        actions
          .filter((a) => a.action === 'create' || a.action === 'recreate')
          .map((a) => a.serviceName),
      );
      const poolTokens = await rotatePoolManagementTokens(
        this.prisma,
        stackId,
        recreatedCallers,
      );

      // 6.5. Resolve vault dynamic-env values for services that need them.
      // Skipped entirely when no binding is present. Runs after image pull is
      // conceptually complete (handled inside prepareServiceContainer) and
      // before any container is created, so wrapped secret_ids have the
      // tightest possible lifetime around container start.
      const activeServiceNames = new Set(actions.map((a) => a.serviceName));
      const { overrides: resolvedEnvOverrides, serviceBindingsToRecord: serviceBindingsToRecordApply } =
        await this.resolveVaultEnv(
          stack,
          stack.services,
          resolvedDefinitions,
          poolTokens,
          activeServiceNames,
          log,
        );

      for (const action of actions) {
        const actionStart = Date.now();
        const svc = serviceMap.get(action.serviceName);
        const serviceDef = resolvedDefinitions.get(action.serviceName) ?? null;
        const isStatelessWeb = svc?.serviceType === 'StatelessWeb';
        const isAdoptedWeb = svc?.serviceType === 'AdoptedWeb';

        if ((isStatelessWeb || isAdoptedWeb) && !this.routingManager) {
          throw new Error(`StackRoutingManager is required for ${svc?.serviceType} service "${action.serviceName}"`);
        }

        const handlerCtx: ServiceHandlerContext = {
          action, svc: svc!, serviceDef, projectName, stackId, stack,
          networkNames, serviceHashes, resolvedConfigsMap, containerByService,
          infraNetworkMap, resolvedEnvOverrides, actionStart, log,
        };

        try {
          const result = isAdoptedWeb
            ? await this.serviceHandlers.applyAdoptedWeb(handlerCtx)
            : isStatelessWeb
              ? await this.serviceHandlers.applyStatelessWeb(handlerCtx)
              : await this.serviceHandlers.applyStateful(handlerCtx);
          serviceResults.push(result);
        } catch (err: unknown) {
          log.error({ service: action.serviceName, error: (err instanceof Error ? err.message : String(err)) }, 'Action failed');
          serviceResults.push({
            serviceName: action.serviceName,
            action: action.action,
            success: false,
            duration: Date.now() - actionStart,
            error: (err instanceof Error ? err.message : String(err)),
          });
        }

        // Notify caller of per-service progress
        if (options?.onProgress) {
          try {
            options.onProgress(serviceResults[serviceResults.length - 1], serviceResults.length, actions.length);
          } catch { /* never let callback errors break apply */ }
        }
      }

      // 7b. Connect mini-infra container to resource output networks with joinSelf: true
      await this.infraManager.joinSelfToOutputNetworks(resourceOutputs, outputNetworkMap, log);

      // 7c. Run post-install actions declared by the template (failures are non-fatal)
      await runPostInstallActions(stack.template?.name, {
        stackId,
        stackName: stack.name,
        projectName,
        parameterValues: (stack.parameterValues as Record<string, string | number | boolean>) ?? {},
        serviceResults,
        triggeredBy: options?.triggeredBy,
        prisma: this.prisma,
      });

      // 8. Update stack in DB
      const allSucceeded = serviceResults.every((r) => r.success);
      const resultStatus = allSucceeded ? 'synced' : 'error';
      await this.prisma.stack.update({
        where: { id: stackId },
        data: {
          lastAppliedVersion: stack.version,
          lastAppliedAt: new Date(),
          lastAppliedSnapshot: buildAppliedSnapshot(stack),
          // Track the AppRole binding that was in effect on this apply so the
          // credential injector can detect binding changes on future re-applies.
          ...(allSucceeded
            ? { lastAppliedVaultAppRoleId: stack.vaultAppRoleId ?? null, lastFailureReason: null }
            // Surface the failure into Stack.lastFailureReason so operators
            // can diagnose at the API level without `docker ps` + `docker logs`.
            // Previously this only got set by the vault reconciler — service
            // apply failures (image pull, port conflict, crash on startup,
            // healthcheck timeout) silently left the field stale or null.
            : { lastFailureReason: summariseServiceFailures(serviceResults) }),
          status: resultStatus,
          removedAt: null,
        },
      });

      // 8b. Record per-service AppRole bindings that were just applied so
      // the next apply's stable-binding check can degrade gracefully when
      // Vault is briefly unreachable. Only services with their OWN binding
      // need this; services that fall back to the stack-level binding rely
      // on the Stack row's lastAppliedVaultAppRoleId above.
      if (allSucceeded && serviceBindingsToRecordApply.size > 0) {
        const successfulServiceNames = new Set(
          serviceResults.filter((r) => r.success).map((r) => r.serviceName),
        );
        await Promise.all(
          Array.from(serviceBindingsToRecordApply, ([serviceName, appRoleId]) => {
            if (!successfulServiceNames.has(serviceName)) return Promise.resolve();
            const svcRow = serviceMap.get(serviceName);
            if (!svcRow) return Promise.resolve();
            return this.prisma.stackService.update({
              where: { id: svcRow.id },
              data: { lastAppliedVaultAppRoleId: appRoleId },
            });
          }),
        );
      }

      // 9. Record deployment history
      await this.prisma.stackDeployment.create({
        data: {
          stackId,
          action: 'apply',
          success: allSucceeded,
          version: stack.version,
          status: resultStatus,
          duration: Date.now() - startTime,
          serviceResults: serviceResults as unknown as Prisma.InputJsonValue,
          resourceResults: allResourceResults as unknown as Prisma.InputJsonValue,
          triggeredBy: options?.triggeredBy ?? null,
        },
      });

      return {
        success: allSucceeded,
        stackId,
        appliedVersion: stack.version,
        serviceResults,
        resourceResults: allResourceResults,
        duration: Date.now() - startTime,
      };
    } catch (err: unknown) {
      const duration = Date.now() - startTime;
      log.error({ error: (err instanceof Error ? err.message : String(err)) }, 'Apply failed unexpectedly');
      await recordDeploymentFailure(this.prisma, stackId, 'apply', stack.version, duration, (err instanceof Error ? err.message : String(err)), options?.triggeredBy, log);
      throw err;
    }
  }

  async update(stackId: string, options?: UpdateOptions): Promise<ApplyResult> {
    return withOperation(`stack-update-${stackId}`, () =>
      this.updateInner(stackId, options),
    );
  }

  private async updateInner(stackId: string, options?: UpdateOptions): Promise<ApplyResult> {
    const startTime = Date.now();
    const log = getLogger("stacks", "stack-reconciler").child({ operation: 'stack-update', stackId });

    const plan = await this.plan(stackId);
    await this.promoteStalePullActions(plan, stackId, log);

    // Force-recreate: promote remaining no-op actions to recreate
    if (options?.forceRecreate) {
      for (const action of plan.actions) {
        if (action.action === 'no-op') {
          log.info({ service: action.serviceName }, 'Force-recreate: promoting no-op to recreate');
          action.action = 'recreate';
          action.reason = 'force recreate';
        }
      }
    }

    const actions = plan.actions.filter((a) => a.action !== 'no-op');

    if (actions.length === 0) {
      log.info('All images are up to date — nothing to update');
      await this.prisma.stackDeployment.create({
        data: {
          stackId,
          action: 'update',
          success: true,
          version: plan.stackVersion,
          status: 'synced',
          duration: Date.now() - startTime,
          serviceResults: [],
          triggeredBy: options?.triggeredBy ?? null,
        },
      });
      return {
        success: true,
        stackId,
        appliedVersion: plan.stackVersion,
        serviceResults: [],
        resourceResults: [],
        duration: Date.now() - startTime,
      };
    }

    const stack = await this.prisma.stack.findUniqueOrThrow({
      where: { id: stackId },
      include: { services: { orderBy: { order: 'asc' } }, environment: true },
    });

    try {
      const projectName = stack.environment ? `${stack.environment.name}-${stack.name}` : `mini-infra-${stack.name}`;
      const params = mergeParameterValues(
        (stack.parameters as unknown as StackParameterDefinition[]) ?? [],
        (stack.parameterValues as unknown as Record<string, StackParameterValue>) ?? {}
      );
      const templateContext = buildStackTemplateContext(stack, params);
      const serviceMap = new Map(stack.services.map((s) => [s.serviceName, s]));
      const { resolvedConfigsMap, resolvedDefinitions, serviceHashes } = await resolveServiceConfigs(stack.services, templateContext);

      // Reconcile infra resource outputs and inputs
      const resourceOutputs = (stack.resourceOutputs as unknown as StackResourceOutput[]) ?? [];
      const resourceInputs = (stack.resourceInputs as unknown as StackResourceInput[]) ?? [];
      const outputNetworkMap = await this.infraManager.reconcileOutputs(stack, resourceOutputs, log);
      const inputNetworkMap = await this.infraManager.resolveInputs(stack.environmentId, resourceInputs, log);
      const infraNetworkMap = new Map([...outputNetworkMap, ...inputNetworkMap]);

      const docker = this.dockerExecutor.getDockerClient();
      const containers = (await docker.listContainers({
        all: true,
        filters: { label: [`mini-infra.stack-id=${stackId}`] },
      })).filter((c) => c.Labels['mini-infra.pool-instance'] !== 'true');
      const containerByService = buildContainerMap(containers);

      const updateNetworks = synthesiseDefaultNetworkIfNeeded(
        (stack.networks as unknown as StackNetwork[]) ?? [],
        stack.services,
        log,
      );
      const networkNames = updateNetworks.map((n) => `${projectName}_${n.name}`);

      // Ensure stack-owned networks exist. Update is normally called after at
      // least one apply, so the original networks should already be present —
      // but a stack that flipped from 1 service to 2+ services since last
      // apply needs the synthesised default network to be created here.
      const updateStackLabels = { 'mini-infra.stack': stack.name, 'mini-infra.stack-id': stackId };
      for (const net of updateNetworks) {
        const netName = `${projectName}_${net.name}`;
        const exists = await this.dockerExecutor.networkExists(netName);
        if (!exists) {
          log.info({ network: netName }, 'Creating network');
          await this.dockerExecutor.createNetwork(netName, projectName, {
            driver: net.driver,
            labels: updateStackLabels,
          });
        }
      }

      const serviceResults: ServiceApplyResult[] = [];
      let completedCount = 0;

      // Mint fresh pool management tokens + resolve dynamic env (update flow).
      // Same lifecycle rule as apply: rotate only for callers whose container
      // is being replaced, so existing no-op callers keep a valid token.
      const recreatedCallers = new Set(
        actions
          .filter((a) => a.action === 'create' || a.action === 'recreate')
          .map((a) => a.serviceName),
      );
      const poolTokens = await rotatePoolManagementTokens(
        this.prisma,
        stackId,
        recreatedCallers,
      );
      const activeServiceNames = new Set(actions.map((a) => a.serviceName));
      const { overrides: resolvedEnvOverrides, serviceBindingsToRecord: serviceBindingsToRecordUpdate } =
        await this.resolveVaultEnv(
          stack,
          stack.services,
          resolvedDefinitions,
          poolTokens,
          activeServiceNames,
          log,
        );

      for (const action of actions) {
        const svc = serviceMap.get(action.serviceName);
        const serviceDef = resolvedDefinitions.get(action.serviceName) ?? null;
        const actionStart = Date.now();

        const handlerCtx: ServiceHandlerContext = {
          action, svc: svc!, serviceDef, projectName, stackId, stack,
          networkNames, serviceHashes, resolvedConfigsMap, containerByService,
          infraNetworkMap, resolvedEnvOverrides, actionStart, log,
        };

        let result: ServiceApplyResult;

        if (svc?.serviceType === 'AdoptedWeb' && serviceDef) {
          result = await this.serviceHandlers.applyAdoptedWeb(handlerCtx);
        } else if (svc?.serviceType === 'StatelessWeb' && serviceDef && action.action === 'recreate') {
          result = await this.serviceHandlers.updateStatelessWeb(handlerCtx);
        } else if (svc?.serviceType === 'StatelessWeb' && serviceDef) {
          result = await this.serviceHandlers.applyStatelessWeb(handlerCtx);
        } else {
          result = await this.serviceHandlers.applyStateful(handlerCtx);
        }

        result = { ...result, action: 'update' };
        serviceResults.push(result);
        completedCount++;
        options?.onProgress?.(result, completedCount, actions.length);
      }

      const allSucceeded = serviceResults.every((r) => r.success);
      const resultStatus = allSucceeded ? 'synced' : 'error';

      await this.prisma.stack.update({
        where: { id: stackId },
        data: {
          status: resultStatus,
          lastAppliedVersion: stack.version,
          lastAppliedAt: new Date(),
          lastAppliedSnapshot: buildAppliedSnapshot(stack),
          ...(allSucceeded
            ? { lastAppliedVaultAppRoleId: stack.vaultAppRoleId ?? null, lastFailureReason: null }
            // Same surfacing as in `apply` above — see that branch for context.
            : { lastFailureReason: summariseServiceFailures(serviceResults) }),
        },
      });

      if (allSucceeded && serviceBindingsToRecordUpdate.size > 0) {
        const successfulServiceNames = new Set(
          serviceResults.filter((r) => r.success).map((r) => r.serviceName),
        );
        await Promise.all(
          Array.from(serviceBindingsToRecordUpdate, ([serviceName, appRoleId]) => {
            if (!successfulServiceNames.has(serviceName)) return Promise.resolve();
            const svcRow = serviceMap.get(serviceName);
            if (!svcRow) return Promise.resolve();
            return this.prisma.stackService.update({
              where: { id: svcRow.id },
              data: { lastAppliedVaultAppRoleId: appRoleId },
            });
          }),
        );
      }

      await this.prisma.stackDeployment.create({
        data: {
          stackId,
          action: 'update',
          success: allSucceeded,
          version: stack.version,
          status: resultStatus,
          duration: Date.now() - startTime,
          serviceResults: serviceResults as unknown as Prisma.InputJsonValue,
          triggeredBy: options?.triggeredBy ?? null,
        },
      });

      return {
        success: allSucceeded,
        stackId,
        appliedVersion: stack.version,
        serviceResults,
        resourceResults: [],
        duration: Date.now() - startTime,
      };
    } catch (err: unknown) {
      const duration = Date.now() - startTime;
      log.error({ error: (err instanceof Error ? err.message : String(err)) }, 'Update failed unexpectedly');
      await recordDeploymentFailure(this.prisma, stackId, 'update', stack.version, duration, (err instanceof Error ? err.message : String(err)), options?.triggeredBy, log);
      throw err;
    }
  }

  /**
   * Resolve dynamic-env values (Vault + pool-management-token) for every
   * service that declares `dynamicEnv`. Returns per-service env overrides
   * plus a map of services whose per-service AppRole binding succeeded
   * (so the caller can record `service.lastAppliedVaultAppRoleId` for the
   * fail-closed stable-binding check on the next apply).
   *
   * Effective AppRole per service: `service.vaultAppRoleId ?? stack.vaultAppRoleId`.
   * Effective `prevBoundAppRoleId` follows the same fallback so the stable-
   * binding check compares like-for-like.
   *
   * Services with *only* pool-management-token entries are resolved even
   * when no AppRole binding is present. Throws on any per-service Vault
   * failure so apply aborts cleanly before touching containers.
   */
  private async resolveVaultEnv(
    stack: {
      id: string;
      vaultAppRoleId: string | null;
      vaultFailClosed: boolean;
      lastAppliedVaultAppRoleId: string | null;
    },
    services: Array<{
      serviceName: string;
      vaultAppRoleId: string | null;
      lastAppliedVaultAppRoleId: string | null;
      natsCredentialId?: string | null;
    }>,
    resolvedDefinitions: Map<string, StackServiceDefinition>,
    poolTokens: Record<string, string>,
    activeServiceNames: Set<string>,
    log: Logger,
  ): Promise<{
    overrides: Map<string, Record<string, string>>;
    /** serviceName → effective AppRoleId, populated only for services with their OWN binding. */
    serviceBindingsToRecord: Map<string, string>;
  }> {
    const overrides = new Map<string, Record<string, string>>();
    const serviceBindingsToRecord = new Map<string, string>();
    const serviceByName = new Map(services.map((s) => [s.serviceName, s]));
    const vaultReady = vaultServicesReady();
    const injector = vaultReady ? new VaultCredentialInjector(this.prisma) : null;
    const natsInjector = new NatsCredentialInjector(this.prisma);

    for (const [serviceName, serviceDef] of resolvedDefinitions.entries()) {
      if (!activeServiceNames.has(serviceName)) continue;
      // Pool services never get a container at apply time — skip resolution
      // entirely so we don't waste a Vault mint on something we won't use.
      if (serviceDef.serviceType === 'Pool') continue;
      const dynamicEnv = serviceDef.containerConfig?.dynamicEnv;
      if (!dynamicEnv) continue;

      const hasAppRoleEntries = Object.values(dynamicEnv).some(
        (src) => src.kind === 'vault-role-id' || src.kind === 'vault-wrapped-secret-id',
      );
      const hasVaultTouchEntries = Object.values(dynamicEnv).some(
        (src) => src.kind === 'vault-addr' || src.kind === 'vault-role-id' || src.kind === 'vault-wrapped-secret-id' || src.kind === 'vault-kv',
      );
      const hasNatsEntries = Object.values(dynamicEnv).some(
        (src) =>
          src.kind === 'nats-url' ||
          src.kind === 'nats-creds' ||
          src.kind === 'nats-signer-seed' ||
          src.kind === 'nats-account-public',
      );
      const hasPoolTokenEntries = Object.values(dynamicEnv).some(
        (src) => src.kind === 'pool-management-token',
      );

      const svcRow = serviceByName.get(serviceName) ?? {
        vaultAppRoleId: null,
        lastAppliedVaultAppRoleId: null,
        natsCredentialId: null,
      };
      const binding = resolveEffectiveVaultBinding(stack, svcRow);

      // Pool-token-only entries: resolve inline without invoking Vault. Used
      // when a stack has Pool services but no other Vault dependencies.
      if (!hasVaultTouchEntries && !hasNatsEntries && hasPoolTokenEntries) {
        const values: Record<string, string> = {};
        for (const [key, src] of Object.entries(dynamicEnv)) {
          if (src.kind === 'pool-management-token') {
            const token = poolTokens[src.poolService];
            if (token) values[key] = token;
          }
        }
        if (Object.keys(values).length > 0) overrides.set(serviceName, values);
        continue;
      }

      if (hasNatsEntries) {
        try {
          const values = await natsInjector.resolve(
            svcRow.natsCredentialId ?? null,
            serviceDef.containerConfig,
            { stackId: stack.id },
          );
          if (values) {
            const existing = overrides.get(serviceName) ?? {};
            overrides.set(serviceName, { ...existing, ...values });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ service: serviceName, err: msg }, 'NATS dynamic env resolution failed');
          throw new Error(`NATS credential injection failed for service "${serviceName}": ${msg}`, { cause: err });
        }
      }

      if (!hasVaultTouchEntries) {
        continue;
      }

      // Anything else (vault-addr / vault-role-id / vault-wrapped-secret-id /
      // vault-kv) goes through the injector. Vault must be ready; AppRole
      // entries additionally require a binding (the injector enforces this).
      if (!injector) continue;
      if (hasAppRoleEntries && !binding.appRoleId) {
        // Be loud rather than silent — the apply would otherwise leave the
        // service running without the env vars it asked for.
        throw new Error(
          `Service "${serviceName}" declares vault-role-id or vault-wrapped-secret-id but no AppRole is bound on the service or stack`,
        );
      }
      try {
        const res = await injector.resolve(
          {
            appRoleId: binding.appRoleId,
            failClosed: stack.vaultFailClosed,
            prevBoundAppRoleId: binding.prevBoundAppRoleId,
            poolTokens,
          },
          serviceDef.containerConfig,
        );
        if (res) {
          const existing = overrides.get(serviceName) ?? {};
          overrides.set(serviceName, { ...existing, ...res.values });
        }
        if (binding.recordPerService && binding.appRoleId) {
          serviceBindingsToRecord.set(serviceName, binding.appRoleId);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          { service: serviceName, err: msg },
          'Vault dynamic env resolution failed',
        );
        throw new Error(
          `Vault credential injection failed for service "${serviceName}": ${msg}`,
          { cause: err },
        );
      }
    }
    return { overrides, serviceBindingsToRecord };
  }

  /**
   * Pull all images for the stack's services and promote no-op actions to
   * 'recreate' when the freshly-pulled image ID differs from the running
   * container's image ID. Mutates `plan.actions` in place.
   */
  private async promoteStalePullActions(
    plan: StackPlan,
    stackId: string,
    log: Logger
  ): Promise<void> {
    const docker = this.dockerExecutor.getDockerClient();

    // Load stack + services so we can resolve template references on dockerImage
    // / dockerTag the same way the apply path does. Pulling against the raw
    // Prisma row would send `{{params.foo}}` to Docker as a literal string.
    const stack = await this.prisma.stack.findUniqueOrThrow({
      where: { id: stackId },
      include: { services: true, environment: true },
    });
    const params = mergeParameterValues(
      (stack.parameters as unknown as StackParameterDefinition[]) ?? [],
      (stack.parameterValues as unknown as Record<string, StackParameterValue>) ?? {}
    );
    const templateContext = buildStackTemplateContext(stack, params);
    const { resolvedDefinitions } = await resolveServiceConfigs(stack.services, templateContext);

    const serviceImageMap = new Map<string, string>();
    for (const [serviceName, def] of resolvedDefinitions.entries()) {
      serviceImageMap.set(serviceName, `${def.dockerImage}:${def.dockerTag}`);
    }

    // Pull all images (regardless of action — we always want latest)
    const pulledImageIds = new Map<string, string>();
    for (const svc of stack.services) {
      // Pool services don't run containers at apply time, so don't pull/compare.
      if (svc.serviceType === 'Pool') continue;
      const def = resolvedDefinitions.get(svc.serviceName);
      if (!def) continue;
      const imageRef = `${def.dockerImage}:${def.dockerTag}`;
      try {
        log.info({ service: svc.serviceName, image: imageRef }, 'Force-pulling image');
        await this.containerManager.pullImage(def.dockerImage, def.dockerTag);

        // Get the image ID of the freshly-pulled image
        const image = docker.getImage(imageRef);
        const inspectData = await image.inspect();
        pulledImageIds.set(svc.serviceName, inspectData.Id);
      } catch (err: unknown) {
        log.warn({ service: svc.serviceName, error: (err instanceof Error ? err.message : String(err)) }, 'Force-pull failed, skipping');
      }
    }

    // Get running containers to compare image IDs (skip pool instances).
    const containers = (await docker.listContainers({
      all: true,
      filters: { label: [`mini-infra.stack-id=${stackId}`] },
    })).filter((c) => c.Labels['mini-infra.pool-instance'] !== 'true');
    const containerByService = buildContainerMap(containers);

    // Promote no-op actions to recreate if the image digest changed
    for (const action of plan.actions) {
      if (action.action !== 'no-op') continue;

      const pulledId = pulledImageIds.get(action.serviceName);
      if (!pulledId) continue;

      const container = containerByService.get(action.serviceName);
      if (!container) continue;

      // container.ImageID is the full image digest of the image the container was created from
      if (container.ImageID !== pulledId) {
        log.info(
          {
            service: action.serviceName,
            oldImageId: container.ImageID?.substring(0, 24),
            newImageId: pulledId.substring(0, 24),
          },
          'Image updated — promoting to recreate'
        );
        action.action = 'recreate';
        action.reason = 'image updated (force pull)';
        action.currentImage = container.Image;
        action.desiredImage = serviceImageMap.get(action.serviceName);
        plan.hasChanges = true;
      }
    }
  }

  async stopStack(stackId: string, options?: { triggeredBy?: string }): Promise<{ success: boolean; stoppedContainers: number }> {
    return withOperation(`stack-stop-${stackId}`, () =>
      this.stopStackInner(stackId, options),
    );
  }

  private async stopStackInner(stackId: string, options?: { triggeredBy?: string }): Promise<{ success: boolean; stoppedContainers: number }> {
    const startTime = Date.now();
    const log = getLogger("stacks", "stack-reconciler").child({ operation: 'stack-stop', stackId });

    const docker = this.dockerExecutor.getDockerClient();
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`mini-infra.stack-id=${stackId}`] },
    });

    log.info({ containerCount: containers.length }, 'Stopping stack containers');

    let stopped = 0;
    // Stop in reverse order (highest order first = dependents before dependencies)
    const sorted = [...containers].sort((a, b) => {
      const orderA = parseInt(a.Labels['mini-infra.stack-version'] || '0');
      const orderB = parseInt(b.Labels['mini-infra.stack-version'] || '0');
      return orderB - orderA;
    });

    for (const containerInfo of sorted) {
      try {
        await this.containerManager.stopAndRemoveContainer(containerInfo.Id);
        stopped++;
      } catch (err: unknown) {
        log.warn({ containerId: containerInfo.Id, error: err }, 'Failed to stop container, continuing');
      }
    }

    // Transition any active pool instances for this stack to stopped. The
    // containers were already removed in the loop above (they carry the
    // stack-id label); the DB state must follow or it will be stale.
    await this.prisma.poolInstance.updateMany({
      where: { stackId, status: { in: ['starting', 'running', 'stopping'] } },
      data: { status: 'stopped', stoppedAt: new Date() },
    });

    // Update stack status to undeployed
    await this.prisma.stack.update({
      where: { id: stackId },
      data: { status: 'undeployed' },
    });

    // Record deployment history
    await this.prisma.stackDeployment.create({
      data: {
        stackId,
        action: 'stop',
        success: true,
        status: 'undeployed',
        duration: Date.now() - startTime,
        triggeredBy: options?.triggeredBy ?? null,
      },
    });

    log.info({ stopped }, 'Stack stopped');
    return { success: true, stoppedContainers: stopped };
  }

  /**
   * Destroy a stack: stop and remove all containers, networks, and volumes,
   * then delete the stack from the database.
   */
  async destroyStack(stackId: string, _options?: { triggeredBy?: string }): Promise<DestroyResult> {
    return withOperation(`stack-destroy-${stackId}`, () =>
      this.destroyStackInner(stackId, _options),
    );
  }

  private async destroyStackInner(stackId: string, _options?: { triggeredBy?: string }): Promise<DestroyResult> {
    const startTime = Date.now();
    const log = getLogger("stacks", "stack-reconciler").child({ operation: 'stack-destroy', stackId });

    const stack = await this.prisma.stack.findUniqueOrThrow({
      where: { id: stackId },
      include: { services: true, environment: true },
    });

    const projectName = stack.environment ? `${stack.environment.name}-${stack.name}` : `mini-infra-${stack.name}`;
    // Include any synthesised default network so destroy reaps it as well.
    const networks = synthesiseDefaultNetworkIfNeeded(
      (stack.networks as unknown as StackNetwork[]) ?? [],
      stack.services,
      log,
    );
    const volumes = (stack.volumes as unknown as StackVolume[]) ?? [];

    log.info({ stackName: stack.name, projectName }, 'Destroying stack');

    // 0. Destroy stack-level resources (TLS certificates, DNS records, tunnels)
    if (this.resourceReconciler) {
      try {
        await this.resourceReconciler.destroyAllResources(stackId);
      } catch (err: unknown) {
        log.warn({ error: (err instanceof Error ? err.message : String(err)) }, 'Resource destruction failed (non-fatal), continuing with container removal');
      }
    }

    // 0b. Clean up routing for AdoptedWeb services (container is NOT removed)
    const adoptedServices = stack.services.filter((s) => s.serviceType === 'AdoptedWeb');
    if (adoptedServices.length > 0 && this.routingManager && stack.environmentId) {
      for (const svc of adoptedServices) {
        const routing = svc.routing as unknown as StackServiceDefinition['routing'];
        const adopted = svc.adoptedContainer as unknown as StackServiceDefinition['adoptedContainer'];
        if (!routing || !adopted) continue;

        try {
          const haproxyCtx = await this.routingManager.getHAProxyContext(stack.environmentId);
          const haproxyClient = new (await import('../haproxy')).HAProxyDataPlaneClient();
          await haproxyClient.initialize(haproxyCtx.haproxyContainerId);

          const routingCtx: StackRoutingContext = {
            serviceName: svc.serviceName,
            containerId: '',
            containerName: adopted.containerName,
            routing,
            environmentId: stack.environmentId,
            stackId,
            stackName: stack.name,
          };

          // Drain and remove servers
          const backendName = `stk-${stack.name}-${svc.serviceName}`;
          const backendRecord = await this.prisma.hAProxyBackend.findFirst({
            where: { name: backendName, environmentId: stack.environmentId },
            include: { servers: true },
          });
          if (backendRecord) {
            for (const server of backendRecord.servers) {
              try {
                await this.routingManager.drainAndRemoveServer(backendName, server.name, haproxyClient);
              } catch { /* best effort */ }
            }
          }

          await this.routingManager.removeRoute(routingCtx, haproxyClient);
          log.info({ service: svc.serviceName }, 'Removed AdoptedWeb routing');
        } catch (err: unknown) {
          log.warn({ service: svc.serviceName, error: (err instanceof Error ? err.message : String(err)) }, 'Failed to remove AdoptedWeb routing');
        }
      }
    }

    // 1. Stop and remove all containers (AdoptedWeb containers are excluded — they don't have stack labels)
    const docker = this.dockerExecutor.getDockerClient();
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`mini-infra.stack-id=${stackId}`] },
    });

    let containersRemoved = 0;
    for (const containerInfo of containers) {
      try {
        await this.containerManager.stopAndRemoveContainer(containerInfo.Id);
        containersRemoved++;
      } catch (err: unknown) {
        log.warn({ containerId: containerInfo.Id, error: err }, 'Failed to remove container, continuing');
      }
    }

    // 2. Remove networks
    const networksRemoved: string[] = [];
    for (const net of networks) {
      const netName = `${projectName}_${net.name}`;
      try {
        if (await this.dockerExecutor.networkExists(netName)) {
          await this.dockerExecutor.removeNetwork(netName);
          networksRemoved.push(netName);
        }
      } catch (err: unknown) {
        log.warn({ network: netName, error: err }, 'Failed to remove network, continuing');
      }
    }

    // 3. Remove volumes
    const volumesRemoved: string[] = [];
    for (const vol of volumes) {
      const volName = `${projectName}_${vol.name}`;
      try {
        if (await this.dockerExecutor.volumeExists(volName)) {
          await this.dockerExecutor.removeVolume(volName);
          volumesRemoved.push(volName);
        }
      } catch (err: unknown) {
        log.warn({ volume: volName, error: err }, 'Failed to remove volume, continuing');
      }
    }

    // 4. Archive egress policy before deleting the stack row so we can record
    //    the reason while the stack is still resolvable.
    const egressPolicyLifecycle = new EgressPolicyLifecycleService(this.prisma);
    await egressPolicyLifecycle.archiveForStack(stackId, _options?.triggeredBy ?? null);

    // 4.5. Phase 4: revoke any scoped signing keys this stack owns before
    //      the cascade drops the rows. See `stack-nats-revocation.ts`.
    //      NOTE: this `destroyStack` method is currently dead code — the
    //      production destroy flow runs through `stacks-destroy-route.ts`
    //      which calls `revokeStackNatsSigningKeys` directly. The hook
    //      stays here for parity in case a future caller revives this
    //      path.
    await revokeStackNatsSigningKeys(this.prisma, stackId, log);

    // 5. Delete the stack record (cascades to deployments, services, resources)
    const duration = Date.now() - startTime;
    await this.prisma.stack.delete({
      where: { id: stackId },
    });

    log.info({ containersRemoved, networksRemoved, volumesRemoved, duration }, 'Stack destroyed');
    return {
      success: true,
      stackId,
      containersRemoved,
      networksRemoved,
      volumesRemoved,
      duration,
    };
  }

}

