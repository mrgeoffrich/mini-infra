import type {
  DockerNetworkGcOrphan,
  DockerNetworkGcOwnerKind,
  DockerNetworkGcReport,
} from '@mini-infra/types';
import type { PrismaClient } from '../../generated/prisma/client';
import { getLogger } from '../../lib/logger-factory';
import { withOperation } from '../../lib/logging-context';
import type { NetworkManager } from './network-manager';

const logger = getLogger('docker', 'network-gc');

export interface NetworkGcOptions {
  /** Defaults to true — report-only, never calls `NetworkManager.remove()`. */
  dryRun?: boolean;
}

/**
 * Label-driven GC sweep (network overhaul Phase 4, design doc §2.3).
 *
 * Enumerates every `mini-infra.managed=true` network via
 * `NetworkManager.listManaged()`, resolves each one's owner against the DB
 * (Stack/Environment existence — not `InfraResource`, so this also catches
 * every historical orphan whose `InfraResource` row already went missing
 * before this phase added a deletion path for it), and reports networks
 * whose owner no longer exists and which have zero attached containers.
 *
 * Hard safety rule: only networks carrying `mini-infra.managed=true` are
 * ever candidates (enforced by `listManaged()`, not by this function) — an
 * unlabelled or foreign network on a shared Docker host (worktree dev hosts
 * run other projects on the same daemon) is never enumerated, let alone
 * removed. `host`-scoped networks are also never candidates: there is no DB
 * row that can disappear out from under the mini-infra server itself.
 *
 * Dry-run by default: pass `{ dryRun: false }` to actually call
 * `networkManager.remove()` on eligible orphans. A network with attached
 * containers is reported but never removed regardless of `dryRun` — GC
 * never force-disconnects.
 */
export async function runNetworkGc(
  networkManager: NetworkManager,
  prisma: PrismaClient,
  options: NetworkGcOptions = {},
): Promise<DockerNetworkGcReport> {
  const dryRun = options.dryRun ?? true;
  const ranAt = new Date().toISOString();

  const managed = await networkManager.listManaged();

  const stackOwnerIds = Array.from(
    new Set(
      managed
        .filter((n) => n.ownerKind === 'stack' && n.ownerId)
        .map((n) => n.ownerId as string),
    ),
  );
  const environmentOwnerIds = Array.from(
    new Set(
      managed
        .filter((n) => n.ownerKind === 'environment' && n.ownerId)
        .map((n) => n.ownerId as string),
    ),
  );

  const [existingStacks, existingEnvironments] = await Promise.all([
    stackOwnerIds.length > 0
      ? prisma.stack.findMany({ where: { id: { in: stackOwnerIds } }, select: { id: true } })
      : Promise.resolve([]),
    environmentOwnerIds.length > 0
      ? prisma.environment.findMany({ where: { id: { in: environmentOwnerIds } }, select: { id: true } })
      : Promise.resolve([]),
  ]);
  const existingStackIds = new Set(existingStacks.map((s) => s.id));
  const existingEnvironmentIds = new Set(existingEnvironments.map((e) => e.id));

  const ownerExists = (ownerKind: DockerNetworkGcOwnerKind, ownerId?: string): boolean => {
    if (ownerKind === 'host') return true; // the host itself never disappears.
    if (!ownerId) return true; // malformed/unlabelled owner id — nothing to resolve against; don't touch it.
    return ownerKind === 'stack' ? existingStackIds.has(ownerId) : existingEnvironmentIds.has(ownerId);
  };

  const orphans: DockerNetworkGcOrphan[] = [];

  for (const net of managed) {
    if (ownerExists(net.ownerKind, net.ownerId)) continue;

    let connectedContainerCount: number;
    try {
      const inspected = await networkManager.inspect(net.name);
      connectedContainerCount = inspected?.connectedContainerIds.length ?? 0;
    } catch (err) {
      logger.warn(
        { name: net.name, error: err instanceof Error ? err.message : String(err) },
        'Failed to inspect candidate orphan network during GC — skipping it this run',
      );
      continue;
    }

    const eligibleForRemoval = connectedContainerCount === 0;
    const orphan: DockerNetworkGcOrphan = {
      name: net.name,
      ownerKind: net.ownerKind,
      ownerId: net.ownerId,
      purpose: net.purpose,
      connectedContainerCount,
      eligibleForRemoval,
    };

    if (eligibleForRemoval && !dryRun) {
      const result = await networkManager.remove(net.name);
      orphan.removed = result.removed;
      if (!result.removed) {
        logger.warn(
          { name: net.name, reason: result.reason },
          'GC could not remove eligible orphaned network, will retry next sweep',
        );
      }
    }

    orphans.push(orphan);
  }

  const removedCount = orphans.filter((o) => o.removed).length;

  logger.info(
    {
      dryRun,
      scannedCount: managed.length,
      orphanCount: orphans.length,
      eligibleCount: orphans.filter((o) => o.eligibleForRemoval).length,
      removedCount,
    },
    'Network GC sweep complete',
  );

  return {
    dryRun,
    scannedCount: managed.length,
    orphans,
    removedCount,
    ranAt,
  };
}

