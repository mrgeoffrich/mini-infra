/**
 * NetworkConvergenceScheduler — network overhaul Phase 8.
 *
 * Wires `network-converger.ts`'s `convergeStack`/`convergeEnvironment`/
 * `convergeAll`/`convergeContainer` up to the three non-boot, non-apply
 * triggers the plan calls for: a periodic full sweep, and debounced,
 * scoped reactions to Docker `network` events and container `start` events.
 * (Stack-apply-scoped convergence and the boot-time full convergence are
 * wired directly in `stack-reconciler.ts`/`server.ts` — this class doesn't
 * own those.)
 *
 * ## Debounce, not immediate action — "don't race container creation"
 *
 * Every trigger here schedules a converge `debounceMs` after the *last*
 * matching event for that scope, coalescing bursts (a single stack apply
 * emits one container `start` event per service; a `docker network
 * disconnect` sometimes pairs with other network churn) into one converge
 * call instead of one per event. This also means convergence never fires
 * *during* the narrow window a container is mid create→attach→start — by
 * the time the debounce timer fires, the ordinary imperative attach
 * pipeline (`attachServiceNetworks`) has long since finished, so there is
 * nothing to race. Connects triggered by this scheduler are always safe to
 * run concurrently with anything else (purely additive); the one genuinely
 * risky action — a `membership-stale` disconnect gated behind
 * `enforceMemberships` — has its own additional per-container grace-period
 * guard inside `network-converger.ts`'s `isSafeToDisconnect`.
 *
 * Unknown Docker networks (no `ManagedNetwork` row — includes every foreign
 * network on a shared worktree Docker host) are ignored outright, never
 * triggering even a full sweep — see `docs/planning/not-shipped/
 * docker-network-overhaul-plan.md` §7 "Shared-daemon hosts".
 */
import type { PrismaClient } from '../../generated/prisma/client';
import { getLogger } from '../../lib/logger-factory';
import { withOperation } from '../../lib/logging-context';
import type { DockerContainerEvent } from '../../lib/docker-event-pattern-detector';
import type { DockerNetworkEvent } from '../docker';
import type { DockerExecutorService } from '../docker-executor';
import { getOwnContainerId } from '../self-update';
import type { NetworkManager } from './network-manager';
import type { NetworkReconcilerDeps } from './network-reconciler';
import { convergeAll, convergeContainer, convergeEnvironment, convergeStack } from './network-converger';

const logger = getLogger('docker', 'network-convergence-scheduler');

const STACK_ID_LABEL = 'mini-infra.stack-id';

export interface NetworkConvergenceSchedulerDeps {
  /** Builds a `NetworkManager` wired to a live Docker connection. Called fresh per action (mirrors `NetworkGcScheduler`) so a Docker reconnect is picked up automatically. */
  createNetworkManager: () => Promise<NetworkManager>;
  /** Builds the `{ getDockerClient() }` source `NetworkReconcilerDeps` needs for its own `listContainers`/`inspect` calls. */
  createDockerExecutor: () => Promise<Pick<DockerExecutorService, 'getDockerClient'>>;
}

export interface NetworkConvergenceSchedulerOptions {
  /** Interval between full periodic sweeps, milliseconds. Default 5 minutes. */
  intervalMs?: number;
  /** Debounce window for event-driven convergence, milliseconds. Default 5 seconds. */
  debounceMs?: number;
}

export class NetworkConvergenceScheduler {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly debounceMs: number;
  private running = false;

