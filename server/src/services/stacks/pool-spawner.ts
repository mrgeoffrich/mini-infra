import type { PrismaClient } from '../../generated/prisma/client';
import type {
  PoolConfig,
  StackContainerConfig,
  StackNetwork,
  StackParameterDefinition,
  StackParameterValue,
  StackServiceDefinition,
} from '@mini-infra/types';
import type { DockerExecutorService } from '../docker-executor';
import { VaultCredentialInjector } from '../vault/vault-credential-injector';
import { vaultServicesReady } from '../vault/vault-services';
import { NatsCredentialInjector } from '../nats/nats-credential-injector';
import { resolveEffectiveVaultBinding } from './vault-binding-resolver';
import { getLogger } from '../../lib/logger-factory';
import {
  buildStackTemplateContext,
  mergeParameterValues,
  resolveServiceConfigs,
  synthesiseDefaultNetworkIfNeeded,
} from './utils';
import { resolveEgressEnv, attachEgressNetworkIfNeeded } from './egress-injection';
import { TailscaleService } from '../tailscale/tailscale-service';
import { spawnPoolAddonSidecars } from './pool-addon-sidecar';

const log = getLogger('stacks', 'pool-spawner');

/** Env keys the caller is never allowed to set — mini-infra owns Vault values. */
const RESERVED_CALLER_ENV_PREFIXES = ['VAULT_', 'NATS_'];

export interface PoolSpawnContext {
  stackId: string;
  stackName: string;
  environmentName: string | null;
  environmentId: string | null;
  serviceName: string;
  instanceId: string;
  instanceRowId: string;
  callerEnv: Record<string, string>;
  idleTimeoutMinutes: number;
  /**
   * Optional Docker labels stamped on the spawned container alongside the
   * standard pool-instance labels. Used by the JobPool spawner to pass
   * trigger attribution forward — the exit watcher reads the labels off
   * the `die` event to know which trigger fired the run. Reserved label
   * keys (`mini-infra.*`) emitted by the spawner cannot be overridden.
   */
  extraLabels?: Record<string, string>;
}

/**
 * Build the sanitised Docker container name for a pool instance.
 * Mirrors static-service naming: env-scoped → `{env}-{stack}`; host → `mini-infra-{stack}`.
 */
export function buildPoolContainerName(
  stackName: string,
  environmentName: string | null,
  serviceName: string,
  instanceId: string,
): string {
  const projectName = environmentName ? `${environmentName}-${stackName}` : `mini-infra-${stackName}`;
  const raw = `${projectName}-pool-${serviceName}-${instanceId}`;
  // Docker allows [a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}; sanitise aggressively to
  // [a-z0-9-] for operator readability.
  const sanitised = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return sanitised.slice(0, 63);
}

