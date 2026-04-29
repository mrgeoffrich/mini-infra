/**
 * EnvFirewallManager
 *
 * Drives the egress-fw-agent (a privileged host-singleton container) over its
 * Unix-socket HTTP admin API. Responsible for:
 *
 * 1. Calling POST /v1/env when a firewall-enabled env is created or its mode changes.
 * 2. Calling DELETE /v1/env/:env when a firewall-enabled env is destroyed.
 * 3. Subscribing to Docker container start/die/destroy events and pushing ipset
 *    add/del deltas for managed containers (non-bypass, not the gateway itself).
 * 4. Reconcile on server boot and Docker daemon reconnect — calls syncManaged
 *    for each opted-in env.
 * 5. Outage queue: if the agent socket is unreachable, queue ipset updates (bounded
 *    at 1000 entries; drop oldest on overflow). Drain on recovery.
 *
 * The agent socket is at /var/run/mini-infra/fw.sock (configurable via
 * FW_AGENT_SOCKET_PATH env var). The mini-infra-server container mounts the
 * same directory, so plain HTTP-over-unix-socket works.
 *
 * Feature flag: egressFirewallEnabled on the Environment model defaults to false.
 * Nothing is called for envs with the flag OFF.
 *
 * Design decisions vs. plan:
 * - The plan (section 2.7) suggests calling EnvFirewallManager.addManagedContainer()
 *   from stack-container-manager.ts post-start. We instead use Docker events
 *   (onContainerEvent) to detect start/die on labelled containers. This is more
 *   robust: it catches restarts, manual docker start/stop, and avoids a new
 *   dependency from stack-container-manager on EnvFirewallManager.
 */

import type { PrismaClient } from '../../generated/prisma/client';
import DockerService from '../docker';
import { getLogger } from '../../lib/logger-factory';
import {
  createUnixSocketFetcher,
  getFwAgentSocketPath,
  type Fetcher,
  type FwAgentRequest,
  type FwAgentResponse,
} from './fw-agent-transport';

export type { Fetcher, FwAgentRequest, FwAgentResponse };

const log = getLogger('stacks', 'env-firewall-manager');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUEUE_CAP = 1000;

export type FirewallMode = 'observe' | 'enforce';

// ---------------------------------------------------------------------------
// Queued delta — applied when the agent recovers from an outage
// ---------------------------------------------------------------------------

interface QueuedDelta {
  type: 'add' | 'del';
  env: string;
  ip: string;
}

// ---------------------------------------------------------------------------
// EnvFirewallManager
// ---------------------------------------------------------------------------

export class EnvFirewallManager {
  private readonly fetcher: Fetcher;
  private readonly socketPath: string;
  private stopped = false;

  /** Bounded outage queue */
  private readonly queue: QueuedDelta[] = [];
  /** Whether the agent is currently reachable */
  private agentUp = false;

  constructor(
    private readonly prisma: PrismaClient,
    fetcher?: Fetcher,
  ) {
    this.socketPath = getFwAgentSocketPath();
    this.fetcher = fetcher ?? createUnixSocketFetcher(this.socketPath);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start the manager — subscribe to Docker events and run boot reconcile. */
  async start(): Promise<void> {
    log.info({ socketPath: this.socketPath }, 'EnvFirewallManager starting');

    const dockerService = DockerService.getInstance();
    dockerService.onContainerEvent(async (event) => {
      if (this.stopped) return;
      try {
        await this._handleContainerEvent(event);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'EnvFirewallManager: container event handler failed',
        );
      }
    });

    await this._reconcile();
    log.info('EnvFirewallManager started');
  }

  /** Stop the manager — no further processing. */
  stop(): void {
    this.stopped = true;
    log.info('EnvFirewallManager stopped');
  }

  // -------------------------------------------------------------------------
  // Public API (called by EnvironmentManager)
  // -------------------------------------------------------------------------

