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
  ServiceApplyResult,
  ResourceResult,
} from '@mini-infra/types';
import { DockerExecutorService } from '../docker-executor';
import { InternalError } from '../../lib/errors';
import { StackContainerManager } from './stack-container-manager';
import { StackRoutingManager } from './stack-routing-manager';
import { StackResourceReconciler } from './stack-resource-reconciler';
import { getStackProjectName } from './template-engine';
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
import { emitStackStatusChanged } from './stack-socket-emitter';
import { summariseServiceFailures } from './stack-failure-summary';
import { StackInfraResourceManager } from './stack-infra-resource-manager';
import { StackPlanComputer } from './stack-plan-computer';
import { StackServiceHandlers, type ServiceHandlerContext } from './stack-service-handlers';
import { VaultCredentialInjector } from '../vault/vault-credential-injector';
import { vaultServicesReady } from '../vault/vault-services';
import { NatsCredentialInjector } from '../nats/nats-credential-injector';
import { writeNatsCredsFiles, type NatsCredsFileSpec } from '../nats/nats-creds-volume';
import { CloudflareTunnelTokenInjector } from '../cloudflare/cloudflare-tunnel-token-injector';
import { TailscaleAuthkeyInjector } from '../tailscale/tailscale-authkey-injector';
import { rotatePoolManagementTokens } from './pool-management-token';
import { resolveEffectiveVaultBinding } from './vault-binding-resolver';
import {
  createNetworkManager,
  stackNetworkName,
  compileStackNetworkMemberships,
  buildMembershipServiceInputs,
  convergeStack,
  ensureApplicationsMembership,
  type NetworkManager,
} from '../networks';
import { recordEgressNetworkMemberships } from './egress-injection';

export class StackReconciler {
  private containerManager: StackContainerManager;
  private infraManager: StackInfraResourceManager;
  private planComputer: StackPlanComputer;
  private serviceHandlers: StackServiceHandlers;
  private networkManager: NetworkManager;

  constructor(
    private dockerExecutor: DockerExecutorService,
    private prisma: PrismaClient,
    private routingManager?: StackRoutingManager,
    private resourceReconciler?: StackResourceReconciler
  ) {
    this.networkManager = createNetworkManager(dockerExecutor);
    this.containerManager = new StackContainerManager(dockerExecutor, prisma);
    this.infraManager = new StackInfraResourceManager(dockerExecutor, prisma, this.containerManager);
    this.planComputer = new StackPlanComputer(prisma, dockerExecutor, resourceReconciler);
    this.serviceHandlers = new StackServiceHandlers(
      prisma, dockerExecutor, this.containerManager, this.infraManager, this.networkManager, routingManager
    );
  }