/** Strip VAULT_* keys from caller-supplied env. */
export function sanitiseCallerEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (RESERVED_CALLER_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Result of a pool instance spawn. Contains the Docker container ID on
 * success, or an error message on failure. Never throws — the caller
 * transitions the DB row to `error` when success is false.
 */
export interface PoolSpawnResult {
  success: boolean;
  containerId?: string;
  error?: string;
}

/**
 * Synchronous spawn of a single pool instance. Pulls the image, resolves
 * Vault credentials (when bound), creates the container with mini-infra
 * labels, attaches networks, starts it, polls for running state. Returns
 * success/failure — never throws.
 *
 * In Phase 2 this becomes an async background task that emits Socket.IO
 * events; Phase 1 callers invoke it inline and await the result.
 */
export async function spawnPoolInstance(
  prisma: PrismaClient,
  dockerExecutor: DockerExecutorService,
  ctx: PoolSpawnContext,
): Promise<PoolSpawnResult> {
  const stack = await prisma.stack.findUnique({
    where: { id: ctx.stackId },
    include: { environment: true, services: { orderBy: { order: 'asc' } } },
  });
  if (!stack) return { success: false, error: 'Stack not found' };

  // Accept both `Pool` (Phase 1 — caller-driven ensure-instance) and `JobPool`
  // (this plan's Phase 1 — triggered one-shot runs). Both ride the same
  // PoolInstance lifecycle, dynamicEnv injection, and network-attachment
  // machinery; the differences (idle vs. exit-driven, ensure vs. trigger)
  // live above this layer in the dispatcher and exit watcher (Phase 2+).
  const service = stack.services.find(
    (s) =>
      s.serviceName === ctx.serviceName &&
      (s.serviceType === 'Pool' || s.serviceType === 'JobPool'),
  );
  if (!service) return { success: false, error: 'Pool/JobPool service not found' };

  // Resolve `{{params.X}}`, `{{volumes.X}}`, etc. on the service definition —
  // mirrors what stack-reconciler does on apply. Pool services were skipped
  // here previously, so `dockerImage`/`dockerTag` and any templated
  // `containerConfig` field reached Docker as the raw template string (and
  // `docker pull` rejects them as invalid references).
  const params = mergeParameterValues(
    (stack.parameters as unknown as StackParameterDefinition[]) ?? [],
    (stack.parameterValues as unknown as Record<string, StackParameterValue>) ?? {},
  );
  const templateContext = buildStackTemplateContext(stack, params);
  // Run the addon render pipeline with `instance: { instanceId }` populated so
  // addons attached to a Pool service mint per-instance authkeys and produce
  // per-instance synthetic sidecar definitions. The Tailscale connected
  // service is injected so `provision()` can mint authkeys; absence is
  // tolerated for envs where no addons are declared.
  const tailscaleService = new TailscaleService(prisma);
  const { resolvedDefinitions } = await resolveServiceConfigs(
    stack.services,
    templateContext,
    {
      instance: { instanceId: ctx.instanceId },
      connectedServices: { tailscale: tailscaleService },
    },
  );
  const resolvedDef = resolvedDefinitions.get(ctx.serviceName);
  if (!resolvedDef) {
    return { success: false, error: 'Pool service missing from resolved definitions' };
  }

  // Pull out the per-instance synthetic sidecar definitions produced by addon
  // expansion: anything in the rendered map that wasn't an authored service
  // on this stack. Phase 6 — these are spawned alongside the worker below.
  const authoredServiceNames = new Set(stack.services.map((s) => s.serviceName));
  const syntheticSidecarDefs: StackServiceDefinition[] = [];
  for (const [name, def] of resolvedDefinitions) {
    if (authoredServiceNames.has(name)) continue;
    if (!def.synthetic) continue;
    if (def.synthetic.targetService !== ctx.serviceName) continue;
    syntheticSidecarDefs.push(def);
  }

  const dockerImage = resolvedDef.dockerImage;
  const dockerTag = resolvedDef.dockerTag;
  const containerConfig = resolvedDef.containerConfig as StackContainerConfig;
  // poolConfig is required for Pool services but absent on JobPool services.
  // Either pool authoring block must be present for the spawn to make sense;
  // beyond that gate `poolConfig` / `jobPoolConfig` aren't read here — the
  // per-spawn knobs (idle timer, cap, lifecycle) live on the rows above.
  const poolConfig = (resolvedDef.poolConfig ?? null) as PoolConfig | null;
  const jobPoolConfig = resolvedDef.jobPoolConfig ?? null;
  if (service.serviceType === 'Pool' && !poolConfig) {
    return { success: false, error: 'Pool service missing poolConfig' };
  }
  if (service.serviceType === 'JobPool' && !jobPoolConfig) {
    return { success: false, error: 'JobPool service missing jobPoolConfig' };
  }

  const projectName = stack.environment
    ? `${stack.environment.name}-${stack.name}`
    : `mini-infra-${stack.name}`;
  const containerName = buildPoolContainerName(
    stack.name,
    stack.environment?.name ?? null,
    ctx.serviceName,
    ctx.instanceId,
  );

  // Resolve Vault dynamic env via the shared effective-binding helper —
  // single source of truth for service-level vs. stack-level fallback.
  const binding = resolveEffectiveVaultBinding(stack, service);
  let vaultEnv: Record<string, string> = {};
  const hasVaultEntries = !!containerConfig.dynamicEnv && Object.values(containerConfig.dynamicEnv).some(
    (src) => src.kind === 'vault-addr' || src.kind === 'vault-role-id' || src.kind === 'vault-wrapped-secret-id' || src.kind === 'vault-kv',
  );
  if (
    vaultServicesReady() &&
    containerConfig.dynamicEnv &&
    hasVaultEntries
  ) {
    try {
      const injector = new VaultCredentialInjector(prisma);
      const res = await injector.resolve(
        {
          appRoleId: binding.appRoleId,
          // Freshly-spawned instances never start in degraded mode —
          // fail loudly if Vault is unreachable. failClosed=false is fine
          // because a fresh spawn has nothing to fall back to anyway.
          failClosed: false,
          prevBoundAppRoleId: binding.prevBoundAppRoleId,
          poolTokens: {},
        },
        containerConfig,
      );
      if (res) vaultEnv = res.values;
    } catch (err) {
      return {
        success: false,
        error: `Vault credential resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  let natsEnv: Record<string, string> = {};
  if (
    containerConfig.dynamicEnv &&
    Object.values(containerConfig.dynamicEnv).some(
      (src) =>
        src.kind === 'nats-url' ||
        src.kind === 'nats-creds' ||
        src.kind === 'nats-signer-seed' ||
        src.kind === 'nats-account-public',
    )
  ) {
    try {
      const injector = new NatsCredentialInjector(prisma);
      const resolved = await injector.resolve(
        service.natsCredentialId ?? null,
        containerConfig,
        { stackId: ctx.stackId },
      );
      if (resolved) natsEnv = resolved;
    } catch (err) {
      return {
        success: false,
        error: `NATS credential resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Egress proxy env — injected for non-bypass services in env-scoped stacks
  // when the env has a provisioned gateway. Pool workers need this on the
  // same gates as the static service path so outbound calls flow through the
  // gateway. See egress-injection.ts.
  const egressEnv = await resolveEgressEnv(
    prisma,
    stack.environmentId,
    containerConfig.egressBypass === true,
  );

  // Caller env wins over base/Vault env; VAULT_* is stripped. Egress proxy
  // env goes first so service-defined env or caller env can still override.
  const finalEnv: Record<string, string> = {
    ...egressEnv,
    ...(containerConfig.env ?? {}),
    ...vaultEnv,
    ...natsEnv,
    ...sanitiseCallerEnv(ctx.callerEnv),
  };

  // Pull image (with registry auth resolution).
  try {
    log.info({ image: dockerImage, tag: dockerTag, containerName }, 'Pulling image for pool spawn');
    await dockerExecutor.pullImageWithAutoAuth(`${dockerImage}:${dockerTag}`);
  } catch (err) {
    return { success: false, error: `Image pull failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Build the network list. Mirror stack-reconciler: declared networks plus
  // the synthesised `<project>_default` for multi-service stacks. Without
  // the synthesis call, pool containers attach only to the vault network +
  // bridge and can't resolve sibling stack services by name (e.g. `nats`).
  const declaredNetworks = (stack.networks as unknown as StackNetwork[]) ?? [];
  const networks = synthesiseDefaultNetworkIfNeeded(declaredNetworks, stack.services);
  const networkNames = networks.map((n) => `${projectName}_${n.name}`);

  // Labels that match static stack containers, plus pool-instance markers.
  // `extraLabels` (e.g. JobPool trigger attribution) layer on top of the
  // template's container labels but cannot override the reserved
  // mini-infra.* markers further below.
  const labels: Record<string, string> = {
    'mini-infra.stack': stack.name,
    'mini-infra.stack-id': stack.id,
    'mini-infra.service': ctx.serviceName,
    'mini-infra.pool-instance': 'true',
    'mini-infra.pool-instance-id': ctx.instanceId,
    ...(stack.environmentId ? { 'mini-infra.environment': stack.environmentId } : {}),
    ...(containerConfig.labels ?? {}),
    ...(ctx.extraLabels ?? {}),
  };

  // Ports (mirror StackContainerManager logic).
  const hostBoundPorts = containerConfig.ports?.filter(
    (p) => p.hostPort !== 0 && p.exposeOnHost !== false,
  );
  const internalOnlyPorts = containerConfig.ports?.filter(
    (p) => p.exposeOnHost === false && p.hostPort !== 0,
  );
  const ports = hostBoundPorts && hostBoundPorts.length > 0
    ? Object.fromEntries(
        hostBoundPorts.map((p) => [
          `${p.containerPort}/${p.protocol}`,
          [{ HostPort: String(p.hostPort) }],
        ]),
      )
    : undefined;
  const internalPorts = internalOnlyPorts && internalOnlyPorts.length > 0
    ? internalOnlyPorts.map((p) => `${p.containerPort}/${p.protocol}`)
    : undefined;

  // Mounts (volume sources get projectName prefix, same as stateful services).
  const mounts = containerConfig.mounts?.map((m) => ({
    Target: m.target,
    Source: m.type === 'volume' && !m.source.includes('/') ? `${projectName}_${m.source}` : m.source,
    Type: m.type,
    ReadOnly: m.readOnly,
  }));

  // Healthcheck: seconds → nanoseconds.
  const healthcheck = containerConfig.healthcheck
    ? {
        Test: containerConfig.healthcheck.test,
        Interval: Number(containerConfig.healthcheck.interval) * 1_000_000_000,
        Timeout: Number(containerConfig.healthcheck.timeout) * 1_000_000_000,
        Retries: Number(containerConfig.healthcheck.retries),
        StartPeriod: Number(containerConfig.healthcheck.startPeriod) * 1_000_000_000,
      }
    : undefined;

  const logConfig = containerConfig.logConfig
    ? {
        Type: containerConfig.logConfig.type,
        Config: {
          'max-size': containerConfig.logConfig.maxSize,
          'max-file': containerConfig.logConfig.maxFile,
        },
      }
    : undefined;

  // Create the container BEFORE starting it so we can attach all required
  // networks (joinNetworks + joinResourceNetworks) up front. Starting first
  // races the container's bootstrap (e.g. vault unwrap) against late-attached
  // networks like `mini-infra-vault` — see createContainer/startContainer in
  // StackContainerManager for the same pattern on the static service path.
  let containerId: string;
  let createdContainer: Awaited<ReturnType<typeof dockerExecutor.createLongRunningContainer>>;
  try {
    createdContainer = await dockerExecutor.createLongRunningContainer({
      image: `${dockerImage}:${dockerTag}`,
      name: containerName,
      projectName,
      serviceName: ctx.serviceName,
      env: finalEnv,
      cmd: containerConfig.command,
      entrypoint: containerConfig.entrypoint,
      capAdd: containerConfig.capAdd,
      user: containerConfig.user,
      ports,
      internalPorts,
      mounts,
      networks: networkNames,
      restartPolicy: containerConfig.restartPolicy ?? 'no',
      healthcheck,
      logConfig,
      labels,
    });
    containerId = createdContainer.id;
  } catch (err) {
    return {
      success: false,
      error: `Container create failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Attach join networks (external networks referenced by name).
  if (containerConfig.joinNetworks?.length) {
    const docker = dockerExecutor.getDockerClient();
    for (const netName of containerConfig.joinNetworks) {
      if (!netName) continue;
      try {
        await docker.getNetwork(netName).connect({ Container: containerId });
      } catch (err) {
        log.warn({ containerId, network: netName, err: err instanceof Error ? err.message : String(err) }, 'Failed to attach join network');
      }
    }
  }

  // Attach infra resource networks declared by the service template's
  // `joinResourceNetworks` (e.g. `['vault']`). Mirrors the static service
  // path in StackInfraResourceManager.joinResourceNetworks — without this,
  // pool workers that need to read shared secrets from Vault directly (or
  // talk to any other resource-network sibling) crash on DNS resolution.
  //
  // We also implicitly require the vault network when an AppRole binding is
  // in play, even if the template didn't list it — this preserves the prior
  // belt-and-suspenders behaviour for AppRole-bound pool services whose
  // dynamicEnv was working only because pool-spawner attached vault for them.
  const declaredPurposes = new Set(containerConfig.joinResourceNetworks ?? []);
  if (binding.appRoleId && Object.keys(vaultEnv).length > 0) {
    declaredPurposes.add('vault');
  }
  if (Object.keys(natsEnv).length > 0) {
    declaredPurposes.add('nats');
  }
  if (declaredPurposes.size > 0) {
    const docker = dockerExecutor.getDockerClient();
    for (const purpose of declaredPurposes) {
      const resource = await prisma.infraResource.findFirst({
        where: {
          type: 'docker-network',
          purpose,
          ...(stack.environmentId
            ? { environmentId: stack.environmentId, scope: 'environment' }
            : { scope: 'host', environmentId: null }),
        },
      });
      if (!resource) {
        // Fall back to host scope when the env-scoped resource is missing —
        // matches StackInfraResourceManager.resolveInputs.
        const hostResource = stack.environmentId
          ? await prisma.infraResource.findFirst({
              where: {
                type: 'docker-network',
                purpose,
                scope: 'host',
                environmentId: null,
              },
            })
          : null;
        if (!hostResource) {
          log.warn(
            { containerId, stackId: ctx.stackId, purpose },
            'Infra resource network not found; skipping attach (pool worker may fail to reach this resource)',
          );
          continue;
        }
        try {
          await docker.getNetwork(hostResource.name).connect({ Container: containerId });
          log.info({ containerId, network: hostResource.name, purpose }, 'Attached infra resource network');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/already exists/i.test(msg)) {
            log.warn({ containerId, network: hostResource.name, purpose, err: msg }, 'Failed to attach infra resource network');
          }
        }
        continue;
      }
      try {
        await docker.getNetwork(resource.name).connect({ Container: containerId });
        log.info({ containerId, network: resource.name, purpose }, 'Attached infra resource network');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already exists/i.test(msg)) {
          log.warn({ containerId, network: resource.name, purpose, err: msg }, 'Failed to attach infra resource network');
        }
      }
    }
  }

  // Auto-attach to the per-env egress network so the proxy env injected
  // above (HTTP_PROXY=http://egress-gateway:3128) can resolve the DNS alias.
  // Same gates as resolveEgressEnv: non-bypass + env has gateway provisioned.
  {
    const egressDocker = dockerExecutor.getDockerClient();
    await attachEgressNetworkIfNeeded(
      prisma,
      {
        connectToNetwork: async (id, name) => {
          await egressDocker.getNetwork(name).connect({ Container: id });
        },
      },
      containerId,
      stack.environmentId,
      containerConfig.egressBypass === true,
      log,
    );
  }

  // All required networks are attached — start the container now so its
  // bootstrap code sees them on first instruction.
  try {
    await createdContainer.start();
  } catch (err) {
    return {
      success: false,
      containerId,
      error: `Container start failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Spawn per-instance addon sidecars (Phase 6). Best-effort — a sidecar
  // failure logs but doesn't fail the pool spawn, since the worker is
  // already up and addons are observability/connectivity sugar rather than
  // gating prerequisites. Reaping the worker sweeps any half-started
  // sidecars via the `mini-infra.pool-instance-id` label match.
  if (syntheticSidecarDefs.length > 0) {
    try {
      const sidecarResults = await spawnPoolAddonSidecars({
        prisma,
        dockerExecutor,
        stackId: ctx.stackId,
        stackName: stack.name,
        environmentName: stack.environment?.name ?? null,
        environmentId: stack.environmentId,
        serviceName: ctx.serviceName,
        instanceId: ctx.instanceId,
        projectName,
        syntheticDefinitions: syntheticSidecarDefs,
        workerNetworkNames: networkNames,
      });
      for (const r of sidecarResults) {
        if (r.error) {
          log.warn(
            {
              stackId: ctx.stackId,
              serviceName: ctx.serviceName,
              instanceId: ctx.instanceId,
              syntheticServiceName: r.serviceName,
              error: r.error,
            },
            'Per-instance addon sidecar spawn failed (continuing — reaper will clean up)',
          );
        }
      }
    } catch (err) {
      log.warn(
        {
          stackId: ctx.stackId,
          serviceName: ctx.serviceName,
          instanceId: ctx.instanceId,
          err: err instanceof Error ? err.message : String(err),
        },
        'Per-instance addon spawn helper crashed (continuing — worker is up)',
      );
    }
  }

  // Poll for running state (up to 30s).
  //
  // For `Pool` services, the container is expected to stay up — observing
  // an `exited` state during the poll means the bootstrap died and the
  // pool worker never came up. That's a spawn failure.
  //
  // For `JobPool` services, the container is *expected* to exit — that's the
  // entire lifecycle. A super-fast exit (success or non-zero) is a normal
  // outcome, not a spawn failure: the exit watcher (Phase 2 — see
  // `job-pool-exit-watcher.ts`) flips the `PoolInstance` row to
  // `completed`/`failed` based on the exit code from the Docker `die`
  // event. Reporting it as a spawn failure here would race the watcher and
  // (depending on which loses the race) leave the row stuck at `error` with
  // semantically wrong status, even though the run actually completed
  // cleanly. So for JobPool we treat both `Running` and `exited` as success
  // and let the watcher own the terminal-state transition.
  const isJobPool = service.serviceType === 'JobPool';
  const deadline = Date.now() + 30_000;
  const docker = dockerExecutor.getDockerClient();
  while (Date.now() < deadline) {
    try {
      const info = await docker.getContainer(containerId).inspect();
      if (info.State?.Running) {
        return { success: true, containerId };
      }
      if (info.State?.Status === 'exited') {
        if (isJobPool) {
          return { success: true, containerId };
        }
        return {
          success: false,
          containerId,
          error: `Container exited immediately (exit code ${info.State.ExitCode})`,
        };
      }
    } catch (err) {
      log.debug({ containerId, err: err instanceof Error ? err.message : String(err) }, 'Inspect during poll failed');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { success: false, containerId, error: 'Container did not reach running state within 30s' };
}
