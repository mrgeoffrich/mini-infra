import { POOL_ADDON_LABELS, type StackContainerConfig, type StackServiceDefinition } from '@mini-infra/types';
import type { PrismaClient } from '../../generated/prisma/client';
import type { DockerExecutorService } from '../docker-executor';
import { getLogger } from '../../lib/logger-factory';
import { getStackProjectName } from './template-engine';
import { StackContainerManager } from './stack-container-manager';
import { StackInfraResourceManager } from './stack-infra-resource-manager';
import { attachServiceNetworks, createNetworkManager, type NetworkManager } from '../networks';

const log = getLogger('stacks', 'pool-addon-sidecar');

/**
 * Inputs for `spawnPoolAddonSidecars` — the per-instance sidecar materialiser
 * invoked by the pool spawner after the worker container is up.
 */
export interface SpawnPoolAddonSidecarsInput {
  prisma: PrismaClient;
  dockerExecutor: DockerExecutorService;
  stackId: string;
  stackName: string;
  environmentName: string | null;
  environmentId: string | null;
  /** The pool service name the addons are attached to. */
  serviceName: string;
  /** The id of the just-spawned pool instance. */
  instanceId: string;
  /** The instance's existing project name (e.g. `<env>-<stack>`). */
  projectName: string;
  /** Per-instance synthetic sidecar definitions produced by `expandAddons`. */
  syntheticDefinitions: StackServiceDefinition[];
  /** Worker container networks (for sibling DNS — sidecar must join the same set). */
  workerNetworkNames: string[];
}

export interface PoolAddonSidecarResult {
  serviceName: string;
  containerId?: string;
  error?: string;
}

/**
 * Build the sanitised Docker container name for a per-instance addon sidecar.
 * Mirrors `buildPoolContainerName` so the operator sees the same naming
 * convention on the worker and its sidecars.
 */
function buildSidecarContainerName(
  stackName: string,
  environmentName: string | null,
  syntheticServiceName: string,
): string {
  const projectName = getStackProjectName({
    name: stackName,
    environment: environmentName ? { name: environmentName } : null,
  });
  const raw = `${projectName}-pool-${syntheticServiceName}`;
  const sanitised = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitised.slice(0, 63);
}

/**
 * Spawn one Docker container per synthetic sidecar definition. Best-effort:
 * a failure to create or start any one sidecar logs the error and returns
 * it on the result list but does NOT throw — the worker is already running
 * and reaping the worker will sweep up any half-started sidecars via the
 * pool-instance-id label match.
 *
 * The sidecars carry the same `mini-infra.pool-instance-id` label as the
 * worker so the reaper can find them by label without consulting the DB.
 * `mini-infra.synthetic=true` matches static-service addon sidecars so any
 * UI code that already dims synthetic rows treats per-instance sidecars
 * uniformly.
 *
 * Container creation skips Vault/NATS credential resolution and joinResource
 * networks: the addon sidecars (currently only `tailscale-*`) don't bind a
 * Vault AppRole or NATS account — they speak to the Tailscale control plane
 * directly, which is gated by the egress allowlist already promoted via
 * `requiredEgress`.
 */
export async function spawnPoolAddonSidecars(
  input: SpawnPoolAddonSidecarsInput,
): Promise<PoolAddonSidecarResult[]> {
  const results: PoolAddonSidecarResult[] = [];
  if (input.syntheticDefinitions.length === 0) return results;

  // Built once per batch and reused across sidecars — same pattern as the
  // pool spawner: a NetworkManager + StackContainerManager +
  // StackInfraResourceManager trio wired to the shared `attachServiceNetworks`
  // helper instead of a raw-connect shim.
  const networkManager = createNetworkManager(input.dockerExecutor);
  const containerManager = new StackContainerManager(input.dockerExecutor, input.prisma);
  const infraManager = new StackInfraResourceManager(input.dockerExecutor, input.prisma, containerManager);

  for (const def of input.syntheticDefinitions) {
    const result = await spawnOne(input, def, { networkManager, containerManager, infraManager });
    results.push(result);
  }
  return results;
}

