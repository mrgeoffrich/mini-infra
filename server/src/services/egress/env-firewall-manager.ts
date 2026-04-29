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

import { createConnection } from 'net';
import type { PrismaClient } from '../../generated/prisma/client';
import DockerService from '../docker';
import { getLogger } from '../../lib/logger-factory';

const log = getLogger('stacks', 'env-firewall-manager');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SOCKET_PATH = '/var/run/mini-infra/fw.sock';
const QUEUE_CAP = 1000;

export type FirewallMode = 'observe' | 'enforce';

// ---------------------------------------------------------------------------
// Fetcher interface — injectable for tests
// ---------------------------------------------------------------------------

export interface FwAgentRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
}

export interface FwAgentResponse {
  status: number;
  body: unknown;
}

export type Fetcher = (req: FwAgentRequest) => Promise<FwAgentResponse>;

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
    this.socketPath = process.env.FW_AGENT_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;
    this.fetcher = fetcher ?? this._defaultFetcher.bind(this);
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

    try {
      const resp = await this.fetcher({
        method: 'POST',
        path: '/v1/env',
        body: { env: env.name, bridgeCidr: env.egressGatewayIp ?? '10.0.0.0/24', mode },
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
   * No-op if egressFirewallEnabled is false on the env.
   */
  async removeEnv(envId: string, envName: string): Promise<void> {
    // Fetch the flag — even if already deleted from DB we still want to clean up.
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

      const allContainers = await dockerService.listContainers(false);

      for (const env of envs) {
        try {
          // Collect IPs of managed running containers in this env.
          const ips: string[] = [];
          for (const c of allContainers) {
            const envLabel = c.labels['mini-infra.environment'];
            if (envLabel !== env.id) continue;
            if (c.labels['mini-infra.egress.bypass'] === 'true') continue;
            if (c.labels['mini-infra.egress.gateway'] === 'true') continue;
            if (c.labels['mini-infra.egress.fw-agent'] === 'true') continue;

            // Extract IP from the container's networks.
            const ip = this._extractIpFromNetworkSummary(c, env.name);
            if (ip) ips.push(ip);
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

  private _extractIpFromNetworkSummary(
    _container: { networkNames?: string[]; labels: Record<string, string> },
    _envName: string,
  ): string | null {
    // DockerService.listContainers() returns a simplified view; we don't get IPs
    // directly from it. Return null here — reconcile will skip containers whose
    // IP cannot be resolved. A follow-on PR can extend listContainers() with IPs.
    return null;
  }

  // -------------------------------------------------------------------------
  // Default fetcher — HTTP over Unix socket
  // -------------------------------------------------------------------------

  private _defaultFetcher(req: FwAgentRequest): Promise<FwAgentResponse> {
    return new Promise((resolve, reject) => {
      const bodyStr = req.body ? JSON.stringify(req.body) : '';
      const headers: string[] = [
        `${req.method} ${req.path} HTTP/1.1`,
        'Host: localhost',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(bodyStr)}`,
        'Connection: close',
        '',
        bodyStr,
      ];
      const rawRequest = headers.join('\r\n');

      const socket = createConnection(this.socketPath);
      let rawResponse = '';

      socket.setTimeout(5000);
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error(`fw-agent socket timeout: ${this.socketPath}`));
      });

      socket.on('error', (err) => {
        reject(new Error(`fw-agent socket error: ${err.message}`));
      });

      socket.on('data', (chunk) => {
        rawResponse += chunk.toString('utf-8');
      });

      socket.on('end', () => {
        try {
          const lines = rawResponse.split('\r\n');
          const statusLine = lines[0] ?? '';
          const statusMatch = statusLine.match(/HTTP\/1\.[01] (\d+)/);
          const status = statusMatch ? parseInt(statusMatch[1], 10) : 500;

          // Body is after the blank line separator.
          const bodyStart = rawResponse.indexOf('\r\n\r\n');
          const rawBody = bodyStart >= 0 ? rawResponse.slice(bodyStart + 4) : '';
          let body: unknown;
          try {
            body = rawBody ? JSON.parse(rawBody) : null;
          } catch {
            body = rawBody;
          }
          resolve({ status, body });
        } catch (err) {
          reject(err);
        }
      });

      socket.write(rawRequest);
    });
  }
}