  /**
   * Called when an environment is created or its mode is changed.
   * No-op if egressFirewallEnabled is false on the env.
   */
  async applyEnv(envId: string, mode: FirewallMode): Promise<void> {
    const env = await this._getEnabledEnv(envId);
    if (!env) return;

    // Resolve the real bridge CIDR from the applications network InfraResource.
    // The subnet is stored in InfraResource.metadata.subnet for the docker-network
    // resource with purpose "applications" in this environment.
    const bridgeCidr = await this._getBridgeCidr(envId, env.name);
    if (!bridgeCidr) {
      log.error(
        { envId, envName: env.name },
        'fw-agent: applyEnv: cannot resolve bridge CIDR — env has no applications network yet; skipping',
      );
      return;
    }

    try {
      const resp = await this.fetcher({
        method: 'POST',
        path: '/v1/env',
        body: { env: env.name, bridgeCidr, mode },
      });
      if (resp.status !== 200) {
        log.warn({ envId, status: resp.status, body: resp.body }, 'fw-agent: applyEnv failed');
      } else {
        this.agentUp = true;
      }
    } catch (err) {
      this._handleAgentOutage(
        `applyEnv(${envId})`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Called when an environment is destroyed.
   *
   * Checks egressFirewallEnabled before calling the agent (consistent with
   * applyEnv). If the env row is already gone from the DB (deleted), attempts
   * the removal anyway as a best-effort cleanup.
   */
  async removeEnv(envId: string, envName: string): Promise<void> {
    // Look up the flag. If the env is already deleted from DB, proceed with
    // cleanup anyway (best-effort) rather than silently dropping the call.
    try {
      const env = await this.prisma.environment.findUnique({
        where: { id: envId },
        select: { egressFirewallEnabled: true },
      });

      if (env !== null && !env.egressFirewallEnabled) {
        // Env exists but firewall is disabled — skip agent call (consistent with applyEnv).
        return;
      }

      if (env === null) {
        // Env already deleted from DB — attempt cleanup at best-effort.
        log.info({ envId, envName }, 'fw-agent: removeEnv: env not found in DB — attempting cleanup anyway');
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), envId },
        'fw-agent: removeEnv: DB lookup failed — attempting cleanup anyway',
      );
    }

    try {
      const resp = await this.fetcher({ method: 'DELETE', path: `/v1/env/${envName}` });
      if (resp.status !== 200 && resp.status !== 404) {
        log.warn({ envId, envName, status: resp.status }, 'fw-agent: removeEnv non-200');
      } else {
        this.agentUp = true;
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), envId },
        'fw-agent: removeEnv failed (agent down)',
      );
    }
  }

  /**
   * Change the firewall mode for an env (observe ↔ enforce).
   */
  async setMode(envId: string, mode: FirewallMode): Promise<void> {
    return this.applyEnv(envId, mode);
  }

  // -------------------------------------------------------------------------
  // Docker event handler
  // -------------------------------------------------------------------------

  private async _handleContainerEvent(event: {
    action?: string;
    containerId?: string;
    containerName?: string;
    labels?: Record<string, string>;
  }): Promise<void> {
    const labels = event.labels ?? {};
    const action = event.action;
    if (!action || !['start', 'die', 'destroy'].includes(action)) return;

    // Filter: must have mini-infra.environment label.
    const envId = labels['mini-infra.environment'];
    if (!envId) return;

    // Filter: skip bypass containers.
    if (labels['mini-infra.egress.bypass'] === 'true') return;

    // Filter: skip the gateway itself.
    if (labels['mini-infra.egress.gateway'] === 'true') return;

    // Filter: skip the fw-agent itself.
    if (labels['mini-infra.egress.fw-agent'] === 'true') return;

    // Check that the env has the firewall flag enabled.
    const env = await this._getEnabledEnv(envId);
    if (!env) return;

    const containerId = event.containerId ?? '';
    if (!containerId) return;

    if (action === 'start') {
      // Look up the container's IP in the env's network.
      const ip = await this._getContainerIp(containerId, env.name);
      if (!ip) {
        log.debug({ containerId, envId }, 'Could not determine container IP — skipping ipset add');
        return;
      }
      await this._addMember(env.name, ip);
    } else {
      // die or destroy — remove from ipset (best-effort; we may not know the IP anymore).
      // Attempt to get the IP from Docker inspect before the container is gone.
      const ip = await this._getContainerIp(containerId, env.name).catch(() => null);
      if (ip) {
        await this._delMember(env.name, ip);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reconcile
  // -------------------------------------------------------------------------

  private async _reconcile(): Promise<void> {
    try {
      const envs = await this.prisma.environment.findMany({
        where: { egressFirewallEnabled: true },
        select: { id: true, name: true, egressGatewayIp: true },
      });

      if (envs.length === 0) {
        log.debug('EnvFirewallManager reconcile: no enabled envs');
        return;
      }

      log.info({ count: envs.length }, 'EnvFirewallManager reconcile started');

      const dockerService = DockerService.getInstance();
      if (!dockerService.isConnected()) {
        log.warn('EnvFirewallManager reconcile: Docker not connected — skipping');
        return;
      }

      // Re-register each env with the agent first (High 2 fix: the agent's
      // in-memory EnvStore is empty on every restart, so we must re-send the
      // POST /v1/env call before any ipset sync for that env).
      const modeResults = await this._reconcileEnvRegistrations(envs);

      // Fetch raw container list for IP extraction (High 1 fix: use the raw
      // Docker API to get per-network IPs, matching egress-container-map-pusher).
      const docker = await dockerService.getDockerInstance();
      const rawContainers = await docker.listContainers({ all: false });

      for (const env of envs) {
        // Only sync if env registration succeeded (agent knows the CIDR).
        if (!modeResults.has(env.id)) continue;

        try {
          const applicationsNetwork = `${env.name}-applications`;
          // Collect IPs of managed running containers in this env.
          const ips: string[] = [];
          for (const c of rawContainers) {
            const labels = c.Labels ?? {};
            const envLabel = labels['mini-infra.environment'];
            if (envLabel !== env.id) continue;
            if (labels['mini-infra.egress.bypass'] === 'true') continue;
            if (labels['mini-infra.egress.gateway'] === 'true') continue;
            if (labels['mini-infra.egress.fw-agent'] === 'true') continue;

            // Extract IP from the env's applications network (same pattern as
            // egress-container-map-pusher).
            const networks = c.NetworkSettings?.Networks ?? {};
            const networkInfo = networks[applicationsNetwork];
            const ip = networkInfo?.IPAddress;
            if (ip) {
              ips.push(ip);
            } else {
              log.debug(
                { containerId: c.Id, envName: env.name, applicationsNetwork },
                'EnvFirewallManager reconcile: container not on env applications network — skipping',
              );
            }
          }

          await this._syncManaged(env.name, ips);
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err), env: env.name },
            'EnvFirewallManager reconcile: syncManaged failed for env',
          );
        }
      }

      // Drain the outage queue now that the agent is reachable.
      await this._drainQueue();

      log.info({ count: envs.length }, 'EnvFirewallManager reconcile complete');
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'EnvFirewallManager reconcile failed',
      );
    }
  }

  /**
   * Re-register each enabled env with the fw-agent (POST /v1/env).
   * Returns a Set of env IDs that were successfully registered (or already up).
   * Envs whose bridge CIDR can't be resolved are skipped and excluded from the set.
   */
  private async _reconcileEnvRegistrations(
    envs: Array<{ id: string; name: string; egressGatewayIp: string | null }>,
  ): Promise<Set<string>> {
    const registered = new Set<string>();
    for (const env of envs) {
      try {
        const bridgeCidr = await this._getBridgeCidr(env.id, env.name);
        if (!bridgeCidr) {
          log.warn(
            { envId: env.id, envName: env.name },
            'EnvFirewallManager reconcile: no bridge CIDR for env — skipping env registration',
          );
          continue;
        }
        // All envs in the outer list already have egressFirewallEnabled: true.
        // Default to observe mode for reconcile — the mode is not persisted
        // separately, and observe is the safe default (no packets dropped).
        const resp = await this.fetcher({
          method: 'POST',
          path: '/v1/env',
          body: { env: env.name, bridgeCidr, mode: 'observe' as FirewallMode },
        });
        if (resp.status === 200) {
          this.agentUp = true;
          registered.add(env.id);
        } else {
          log.warn(
            { envId: env.id, envName: env.name, status: resp.status },
            'EnvFirewallManager reconcile: applyEnv failed for env',
          );
        }
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), envId: env.id },
          'EnvFirewallManager reconcile: applyEnv threw for env',
        );
      }
    }
    return registered;
  }

  // -------------------------------------------------------------------------
  // Outage queue
  // -------------------------------------------------------------------------

  private _enqueue(delta: QueuedDelta): void {
    if (this.queue.length >= QUEUE_CAP) {
      const dropped = this.queue.shift();
      log.warn(
        { dropped, queueLength: this.queue.length },
        'EnvFirewallManager: outage queue cap exceeded — dropped oldest delta',
      );
    }
    this.queue.push(delta);
  }

  private async _drainQueue(): Promise<void> {
    if (this.queue.length === 0) return;

    log.info({ count: this.queue.length }, 'EnvFirewallManager: draining outage queue');
    const draining = this.queue.splice(0);
    for (const delta of draining) {
      try {
        if (delta.type === 'add') {
          await this._addMember(delta.env, delta.ip);
        } else {
          await this._delMember(delta.env, delta.ip);
        }
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), delta },
          'EnvFirewallManager: drain failed for delta',
        );
      }
    }
    log.info('EnvFirewallManager: outage queue drained');
  }

  private _handleAgentOutage(context: string, reason: string): void {
    if (this.agentUp) {
      log.warn({ context, reason }, 'EnvFirewallManager: fw-agent appears to be down');
      this.agentUp = false;
    }
  }

  // -------------------------------------------------------------------------
  // fw-agent calls
  // -------------------------------------------------------------------------

  private async _addMember(envName: string, ip: string): Promise<void> {
    try {
      const resp = await this.fetcher({
        method: 'POST',
        path: `/v1/ipset/${envName}/managed/add`,
        body: { ip },
      });
      if (resp.status !== 200) {
        log.warn({ envName, ip, status: resp.status }, 'fw-agent: addMember non-200');
      } else {
        this.agentUp = true;
      }
    } catch (err) {
      this._handleAgentOutage('addMember', err instanceof Error ? err.message : String(err));
      this._enqueue({ type: 'add', env: envName, ip });
    }
  }

  private async _delMember(envName: string, ip: string): Promise<void> {
    try {
      const resp = await this.fetcher({
        method: 'POST',
        path: `/v1/ipset/${envName}/managed/del`,
        body: { ip },
      });
      if (resp.status !== 200) {
        log.warn({ envName, ip, status: resp.status }, 'fw-agent: delMember non-200');
      } else {
        this.agentUp = true;
      }
    } catch (err) {
      this._handleAgentOutage('delMember', err instanceof Error ? err.message : String(err));
      this._enqueue({ type: 'del', env: envName, ip });
    }
  }

  private async _syncManaged(envName: string, ips: string[]): Promise<void> {
    try {
      const resp = await this.fetcher({
        method: 'POST',
        path: `/v1/ipset/${envName}/managed/sync`,
        body: { ips },
      });
      if (resp.status !== 200) {
        log.warn({ envName, count: ips.length, status: resp.status }, 'fw-agent: syncManaged non-200');
      } else {
        this.agentUp = true;
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), envName },
        'fw-agent: syncManaged failed',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async _getEnabledEnv(envId: string): Promise<{
    id: string;
    name: string;
    egressGatewayIp: string | null;
  } | null> {
    try {
      const env = await this.prisma.environment.findUnique({
        where: { id: envId },
        select: { id: true, name: true, egressGatewayIp: true, egressFirewallEnabled: true },
      });
      if (!env || !env.egressFirewallEnabled) return null;
      return env;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), envId },
        'EnvFirewallManager: DB lookup failed',
      );
      return null;
    }
  }

  private async _getContainerIp(containerId: string, envName: string): Promise<string | null> {
    try {
      const dockerService = DockerService.getInstance();
      const docker = await dockerService.getDockerInstance();
      const info = await docker.getContainer(containerId).inspect();
      const networks = info.NetworkSettings?.Networks ?? {};
      for (const [netName, net] of Object.entries(networks)) {
        if (netName.includes(envName)) {
          const ip = (net as { IPAddress?: string })?.IPAddress;
          if (ip) return ip;
        }
      }
      // Fallback: first network.
      for (const net of Object.values(networks)) {
        const ip = (net as { IPAddress?: string })?.IPAddress;
        if (ip) return ip;
      }
    } catch {
      // Container may already be removed.
    }
    return null;
  }

  /**
   * Resolve the bridge CIDR (e.g. "172.30.5.0/24") for an env's applications
   * network by reading the subnet stored in the InfraResource row.
   *
   * Returns null if no subnet is recorded yet (env not fully provisioned).
   */
  private async _getBridgeCidr(envId: string, envName: string): Promise<string | null> {
    try {
      const resource = await this.prisma.infraResource.findFirst({
        where: {
          type: 'docker-network',
          purpose: 'applications',
          scope: 'environment',
          environmentId: envId,
        },
        select: { metadata: true },
      });
      if (!resource) return null;
      const meta = resource.metadata as Record<string, unknown> | null;
      const subnet = meta?.['subnet'];
      if (typeof subnet === 'string' && subnet) {
        return subnet;
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), envId, envName },
        'EnvFirewallManager: _getBridgeCidr DB lookup failed',
      );
    }
    return null;
  }

}
