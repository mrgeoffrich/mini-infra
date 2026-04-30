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
  // Fingerprint of the last successfully-pushed entries. Used to suppress
  // no-op pushes when Docker fires container events that don't change the
  // map (most events are healthcheck exec_create/exec_start/exec_die churn,
  // which produces identical entries). Null until the first successful push.
  lastPushedFingerprint: string | null;
}

/**
 * Build a deterministic fingerprint for a set of entries. Entries are
 * already sorted by _buildContainerMap, so this is just a JSON
 * serialisation of the fields the gateway cares about.
 */
function fingerprintEntries(entries: ContainerMapEntry[]): string {
  return JSON.stringify(
    entries.map((e) => [e.ip, e.stackId, e.serviceName, e.containerId ?? '']),
  );
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
      state = { timer: null, version: 0, lastPushedAt: null, lastPushedFingerprint: null };
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
          state = { timer: null, version: 0, lastPushedAt: null, lastPushedFingerprint: null };
          this.states.set(env.id, state);
        }
        return this._pushEnv(env, state);
      }),
    );
  }

  private async _pushEnv(env: EnvRow, state: EnvState): Promise<void> {
    const attempt = async (): Promise<void> => {
      const entries = await this._buildContainerMap(env);

      // Most container events Docker emits (healthcheck exec_create /
      // exec_start / exec_die, etc.) don't change the map — without this
      // check the pusher hits the gateway ~once per second on an idle
      // env. Skip when the snapshot is identical to what we last pushed.
      const fingerprint = fingerprintEntries(entries);
      if (state.lastPushedFingerprint === fingerprint) {
        log.debug(
          { envId: env.id, envName: env.name, entryCount: entries.length },
          'Container map unchanged since last push — skipping',
        );
        return;
      }

      const client = new EgressGatewayClient(env.egressGatewayIp);
      state.version += 1;
      const result = await client.pushContainerMap({
        version: state.version,
        entries,
      });
      state.lastPushedAt = new Date();
      state.lastPushedFingerprint = fingerprint;
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
   * Discovery is label-driven: we walk every container with an IP on the
   * env's egress network and key off the `mini-infra.stack-id` /
   * `mini-infra.service` labels that both StackContainerManager and the
   * pool-spawner stamp on every managed container. The stack list from
   * Prisma is used purely to validate membership and read each service's
   * `egressBypass` flag — not to construct expected names.
   *
   * Doing it by name was wrong because pool instances follow the
   * `${env}-${stack}-pool-${service}-${instanceId}` pattern from
   * pool-spawner.ts, not the static `${env}-${stack}-${service}` pattern,
   * so they were silently dropped from the map and got 403'd at the
   * gateway's UnknownIPDenyHandler before any ACL eval.
   */
  private async _buildContainerMap(env: EnvRow): Promise<ContainerMapEntry[]> {
    const egressNetwork = `${env.name}-egress`;

    // Stacks in this environment that are not removed.
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

    // Index: stackId → service map, so a container's labels can be looked
    // up in O(1) and validated against this env's stack list.
    const serviceConfigByKey = new Map<string, Record<string, unknown> | null>();
    for (const stack of stacks) {
      for (const service of stack.services) {
        serviceConfigByKey.set(
          `${stack.id}:${service.serviceName}`,
          service.containerConfig as Record<string, unknown> | null,
        );
      }
    }

    // Fetch live container list from Docker (raw API gives per-network IPs and labels).
    const dockerService = DockerService.getInstance();
    if (!dockerService.isConnected()) {
      log.warn({ envId: env.id }, 'Docker not connected — returning empty container map');
      return [];
    }

    const docker = await dockerService.getDockerInstance();
    const rawContainers = await docker.listContainers({ all: false });

    const entries: ContainerMapEntry[] = [];

    for (const c of rawContainers) {
      const ip = c.NetworkSettings?.Networks?.[egressNetwork]?.IPAddress;
      if (!ip) continue;

      const labels = c.Labels ?? {};
      const stackId = labels['mini-infra.stack-id'];
      const serviceName = labels['mini-infra.service'];
      if (!stackId || !serviceName) continue;

      const key = `${stackId}:${serviceName}`;
      if (!serviceConfigByKey.has(key)) {
        // Container is on this egress network but the stack/service is
        // unknown to this env (foreign stack, deleted service, or a stale
        // container that survived a stack rebuild). Skip — don't trust
        // labels alone for membership.
        continue;
      }

      const cfg = serviceConfigByKey.get(key);
      if (cfg?.egressBypass === true) continue;

      entries.push({
        ip,
        stackId,
        serviceName,
        containerId: c.Id,
      });
    }

    // Stable ordering keeps log output and downstream snapshot diffs
    // deterministic across pushes that don't change membership.
    entries.sort((a, b) => {
      if (a.stackId !== b.stackId) return a.stackId < b.stackId ? -1 : 1;
      if (a.serviceName !== b.serviceName) return a.serviceName < b.serviceName ? -1 : 1;
      return a.ip < b.ip ? -1 : a.ip > b.ip ? 1 : 0;
    });

    log.debug(
      { envId: env.id, envName: env.name, egressNetwork, entryCount: entries.length },
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
