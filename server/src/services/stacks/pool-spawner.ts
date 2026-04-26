import type { PrismaClient } from '../../generated/prisma/client';
import type {
  PoolConfig,
  StackContainerConfig,
  StackNetwork,
  StackParameterDefinition,
  StackParameterValue,
} from '@mini-infra/types';
import type { DockerExecutorService } from '../docker-executor';
import { VaultCredentialInjector } from '../vault/vault-credential-injector';
import { vaultServicesReady } from '../vault/vault-services';
import { resolveEffectiveVaultBinding } from './vault-binding-resolver';
import { getLogger } from '../../lib/logger-factory';
import {
  buildStackTemplateContext,
  mergeParameterValues,
  resolveServiceConfigs,
  synthesiseDefaultNetworkIfNeeded,
} from './utils';

const log = getLogger('stacks', 'pool-spawner');

/** Env keys the caller is never allowed to set — mini-infra owns Vault values. */
const RESERVED_CALLER_ENV_PREFIXES = ['VAULT_'];

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

  const service = stack.services.find(
    (s) => s.serviceName === ctx.serviceName && s.serviceType === 'Pool',
  );
  if (!service) return { success: false, error: 'Pool service not found' };

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
  const { resolvedDefinitions } = resolveServiceConfigs(stack.services, templateContext);
  const resolvedDef = resolvedDefinitions.get(ctx.serviceName);
  if (!resolvedDef) {
    return { success: false, error: 'Pool service missing from resolved definitions' };
  }

  const dockerImage = resolvedDef.dockerImage;
  const dockerTag = resolvedDef.dockerTag;
  const containerConfig = resolvedDef.containerConfig as StackContainerConfig;
  const poolConfig = (resolvedDef.poolConfig ?? null) as PoolConfig | null;
  if (!poolConfig) return { success: false, error: 'Pool service missing poolConfig' };

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
  if (
    vaultServicesReady() &&
    containerConfig.dynamicEnv &&
    Object.values(containerConfig.dynamicEnv).some((src) => src.kind !== 'pool-management-token')
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

  // Caller env wins over base/Vault env; VAULT_* is stripped.
  const finalEnv: Record<string, string> = {
    ...(containerConfig.env ?? {}),
    ...vaultEnv,
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
  const labels: Record<string, string> = {
    'mini-infra.stack': stack.name,
    'mini-infra.stack-id': stack.id,
    'mini-infra.service': ctx.serviceName,
    'mini-infra.pool-instance': 'true',
    'mini-infra.pool-instance-id': ctx.instanceId,
    ...(stack.environmentId ? { 'mini-infra.environment': stack.environmentId } : {}),
    ...(containerConfig.labels ?? {}),
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

  let containerId: string;
  try {
    const container = await dockerExecutor.createLongRunningContainer({
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
    await container.start();
    containerId = container.id;
  } catch (err) {
    return {
      success: false,
      error: `Container create/start failed: ${err instanceof Error ? err.message : String(err)}`,
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

  // Poll for running state (up to 30s).
  const deadline = Date.now() + 30_000;
  const docker = dockerExecutor.getDockerClient();
  while (Date.now() < deadline) {
    try {
      const info = await docker.getContainer(containerId).inspect();
      if (info.State?.Running) {
        return { success: true, containerId };
      }
      if (info.State?.Status === 'exited') {
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