  private readonly pendingStacks = new Map<string, NodeJS.Timeout>();
  private readonly pendingEnvironments = new Map<string, NodeJS.Timeout>();
  private readonly pendingContainers = new Map<string, NodeJS.Timeout>();
  private pendingAll: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly deps: NetworkConvergenceSchedulerDeps,
    options: NetworkConvergenceSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 5 * 60_000;
    this.debounceMs = options.debounceMs ?? 5_000;
  }

  start(): void {
    if (this.running) {
      logger.warn('NetworkConvergenceScheduler already running');
      return;
    }
    this.running = true;
    logger.info(
      { intervalMs: this.intervalMs, debounceMs: this.debounceMs },
      'Starting NetworkConvergenceScheduler (periodic full sweep + debounced event-driven convergence)',
    );
    this.intervalId = setInterval(() => {
      void withOperation('network-converge-tick', () => this.tick());
    }, this.intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    for (const t of this.pendingStacks.values()) clearTimeout(t);
    for (const t of this.pendingEnvironments.values()) clearTimeout(t);
    for (const t of this.pendingContainers.values()) clearTimeout(t);
    if (this.pendingAll) clearTimeout(this.pendingAll);
    this.pendingStacks.clear();
    this.pendingEnvironments.clear();
    this.pendingContainers.clear();
    this.pendingAll = null;
    this.running = false;
    logger.info('NetworkConvergenceScheduler stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  private async buildDeps(): Promise<NetworkReconcilerDeps | undefined> {
    try {
      const [networkManager, dockerExecutor] = await Promise.all([
        this.deps.createNetworkManager(),
        this.deps.createDockerExecutor(),
      ]);
      return { prisma: this.prisma, networkManager, dockerExecutor, log: logger };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Docker unreachable — skipping network convergence',
      );
      return undefined;
    }
  }

  /** Single periodic full sweep. Exposed for tests and the constructor's interval callback. */
  async tick() {
    const deps = await this.buildDeps();
    if (!deps) return undefined;
    try {
      return await convergeAll(deps);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Periodic network convergence tick failed; will retry next interval',
      );
      return undefined;
    }
  }

  /** Debounced, stack-scoped converge — coalesces rapid repeated triggers (e.g. one container `start` event per service during a single apply) into one converge call fired `debounceMs` after the last trigger. */
  scheduleStackConverge(stackId: string): void {
    const existing = this.pendingStacks.get(stackId);
    if (existing) clearTimeout(existing);
    this.pendingStacks.set(
      stackId,
      setTimeout(() => {
        this.pendingStacks.delete(stackId);
        void withOperation('network-converge-stack', async () => {
          const deps = await this.buildDeps();
          if (!deps) return;
          try {
            await convergeStack(stackId, deps);
          } catch (err) {
            logger.warn(
              { stackId, err: err instanceof Error ? err.message : String(err) },
              'Event-driven stack network convergence failed',
            );
          }
        });
      }, this.debounceMs),
    );
  }

  /** Debounced, environment-scoped converge. */
  scheduleEnvironmentConverge(environmentId: string): void {
    const existing = this.pendingEnvironments.get(environmentId);
    if (existing) clearTimeout(existing);
    this.pendingEnvironments.set(
      environmentId,
      setTimeout(() => {
        this.pendingEnvironments.delete(environmentId);
        void withOperation('network-converge-environment', async () => {
          const deps = await this.buildDeps();
          if (!deps) return;
          try {
            await convergeEnvironment(environmentId, deps);
          } catch (err) {
            logger.warn(
              { environmentId, err: err instanceof Error ? err.message : String(err) },
              'Event-driven environment network convergence failed',
            );
          }
        });
      }, this.debounceMs),
    );
  }

  /** Debounced, single-container converge (the `converge(containerId)` primitive) — the container `start` event handler's action. */
  scheduleContainerConverge(containerId: string): void {
    const existing = this.pendingContainers.get(containerId);
    if (existing) clearTimeout(existing);
    this.pendingContainers.set(
      containerId,
      setTimeout(() => {
        this.pendingContainers.delete(containerId);
        void withOperation('network-converge-container', async () => {
          const deps = await this.buildDeps();
          if (!deps) return;
          try {
            await convergeContainer(containerId, deps);
          } catch (err) {
            logger.warn(
              { containerId, err: err instanceof Error ? err.message : String(err) },
              'Event-driven container network convergence failed',
            );
          }
        });
      }, this.debounceMs),
    );
  }

  /** Debounced full sweep — used when a network event resolves to a host-scoped (or otherwise unattributable) `ManagedNetwork` row, where no narrower scope exists. */
  scheduleFullConverge(): void {
    if (this.pendingAll) clearTimeout(this.pendingAll);
    this.pendingAll = setTimeout(() => {
      this.pendingAll = null;
      void withOperation('network-converge-all', async () => {
        const deps = await this.buildDeps();
        if (!deps) return;
        try {
          await convergeAll(deps);
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Event-driven full network convergence failed');
        }
      });
    }, this.debounceMs);
  }

  /**
   * Docker container `start` event handler — wire via `DockerService.
   * onContainerEvent(scheduler.handleContainerEvent.bind(scheduler))`. Only
   * `start` actions matter (a recreated/restarted container regaining its
   * memberships); every other action is ignored. Containers carrying none
   * of mini-infra's own labels and that aren't the self container are
   * skipped without scheduling anything — a foreign container on a shared
   * Docker host has no declared memberships, so there's nothing to converge
   * and no reason to pay for a debounce timer + DB lookup on its behalf.
   */
  handleContainerEvent(event: DockerContainerEvent): void {
    if (event.action !== 'start') return;
    const hasOwnLabels = Boolean(event.labels?.[STACK_ID_LABEL]);
    const isSelf = getOwnContainerId() === event.containerId;
    if (!hasOwnLabels && !isSelf) return;
    this.scheduleContainerConverge(event.containerId);
  }

  /**
   * Docker network event handler — wire via `DockerService.
   * onNetworkEvent(scheduler.handleNetworkEvent.bind(scheduler))`. Resolves
   * the network name to its `ManagedNetwork` owner and schedules the
   * narrowest matching converge; a name with no matching row (any network
   * mini-infra doesn't manage) is ignored outright — this is what keeps
   * convergence from reacting to every other project's networks on a
   * shared worktree Docker host.
   */
  handleNetworkEvent(event: DockerNetworkEvent): void {
    if (!event.networkName) return;
    const networkName = event.networkName;
    void withOperation('network-event-lookup', async () => {
      try {
        const row = await this.prisma.managedNetwork.findUnique({
          where: { name: networkName },
          select: { scope: true, stackId: true, environmentId: true },
        });
        if (!row) return;
        if (row.scope === 'stack' && row.stackId) {
          this.scheduleStackConverge(row.stackId);
        } else if (row.scope === 'environment' && row.environmentId) {
          this.scheduleEnvironmentConverge(row.environmentId);
        } else {
          this.scheduleFullConverge();
        }
      } catch (err) {
        logger.warn(
          { network: networkName, err: err instanceof Error ? err.message : String(err) },
          'Failed to resolve network event owner — skipping event-driven convergence for this event',
        );
      }
    });
  }
}
