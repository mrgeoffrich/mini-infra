import type { PrismaClient } from '../../generated/prisma/client';
import type { DockerExecutorService } from '../docker-executor';
import { getLogger } from '../../lib/logger-factory';
import type { JobPoolTriggerKind } from './job-pool-spawner';

const log = getLogger('stacks', 'job-pool-runtime-env-resolver');

/**
 * Context handed to a runtime env resolver when a JobPool run is about to
 * spawn. Resolvers see the trigger that fired (cron / nats-request / manual)
 * by name + kind, plus the trigger's optional `metadata` map (structured
 * authoring keys like `databaseId` — see `JobPoolTrigger.metadata` in
 * `@mini-infra/types`), and any caller-supplied payload (e.g. a NATS-request
 * body or the JSON body POSTed to the manual HTTP route).
 *
 * `runId` is the canonical run identifier — the framework generates it via
 * `randomUUID()` (or uses an externally-supplied identifier) **before** the
 * resolver runs. Resolvers needing to correlate the run with an
 * externally-owned record (e.g. `BackupOperation.id`) write the record with
 * `id: runId` rather than asking the framework to override their own UUID
 * after the fact — this ordering is load-bearing for the atomic-cap-check
 * race fix (MINI-50 review finding H3).
 *
 * The resolver returns the extra env to merge into `callerEnv` before spawn.
 * A resolver throwing (or returning a string `error`) cancels the spawn —
 * the trigger sees a `spawn_failed` result with the error message.
 */
export interface JobPoolRuntimeEnvContext {
  stackId: string;
  serviceName: string;
  trigger: {
    kind: JobPoolTriggerKind;
    name: string;
    /**
     * Structured authoring metadata attached to the trigger by the template
     * or materialiser. Resolvers should prefer `metadata.<key>` over parsing
     * keys out of `name` so an operator-driven rename can't silently break
     * resolution (MINI-50 review finding M8).
     */
    metadata?: Record<string, string>;
  };
  /** Caller-supplied payload (NATS request body or manual HTTP body). */
  payload?: Record<string, unknown>;
  /**
   * The framework-generated runId for this attempt. Already reserved against
   * the atomic concurrency cap before the resolver fires — resolvers should
   * use this value as the primary key of any external row they create
   * (e.g. `prisma.backupOperation.create({ data: { id: ctx.runId, ... } })`).
   */
  runId: string;
}

export interface JobPoolRuntimeEnvResult {
  /** Extra env to merge into `callerEnv` before container spawn. */
  env: Record<string, string>;
  /**
   * If set, the resolver aborted the spawn with a human-readable reason.
   * `runJobPool` surfaces this as a `spawn_failed` result. The `PoolInstance`
   * row was already reserved before the resolver ran, so it's transitioned to
   * `error` rather than deleted — the lifecycle stays observable.
   */
  error?: string;
}

export type JobPoolRuntimeEnvResolver = (
  prisma: PrismaClient,
  dockerExecutor: DockerExecutorService,
  ctx: JobPoolRuntimeEnvContext,
) => Promise<JobPoolRuntimeEnvResult>;

/**
 * Process-wide registry of per-pool runtime env resolvers. Keyed by
 * `<stackId>::<serviceName>` so a single template type (e.g. `pg-az-backup`)
 * can register one resolver per applied stack — apps that need the same
 * resolver across every applied instance register a wildcard entry on
 * `*::<serviceName>` and `getResolver()` falls back to it.
 *
 * The pg-az-backup migration uses the wildcard form because every applied
 * `pg-az-backup` stack across every environment shares the same per-run env
 * resolution (the resolver looks up the trigger name → BackupConfiguration
 * row → POSTGRES_* + AZURE_SAS_URL).
 */
class JobPoolRuntimeEnvResolverRegistry {
  private static instance: JobPoolRuntimeEnvResolverRegistry | null = null;

  private readonly bySlot = new Map<string, JobPoolRuntimeEnvResolver>();

  static getInstance(): JobPoolRuntimeEnvResolverRegistry {
    if (!JobPoolRuntimeEnvResolverRegistry.instance) {
      JobPoolRuntimeEnvResolverRegistry.instance = new JobPoolRuntimeEnvResolverRegistry();
    }
    return JobPoolRuntimeEnvResolverRegistry.instance;
  }

  /** Reset between test runs. Not safe to call from production code. */
  static __resetForTests(): void {
    if (JobPoolRuntimeEnvResolverRegistry.instance) {
      JobPoolRuntimeEnvResolverRegistry.instance.bySlot.clear();
    }
  }

  private slotKey(stackId: string | '*', serviceName: string): string {
    return `${stackId}::${serviceName}`;
  }

  /**
   * Register a resolver for a specific (stackId, serviceName). Pass `'*'` for
   * stackId to register a wildcard that matches every applied instance of the
   * service.
   */
  register(
    stackId: string | '*',
    serviceName: string,
    resolver: JobPoolRuntimeEnvResolver,
  ): void {
    const key = this.slotKey(stackId, serviceName);
    if (this.bySlot.has(key)) {
      log.info({ stackId, serviceName }, 'Replacing existing JobPool runtime env resolver');
    }
    this.bySlot.set(key, resolver);
  }

  unregister(stackId: string | '*', serviceName: string): void {
    this.bySlot.delete(this.slotKey(stackId, serviceName));
  }

  /**
   * Look up a resolver for an exact `(stackId, serviceName)` match, falling
   * back to the wildcard `(*, serviceName)` slot.
   */
  getResolver(stackId: string, serviceName: string): JobPoolRuntimeEnvResolver | undefined {
    return (
      this.bySlot.get(this.slotKey(stackId, serviceName)) ??
      this.bySlot.get(this.slotKey('*', serviceName))
    );
  }

  size(): number {
    return this.bySlot.size;
  }
}

export const jobPoolRuntimeEnvResolvers = JobPoolRuntimeEnvResolverRegistry.getInstance();

/** Test-only — clears every registered resolver. */
export function __clearJobPoolRuntimeEnvResolversForTests(): void {
  JobPoolRuntimeEnvResolverRegistry.__resetForTests();
}
