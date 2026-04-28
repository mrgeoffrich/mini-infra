/**
 * EgressContainerMapPusher
 *
 * Watches Docker container changes and pushes a full container-map snapshot
 * to each environment's egress-gateway whenever containers start/stop.
 *
 * - Debounced per environment (500 ms quiet window) to collapse bursts.
 * - On startup, pushes once for every env that has an egressGatewayIp.
 * - On failure: retries once after 1 s; on second failure gives up until
 *   the next container event triggers a fresh push.
 * - Version counter is in-memory and monotonically incremented per env.
 */

import type { PrismaClient } from '../../generated/prisma/client';
import DockerService from '../docker';
import { EgressGatewayClient, type ContainerMapEntry } from './egress-gateway-client';
import { getLogger } from '../../lib/logger-factory';
import { emitEgressGatewayHealth } from './egress-socket-emitter';

const log = getLogger('stacks', 'egress-container-map-pusher');

const DEBOUNCE_MS = 500;
const RETRY_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Per-environment state
// ---------------------------------------------------------------------------

interface EnvState {
  timer: NodeJS.Timeout | null;
  version: number;
  lastPushedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Stack + service shape we query from Prisma
// ---------------------------------------------------------------------------

interface ServiceRow {
  serviceName: string;
  containerConfig: unknown;
}

interface StackRow {
  id: string;
  name: string;
  services: ServiceRow[];
}

interface EnvRow {
  id: string;
  name: string;
  egressGatewayIp: string;
}

// ---------------------------------------------------------------------------
// Pusher class
// ---------------------------------------------------------------------------

export class EgressContainerMapPusher {
  private readonly states = new Map<string, EnvState>();
  private shutdown = false;

  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Start watching Docker container changes and push initial maps.
   */
  start(): void {
    const dockerService = DockerService.getInstance();

    // Register container-change callback — same pattern as container-socket-emitter
    dockerService.onContainerChange(() => {
      if (this.shutdown) return;
      void this._scheduleAllEnvs();
    });

    // Push initial maps on startup (fire-and-forget — non-fatal)
    void this._pushAllEnvs('startup');

    log.info('EgressContainerMapPusher started');
  }

  /**
   * Stop all pending timers.
   */
  stop(): void {
    this.shutdown = true;
    for (const state of this.states.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
    log.info('EgressContainerMapPusher stopped');
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async _scheduleAllEnvs(): Promise<void> {
    let envs: EnvRow[];
    try {
      envs = await this._getEnvsWithGateway();
    } catch (err) {
      log.warn({ err }, 'Failed to fetch envs with gateway — skipping debounce');
      return;
    }

    for (const env of envs) {
      this._scheduleEnv(env.id, env);
    }
  }

  private _scheduleEnv(envId: string, env: EnvRow): void {
    let state = this.states.get(envId);
    if (!state) {
      state = { timer: null, version: 0, lastPushedAt: null };
      this.states.set(envId, state);
    }

    if (state.timer) {
      clearTimeout(state.timer);
    }

    state.timer = setTimeout(() => {
      state!.timer = null;
      void this._pushEnv(env, state!);
    }, DEBOUNCE_MS);
  }

  private async _pushAllEnvs(reason: string): Promise<void> {
    let envs: EnvRow[];
    try {
      envs = await this._getEnvsWithGateway();
    } catch (err) {
      log.warn({ err, reason }, 'Failed to fetch envs with gateway on initial push');
      return;
    }

    log.info({ count: envs.length, reason }, 'Pushing container maps to all envs');

    await Promise.all(
      envs.map((env) => {
        let state = this.states.get(env.id);
        if (!state) {
          state = { timer: null, version: 0, lastPushedAt: null };
          this.states.set(env.id, state);
        }
        return this._pushEnv(env, state);
      }),
    );
  }

  private async _pushEnv(env: EnvRow, state: EnvState): Promise<void> {
    const attempt = async (): Promise<void> => {
      const entries = await this._buildContainerMap(env);
      const client = new EgressGatewayClient(env.egressGatewayIp);
      state.version += 1;
      const result = await client.pushContainerMap({
        version: state.version,
        entries,
      });
      state.lastPushedAt = new Date();
      log.info(
        { envId: env.id, envName: env.name, version: result.version, entryCount: result.entryCount },
        'Container map pushed to gateway',
      );

      // Emit gateway health — success
      emitEgressGatewayHealth({
        environmentId: env.id,
        gatewayIp: env.egressGatewayIp,
        ok: true,
        // Rules version not known by the container-map pusher — safe defaults
        rulesVersion: 0,
        appliedRulesVersion: null,
        containerMapVersion: state.version,
        appliedContainerMapVersion: state.version,
        upstream: {
          servers: [],
          lastSuccessAt: new Date().toISOString(),
          lastFailureAt: null,
        },
      });
    };

    try {
      await attempt();
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), envId: env.id, envName: env.name },
        'Container map push failed — retrying once',
      );
      await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      try {
        await attempt();
      } catch (err2) {
        const errMsg = err2 instanceof Error ? err2.message : String(err2);
        log.warn(
          { err: errMsg, envId: env.id, envName: env.name },
          'Container map push failed on retry — giving up until next event',
        );
        // Roll back the version bump so the next push increments from a sane baseline
        state.version -= 1;

        // Emit gateway health — failure
        emitEgressGatewayHealth({
          environmentId: env.id,
          gatewayIp: env.egressGatewayIp,
          ok: false,
          rulesVersion: 0,
          appliedRulesVersion: null,
          containerMapVersion: state.version,
          appliedContainerMapVersion: null,
          upstream: {
            servers: [],
            lastSuccessAt: null,
            lastFailureAt: new Date().toISOString(),
          },
          errorMessage: errMsg,
        });
      }
    }
  }