export interface NetworkGcSchedulerDeps {
  /**
   * Builds a `NetworkManager` wired to a live Docker connection. Called
   * fresh on every tick (mirrors the rest of `services/networks/` — the
   * executor is re-initialised per call rather than captured once at boot,
   * so a Docker reconnect is picked up automatically). Injected rather than
   * imported directly so this module has no dependency on `./index`
   * (`createNetworkManager` lives there) and therefore no import cycle.
   */
  createNetworkManager: () => Promise<NetworkManager>;
}

export interface NetworkGcSchedulerOptions {
  /** Interval between ticks, milliseconds. Default 15 minutes. */
  intervalMs?: number;
}

/**
 * Periodic GC sweep, mirroring the `PoolInstanceReaper` shape
 * (`services/stacks/pool-instance-reaper.ts`): a simple `setInterval` loop
 * with `start()`/`stop()`/`tick()`, wired up in `server.ts` alongside the
 * other scheduler singletons.
 *
 * Every scheduled tick runs in **dry-run mode only** — it reports and logs
 * orphan counts but never mutates Docker. A real removal is only ever
 * triggered on-demand via `POST /api/docker/networks/gc` with
 * `{ dryRun: false }`, so an operator always has to explicitly opt into
 * deletion; the automatic sweep can never surprise anyone by deleting a
 * network on its own schedule. Docker connectivity failures are caught and
 * logged — a bad tick never crashes the process or wedges the interval.
 */
export class NetworkGcScheduler {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private running = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly deps: NetworkGcSchedulerDeps,
    options: NetworkGcSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 15 * 60_000;
  }

  start(): void {
    if (this.running) {
      logger.warn('NetworkGcScheduler already running');
      return;
    }
    this.running = true;
    logger.info(
      { intervalMs: this.intervalMs },
      'Starting NetworkGcScheduler (dry-run sweeps only — POST /api/docker/networks/gc with dryRun:false for a real run)',
    );
    void withOperation('network-gc-tick', () => this.tick());
    this.intervalId = setInterval(() => {
      void withOperation('network-gc-tick', () => this.tick());
    }, this.intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
    logger.info('NetworkGcScheduler stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Single dry-run sweep. Exposed for tests and for the constructor's immediate first tick. */
  async tick(): Promise<DockerNetworkGcReport | undefined> {
    let networkManager: NetworkManager;
    try {
      networkManager = await this.deps.createNetworkManager();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Docker unreachable — skipping network GC tick',
      );
      return undefined;
    }

    try {
      const report = await runNetworkGc(networkManager, this.prisma, { dryRun: true });
      if (report.orphans.length > 0) {
        logger.info(
          { orphans: report.orphans.map((o) => o.name) },
          'Network GC dry-run sweep found orphaned managed network(s)',
        );
      }
      return report;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Network GC tick failed; will retry next interval',
      );
      return undefined;
    }
  }
}