  /**
   * Ensure every stack-owned network exists (mechanism 1: the stack's
   * `networks[]`, plus the synthesised `default` network for multi-service
   * stacks that declare none). Shared by `applyInner` and `updateInner` so
   * this logic exists in exactly one place instead of two copy-pasted loops.
   */
  private async ensureStackNetworks(
    networks: StackNetwork[],
    projectName: string,
    stackId: string,
    stackName: string,
    log: Logger,
  ): Promise<void> {
    const extraLabels = { 'mini-infra.stack': stackName, 'mini-infra.stack-id': stackId };
    for (const net of networks) {
      const netName = stackNetworkName(projectName, net.name);
      const result = await this.networkManager.ensure({
        name: netName,
        owner: { kind: 'stack', id: stackId },
        purpose: '_stack',
        driver: net.driver,
        options: net.options,
        extraLabels,
      });
      if (result.created) {
        log.info({ network: netName }, 'Creating network');
      }
    }
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
        template: { select: { name: true, source: true, createdById: true } },
      },
    });

    try {
      const projectName = getStackProjectName(stack);

      // Build template context with parameters and resolve service definitions
      const params = mergeParameterValues(
        (stack.parameters as unknown as StackParameterDefinition[]) ?? [],
        (stack.parameterValues as unknown as Record<string, StackParameterValue>) ?? {}
      );
      const templateContext = buildStackTemplateContext(stack, params);

      // Build maps for service definitions, hashes, and resolved configs
      const serviceMap = new Map(stack.services.map((s) => [s.serviceName, s]));
      const { resolvedConfigsMap, resolvedDefinitions: resolvedServiceDefinitions, serviceHashes } = await resolveServiceConfigs(
        stack.services,
        templateContext,
        {
          // Service Addons render-pass plumbing (Phase 3). The framework
          // tolerates a missing progress callback or connected-services
          // lookup — when both are absent (e.g. a stack with no `addons:`
          // declarations) the expansion is a pure pass-through.
          expansionProgress: options?.addonExpansion?.progress as
            | import('../stack-addons').ExpansionProgress
            | undefined,
          connectedServices: options?.addonExpansion?.connectedServices,
        },
      );

      // Apply-time invariant (network overhaul): HAProxy-routed services must
      // declare membership of the environment's `applications` network. Inject
      // it here — before resolveInputs and the handler dispatch below — so the
      // deploy path attaches networks purely from the declared membership
      // rather than force-attaching the HAProxy network imperatively.
      const { resourceInputs, resolvedDefinitions } = ensureApplicationsMembership(stack.environmentId, {
        resourceInputs: (stack.resourceInputs as unknown as StackResourceInput[]) ?? [],
        resolvedDefinitions: resolvedServiceDefinitions,
      });

      // 5a-i. Reconcile infra resource outputs (creates Docker networks + InfraResource records)
      const resourceOutputs = (stack.resourceOutputs as unknown as StackResourceOutput[]) ?? [];
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

      await this.ensureStackNetworks(networks, projectName, stackId, stack.name, log);

      // 5b-ii. Network overhaul Phase 6 — compile this apply's desired
      // network membership into ManagedNetwork/NetworkMembership rows,
      // write-only (nothing reads these yet; see services/networks/
      // membership-compiler.ts). Purely additive bookkeeping alongside the
      // ensure/attach calls above and below — never mutates actual
      // connectivity, never throws.
      const membershipServices = buildMembershipServiceInputs(stack.services, resolvedDefinitions);
      await compileStackNetworkMemberships({
        prisma: this.prisma,
        stack: {
          id: stackId,
          environmentId: stack.environmentId,
          templateSource: stack.template?.source ?? null,
          templateCreatedById: stack.template?.createdById ?? null,
        },
        projectName,
        networks,
        outputNetworkMap,
        inputNetworkMap,
        services: membershipServices,
        log,
      });
      await recordEgressNetworkMemberships(this.prisma, stack.environmentId, membershipServices, log);

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
          throw new InternalError(`DNS reconciliation failed: ${failed?.error}`);
        }

        // TLS second
        const tlsResults = await this.resourceReconciler.reconcileTls(
          plan.resourceActions, stackId, definitions.tlsCertificates,
          options?.triggeredBy ?? 'system', progressCallback
        );
        allResourceResults.push(...tlsResults);
        if (tlsResults.some((r) => !r.success)) {
          const failed = tlsResults.find((r) => !r.success);
          throw new InternalError(`TLS reconciliation failed: ${failed?.error}`);
        }

        // Tunnel third
        const tunnelResults = await this.resourceReconciler.reconcileTunnel(
          plan.resourceActions, stackId, definitions.tunnelIngress, progressCallback
        );
        allResourceResults.push(...tunnelResults);
        if (tunnelResults.some((r) => !r.success)) {
          const failed = tunnelResults.find((r) => !r.success);
          throw new InternalError(`Tunnel reconciliation failed: ${failed?.error}`);
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
      const networkNames = networks.map((n) => stackNetworkName(projectName, n.name));

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
      const { overrides: resolvedEnvOverrides, serviceBindingsToRecord: serviceBindingsToRecordApply, credsFiles: applyCredsFiles } =
        await this.resolveVaultEnv(
          stack,
          stack.services,
          resolvedDefinitions,
          poolTokens,
          activeServiceNames,
          log,
        );

      // Phase 5, §4.3: persist minted `.creds` into the stack's `nats_creds`
      // volume before any container is created, so the agent mounts a
      // populated file and re-reads it on every reconnect (the declared volume
      // was already ensured in step 5b). Throws (aborting apply) on failure.
      await writeNatsCredsFiles(this.dockerExecutor, { projectName, files: applyCredsFiles });

      for (const action of actions) {
        const actionStart = Date.now();
        const svc = serviceMap.get(action.serviceName);
        const serviceDef = resolvedDefinitions.get(action.serviceName) ?? null;
        const isStatelessWeb = svc?.serviceType === 'StatelessWeb';
        const isAdoptedWeb = svc?.serviceType === 'AdoptedWeb';

        if ((isStatelessWeb || isAdoptedWeb) && !this.routingManager) {
          throw new InternalError(`StackRoutingManager is required for ${svc?.serviceType} service "${action.serviceName}"`);
        }

        const handlerCtx: ServiceHandlerContext = {
          action, svc: svc ?? null, serviceDef, projectName, stackId, stack,
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
      await this.infraManager.joinSelfToOutputNetworks(stack.environmentId, resourceOutputs, outputNetworkMap, log);

      // 7b-ii. Network overhaul Phase 8 — scoped convergence for this stack,
      // now that every action above has finished (containers already
      // created/recreated/removed, so there is nothing left to race). This
      // is the "stack apply (scoped)" convergence trigger: it acts on the
      // membership rows `compileStackNetworkMemberships` just wrote/updated
      // above, catching anything the imperative attach pipeline in the
      // action loop above didn't cover (e.g. a service the plan marked
      // no-op this apply but whose desired membership still drifted since
      // its last apply). Best-effort — never blocks or fails the apply.
      try {
        await convergeStack(stackId, { prisma: this.prisma, networkManager: this.networkManager, dockerExecutor: this.dockerExecutor, log });
      } catch (err) {
        log.warn({ stackId, error: err instanceof Error ? err.message : String(err) }, 'Post-apply network convergence failed (non-fatal)');
      }

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
          // Snapshot the *authored* (pre-invariant) definitions: the injected
          // `applications` join is derived at apply time and must not enter the
          // definition hash, or drift detection would perpetually recreate.
          lastAppliedSnapshot: buildAppliedSnapshot(stack, resolvedServiceDefinitions),
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
      emitStackStatusChanged(stackId, resultStatus);

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
        // Distinguish "every image already current, nothing pulled" from a real
        // update that happened to touch zero services, so the client can say
        // "Already up to date" instead of a generic success toast.
        upToDate: true,
      };
    }

    const stack = await this.prisma.stack.findUniqueOrThrow({
      where: { id: stackId },
      include: {
        services: { orderBy: { order: 'asc' } },
        environment: true,
        template: { select: { source: true, createdById: true } },
      },
    });

    try {
      const projectName = getStackProjectName(stack);
      const params = mergeParameterValues(
        (stack.parameters as unknown as StackParameterDefinition[]) ?? [],
        (stack.parameterValues as unknown as Record<string, StackParameterValue>) ?? {}
      );
      const templateContext = buildStackTemplateContext(stack, params);
      const serviceMap = new Map(stack.services.map((s) => [s.serviceName, s]));
      const { resolvedConfigsMap, resolvedDefinitions: resolvedServiceDefinitions, serviceHashes } = await resolveServiceConfigs(stack.services, templateContext);

      // Apply-time invariant — see the create path above. Ensures HAProxy-routed
      // services declare the environment's `applications` network membership.
      const { resourceInputs, resolvedDefinitions } = ensureApplicationsMembership(stack.environmentId, {
        resourceInputs: (stack.resourceInputs as unknown as StackResourceInput[]) ?? [],
        resolvedDefinitions: resolvedServiceDefinitions,
      });

      // Reconcile infra resource outputs and inputs
      const resourceOutputs = (stack.resourceOutputs as unknown as StackResourceOutput[]) ?? [];
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
      const networkNames = updateNetworks.map((n) => stackNetworkName(projectName, n.name));

      // Ensure stack-owned networks exist. Update is normally called after at
      // least one apply, so the original networks should already be present —
      // but a stack that flipped from 1 service to 2+ services since last
      // apply needs the synthesised default network to be created here.
      await this.ensureStackNetworks(updateNetworks, projectName, stackId, stack.name, log);

      // Network overhaul Phase 6 — same write-only membership bookkeeping as
      // `applyInner` (see the comment there); `update` re-resolves the
      // current definition every time, so this keeps desired-state rows
      // fresh for stacks that only ever go through `update` (image-tag
      // bumps) rather than a full `apply`.
      const updateMembershipServices = buildMembershipServiceInputs(stack.services, resolvedDefinitions);
      await compileStackNetworkMemberships({
        prisma: this.prisma,
        stack: {
          id: stackId,
          environmentId: stack.environmentId,
          templateSource: stack.template?.source ?? null,
          templateCreatedById: stack.template?.createdById ?? null,
        },
        projectName,
        networks: updateNetworks,
        outputNetworkMap,
        inputNetworkMap,
        services: updateMembershipServices,
        log,
      });
      await recordEgressNetworkMemberships(this.prisma, stack.environmentId, updateMembershipServices, log);

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
      const { overrides: resolvedEnvOverrides, serviceBindingsToRecord: serviceBindingsToRecordUpdate, credsFiles: updateCredsFiles } =
        await this.resolveVaultEnv(
          stack,
          stack.services,
          resolvedDefinitions,
          poolTokens,
          activeServiceNames,
          log,
        );

      // Phase 5, §4.3: persist minted `.creds` into the stack's `nats_creds`
      // volume before recreating containers. `writeNatsCredsFiles` ensures the
      // volume exists first (the update path does not run step 5b's volume
      // provisioning).
      await writeNatsCredsFiles(this.dockerExecutor, { projectName, files: updateCredsFiles });

      for (const action of actions) {
        const svc = serviceMap.get(action.serviceName);
        const serviceDef = resolvedDefinitions.get(action.serviceName) ?? null;
        const actionStart = Date.now();

        const handlerCtx: ServiceHandlerContext = {
          action, svc: svc ?? null, serviceDef, projectName, stackId, stack,
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
          // Snapshot the *authored* (pre-invariant) definitions: the injected
          // `applications` join is derived at apply time and must not enter the
          // definition hash, or drift detection would perpetually recreate.
          lastAppliedSnapshot: buildAppliedSnapshot(stack, resolvedServiceDefinitions),
          ...(allSucceeded
            ? { lastAppliedVaultAppRoleId: stack.vaultAppRoleId ?? null, lastFailureReason: null }
            // Same surfacing as in `apply` above — see that branch for context.
            : { lastFailureReason: summariseServiceFailures(serviceResults) }),
        },
      });
      emitStackStatusChanged(stackId, resultStatus);

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
      environmentId: string | null;
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
    /**
     * Minted `.creds` blobs the caller must persist into the stack's
     * `nats_creds` volume (Phase 5, §4.3) before creating containers. Deduped
     * by file name — one `<stackId>.creds` per stack (all egress agents are
     * one-nats-creds-service-per-stack).
     */
    credsFiles: NatsCredsFileSpec[];
  }> {
    const overrides = new Map<string, Record<string, string>>();
    const serviceBindingsToRecord = new Map<string, string>();
    const credsFilesByName = new Map<string, NatsCredsFileSpec>();
    const serviceByName = new Map(services.map((s) => [s.serviceName, s]));
    const vaultReady = vaultServicesReady();
    const injector = vaultReady ? new VaultCredentialInjector(this.prisma) : null;
    const natsInjector = new NatsCredentialInjector(this.prisma);
    const tunnelTokenInjector = new CloudflareTunnelTokenInjector(this.prisma);
    const tailscaleAuthkeyInjector = new TailscaleAuthkeyInjector(this.prisma);

    for (const [serviceName, serviceDef] of resolvedDefinitions.entries()) {
      if (!activeServiceNames.has(serviceName)) continue;
      // Pool and JobPool services never get a container at apply time — skip
      // resolution entirely so we don't waste a Vault mint on something we
      // won't use. (Per-instance / per-run credential injection happens on
      // spawn in `pool-spawner.ts`.)
      if (serviceDef.serviceType === 'Pool' || serviceDef.serviceType === 'JobPool') continue;
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
          src.kind === 'nats-creds-file' ||
          src.kind === 'nats-signer-seed' ||
          src.kind === 'nats-account-public',
      );
      const hasPoolTokenEntries = Object.values(dynamicEnv).some(
        (src) => src.kind === 'pool-management-token',
      );
      const hasTunnelTokenEntries = Object.values(dynamicEnv).some(
        (src) => src.kind === 'cloudflare-tunnel-token',
      );
      const hasTailscaleAuthkeyEntries = Object.values(dynamicEnv).some(
        (src) => src.kind === 'tailscale-authkey',
      );

      // Cloudflare tunnel token resolves inline from the managed-tunnel store —
      // no Vault / NATS / AppRole involved. It's independent of the other kinds,
      // so resolve + merge it up front; a tunnel-token-only service (the
      // cloudflared connector) then falls through the Vault/NATS gates below
      // and keeps these values. Fails closed if no managed tunnel exists.
      if (hasTunnelTokenEntries) {
        try {
          const values = await tunnelTokenInjector.resolve(
            stack.environmentId,
            serviceDef.containerConfig,
          );
          if (values) {
            const existing = overrides.get(serviceName) ?? {};
            overrides.set(serviceName, { ...existing, ...values });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(
            { service: serviceName, err: msg },
            'Cloudflare tunnel token resolution failed',
          );
          const wrapped = new InternalError(
            `Cloudflare tunnel token injection failed for service "${serviceName}": ${msg}`,
          );
          wrapped.cause = err;
          throw wrapped;
        }
      }

      // Tailscale authkey mints inline from the tailscale connected service —
      // no Vault / NATS / AppRole involved, independent of the other kinds, so
      // resolve + merge it up front like the tunnel token. An authkey-only
      // service (the tailscale-ingress sidecar) then falls through the
      // Vault/NATS gates below and keeps these values. Fails closed if the
      // tailscale connected service isn't configured.
      if (hasTailscaleAuthkeyEntries) {
        try {
          const values = await tailscaleAuthkeyInjector.resolve(serviceDef.containerConfig);
          if (values) {
            const existing = overrides.get(serviceName) ?? {};
            overrides.set(serviceName, { ...existing, ...values });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(
            { service: serviceName, err: msg },
            'Tailscale authkey resolution failed',
          );
          const wrapped = new InternalError(
            `Tailscale authkey injection failed for service "${serviceName}": ${msg}`,
          );
          wrapped.cause = err;
          throw wrapped;
        }
      }

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
        if (Object.keys(values).length > 0) {
          const existing = overrides.get(serviceName) ?? {};
          overrides.set(serviceName, { ...existing, ...values });
        }
        continue;
      }

      if (hasNatsEntries) {
        try {
          const resolved = await natsInjector.resolve(
            svcRow.natsCredentialId ?? null,
            serviceDef.containerConfig,
            { stackId: stack.id },
          );
          if (resolved) {
            const existing = overrides.get(serviceName) ?? {};
            overrides.set(serviceName, { ...existing, ...resolved.values });
            for (const file of resolved.credsFiles) {
              credsFilesByName.set(file.fileName, file);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ service: serviceName, err: msg }, 'NATS dynamic env resolution failed');
          const wrapped = new InternalError(`NATS credential injection failed for service "${serviceName}": ${msg}`);
          wrapped.cause = err;
          throw wrapped;
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
        throw new InternalError(
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
        const wrapped = new InternalError(
          `Vault credential injection failed for service "${serviceName}": ${msg}`,
        );
        wrapped.cause = err;
        throw wrapped;
      }
    }
    return { overrides, serviceBindingsToRecord, credsFiles: [...credsFilesByName.values()] };
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
      // Pool and JobPool services don't run containers at apply time, so
      // don't pull/compare. Per-instance / per-run pulls happen on spawn.
      if (svc.serviceType === 'Pool' || svc.serviceType === 'JobPool') continue;
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
    emitStackStatusChanged(stackId, 'undeployed');

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

}