  /**
   * Build the container-map entries for an environment.
   *
   * - Query active stacks (not removed, not archived) in the env.
   * - Skip stacks that belong to the egress-gateway itself (egressBypass).
   * - For each service in each stack, find a running container by name and
   *   get its IPv4 address on the env's applications network.
   */
  private async _buildContainerMap(env: EnvRow): Promise<ContainerMapEntry[]> {
    const applicationsNetwork = `${env.name}-applications`;

    // Stacks in this environment that are not removed
    const stacks = await this.prisma.stack.findMany({
      where: {
        environmentId: env.id,
        status: { not: 'removed' },
        removedAt: null,
      },
      select: {
        id: true,
        name: true,
        services: {
          select: {
            serviceName: true,
            containerConfig: true,
          },
        },
      },
    }) as StackRow[];

    // Fetch live container list from Docker (raw API gives per-network IPs)
    const dockerService = DockerService.getInstance();
    if (!dockerService.isConnected()) {
      log.warn({ envId: env.id }, 'Docker not connected — returning empty container map');
      return [];
    }

    const docker = await dockerService.getDockerInstance();
    const rawContainers = await docker.listContainers({ all: false });

    // Build a lookup: containerName → IP on the applications network
    const ipByName = new Map<string, string>();
    const idByName = new Map<string, string>();
    for (const c of rawContainers) {
      const networks = c.NetworkSettings?.Networks ?? {};
      const networkInfo = networks[applicationsNetwork];
      if (networkInfo?.IPAddress) {
        const name = (c.Names?.[0] ?? '').replace(/^\//, '');
        ipByName.set(name, networkInfo.IPAddress);
        idByName.set(name, c.Id);
      }
    }

    const entries: ContainerMapEntry[] = [];

    for (const stack of stacks) {
      for (const service of stack.services) {
        // Skip services with egressBypass (e.g. the egress-gateway itself)
        const cfg = service.containerConfig as Record<string, unknown> | null;
        if (cfg?.egressBypass === true) continue;

        // Container name convention matches what StackContainerManager creates:
        // {stackName}-{serviceName}
        const containerName = `${stack.name}-${service.serviceName}`;
        const ip = ipByName.get(containerName);
        if (!ip) continue; // Container not running or not on this network

        entries.push({
          ip,
          stackId: stack.id,
          serviceName: service.serviceName,
          containerId: idByName.get(containerName),
        });
      }
    }

    log.debug(
      { envId: env.id, envName: env.name, applicationsNetwork, entryCount: entries.length },
      'Built container map',
    );

    return entries;
  }

  private async _getEnvsWithGateway(): Promise<EnvRow[]> {
    const envs = await this.prisma.environment.findMany({
      where: { egressGatewayIp: { not: null } },
      select: { id: true, name: true, egressGatewayIp: true },
    });
    // Filter out nulls (type-safety: findMany with `not: null` still returns nullable type)
    return envs.filter((e): e is EnvRow => e.egressGatewayIp !== null && e.egressGatewayIp !== undefined);
  }
}