async function spawnOne(
  input: SpawnPoolAddonSidecarsInput,
  def: StackServiceDefinition,
  managers: {
    networkManager: NetworkManager;
    containerManager: StackContainerManager;
    infraManager: StackInfraResourceManager;
  },
): Promise<PoolAddonSidecarResult> {
  const containerName = buildSidecarContainerName(
    input.stackName,
    input.environmentName,
    def.serviceName,
  );
  const cfg = def.containerConfig as StackContainerConfig;

  // Stamp per-instance + synthetic labels alongside whatever the addon's
  // buildServiceDefinition set. The addon already emits
  // `mini-infra.addon` / `mini-infra.synthetic` / `mini-infra.addon-target`;
  // here we add the pool-specific join keys.
  const labels: Record<string, string> = {
    ...(cfg.labels ?? {}),
    [POOL_ADDON_LABELS.STACK_ID]: input.stackId,
    [POOL_ADDON_LABELS.SERVICE]: input.serviceName,
    [POOL_ADDON_LABELS.POOL_INSTANCE_ID]: input.instanceId,
    [POOL_ADDON_LABELS.SYNTHETIC]: 'true',
    'mini-infra.pool-instance': 'true',
    ...(input.environmentId
      ? { 'mini-infra.environment': input.environmentId }
      : {}),
  };

  try {
    await input.dockerExecutor.pullImageWithAutoAuth(
      `${def.dockerImage}:${def.dockerTag}`,
    );
  } catch (err) {
    return {
      serviceName: def.serviceName,
      error: `Image pull failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Mounts: synthetic sidecars never use volume namespacing because they own
  // their state volume by full sanitised name (see `tailscaleStateVolumeName`).
  // The static-service path namespaces with the project name, but the addon
  // already produces a globally-unique volume name; namespacing here would
  // double-stamp and create separate volumes per project.
  const mounts = cfg.mounts?.map((m) => ({
    Target: m.target,
    Source: m.source,
    Type: m.type,
    ReadOnly: m.readOnly,
  }));

  const healthcheck = cfg.healthcheck
    ? {
        Test: cfg.healthcheck.test,
        Interval: Number(cfg.healthcheck.interval) * 1_000_000_000,
        Timeout: Number(cfg.healthcheck.timeout) * 1_000_000_000,
        Retries: Number(cfg.healthcheck.retries),
        StartPeriod: Number(cfg.healthcheck.startPeriod) * 1_000_000_000,
      }
    : undefined;

  const logConfig = cfg.logConfig
    ? {
        Type: cfg.logConfig.type,
        Config: {
          'max-size': cfg.logConfig.maxSize,
          'max-file': cfg.logConfig.maxFile,
        },
      }
    : undefined;

  let createdContainer: Awaited<
    ReturnType<typeof input.dockerExecutor.createLongRunningContainer>
  >;
  try {
    createdContainer = await input.dockerExecutor.createLongRunningContainer({
      image: `${def.dockerImage}:${def.dockerTag}`,
      name: containerName,
      projectName: input.projectName,
      serviceName: def.serviceName,
      env: { ...(cfg.env ?? {}) },
      cmd: cfg.command,
      entrypoint: cfg.entrypoint,
      capAdd: cfg.capAdd,
      devices: cfg.devices,
      user: cfg.user,
      mounts,
      // Peer-on-target-network: join the same Docker networks the worker is
      // attached to, so the sidecar can reach the worker by service-name DNS.
      networks: input.workerNetworkNames,
      restartPolicy: cfg.restartPolicy ?? 'unless-stopped',
      healthcheck,
      logConfig,
      labels,
    });
  } catch (err) {
    return {
      serviceName: def.serviceName,
      error: `Container create failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Auto-attach the per-env egress network so the sidecar's HTTP_PROXY env
  // resolves the gateway DNS alias. Tailscale's control plane is then
  // template-allowlisted via `requiredEgress` on the synthetic sidecar.
  // Routed through the same `attachServiceNetworks` helper the worker and
  // static services use instead of a raw-connect shim wrapping
  // `attachEgressNetworkIfNeeded` directly — a no-op for joinNetworks/
  // joinResourceNetworks today since synthetic addon definitions don't
  // declare either, but it means a future addon that does gets the same
  // pipeline for free instead of a second reimplementation.
  try {
    await attachServiceNetworks(createdContainer.id, def.serviceName, def, {
      networkManager: managers.networkManager,
      containerManager: managers.containerManager,
      infraManager: managers.infraManager,
      prisma: input.prisma,
      infraNetworkMap: new Map(),
      environmentId: input.environmentId,
      log,
    });
  } catch (err) {
    log.warn(
      {
        stackId: input.stackId,
        serviceName: def.serviceName,
        err: err instanceof Error ? err.message : String(err),
      },
      'Failed to attach networks to per-instance sidecar (continuing)',
    );
  }

  try {
    await createdContainer.start();
  } catch (err) {
    return {
      serviceName: def.serviceName,
      containerId: createdContainer.id,
      error: `Container start failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  log.info(
    {
      stackId: input.stackId,
      serviceName: input.serviceName,
      instanceId: input.instanceId,
      syntheticServiceName: def.serviceName,
      containerId: createdContainer.id,
    },
    'Per-instance addon sidecar started',
  );

  return { serviceName: def.serviceName, containerId: createdContainer.id };
}
